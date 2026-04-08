import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── SDK-aligned config (from neo_api_client/urls.py & settings.py) ──
const FALLBACK_BASE = "https://gw-napi.kotaksecurities.com";

// SDK quote path: GET /script-details/1.0/quotes/neosymbol/{neo_symbols}/{quote_type}
// neo_symbols = comma-separated list of "exchange_segment|instrument_token" pairs
// quote_type = LTP, OHLC, ALL etc.
const QUOTES_PATH = "script-details/1.0/quotes/neosymbol";
const SCRIP_MASTER_PATH = "script-details/1.0/masterscrip/file-paths";

// ─── Instrument mapping (SDK uses string names for indices) ──────────
const INSTRUMENT_NEO_SYMBOLS: Record<string, string> = {
  NIFTY:     "nse_cm|Nifty 50",
  BANKNIFTY: "nse_cm|Nifty Bank",
  SENSEX:    "bse_cm|SENSEX",
};

// ─── Retry with backoff ─────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
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

// ─── SDK-aligned quote fetch (GET) ──────────────────────────────────
// URL: {base}/script-details/1.0/quotes/neosymbol/{neo_symbols}/{quote_type}
// neo_symbols format: "exchange_segment|token" comma-separated, URL-encoded
async function fetchQuotesSDK(
  baseUrl: string,
  accessToken: string,
  sid: string,
  consumerKey: string,
  neoSymbols: string[], // e.g. ["nse_cm|Nifty 50"]
  quoteType: string = "LTP",
): Promise<{ data: any; error: string | null; details: any }> {
  const symbolsParam = encodeURIComponent(neoSymbols.join(","));
  const url = `${baseUrl}/${QUOTES_PATH}/${symbolsParam}/${quoteType}`;

  console.log(`[Quotes] GET ${url}`);
  console.log(`[Quotes] Token present: ${!!accessToken}, SID present: ${!!sid}, ConsumerKey present: ${!!consumerKey}`);
  console.log(`[Quotes] neo_symbols: ${neoSymbols.join(",")}`);

  try {
    // Kotak Neo API expects: Authorization = consumer_key, Auth = access_token
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        "Authorization": consumerKey,
        "Auth": accessToken,
        "neo-fin-key": "neotradeapi",
        "sid": sid,
      },
    }, 2, 1000);

    const text = await res.text();
    console.log(`[Quotes] Response ${res.status}: ${text.substring(0, 500)}`);

    if (res.status === 401 || res.status === 403) {
      return { data: null, error: "SESSION_EXPIRED", details: text.substring(0, 300) };
    }

    if (!res.ok) {
      return {
        data: null,
        error: `QUOTE_API_ERROR`,
        details: { status: res.status, body: text.substring(0, 300), url },
      };
    }

    try {
      const data = JSON.parse(text);
      
      // Check for API-level errors
      if (data?.fault) {
        return { data: null, error: "QUOTE_FAULT", details: data.fault };
      }
      if (data?.stat === "Not_Ok") {
        return { data: null, error: "QUOTE_REJECTED", details: data?.emsg || data };
      }

      return { data, error: null, details: null };
    } catch {
      return { data: null, error: "INVALID_JSON", details: text.substring(0, 200) };
    }
  } catch (err: any) {
    return { data: null, error: "NETWORK_ERROR", details: err.message };
  }
}

// ─── Parse spot price from SDK quote response ───────────────────────
function parseSpotFromQuote(quoteData: any): { spot: number; change: number } {
  // SDK returns various shapes: { message: [...] }, { data: [...] }, or direct object
  const msg = quoteData?.message?.[0] || quoteData?.data?.[0] || quoteData?.message || quoteData;
  const spot = parseFloat(
    msg?.last_traded_price || msg?.ltp || msg?.LastTradedPrice || "0"
  );
  const change = parseFloat(
    msg?.percentage_change || msg?.change || msg?.percentChange || "0"
  );
  return { spot, change };
}

