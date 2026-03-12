import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(
      authHeader.replace("Bearer ", "")
    );
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub;
    const { action, ...payload } = await req.json();

    switch (action) {
      case "login": {
        const { consumerKey, consumerSecret, userId: neoUserId, password } = payload;

        if (!consumerKey || !consumerSecret || !neoUserId || !password) {
          return new Response(
            JSON.stringify({ error: "All credential fields are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // In production, this calls the Kotak Neo login API:
        // POST https://gw-napi.kotaksecurities.com/login/1.0/login/v2/validate
        // For now, simulate the OTP generation step
        const sessionId = crypto.randomUUID();

        // Store partial session (awaiting OTP)
        const adminClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        await adminClient.from("broker_sessions").upsert(
          {
            user_id: userId,
            broker: "kotak_neo",
            session_token: sessionId,
            is_active: false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,broker" }
        );

        return new Response(
          JSON.stringify({
            success: true,
            step: "otp_required",
            sessionId,
            message: "OTP sent to registered mobile number",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "verify_otp": {
        const { otp, sessionId } = payload;

        if (!otp || !sessionId) {
          return new Response(
            JSON.stringify({ error: "OTP and session ID are required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // In production, this calls:
        // POST https://gw-napi.kotaksecurities.com/login/1.0/login/v2/validate
        // with the OTP to get the access token
        // For now, simulate successful verification
        const accessToken = `neo_${crypto.randomUUID().replace(/-/g, "")}`;
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

        const adminClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        await adminClient
          .from("broker_sessions")
          .update({
            access_token: accessToken,
            is_active: true,
            connected_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("broker", "kotak_neo")
          .eq("session_token", sessionId);

        return new Response(
          JSON.stringify({
            success: true,
            step: "connected",
            message: "Broker connected successfully",
            expiresAt: expiresAt.toISOString(),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "status": {
        const { data: session } = await supabase
          .from("broker_sessions")
          .select("is_active, connected_at, expires_at")
          .eq("broker", "kotak_neo")
          .maybeSingle();

        const isExpired = session?.expires_at
          ? new Date(session.expires_at) < new Date()
          : true;

        return new Response(
          JSON.stringify({
            connected: session?.is_active && !isExpired,
            connectedAt: session?.connected_at,
            expiresAt: session?.expires_at,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "disconnect": {
        const adminClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        await adminClient
          .from("broker_sessions")
          .update({
            is_active: false,
            access_token: null,
            session_token: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("broker", "kotak_neo");

        return new Response(
          JSON.stringify({ success: true, message: "Disconnected" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Invalid action" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
