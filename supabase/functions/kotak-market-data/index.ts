import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── SDK-aligned URL config ──────────────────────────────────────────
// From Kotak Neo SDK v2: neo_api_client/urls.py & settings.py
const FALLBACK_BASE = "https://gw-napi.kotaksecurities.com";

// PROD_URL from SDK settings.py
const QUOTES_PATH = "script-details/1.0/quotes/neosymbol/{neo_symbols}/{quote_type}";
const SCRIP_MASTER_PATH = "script-details/1.0/masterscrip/file-paths";

// ─── Retry with backoff ──────────────────────────────────────────────
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

// ─── Instrument Token Mapping ────────────────────────────────────────
// Kotak APIs use numeric instrument tokens, not string names
const INSTRUMENT_MAP: Record<string, { token: number; segment: string }> = {
  NIFTY:     { token: 26000, segment: "nse_cm" },
  BANKNIFTY: { token: 26009, segment: "nse_cm" },
  SENSEX:    { token: 1,     segment: "bse_cm" },
};

// String fallbacks (some Kotak API versions accept these)
const INSTRUMENT_STRING_MAP: Record<string, string> = {
  NIFTY: "Nifty 50",
  BANKNIFTY: "Nifty Bank",
  SENSEX: "SENSEX",
};

// ─── Quote Fetch (POST with instrumentTokens array) ─────────────────
// Kotak market data API expects POST with { instrumentTokens, quoteType, productType }
// Auth: Bearer access_token + neo-fin-key + sid headers
async function fetchQuotes(
  baseUrl: string,
  accessToken: string,
  sid: string,
  instrumentTokens: Array<{ instrument_token: string; exchange_segment: string }>,
  quoteType: string = "LTP",
): Promise<any> {
  // Build instrumentTokens array as strings: ["26000", "26009"]
  const tokenStrings = instrumentTokens.map(t => String(t.instrument_token));
  
  const requestBody = {
    instrumentTokens: tokenStrings,
    quoteType: quoteType.toUpperCase(),
    productType: "CASH",
  };

  // Try multiple endpoint paths
  const endpoints = [
    `${baseUrl}/apimarketdata/instruments/quote`,
    `${baseUrl}/apimarketdata/quote`,
  ];

  console.log(`[Quotes] Request body: ${JSON.stringify(requestBody)}`);
  console.log(`[Quotes] Token present: ${!!accessToken}, SID present: ${!!sid}`);

  let lastError: string = "";

  for (const url of endpoints) {
    console.log(`[Quotes] POST ${url}`);

    try {
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "neo-fin-key": "neotradeapi",
          "sid": sid,
        },
        body: JSON.stringify(requestBody),
      }, 2, 1000);

      if (res.status === 401 || res.status === 403) {
        const text = await res.text();
        console.error(`[Quotes] Auth error ${res.status}: ${text.substring(0, 300)}`);
        return { __error: "SESSION_EXPIRED", __message: "Session expired — please reconnect broker" };
      }

      if (res.status === 404) {
        lastError = `404 on ${url}`;
        console.log(`[Quotes] 404 on ${url}, trying next endpoint...`);
        continue;
      }

      const text = await res.text();
      console.log(`[Quotes] Response ${res.status}: ${text.substring(0, 500)}`);

      if (!res.ok) {
        lastError = `${res.status}: ${text.substring(0, 200)}`;
        console.error(`[Quotes] Error ${res.status}: ${text.substring(0, 500)}`);
        continue;
      }

      try {
        const data = JSON.parse(text);
        console.log(`[Quotes] Success, keys: ${JSON.stringify(Object.keys(data))}`);
        return data;
      } catch {
        console.error(`[Quotes] Invalid JSON response: ${text.substring(0, 200)}`);
        continue;
      }
    } catch (err: any) {
      lastError = err.message;
      console.error(`[Quotes] Network error on ${url}: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All quote endpoints failed. Last error: ${lastError}`);
}

