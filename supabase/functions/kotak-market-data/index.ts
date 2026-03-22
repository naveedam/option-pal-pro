import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_API_BASE = "https://gw-napi.kotaksecurities.com";

// ─── Retry with backoff (handles 503) ─────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelay = 500,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Request] ${options.method || "GET"} ${url} (attempt ${attempt + 1})`);
      const res = await fetch(url, options);
      if ([502, 503, 504, 522].includes(res.status) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        const text = await res.text();
        console.log(`[Retry] ${res.status} on attempt ${attempt + 1}, waiting ${delay}ms. Body: ${text.substring(0, 200)}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[Retry] Network error on attempt ${attempt + 1}: ${err.message}, waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError || new Error("Max retries exceeded");
}

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// ─── Kotak POST-based Quote API with endpoint fallback ───────────────
const QUOTE_ENDPOINTS = [
  "/apimarketdata/instruments/quote",
  "/apimarketdata/quote",
  "/apimarketdata/instruments/quotes",
];

async function fetchQuote(accessToken: string, instrumentToken: string): Promise<any> {
  for (const endpoint of QUOTE_ENDPOINTS) {
    const url = `${KOTAK_API_BASE}${endpoint}`;
    console.log(`[Quote] Trying: POST ${url}`);

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: buildHeaders(accessToken),
      body: JSON.stringify({ instrumentToken }),
    }, 2, 1000);

    if (res.status === 404) {
      const text = await res.text();
      console.log(`[Quote] 404 on ${endpoint}, trying next. Body: ${text.substring(0, 200)}`);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Quote] Error ${res.status} on ${endpoint}: ${text.substring(0, 500)}`);
      if (res.status === 401) {
        return { __error: "SESSION_EXPIRED", __message: "Session expired — please reconnect broker" };
      }
      throw new Error(`Kotak Quote API error (${res.status}): ${text.substring(0, 200)}`);
    }

    const data = await res.json();
    console.log(`[Quote] Success on ${endpoint} for ${instrumentToken}: keys=${Object.keys(data).join(",")}`);
    return data;
  }

  throw new Error("All quote endpoints returned 404 — Kotak API may have changed");
}

