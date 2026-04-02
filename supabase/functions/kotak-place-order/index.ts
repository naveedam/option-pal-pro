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

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      console.error("Auth failed:", userError?.message);
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const userId = user.id;

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: "Invalid JSON payload" }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const { symbol, strike, optionType, quantity, orderType, product, transactionType } = body;

    // STEP 5: Validate order payload
    if (!symbol || typeof symbol !== "string") {
      return new Response(JSON.stringify({ success: false, error: "Missing or invalid symbol" }), {
        status: 400, headers: jsonHeaders,
      });
    }
    if (strike === undefined || strike === null || isNaN(Number(strike))) {
      return new Response(JSON.stringify({ success: false, error: "Missing or invalid strike price" }), {
        status: 400, headers: jsonHeaders,
      });
    }
    if (!optionType || !["CE", "PE"].includes(optionType)) {
      return new Response(JSON.stringify({ success: false, error: "optionType must be CE or PE" }), {
        status: 400, headers: jsonHeaders,
      });
    }
    if (!quantity || Number(quantity) <= 0) {
      return new Response(JSON.stringify({ success: false, error: "quantity must be greater than 0" }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // STEP 2: Retrieve active broker session using admin client
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: session, error: sessionError } = await adminClient
      .from("broker_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionError) {
      console.error("Session query error:", sessionError.message);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to retrieve broker session. Please try again.",
      }), { status: 500, headers: jsonHeaders });
    }

    if (!session || !session.access_token) {
      console.error("No active broker session found for user:", userId);
      return new Response(JSON.stringify({
        success: false,
        error: "No active Kotak broker session found. Please reconnect your broker.",
      }), { status: 403, headers: jsonHeaders });
    }

    // Determine base URL from session or fallback
    const baseUrl = session.base_url || "https://gw-napi.kotaksecurities.com";
    console.log("Using base_url:", baseUrl);

    // Check session expiry
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      console.error("Broker session expired at:", session.expires_at);
      await adminClient
        .from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);

      return new Response(JSON.stringify({
        success: false,
        error: "Broker session expired. Please reconnect Kotak Neo.",
      }), { status: 403, headers: jsonHeaders });
    }

    // STEP 3: Debug logging before Kotak API call
    console.log("Placing Kotak order", {
      userId,
      symbol,
      strike,
      optionType,
      quantity,
      tokenPrefix: session.access_token.substring(0, 8) + "...",
    });

    // Call Kotak Neo Order Placement API
    try {
      const kotakResponse = await fetch(
        "https://gw-napi.kotaksecurities.com/Orders/2.0/quick/order/rule/ms/place",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            "sid": session.session_token || "",
          },
          body: JSON.stringify({
            am: "NO",
            dq: "0",
            es: optionType === "CE" || optionType === "PE" ? "nse_fo" : "nse_cm",
            mp: "0",
            pc: product || "MIS",
            pf: "N",
            pr: "0",
            pt: orderType || "MKT",
            qt: String(quantity),
            rt: "DAY",
            tp: "0",
            ts: symbol,
            tt: transactionType || "B",
            st: String(strike),
            ot: optionType,
          }),
        }
      );

      const kotakData = await kotakResponse.json();
      console.log("Kotak response status:", kotakResponse.status, "data:", JSON.stringify(kotakData));

      if (kotakResponse.ok && kotakData?.nOrdNo) {
        // Persist the trade
        await adminClient.from("trades").insert({
          user_id: userId,
          order_id: kotakData.nOrdNo,
          symbol,
          strike: Number(strike),
          option_type: optionType,
          quantity: Number(quantity),
          entry_price: 0,
          status: "open",
          is_paper: false,
        });

        return new Response(JSON.stringify({
          success: true,
          orderId: kotakData.nOrdNo,
          message: `Order placed: ${symbol} ${strike} ${optionType} Qty ${quantity}`,
        }), { headers: jsonHeaders });
      } else {
        // STEP 4: Return detailed broker errors
        const errorMsg = kotakData?.errMsg || kotakData?.message || kotakData?.error || "Order rejected by broker";
        console.error("Kotak API rejected order:", errorMsg, kotakData);
        return new Response(JSON.stringify({ success: false, error: errorMsg }), {
          status: 400, headers: jsonHeaders,
        });
      }
    } catch (brokerErr) {
      console.error("Kotak API network error:", brokerErr);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to connect to broker API. Please try again.",
      }), { status: 502, headers: jsonHeaders });
    }
  } catch (error) {
    console.error("Order endpoint error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || "Internal server error",
    }), { status: 500, headers: jsonHeaders });
  }
});