// ─── Fetch Scrip Master CSV file paths ───────────────────────────────
async function fetchScripMasterPaths(baseUrl: string, consumerKey: string): Promise<any> {
  const url = `${baseUrl}/${SCRIP_MASTER_PATH}`;
  console.log(`[ScripMaster] GET ${url}`);

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "Authorization": consumerKey,
    },
  }, 2, 1000);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[ScripMaster] Error ${res.status}: ${text.substring(0, 500)}`);
    throw new Error(`Scrip master API error (${res.status})`);
  }

  return res.json();
}

// ─── Download and parse scrip master CSV for NIFTY options ───────────
async function fetchNiftyOptionTokens(
  baseUrl: string,
  consumerKey: string,
  atmStrike: number,
  strikeRange: number,
): Promise<Array<{ instrument_token: string; exchange_segment: string; strike: number; optionType: string }>> {
  try {
    // Get scrip master file paths
    const pathsData = await fetchScripMasterPaths(baseUrl, consumerKey);
    console.log(`[ScripMaster] Response keys: ${JSON.stringify(Object.keys(pathsData))}`);

    // Find nse_fo CSV URL
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

    // Parse CSV to find NIFTY options near ATM
    // CSV format varies — look for NIFTY rows with strike info
    const tokens: Array<{ instrument_token: string; exchange_segment: string; strike: number; optionType: string }> = [];
    const header = lines[0]?.toLowerCase() || "";
    const headers = header.split(",");

    // Find column indices
    const tokenIdx = headers.findIndex(h => h.includes("token") || h.includes("instrument_token") || h.includes("pSymbol"));
    const symbolIdx = headers.findIndex(h => h.includes("symbol") || h.includes("trading_symbol") || h.includes("pTrdSymbol"));
    const strikeIdx = headers.findIndex(h => h.includes("strike") || h.includes("strike_price") || h.includes("dStrikePrice"));
    const optTypeIdx = headers.findIndex(h => h.includes("option") || h.includes("optiontype") || h.includes("pOptionType"));
    const expiryIdx = headers.findIndex(h => h.includes("expiry") || h.includes("pExpiryDate") || h.includes("dExpiry"));

    console.log(`[ScripMaster] Column indices — token:${tokenIdx} symbol:${symbolIdx} strike:${strikeIdx} optType:${optTypeIdx} expiry:${expiryIdx}`);

    if (tokenIdx < 0) {
      // Try alternate format: fixed column positions for Kotak scrip master
      // Kotak CSV: pSymbol, pGroup, pExchSeg, pInstType, pSymbolName, pTrdSymbol, pOptionType, dStrikePrice, ...
      console.log(`[ScripMaster] Headers: ${headers.slice(0, 15).join(", ")}`);
      return [];
    }

    // Find the nearest expiry for NIFTY options
    const today = new Date();
    let nearestExpiry = "";
    const minStrike = atmStrike - strikeRange * 50;
    const maxStrike = atmStrike + strikeRange * 50;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < Math.max(tokenIdx, symbolIdx, strikeIdx) + 1) continue;

      const symbol = cols[symbolIdx]?.trim().toUpperCase() || "";
      if (!symbol.includes("NIFTY") || symbol.includes("BANKNIFTY") || symbol.includes("FINNIFTY")) continue;

      const strike = parseFloat(cols[strikeIdx] || "0");
      // Kotak stores strikes as strike * 100 in some formats
      const normalizedStrike = strike > 100000 ? strike / 100 : strike;
      if (normalizedStrike < minStrike || normalizedStrike > maxStrike) continue;

      const optType = cols[optTypeIdx]?.trim().toUpperCase() || "";
      if (optType !== "CE" && optType !== "PE") continue;

      const expiry = cols[expiryIdx]?.trim() || "";

      // Track nearest expiry
      if (!nearestExpiry && expiry) {
        nearestExpiry = expiry;
      }

      if (expiry === nearestExpiry) {
        tokens.push({
          instrument_token: cols[tokenIdx].trim(),
          exchange_segment: "nse_fo",
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

// ─── Build option chain from batch quotes ────────────────────────────
async function buildOptionChain(
  baseUrl: string,
  consumerKey: string,
  optionTokens: Array<{ instrument_token: string; exchange_segment: string; strike: number; optionType: string }>,
  atmStrike: number,
): Promise<{ chain: any[]; totalCallOI: number; totalPutOI: number }> {
  const strikeMap = new Map<number, any>();
  let totalCallOI = 0;
  let totalPutOI = 0;

  if (optionTokens.length === 0) {
    return { chain: [], totalCallOI: 0, totalPutOI: 0 };
  }

  // Fetch quotes in batches of 20 (SDK limitation)
  const BATCH_SIZE = 20;
  for (let i = 0; i < optionTokens.length; i += BATCH_SIZE) {
    const batch = optionTokens.slice(i, i + BATCH_SIZE);
    const instrumentTokens = batch.map(t => ({
      instrument_token: t.instrument_token,
      exchange_segment: t.exchange_segment,
    }));

    try {
      const quotesData = await fetchQuotes(baseUrl, consumerKey, instrumentTokens, "all");
      if (quotesData?.__error) return { chain: [], totalCallOI: 0, totalPutOI: 0 };

      // Parse quotes response — SDK returns { message: [...] }
      const quotesList = quotesData?.message || quotesData?.data || quotesData?.result || [];
      const quotesArray = Array.isArray(quotesList) ? quotesList : [quotesList];

      for (let j = 0; j < batch.length && j < quotesArray.length; j++) {
        const quote = quotesArray[j];
        const tokenInfo = batch[j];
        const strike = tokenInfo.strike;

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
        const ltp = parseFloat(quote?.last_traded_price || quote?.ltp || quote?.LastTradedPrice || "0");
        const oi = parseInt(quote?.open_interest || quote?.oi || quote?.openInterest || "0", 10);
        const oiChange = parseInt(quote?.change_in_oi || quote?.changeInOpenInterest || "0", 10);
        const vol = parseInt(quote?.volume || quote?.totalTradedVolume || "0", 10);
        const bid = parseFloat(quote?.best_bid_price || quote?.bidPrice || quote?.bp || "0");
        const ask = parseFloat(quote?.best_ask_price || quote?.askPrice || quote?.sp || "0");

        if (tokenInfo.optionType === "CE") {
          row.callLTP = ltp;
          row.callOI = oi;
          row.callOIChange = oiChange;
          row.callVolume = vol;
          row.callBid = bid;
          row.callAsk = ask;
          totalCallOI += oi;
        } else {
          row.putLTP = ltp;
          row.putOI = oi;
          row.putOIChange = oiChange;
          row.putVolume = vol;
          row.putBid = bid;
          row.putAsk = ask;
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

// ─── Main Handler ────────────────────────────────────────────────────
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

    if (!session?.access_token || !session?.consumer_key) {
      console.log(`[MarketData] auth=connected session_missing_credentials user=${user.id}`);
      return new Response(
        JSON.stringify({ success: false, error: "MARKET_DATA_UNAVAILABLE", code: "MARKET_DATA_UNAVAILABLE" }),
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

    // Use base_url from session (set during login) or fallback
    const baseUrl = (session.base_url || FALLBACK_BASE).replace(/\/$/, "");
    const consumerKey = session.consumer_key;

    console.log(`[MarketData] Using base URL: ${baseUrl}`);
    console.log(`[MarketData] Consumer key present: ${!!consumerKey}`);
    console.log(`[MarketValidation] requested=${validateOnly} symbol=${symbol}`);

    // ─── Step 1: Fetch NIFTY spot via quotes API ─────────────────
    // Try numeric token first, then string fallback
    let niftySpot = 0;
    let niftyChange = 0;

    const symbolKey = symbol?.toUpperCase() || "NIFTY";
    const numericMapping = INSTRUMENT_MAP[symbolKey];
    const stringFallback = INSTRUMENT_STRING_MAP[symbolKey];

    if (!numericMapping) {
      console.error(`[MarketData] Unknown symbol: ${symbolKey}`);
      return new Response(
        JSON.stringify({ success: false, error: "INVALID_SYMBOL", code: "INVALID_SYMBOL" }),
        { status: 200, headers }
      );
    }

    try {
      // Attempt 1: numeric instrument token
      console.log(`[MarketData] Trying numeric token: ${numericMapping.token} on ${numericMapping.segment}`);
      let niftyQuote = await fetchQuotes(
        baseUrl,
        consumerKey,
        [{ instrument_token: String(numericMapping.token), exchange_segment: numericMapping.segment }],
        "ltp"
      );

      // If numeric token returns fault, try string fallback
      if (niftyQuote?.fault && stringFallback) {
        console.log(`[MarketData] Numeric token fault, trying string fallback: ${stringFallback}`);
        niftyQuote = await fetchQuotes(
          baseUrl,
          consumerKey,
          [{ instrument_token: stringFallback, exchange_segment: numericMapping.segment }],
          "ltp"
        );
      }

      if (niftyQuote?.__error === "SESSION_EXPIRED") {
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);
        return new Response(
          JSON.stringify({ success: false, error: "SESSION_EXPIRED", code: "SESSION_EXPIRED" }),
          { status: 200, headers }
        );
      }

      // Check for API fault response (invalid symbol, etc.)
      if (niftyQuote?.fault) {
        console.error(`[Quotes] NIFTY fault: ${JSON.stringify(niftyQuote.fault)}`);
        // Return unavailable but don't crash — auth is still valid
        return new Response(
          JSON.stringify({ success: false, error: "MARKET_DATA_UNAVAILABLE", code: "MARKET_DATA_UNAVAILABLE", details: niftyQuote.fault }),
          { status: 200, headers }
        );
      }

      // SDK response format: { message: [{ last_traded_price: "...", ... }] }
      const quoteMsg = niftyQuote?.message?.[0] || niftyQuote?.data?.[0] || niftyQuote;
      console.log("[Quotes] NIFTY quote response:", JSON.stringify(quoteMsg).substring(0, 500));

      niftySpot = parseFloat(
        quoteMsg?.last_traded_price || quoteMsg?.ltp || quoteMsg?.LastTradedPrice || "0"
      );
      niftyChange = parseFloat(
        quoteMsg?.percentage_change || quoteMsg?.change || quoteMsg?.percentChange || "0"
      );

      console.log(`[MarketData] NIFTY spot: ${niftySpot}, change: ${niftyChange}`);
    } catch (err: any) {
      console.log(`[MarketValidation] result=failed error=${err.message}`);
      console.error(`[MarketData] Spot price fetch failed: ${err.message}`);
      return new Response(
          JSON.stringify({ success: false, error: "MARKET_DATA_UNAVAILABLE", code: "MARKET_DATA_UNAVAILABLE" }),
        { status: 200, headers }
      );
    }

    if (validateOnly) {
      const marketDataState = niftySpot > 0 ? "connected" : "disconnected";
      console.log(`[MarketValidation] result=${marketDataState} symbol=${symbol} quote=${niftySpot}`);

      return new Response(
        JSON.stringify({
          success: niftySpot > 0,
          validation: {
            auth: "connected",
            marketData: marketDataState,
            trading: "connected",
            symbol,
            quote: niftySpot,
             error: niftySpot > 0 ? null : "MARKET_DATA_UNAVAILABLE",
          },
           error: niftySpot > 0 ? null : "MARKET_DATA_UNAVAILABLE",
          code: niftySpot > 0 ? "VALIDATION_OK" : "MARKET_VALIDATION_FAILED",
        }),
        { headers },
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

    // ─── Step 2: Build option chain ──────────────────────────────
    const atmStrike = Math.round(niftySpot / 50) * 50;
    let niftyChain: any[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;

    try {
      console.log(`[MarketData] Building option chain, ATM: ${atmStrike}, range: ${strikeRange}`);

      // Fetch NIFTY option instrument tokens from scrip master
      const optionTokens = await fetchNiftyOptionTokens(baseUrl, consumerKey, atmStrike, strikeRange);

      if (optionTokens.length > 0) {
        const result = await buildOptionChain(baseUrl, consumerKey, optionTokens, atmStrike);
        niftyChain = result.chain;
        totalCallOI = result.totalCallOI;
        totalPutOI = result.totalPutOI;
        console.log(`[MarketData] Option chain: ${niftyChain.length} strikes, callOI: ${totalCallOI}, putOI: ${totalPutOI}`);
      } else {
        console.log("[MarketData] No option tokens found, building empty chain");
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
    } catch (err: any) {
      console.error(`[MarketData] Option chain error: ${err.message}`);
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