// ─── Kotak POST-based Option Chain API ───────────────────────────────
async function fetchOptionChain(
  accessToken: string,
  instrumentToken: string,
  strikeRange: number,
  atmStrike: number,
): Promise<any> {
  const url = `${KOTAK_API_BASE}/apimarketdata/optionchain`;
  const body: any = { instrumentToken };

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify(body),
  }, 3, 1000);

  if (!res.ok) {
    const text = await res.text();
    console.error(`OptionChain API error ${res.status}: ${text.substring(0, 500)}`);
    if (res.status === 401) {
      return { __error: "SESSION_EXPIRED", __message: "Session expired — please reconnect broker" };
    }
    throw new Error(`Kotak OptionChain API error (${res.status}): ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  console.log(`OptionChain response: keys=${Object.keys(data).join(",")}`);
  return data;
}

// ─── Build option chain from API response ────────────────────────────
function buildChainFromResponse(data: any, atmStrike: number, strikeRange: number): {
  chain: any[];
  totalCallOI: number;
  totalPutOI: number;
} {
  let totalCallOI = 0;
  let totalPutOI = 0;
  const strikeMap = new Map<number, any>();

  // Try to extract option chain data from various response formats
  const options = data?.result?.optionChainDetails
    || data?.data?.optionChainDetails
    || data?.optionChainDetails
    || data?.result?.dataList
    || data?.data?.dataList
    || data?.result
    || data?.data
    || [];

  const optionList = Array.isArray(options) ? options : [];

  for (const opt of optionList) {
    const strike = parseFloat(opt.strikePrice || opt.strike_price || opt.strike || "0");
    if (strike <= 0) continue;

    // Filter to strike range
    if (Math.abs(strike - atmStrike) > strikeRange * 50) continue;

    if (!strikeMap.has(strike)) {
      strikeMap.set(strike, {
        strike,
        callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
        callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
        callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
        isATM: strike === atmStrike,
      });
    }

    const row = strikeMap.get(strike)!;

    // CE data
    const ce = opt.CE || opt.ce || opt.callOption || opt.call;
    if (ce) {
      row.callLTP = parseFloat(ce.lastTradedPrice || ce.ltp || ce.last_traded_price || "0");
      row.callOI = parseInt(ce.openInterest || ce.oi || ce.open_interest || "0", 10);
      row.callOIChange = parseInt(ce.changeInOpenInterest || ce.change_in_oi || "0", 10);
      row.callVolume = parseInt(ce.totalTradedVolume || ce.volume || ce.v || "0", 10);
      row.callBid = parseFloat(ce.bidPrice || ce.bp || ce.buy_price || "0");
      row.callAsk = parseFloat(ce.askPrice || ce.sp || ce.sell_price || "0");
      totalCallOI += row.callOI;
    }

    // PE data
    const pe = opt.PE || opt.pe || opt.putOption || opt.put;
    if (pe) {
      row.putLTP = parseFloat(pe.lastTradedPrice || pe.ltp || pe.last_traded_price || "0");
      row.putOI = parseInt(pe.openInterest || pe.oi || pe.open_interest || "0", 10);
      row.putOIChange = parseInt(pe.changeInOpenInterest || pe.change_in_oi || "0", 10);
      row.putVolume = parseInt(pe.totalTradedVolume || pe.volume || pe.v || "0", 10);
      row.putBid = parseFloat(pe.bidPrice || pe.bp || pe.buy_price || "0");
      row.putAsk = parseFloat(pe.askPrice || pe.sp || pe.sell_price || "0");
      totalPutOI += row.putOI;
    }
  }

  const chain = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
  return { chain, totalCallOI, totalPutOI };
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

    const { data: session } = await adminClient
      .from("broker_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session?.access_token) {
      return new Response(
        JSON.stringify({ success: false, error: "Broker not connected — please login first", code: "NO_SESSION" }),
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

    const body = await req.json();
    const { strikeRange = 10 } = body;
    const accessToken = session.access_token;

    // Step 1: Fetch NIFTY spot price via quotes API
    const niftyInstrumentToken = "26000"; // NIFTY 50 index token
    console.log("Fetching NIFTY spot quote...");

    let niftySpot = 0;
    let niftyChange = 0;

    try {
      const quoteData = await fetchQuote(accessToken, niftyInstrumentToken);

      if (quoteData?.__error === "SESSION_EXPIRED") {
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);
        return new Response(
          JSON.stringify({ success: false, error: quoteData.__message, code: "SESSION_EXPIRED" }),
          { status: 200, headers }
        );
      }

      // Extract spot from various response structures
      const quote = quoteData?.result?.listQuotes?.[0]
        || quoteData?.data?.listQuotes?.[0]
        || quoteData?.result?.[0]
        || quoteData?.data?.[0]
        || quoteData?.result
        || quoteData?.data
        || quoteData;

      console.log("Quote data structure:", JSON.stringify(quote).substring(0, 500));

      niftySpot = parseFloat(
        quote?.lastTradedPrice || quote?.ltp || quote?.last_traded_price
        || quote?.LastTradedPrice || quote?.LTP || "0"
      );
      niftyChange = parseFloat(
        quote?.percentChange || quote?.change || quote?.netChange
        || quote?.PercentChange || quote?.Change || "0"
      );

      console.log(`NIFTY spot: ${niftySpot}, change: ${niftyChange}`);
    } catch (err: any) {
      console.error("Spot price fetch failed:", err.message);
      return new Response(
        JSON.stringify({ success: false, error: `Kotak API unavailable: ${err.message}`, code: "KOTAK_API_ERROR" }),
        { status: 200, headers }
      );
    }

    if (niftySpot <= 0) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          niftySpot: 0, sensexSpot: 0, niftyChange: 0, sensexChange: 0,
          niftyPCR: 0, sensexPCR: 0, niftyATM: 0, sensexATM: 0,
          niftyChain: [], sensexChain: [], timestamp: Date.now(),
        }
      }), { headers });
    }

    // Step 2: Fetch option chain via dedicated API
    const atmStrike = Math.round(niftySpot / 50) * 50;
    let niftyChain: any[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;

    try {
      console.log("Fetching NIFTY option chain...");
      const chainData = await fetchOptionChain(accessToken, niftyInstrumentToken, strikeRange, atmStrike);

      if (chainData?.__error === "SESSION_EXPIRED") {
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);
        return new Response(
          JSON.stringify({ success: false, error: chainData.__message, code: "SESSION_EXPIRED" }),
          { status: 200, headers }
        );
      }

      console.log("OptionChain raw response:", JSON.stringify(chainData).substring(0, 1000));

      const result = buildChainFromResponse(chainData, atmStrike, strikeRange);
      niftyChain = result.chain;
      totalCallOI = result.totalCallOI;
      totalPutOI = result.totalPutOI;

      console.log(`Built option chain: ${niftyChain.length} strikes, callOI: ${totalCallOI}, putOI: ${totalPutOI}`);
    } catch (err: any) {
      console.error("Option chain fetch failed:", err.message);
      // Build empty chain shell so UI doesn't break
      for (let i = -strikeRange; i <= strikeRange; i++) {
        const strike = atmStrike + i * 50;
        niftyChain.push({
          strike, callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
          callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
          callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
          isATM: strike === atmStrike,
        });
      }
    }

    const niftyPCR = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    return new Response(JSON.stringify({
      success: true,
      data: {
        niftySpot, sensexSpot: 0, niftyChange, sensexChange: 0,
        niftyPCR, sensexPCR: 0, niftyATM: atmStrike, sensexATM: 0,
        niftyChain, sensexChain: [], timestamp: Date.now(),
      }
    }), { headers });

  } catch (error) {
    console.error("Market data error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Internal server error", code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});
