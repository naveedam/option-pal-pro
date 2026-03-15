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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const userId = user.id;
    const { symbol, strike, optionType, quantity, orderType, product, transactionType } = await req.json();

    // Validate payload
    if (!symbol || !strike || !optionType || !quantity) {
      return new Response(JSON.stringify({ success: false, error: "Missing required order fields" }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // Retrieve active broker session
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: session } = await adminClient
      .from("broker_sessions")
      .select("access_token, session_token, is_active, expires_at")
      .eq("user_id", userId)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .maybeSingle();

    if (!session || !session.access_token) {
      return new Response(JSON.stringify({ success: false, error: "Broker not connected. Please login first." }), {
        status: 403, headers: jsonHeaders,
      });
    }

    // Check session expiry
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ success: false, error: "Broker session expired. Please reconnect." }), {
        status: 403, headers: jsonHeaders,
      });
    }

    // Call Kotak Neo Order Placement API
    // POST https://gw-napi.kotaksecurities.com/Orders/2.0/quick/order/rule/ms/place
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
            am: "NO", // after market
            dq: "0", // disclosed qty
            es: optionType === "CE" || optionType === "PE" ? "nse_fo" : "nse_cm",
            mp: "0",
            pc: product || "MIS",
            pf: "N",
            pr: "0", // market order price = 0
            pt: orderType || "MKT",
            qt: String(quantity),
            rt: "DAY",
            tp: "0",
            ts: symbol,
            tt: transactionType || "B",
            // Additional fields for options
            st: String(strike),
            ot: optionType,
          }),
        }
      );

      const kotakData = await kotakResponse.json();

      if (kotakResponse.ok && kotakData?.nOrdNo) {
        // Success - return broker order ID
        // Persist the trade
        await adminClient.from("trades").insert({
          user_id: userId,
          order_id: kotakData.nOrdNo,
          symbol,
          strike,
          option_type: optionType,
          quantity,
          entry_price: 0, // Will be updated with actual fill price
          status: "open",
          is_paper: false,
        });

        return new Response(JSON.stringify({
          success: true,
          orderId: kotakData.nOrdNo,
          message: `Order placed: ${symbol} ${strike} ${optionType} Qty ${quantity}`,
        }), { headers: jsonHeaders });
      } else {
        // Broker rejected the order
        const errorMsg = kotakData?.errMsg || kotakData?.message || "Order rejected by broker";
        return new Response(JSON.stringify({ success: false, error: errorMsg }), {
          status: 400, headers: jsonHeaders,
        });
      }
    } catch (brokerErr) {
      console.error("Kotak API error:", brokerErr);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to connect to broker API. Please try again.",
      }), { status: 502, headers: jsonHeaders });
    }
  } catch (error) {
    console.error("Order endpoint error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500, headers: jsonHeaders,
    });
  }
});