// ─── Fetch Scrip Master CSV file paths ──────────────────────────────
async function fetchScripMasterPaths(baseUrl: string, accessToken: string, sid: string, consumerKey: string): Promise<any> {
  const url = `${baseUrl}/${SCRIP_MASTER_PATH}`;
  console.log(`[ScripMaster] GET ${url}`);

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "Authorization": consumerKey,
      "Auth": accessToken,
      "neo-fin-key": "neotradeapi",
      "sid": sid,
    },
  }, 2, 1000);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[ScripMaster] Error ${res.status}: ${text.substring(0, 500)}`);
    throw new Error(`Scrip master API error (${res.status})`);
  }

  return res.json();
}

// ─── Download and parse scrip master CSV for NIFTY options ──────────
async function fetchNiftyOptionTokens(
  baseUrl: string,
  accessToken: string,
  sid: string,
  consumerKey: string,
  atmStrike: number,
  strikeRange: number,
): Promise<Array<{ neo_symbol: string; strike: number; optionType: string }>> {
  try {
    const pathsData = await fetchScripMasterPaths(baseUrl, accessToken, sid, consumerKey);
    console.log(`[ScripMaster] Response keys: ${JSON.stringify(Object.keys(pathsData))}`);

    const fileList = pathsData?.filesPaths || pathsData?.data?.filesPaths || pathsData?.result || [];
    let nfoUrl = "";

    if (Array.isArray(fileList)) {
      for (const item of fileList) {
        const path = item?.path || item?.filePath || item?.url || "";
        if (typeof path === "string" && path.includes("nse_fo")) {
          nfoUrl = path;
          break;
        }
      }
    }

    if (!nfoUrl) {
      console.log("[ScripMaster] nse_fo CSV URL not found in response:", JSON.stringify(pathsData).substring(0, 500));
      return [];
    }

    console.log(`[ScripMaster] Downloading nse_fo CSV from: ${nfoUrl}`);
    const csvRes = await fetch(nfoUrl);
    if (!csvRes.ok) {
      console.error(`[ScripMaster] CSV download failed: ${csvRes.status}`);
      return [];
    }

    const csvText = await csvRes.text();
    const lines = csvText.split("\n");
    console.log(`[ScripMaster] CSV lines: ${lines.length}`);

    const tokens: Array<{ neo_symbol: string; strike: number; optionType: string }> = [];
    const header = lines[0]?.toLowerCase() || "";
    const headers = header.split(",");

    const tokenIdx = headers.findIndex(h => h.includes("token") || h.includes("instrument_token") || h.includes("psymbol"));
    const symbolIdx = headers.findIndex(h => h.includes("symbol") || h.includes("trading_symbol") || h.includes("ptrdsymbol"));
    const strikeIdx = headers.findIndex(h => h.includes("strike") || h.includes("strike_price") || h.includes("dstrikeprice"));
    const optTypeIdx = headers.findIndex(h => h.includes("option") || h.includes("optiontype") || h.includes("poptiontype"));
    const expiryIdx = headers.findIndex(h => h.includes("expiry") || h.includes("pexpirydate") || h.includes("dexpiry"));

    console.log(`[ScripMaster] Column indices — token:${tokenIdx} symbol:${symbolIdx} strike:${strikeIdx} optType:${optTypeIdx} expiry:${expiryIdx}`);

    if (tokenIdx < 0) {
      console.log(`[ScripMaster] Headers: ${headers.slice(0, 15).join(", ")}`);
      return [];
    }

    const minStrike = atmStrike - strikeRange * 50;
    const maxStrike = atmStrike + strikeRange * 50;
    let nearestExpiry = "";

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < Math.max(tokenIdx, symbolIdx, strikeIdx) + 1) continue;

      const symbol = cols[symbolIdx]?.trim().toUpperCase() || "";
      if (!symbol.includes("NIFTY") || symbol.includes("BANKNIFTY") || symbol.includes("FINNIFTY")) continue;

      const strike = parseFloat(cols[strikeIdx] || "0");
      const normalizedStrike = strike > 100000 ? strike / 100 : strike;
      if (normalizedStrike < minStrike || normalizedStrike > maxStrike) continue;

      const optType = cols[optTypeIdx]?.trim().toUpperCase() || "";
      if (optType !== "CE" && optType !== "PE") continue;

      const expiry = cols[expiryIdx]?.trim() || "";
      if (!nearestExpiry && expiry) nearestExpiry = expiry;

      if (expiry === nearestExpiry) {
        // SDK neo_symbol format: "exchange_segment|instrument_token"
        tokens.push({
          neo_symbol: `nse_fo|${cols[tokenIdx].trim()}`,
          strike: normalizedStrike,
          optionType: optType,
        });
      }
    }

    console.log(`[ScripMaster] Found ${tokens.length} NIFTY option tokens near ATM ${atmStrike} (expiry: ${nearestExpiry})`);
    return tokens;
  } catch (err: any) {
    console.error(`[ScripMaster] Error: ${err.message}`);
    return [];
  }
}

// ─── Build option chain from SDK quotes ─────────────────────────────
async function buildOptionChain(
  baseUrl: string,
  accessToken: string,
  sid: string,
  consumerKey: string,
  optionTokens: Array<{ neo_symbol: string; strike: number; optionType: string }>,
  atmStrike: number,
): Promise<{ chain: any[]; totalCallOI: number; totalPutOI: number }> {
  const strikeMap = new Map<number, any>();
  let totalCallOI = 0;
  let totalPutOI = 0;

  if (optionTokens.length === 0) {
    return { chain: [], totalCallOI: 0, totalPutOI: 0 };
  }

  // Fetch quotes in batches of 20
  const BATCH_SIZE = 20;
  for (let i = 0; i < optionTokens.length; i += BATCH_SIZE) {
    const batch = optionTokens.slice(i, i + BATCH_SIZE);
    const neoSymbols = batch.map(t => t.neo_symbol);

    try {
      const { data: quotesData, error } = await fetchQuotesSDK(baseUrl, accessToken, sid, neoSymbols, "ALL");
      if (error === "SESSION_EXPIRED") return { chain: [], totalCallOI: 0, totalPutOI: 0 };
      if (error || !quotesData) continue;

      const quotesList = quotesData?.message || quotesData?.data || quotesData?.result || [];
      const quotesArray = Array.isArray(quotesList) ? quotesList : [quotesList];

      for (let j = 0; j < batch.length && j < quotesArray.length; j++) {
        const quote = quotesArray[j];
        const tokenInfo = batch[j];
        const strike = tokenInfo.strike;

        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, {
            strike, callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
            callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
            callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
            isATM: strike === atmStrike,
          });
        }

        const row = strikeMap.get(strike)!;
        const ltp = parseFloat(quote?.last_traded_price || quote?.ltp || "0");
        const oi = parseInt(quote?.open_interest || quote?.oi || "0", 10);
        const oiChange = parseInt(quote?.change_in_oi || "0", 10);
        const vol = parseInt(quote?.volume || "0", 10);
        const bid = parseFloat(quote?.best_bid_price || quote?.bp || "0");
        const ask = parseFloat(quote?.best_ask_price || quote?.sp || "0");

        if (tokenInfo.optionType === "CE") {
          row.callLTP = ltp; row.callOI = oi; row.callOIChange = oiChange;
          row.callVolume = vol; row.callBid = bid; row.callAsk = ask;
          totalCallOI += oi;
        } else {
          row.putLTP = ltp; row.putOI = oi; row.putOIChange = oiChange;
          row.putVolume = vol; row.putBid = bid; row.putAsk = ask;
          totalPutOI += oi;
        }
      }
    } catch (err: any) {
      console.error(`[OptionChain] Batch quote error: ${err.message}`);
    }
  }

  const chain = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
  return { chain, totalCallOI, totalPutOI };
}

// ─── Empty chain helper ─────────────────────────────────────────────
function emptyChain(atmStrike: number, strikeRange: number): any[] {
  const chain: any[] = [];
  for (let i = -strikeRange; i <= strikeRange; i++) {
    const strike = atmStrike + i * 50;
    chain.push({
      strike, callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
      callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
      callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
      isATM: strike === atmStrike,
    });
  }
  return chain;
}

// ─── Main Handler ───────────────────────────────────────────────────
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
        JSON.stringify({ success: false, error: "MARKET_DATA_UNAVAILABLE", code: "NO_SESSION" }),
        { status: 200, headers }
      );
    }

    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await adminClient.from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return new Response(
        JSON.stringify({ success: false, error: "SESSION_EXPIRED", code: "SESSION_EXPIRED" }),
        { status: 200, headers }
      );
    }

    const body = await req.json();
    const { strikeRange = 10, validateOnly = false, symbol = "NIFTY" } = body;

    const baseUrl = (session.base_url || FALLBACK_BASE).replace(/\/$/, "");
    const accessToken = session.access_token;
    const sid = session.session_token || "";
    const consumerKey = session.consumer_key || "";

    console.log(`[MarketData] baseUrl=${baseUrl} token=${!!accessToken} sid=${!!sid} consumerKey=${!!consumerKey}`);

    // ─── Step 1: Fetch spot price via SDK-aligned quote ─────────
    const symbolKey = symbol?.toUpperCase() || "NIFTY";
    const neoSymbol = INSTRUMENT_NEO_SYMBOLS[symbolKey];

    if (!neoSymbol) {
      return new Response(
        JSON.stringify({ success: false, error: "INVALID_SYMBOL", code: "INVALID_SYMBOL" }),
        { status: 200, headers }
      );
    }

    console.log(`[MarketData] Fetching quote for ${symbolKey} → ${neoSymbol}`);

    const quoteResult = await fetchQuotesSDK(baseUrl, accessToken, sid, consumerKey, [neoSymbol], "LTP");

    if (quoteResult.error === "SESSION_EXPIRED") {
      await adminClient.from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return new Response(
        JSON.stringify({ success: false, error: "SESSION_EXPIRED", code: "SESSION_EXPIRED" }),
        { status: 200, headers }
      );
    }

    let niftySpot = 0;
    let niftyChange = 0;

    if (quoteResult.error || !quoteResult.data) {
      console.error(`[MarketData] Quote failed: ${quoteResult.error}`, quoteResult.details);

      if (validateOnly) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "MARKET_DATA_UNAVAILABLE",
            code: "MARKET_VALIDATION_FAILED",
            details: { quoteError: quoteResult.error, quoteDetails: quoteResult.details },
            validation: { auth: "connected", marketData: "disconnected", trading: "connected", symbol: symbolKey, quote: 0 },
          }),
          { headers }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: "MARKET_DATA_UNAVAILABLE", code: "MARKET_DATA_UNAVAILABLE", details: quoteResult.details }),
        { status: 200, headers }
      );
    }

    const parsed = parseSpotFromQuote(quoteResult.data);
    niftySpot = parsed.spot;
    niftyChange = parsed.change;
    console.log(`[MarketData] ${symbolKey} spot=${niftySpot} change=${niftyChange}`);

    if (validateOnly) {
      const marketDataState = niftySpot > 0 ? "connected" : "disconnected";
      console.log(`[MarketValidation] result=${marketDataState} symbol=${symbolKey} quote=${niftySpot}`);
      return new Response(
        JSON.stringify({
          success: niftySpot > 0,
          validation: { auth: "connected", marketData: marketDataState, trading: "connected", symbol: symbolKey, quote: niftySpot },
          error: niftySpot > 0 ? null : "MARKET_DATA_UNAVAILABLE",
          code: niftySpot > 0 ? "VALIDATION_OK" : "MARKET_VALIDATION_FAILED",
        }),
        { headers }
      );
    }

    if (niftySpot <= 0) {
      return new Response(JSON.stringify({
        success: true,
        data: { niftySpot: 0, sensexSpot: 0, niftyChange: 0, sensexChange: 0, niftyPCR: 0, sensexPCR: 0, niftyATM: 0, sensexATM: 0, niftyChain: [], sensexChain: [], timestamp: Date.now() }
      }), { headers });
    }

    // ─── Step 2: Build option chain ─────────────────────────────
    const atmStrike = Math.round(niftySpot / 50) * 50;
    let niftyChain: any[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;

    try {
      console.log(`[MarketData] Building option chain, ATM: ${atmStrike}, range: ${strikeRange}`);
      const optionTokens = await fetchNiftyOptionTokens(baseUrl, accessToken, sid, atmStrike, strikeRange);

      if (optionTokens.length > 0) {
        const result = await buildOptionChain(baseUrl, accessToken, sid, optionTokens, atmStrike);
        niftyChain = result.chain;
        totalCallOI = result.totalCallOI;
        totalPutOI = result.totalPutOI;
        console.log(`[MarketData] Option chain: ${niftyChain.length} strikes`);
      } else {
        niftyChain = emptyChain(atmStrike, strikeRange);
      }
    } catch (err: any) {
      console.error(`[MarketData] Option chain error: ${err.message}`);
      niftyChain = emptyChain(atmStrike, strikeRange);
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
