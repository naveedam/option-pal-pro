import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_BASE = "https://mis.kotaksecurities.com";
const TOTP_LOGIN_PATH = "login/1.0/tradeApiLogin";
const TOTP_VALIDATE_PATH = "login/1.0/tradeApiValidate";

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
    const requestBody = await req.json();
    const { action, ...payload } = requestBody;

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    switch (action) {
      case "login": {
        const consumerKey = typeof payload.consumerKey === "string" ? payload.consumerKey.trim() : "";
        let mobileNumber = typeof payload.mobileNumber === "string" ? payload.mobileNumber.trim() : "";
        if (mobileNumber && !mobileNumber.startsWith("+")) {
          mobileNumber = "+91" + mobileNumber;
        }
        const ucc = typeof payload.ucc === "string" ? payload.ucc.trim().toUpperCase() : "";
        const mpin = typeof payload.mpin === "string" ? payload.mpin.trim() : "";
        const totp =
          typeof payload.totp === "string"
            ? payload.totp.trim()
            : typeof payload.otp === "string"
              ? payload.otp.trim()
              : "";

        if (!consumerKey || !ucc || !mpin || !totp) {
          return new Response(
            JSON.stringify({ success: false, error: "Missing credentials" }),
            { status: 400, headers }
          );
        }

        // Step 1: TOTP Login
        const loginUrl = `${KOTAK_BASE}/${TOTP_LOGIN_PATH}`;
        console.log("Step 1: TOTP Login...");

        const loginResponse = await fetch(loginUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": consumerKey,
            "neo-fin-key": "neotradeapi",
          },
          body: JSON.stringify({ mobileNumber, ucc, totp }),
        });

        const loginText = await loginResponse.text();
        console.log("TOTP Login status:", loginResponse.status);

        let loginData: any;
        try { loginData = JSON.parse(loginText); } catch {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid JSON from Kotak TOTP login" }),
            { status: 200, headers }
          );
        }

        if (!loginResponse.ok || loginData?.stat === "Not_Ok" || loginData?.error || loginData?.code) {
          const errorMsg = loginData?.emsg || loginData?.message || loginData?.description ||
            (typeof loginData?.error === "string" ? loginData.error : JSON.stringify(loginData?.error)) || "TOTP login failed";
          return new Response(
            JSON.stringify({ success: false, error: `TOTP Login failed: ${errorMsg}` }),
            { status: 200, headers }
          );
        }

        const viewToken = loginData?.data?.token || loginData?.token;
        const viewSid = loginData?.data?.sid || loginData?.sid;

        if (!viewToken) {
          return new Response(
            JSON.stringify({ success: false, error: "No view token received from TOTP login" }),
            { status: 200, headers }
          );
        }

        console.log("Step 1 success: got view token and sid");

        // Step 2: MPIN Validation
        const validateUrl = `${KOTAK_BASE}/${TOTP_VALIDATE_PATH}`;
        console.log("Step 2: TOTP Validate with MPIN...");

        const validateResponse = await fetch(validateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": consumerKey,
            "Auth": viewToken,
            "sid": viewSid || "",
            "neo-fin-key": "neotradeapi",
          },
          body: JSON.stringify({ mpin }),
        });

        const validateText = await validateResponse.text();
        console.log("TOTP Validate status:", validateResponse.status);
        console.log("TOTP Validate response keys:", validateText.substring(0, 500));

        let validateData: any;
        try { validateData = JSON.parse(validateText); } catch {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid JSON from Kotak TOTP validate" }),
            { status: 200, headers }
          );
        }

        if (!validateResponse.ok || validateData?.stat === "Not_Ok" || validateData?.error) {
          const errorMsg = validateData?.emsg || validateData?.message || validateData?.error || "MPIN validation failed";
          return new Response(
            JSON.stringify({ success: false, error: `MPIN Validation failed: ${errorMsg}` }),
            { status: 200, headers }
          );
        }

        const tradeToken = validateData?.data?.token || validateData?.token || viewToken;
        const tradeSid = validateData?.data?.sid || validateData?.sid || viewSid;
        const baseUrl = validateData?.data?.baseUrl || validateData?.baseUrl || null;

        console.log("baseUrl from validate:", baseUrl);

        if (!tradeToken) {
          return new Response(
            JSON.stringify({ success: false, error: "No trade token received from MPIN validation" }),
            { status: 200, headers }
          );
        }

        console.log("Step 2 success: got trade token");

        // Kotak tokens are short-lived — use realistic expiry
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

        await adminClient.from("broker_sessions").upsert(
          {
            user_id: userId,
            broker: "kotak_neo",
            session_token: tradeSid || crypto.randomUUID(),
            access_token: tradeToken,
            consumer_key: consumerKey,
            base_url: baseUrl,
            is_active: true,
            connected_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,broker" }
        );

        console.log("Broker session stored successfully");

        return new Response(
          JSON.stringify({ success: true, message: "Broker connected successfully", expiresAt: expiresAt.toISOString() }),
          { headers }
        );
      }

      case "status": {
        // Use adminClient with same query pattern as kotak-market-data
        // to avoid maybeSingle() returning null when multiple rows exist
        const { data: session } = await adminClient
          .from("broker_sessions")
          .select("is_active, connected_at, expires_at, access_token, consumer_key")
          .eq("user_id", userId)
          .eq("broker", "kotak_neo")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const isExpired = session?.expires_at ? new Date(session.expires_at) < new Date() : true;
        const hasCredentials = !!session?.access_token && !!session?.consumer_key;

        console.log(`[Status] user=${userId} active=${session?.is_active} expired=${isExpired} hasCreds=${hasCredentials}`);

        if (session?.is_active && isExpired) {
          // Auto-deactivate expired sessions
          await adminClient.from("broker_sessions")
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("broker", "kotak_neo");
        }

        return new Response(
          JSON.stringify({
            connected: session?.is_active && !isExpired && hasCredentials,
            connectedAt: session?.connected_at,
            expiresAt: session?.expires_at,
          }),
          { headers }
        );
      }

      case "disconnect": {
        await adminClient
          .from("broker_sessions")
          .update({ is_active: false, access_token: null, session_token: null, consumer_key: null, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("broker", "kotak_neo");

        return new Response(JSON.stringify({ success: true, message: "Disconnected" }), { headers });
      }

      default:
        return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers });
    }
  } catch (error) {
    console.error("Auth error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Internal server error" }),
      { status: 200, headers }
    );
  }
});
