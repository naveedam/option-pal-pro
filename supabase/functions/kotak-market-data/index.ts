import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_GW_NAPI = "https://gw-napi.kotaksecurities.com";

interface QuoteRequest {
  instruments: string[];
  strikeRange?: number;
}

const INSTRUMENT_CONFIG: Record<string, { token: string; exchange: string; stepSize: number }> = {
  NIFTY:  { token: "26000", exchange: "nse_cm", stepSize: 50 },
  SENSEX: { token: "1",     exchange: "bse_cm", stepSize: 100 },
};

/**
 * Kotak Neo SDK v2 header format:
 * - Authorization: Bearer <consumer_key>  (API gateway auth)
 * - Auth: <trade_token>                   (session token from login)
 * - sid: <session_id>
 * - neo-fin-key: "neotradeapi"
 */
async function kotakFetch(
  url: string,
  session: { access_token: string; session_token: string; consumer_key: string },
  method: string = "GET",
  body?: string
): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const kotakHeaders: Record<string, string> = {
    "Authorization": `Bearer ${session.consumer_key}`,
    "Auth": session.access_token,
    "sid": session.session_token,
    "neo-fin-key": "neotradeapi",
    "Content-Type": "application/json",
  };

  const response = await fetch(url, { method, headers: kotakHeaders, ...(body ? { body } : {}) });
  const raw = await response.text();

  if (response.status === 401) {
    // Single retry with same credentials
    console.warn("Kotak 401 — retrying once...");
    const retry = await fetch(url, { method, headers: kotakHeaders, ...(body ? { body } : {}) });
    const retryRaw = await retry.text();
    if (retry.status === 401) {
      return { ok: false, status: 401, data: null, raw: retryRaw };
    }
    let retryData: any;
    try { retryData = JSON.parse(retryRaw); } catch { retryData = retryRaw; }
    return { ok: retry.ok, status: retry.status, data: retryData, raw: retryRaw };
  }

  let data: any;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { ok: response.ok, status: response.status, data, raw };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: session, error: sessionError } = await adminClient
      .from("broker_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session?.access_token || !session?.session_token) {
      return new Response(
        JSON.stringify({ success: false, error: "Broker not connected — please login first", code: "NO_SESSION" }),
        { status: 200, headers }
      );
    }

    if (!session.consumer_key) {
      return new Response(
        JSON.stringify({ success: false, error: "Consumer key missing — please reconnect broker", code: "NO_SESSION" }),
        { status: 200, headers }
      );
    }

    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await adminClient.from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return new Response(
        JSON.stringify({ success: false, error: "Session expired — please reconnect broker", code: "SESSION_EXPIRED" }),
        { status: 200, headers }
      );
    }

    const body: QuoteRequest = await req.json();
    const { instruments = ["NIFTY", "SENSEX"], strikeRange = 10 } = body;

    const sessionCreds = {
      access_token: session.access_token,
      session_token: session.session_token,
      consumer_key: session.consumer_key,
    };

    const result: Record<string, any> = { timestamp: Date.now() };

    for (const instrument of instruments) {
      const config = INSTRUMENT_CONFIG[instrument];
      if (!config) continue;

      const key = instrument.toLowerCase();
      const neoSymbol = `${config.exchange}|${config.token}`;
      const encodedSymbol = encodeURIComponent(neoSymbol);
      const quoteUrl = `${KOTAK_GW_NAPI}/apim/quotes/1.0/quotes/neosymbol/${encodedSymbol}/ltp`;

      console.log(`Fetching ${instrument} LTP: ${quoteUrl}`);

      const response = await kotakFetch(quoteUrl, sessionCreds);

      if (response.status === 401) {
        // Mark session expired
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);

        return new Response(
          JSON.stringify({
            success: false,
            error: "Session expired — please reconnect broker",
            code: "SESSION_EXPIRED",
          }),
          { status: 200, headers }
        );
      }

      if (!response.ok) {
        console.error(`Kotak API error for ${instrument}: ${response.status}`);
        // Return debug info on first instrument failure
        if (instrument === instruments[0]) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `Kotak API error (${response.status})`,
              code: "KOTAK_API_ERROR",
              status: response.status,
              raw: response.raw.substring(0, 300),
            }),
            { status: 200, headers }
          );
        }
        result[`${key}Spot`] = 0;
        result[`${key}Change`] = 0;
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = 0;
        result[`${key}PCR`] = 0;
        continue;
      }

      const spotData = response.data;
      const quote = spotData?.message?.[0] || spotData?.data?.[0] || spotData;
      const spotPrice = parseFloat(quote?.last_traded_price || quote?.ltp || quote?.iv || "0");
      const change = parseFloat(quote?.change || quote?.cng || "0");

      result[`${key}Spot`] = spotPrice;
      result[`${key}Change`] = change;

      if (spotPrice <= 0) {
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = 0;
        result[`${key}PCR`] = 0;
        continue;
      }

      const atmStrike = Math.round(spotPrice / config.stepSize) * config.stepSize;
      const chain: any[] = [];
      for (let i = -strikeRange; i <= strikeRange; i++) {
        const strike = atmStrike + i * config.stepSize;
        chain.push({
          strike, callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
          callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
          callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
          isATM: strike === atmStrike,
        });
      }
      chain.sort((a, b) => a.strike - b.strike);

      result[`${key}Chain`] = chain;
      result[`${key}ATM`] = atmStrike;

      const totalCallOI = chain.reduce((s: number, o: any) => s + (o.callOI || 0), 0);
      const totalPutOI = chain.reduce((s: number, o: any) => s + (o.putOI || 0), 0);
      result[`${key}PCR`] = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;
    }

    return new Response(JSON.stringify({ success: true, data: result }), { headers });

  } catch (error) {
    console.error("Market data error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Internal server error", code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});
