import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_BASE = "https://gw-napi.kotaksecurities.com";
const KOTAK_SESSION_BASE = "https://napi.kotaksecurities.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const userId = user.id;
    const { action, ...payload } = await req.json();

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    switch (action) {
      case "login": {
        const { consumerKey, userId: neoUserId, password, otp } = payload;

        if (!consumerKey || !neoUserId || !password || !otp) {
          return new Response(
            JSON.stringify({ error: "All credential fields are required" }),
            { status: 400, headers }
          );
        }

        // Step 1: Call Kotak Neo TOTP login endpoint
        console.log("Calling Kotak Neo login API...");
        const loginUrl = `${KOTAK_BASE}/login/1.0/tradeApiLogin`;
        const loginBody = {
          userId: neoUserId,
          password: password,
          totp: otp,
        };
        console.log("Kotak login request:", { url: loginUrl, body: { ...loginBody, password: "***" } });
        const loginResponse = await fetch(loginUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": consumerKey,
          },
          body: JSON.stringify(loginBody),
        });

        const loginText = await loginResponse.text();
        console.log("Kotak login status:", loginResponse.status);
        console.log("Kotak login response:", loginText.substring(0, 500));

        let loginData: any;
        try {
          loginData = JSON.parse(loginText);
        } catch {
          return new Response(
            JSON.stringify({ error: "Invalid response from Kotak Neo login", raw: loginText.substring(0, 200) }),
            { status: 502, headers }
          );
        }

        // Check for login errors
        if (!loginResponse.ok || loginData?.error || loginData?.stat === "Not_Ok") {
          const errorMsg = loginData?.error || loginData?.emsg || loginData?.message || "Login failed";
          console.error("Kotak login failed:", errorMsg);
          return new Response(
            JSON.stringify({ error: `Kotak Neo login failed: ${errorMsg}` }),
            { status: 400, headers }
          );
        }

        // Step 2: Validate with OTP / 2FA
        // The tradeApiLogin may return tokens directly, or we may need a second call
        let accessToken = loginData?.token || loginData?.access_token || loginData?.data?.token;
        let sessionId = loginData?.sid || loginData?.data?.sid || loginData?.session_id;
        const serverId = loginData?.serverId || loginData?.data?.serverId || loginData?.hsServerId;

        // If tradeApiLogin doesn't work, try the validate endpoint
        if (!accessToken) {
          console.log("Trying validate endpoint...");
          const validateUrl = `${KOTAK_BASE}/login/1.0/tradeApiValidate`;
          const validateResponse = await fetch(validateUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${consumerKey}`,
            },
            body: JSON.stringify({
              userId: neoUserId,
              otp: otp,
            }),
          });

          const validateText = await validateResponse.text();
          console.log("Kotak validate status:", validateResponse.status);
          console.log("Kotak validate response:", validateText.substring(0, 500));

          let validateData: any;
          try {
            validateData = JSON.parse(validateText);
          } catch {
            return new Response(
              JSON.stringify({ error: "Invalid response from Kotak Neo validate", raw: validateText.substring(0, 200) }),
              { status: 502, headers }
            );
          }

          if (!validateResponse.ok || validateData?.error || validateData?.stat === "Not_Ok") {
            const errorMsg = validateData?.error || validateData?.emsg || validateData?.message || "Validation failed";
            return new Response(
              JSON.stringify({ error: `Kotak Neo validation failed: ${errorMsg}` }),
              { status: 400, headers }
            );
          }

          accessToken = validateData?.token || validateData?.access_token || validateData?.data?.token;
          sessionId = validateData?.sid || validateData?.data?.sid || validateData?.session_id;
        }

        if (!accessToken) {
          console.error("No access token in Kotak response:", JSON.stringify(loginData).substring(0, 300));
          return new Response(
            JSON.stringify({ 
              error: "Could not extract access token from Kotak Neo response",
              debug: { keys: Object.keys(loginData), status: loginResponse.status }
            }),
            { status: 400, headers }
          );
        }

        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

        // Store the REAL token from Kotak
        await adminClient.from("broker_sessions").upsert(
          {
            user_id: userId,
            broker: "kotak_neo",
            session_token: sessionId || crypto.randomUUID(),
            access_token: accessToken,
            is_active: true,
            connected_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,broker" }
        );

        console.log("Broker session stored successfully");

        return new Response(
          JSON.stringify({
            success: true,
            message: "Broker connected successfully",
            expiresAt: expiresAt.toISOString(),
          }),
          { headers }
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
          { headers }
        );
      }

      case "disconnect": {
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
          { headers }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Invalid action" }),
          { status: 400, headers }
        );
    }
  } catch (error) {
    console.error("Auth error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers }
    );
  }
});
