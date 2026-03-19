import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Kotak Neo SDK v2 base URLs
const KOTAK_GW_NAPI = "https://gw-napi.kotaksecurities.com";

// SDK v2 PROD endpoints (from settings.py)
const TOTP_LOGIN_PATH = "login/1.0/login/v6/totp/login";
const TOTP_VALIDATE_PATH = "login/1.0/login/v6/totp/validate";

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
        const { consumerKey, mobileNumber, ucc, totp, mpin } = payload;

        if (!consumerKey || !mobileNumber || !ucc || !totp || !mpin) {
          return new Response(
            JSON.stringify({ success: false, error: "All fields are required: Consumer Key, Mobile Number, UCC, TOTP, and MPIN" }),
            { status: 200, headers }
          );
        }

        // === Step 1: TOTP Login (generates view token + sid) ===
        const loginUrl = `${KOTAK_GW_NAPI}/${TOTP_LOGIN_PATH}`;
        const loginBody = {
          mobileNumber: mobileNumber,
          ucc: ucc,
          totp: totp,
        };

        console.log("Step 1: TOTP Login...");
        console.log("Request:", { url: loginUrl, body: { ...loginBody, totp: "***" } });

        const loginResponse = await fetch(loginUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": consumerKey,
          },
          body: JSON.stringify(loginBody),
        });

        const loginText = await loginResponse.text();
        console.log("TOTP Login status:", loginResponse.status);
        console.log("TOTP Login response:", loginText.substring(0, 500));

        let loginData: any;
        try {
          loginData = JSON.parse(loginText);
        } catch {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid JSON from Kotak TOTP login", raw: loginText.substring(0, 300) }),
            { status: 200, headers }
          );
        }

        if (!loginResponse.ok || loginData?.stat === "Not_Ok" || loginData?.error) {
          const errorMsg = loginData?.emsg || loginData?.message || loginData?.error || loginData?.description || "TOTP login failed";
          console.error("TOTP Login failed:", errorMsg);
          return new Response(
            JSON.stringify({ success: false, error: `TOTP Login failed: ${errorMsg}`, status: loginResponse.status }),
            { status: 200, headers }
          );
        }

        // Extract view token and sid from step 1
        const viewToken = loginData?.data?.token || loginData?.token;
        const viewSid = loginData?.data?.sid || loginData?.sid;
        const serverId = loginData?.data?.hsServerId || loginData?.hsServerId;

        if (!viewToken) {
          console.error("No view token in response:", JSON.stringify(loginData).substring(0, 300));
          return new Response(
            JSON.stringify({ success: false, error: "No view token received from TOTP login", keys: Object.keys(loginData) }),
            { status: 200, headers }
          );
        }

        console.log("Step 1 success: got view token and sid");

        // === Step 2: TOTP Validate with MPIN (generates trade token) ===
        const validateUrl = `${KOTAK_GW_NAPI}/${TOTP_VALIDATE_PATH}`;
        const validateBody = {
          mpin: mpin,
        };

        console.log("Step 2: TOTP Validate with MPIN...");
        console.log("Request:", { url: validateUrl });

        const validateResponse = await fetch(validateUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${viewToken}`,
            "sid": viewSid || "",
          },
          body: JSON.stringify(validateBody),
        });

        const validateText = await validateResponse.text();
        console.log("TOTP Validate status:", validateResponse.status);
        console.log("TOTP Validate response:", validateText.substring(0, 500));

        let validateData: any;
        try {
          validateData = JSON.parse(validateText);
        } catch {
          return new Response(
            JSON.stringify({ success: false, error: "Invalid JSON from Kotak TOTP validate", raw: validateText.substring(0, 300) }),
            { status: 200, headers }
          );
        }

        if (!validateResponse.ok || validateData?.stat === "Not_Ok" || validateData?.error) {
          const errorMsg = validateData?.emsg || validateData?.message || validateData?.error || validateData?.description || "MPIN validation failed";
          console.error("TOTP Validate failed:", errorMsg);
          return new Response(
            JSON.stringify({ success: false, error: `MPIN Validation failed: ${errorMsg}`, status: validateResponse.status }),
            { status: 200, headers }
          );
        }

        // Extract trade token from step 2
        const tradeToken = validateData?.data?.token || validateData?.token || viewToken;
        const tradeSid = validateData?.data?.sid || validateData?.sid || viewSid;

        if (!tradeToken) {
          return new Response(
            JSON.stringify({ success: false, error: "No trade token received from MPIN validation" }),
            { status: 200, headers }
          );
        }

        console.log("Step 2 success: got trade token");

        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

        // Store session
        await adminClient.from("broker_sessions").upsert(
          {
            user_id: userId,
            broker: "kotak_neo",
            session_token: tradeSid || crypto.randomUUID(),
            access_token: tradeToken,
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
      JSON.stringify({ success: false, error: error.message || "Internal server error" }),
      { status: 200, headers }
    );
  }
});
