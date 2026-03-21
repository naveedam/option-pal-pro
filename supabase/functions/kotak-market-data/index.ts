import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// SDK v2 uses mnapi for data calls (NOT gw-napi)
const KOTAK_DATA_BASE = "https://mnapi.kotaksecurities.com";
const EXPIRY_OFFSET_SECONDS = 315511200; // ~10 year offset in scrip master CSV

interface OptionToken {
  token: string;
  strike: number;
  optionType: "CE" | "PE";
  expiry: string;
  tradingSymbol: string;
}

// In-memory cache for scrip master (persists across requests in same isolate)
let cachedNiftyOptions: OptionToken[] = [];
let cachedDate: string | null = null;

/**
 * SDK v2 header format for data APIs:
 * - Authorization: {consumer_key}  (NO Bearer prefix!)
 * - Content-Type: application/x-www-form-urlencoded
 * That's it. No Auth, no sid, no neo-fin-key for quotes.
 */
function buildDataHeaders(consumerKey: string): Record<string, string> {
  return {
    "Authorization": consumerKey,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function fetchScripMaster(consumerKey: string): Promise<string[]> {
  const url = `${KOTAK_DATA_BASE}/script-details/1.0/masterscrip/file-paths`;
  console.log("Fetching scrip master file paths...");
  const res = await fetch(url, { method: "GET", headers: buildDataHeaders(consumerKey) });
  if (!res.ok) {
    const text = await res.text();
    console.error("Scrip master file-paths failed:", res.status, text.substring(0, 300));
    throw new Error(`Scrip master API error (${res.status})`);
  }
  const data = await res.json();
  return data?.data?.filesPaths || [];
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

async function fetchAndParseNiftyOptions(consumerKey: string, spotPrice: number, strikeRange: number): Promise<OptionToken[]> {
  const today = new Date().toISOString().split("T")[0];
  if (cachedDate === today && cachedNiftyOptions.length > 0) {
    console.log(`Using cached scrip data (${cachedNiftyOptions.length} contracts)`);
    return filterByStrikeRange(cachedNiftyOptions, spotPrice, strikeRange);
  }

  const filePaths = await fetchScripMaster(consumerKey);
  const nfoCsvUrl = filePaths.find((p: string) => p.toLowerCase().includes("nse_fo"));
  if (!nfoCsvUrl) throw new Error("nse_fo CSV not found in scrip master");

  console.log("Downloading nse_fo CSV:", nfoCsvUrl.substring(0, 80));
  const csvRes = await fetch(nfoCsvUrl);
  if (!csvRes.ok) throw new Error(`CSV download failed (${csvRes.status})`);
  const csvText = await csvRes.text();

  const lines = csvText.split("\n");
  if (lines.length < 2) throw new Error("Empty CSV");

  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine).map(h => h.replace(/[;\s]/g, "").toLowerCase());

  const symbolIdx = headers.indexOf("psymbolname");
  const tokenIdx = headers.indexOf("ptoken") !== -1 ? headers.indexOf("ptoken") : headers.indexOf("pscriprefkey");
  const expiryIdx = headers.indexOf("pexpirydate");
  const optTypeIdx = headers.indexOf("poptiontype");
  const strikeIdx = headers.findIndex(h => h.startsWith("dstrikeprice"));
  const instTypeIdx = headers.indexOf("pinsttype") !== -1 ? headers.indexOf("pinsttype") : -1;
  const exchSegIdx = headers.indexOf("pexchseg") !== -1 ? headers.indexOf("pexchseg") : headers.indexOf("pexch");

  console.log("CSV headers found:", { symbolIdx, tokenIdx, expiryIdx, optTypeIdx, strikeIdx, instTypeIdx });

  if (tokenIdx === -1 || expiryIdx === -1 || optTypeIdx === -1 || strikeIdx === -1) {
    console.error("CSV header mapping failed. Headers:", headers.slice(0, 20).join(", "));
    throw new Error("Could not parse scrip master CSV headers");
  }

  const allNiftyOptions: OptionToken[] = [];
  const now = new Date();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);

    const symbol = (cols[symbolIdx] || "").trim().toUpperCase();
    if (symbol !== "NIFTY") continue;

    const optType = (cols[optTypeIdx] || "").trim().toUpperCase();
    if (optType !== "CE" && optType !== "PE") continue;

    const rawExpiry = parseFloat(cols[expiryIdx] || "0");
    if (!rawExpiry) continue;

    // Apply the 10-year offset quirk from SDK
    const expiryDate = new Date((rawExpiry + EXPIRY_OFFSET_SECONDS) * 1000);
    if (expiryDate < now) continue; // Skip expired

    const rawStrike = parseFloat(cols[strikeIdx] || "0");
    const strike = rawStrike / 100; // CSV stores strike * 100

    if (strike <= 0) continue;

    const token = (cols[tokenIdx] || "").trim();
    if (!token) continue;

    allNiftyOptions.push({
      token,
      strike,
      optionType: optType as "CE" | "PE",
      expiry: expiryDate.toISOString().split("T")[0],
      tradingSymbol: `NIFTY_${expiryDate.getDate()}${(expiryDate.getMonth() + 1).toString().padStart(2, "0")}_${strike}_${optType}`,
    });
  }

  console.log(`Parsed ${allNiftyOptions.length} NIFTY option contracts`);

  // Cache for the day
  cachedNiftyOptions = allNiftyOptions;
  cachedDate = today;

  return filterByStrikeRange(allNiftyOptions, spotPrice, strikeRange);
}

function filterByStrikeRange(options: OptionToken[], spotPrice: number, strikeRange: number): OptionToken[] {
  // Find nearest weekly expiry
  const expiries = [...new Set(options.map(o => o.expiry))].sort();
  const nearestExpiry = expiries[0];
  if (!nearestExpiry) return [];

  console.log(`Nearest expiry: ${nearestExpiry}, total expiries: ${expiries.length}`);

  const expiryOptions = options.filter(o => o.expiry === nearestExpiry);

  // ATM strike
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const minStrike = atmStrike - strikeRange * 50;
  const maxStrike = atmStrike + strikeRange * 50;

  const filtered = expiryOptions.filter(o => o.strike >= minStrike && o.strike <= maxStrike);
  console.log(`ATM: ${atmStrike}, range: ${minStrike}-${maxStrike}, filtered: ${filtered.length} contracts`);
  return filtered;
}

async function fetchQuotes(
  consumerKey: string,
  tokens: OptionToken[],
  indexToken: string
): Promise<Record<string, any>> {
  // Build neoSymbol string: nse_cm|26000,nse_fo|token1,nse_fo|token2,...
  const symbols = [`nse_cm|${indexToken}`];
  for (const t of tokens) {
    symbols.push(`nse_fo|${t.token}`);
  }

  // Batch in groups of 25 to avoid URL length limits
  const batchSize = 25;
  const allQuotes: Record<string, any> = {};

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const encoded = encodeURIComponent(batch.join(","));
    const url = `${KOTAK_DATA_BASE}/script-details/1.0/quotes/neosymbol/${encoded}/all`;

    console.log(`Fetching quotes batch ${Math.floor(i / batchSize) + 1}: ${batch.length} symbols`);
    const res = await fetch(url, { method: "GET", headers: buildDataHeaders(consumerKey) });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Quotes batch failed (${res.status}):`, text.substring(0, 300));
      if (res.status === 401) {
        return { __error: "SESSION_EXPIRED", __message: "Session expired — please reconnect broker" };
      }
      continue; // Skip failed batch, don't fail entire chain
    }

    const data = await res.json();
    // Response is typically an array of quote objects
    const quotes = Array.isArray(data) ? data : (data?.data || data?.message || []);
    if (Array.isArray(quotes)) {
      for (const q of quotes) {
        const key = `${q.e || q.exchange_segment}|${q.tk || q.instrument_token}`;
        allQuotes[key] = q;
      }
    }
  }

  return allQuotes;
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

    if (!session?.consumer_key) {
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
    const consumerKey = session.consumer_key;

    // Step 1: Fetch NIFTY spot price
    const niftyIndexToken = "26000";
    const spotEncoded = encodeURIComponent(`nse_cm|${niftyIndexToken}`);
    const spotUrl = `${KOTAK_DATA_BASE}/script-details/1.0/quotes/neosymbol/${spotEncoded}/ltp`;

    console.log("Fetching NIFTY spot price...");
    const spotRes = await fetch(spotUrl, { method: "GET", headers: buildDataHeaders(consumerKey) });

    if (!spotRes.ok) {
      const spotText = await spotRes.text();
      console.error("Spot price failed:", spotRes.status, spotText.substring(0, 300));
      if (spotRes.status === 401) {
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);
        return new Response(
          JSON.stringify({ success: false, error: "Session expired — please reconnect broker", code: "SESSION_EXPIRED" }),
          { status: 200, headers }
        );
      }
      return new Response(
        JSON.stringify({ success: false, error: `Kotak API error (${spotRes.status})`, code: "KOTAK_API_ERROR" }),
        { status: 200, headers }
      );
    }

    const spotData = await spotRes.json();
    const spotQuote = Array.isArray(spotData) ? spotData[0] : (spotData?.data?.[0] || spotData?.message?.[0] || spotData);
    const niftySpot = parseFloat(spotQuote?.ltp || spotQuote?.iv || spotQuote?.last_traded_price || "0");
    const niftyChange = parseFloat(spotQuote?.cng || spotQuote?.change || "0");

    console.log(`NIFTY spot: ${niftySpot}, change: ${niftyChange}`);

    if (niftySpot <= 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            niftySpot: 0, sensexSpot: 0, niftyChange: 0, sensexChange: 0,
            niftyPCR: 0, sensexPCR: 0, niftyATM: 0, sensexATM: 0,
            niftyChain: [], sensexChain: [], timestamp: Date.now(),
          }
        }),
        { headers }
      );
    }

    // Step 2: Fetch and parse NIFTY options from scrip master
    let niftyOptions: OptionToken[] = [];
    try {
      niftyOptions = await fetchAndParseNiftyOptions(consumerKey, niftySpot, strikeRange);
    } catch (err: any) {
      console.error("Scrip master error:", err.message);
      // Return spot data with empty chain if scrip master fails
    }

    // Step 3: Fetch quotes for all option tokens
    const atmStrike = Math.round(niftySpot / 50) * 50;
    let niftyChain: any[] = [];
    let totalCallOI = 0;
    let totalPutOI = 0;

    if (niftyOptions.length > 0) {
      const quotes = await fetchQuotes(consumerKey, niftyOptions, niftyIndexToken);

      if (quotes.__error === "SESSION_EXPIRED") {
        await adminClient.from("broker_sessions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", session.id);
        return new Response(
          JSON.stringify({ success: false, error: quotes.__message, code: "SESSION_EXPIRED" }),
          { status: 200, headers }
        );
      }

      // Step 4: Build option chain
      const strikeMap = new Map<number, any>();

      for (const opt of niftyOptions) {
        const key = `nse_fo|${opt.token}`;
        const quote = quotes[key];

        if (!strikeMap.has(opt.strike)) {
          strikeMap.set(opt.strike, {
            strike: opt.strike,
            callLTP: 0, putLTP: 0, callOI: 0, putOI: 0,
            callOIChange: 0, putOIChange: 0, callVolume: 0, putVolume: 0,
            callBid: 0, callAsk: 0, putBid: 0, putAsk: 0,
            isATM: opt.strike === atmStrike,
          });
        }

        const row = strikeMap.get(opt.strike)!;
        if (quote) {
          const ltp = parseFloat(quote.ltp || quote.last_traded_price || "0");
          const oi = parseInt(quote.oi || quote.open_interest || "0", 10);
          const vol = parseInt(quote.v || quote.volume || "0", 10);
          const bp = parseFloat(quote.bp || quote.buy_price || "0");
          const sp_val = parseFloat(quote.sp || quote.sell_price || "0");

          if (opt.optionType === "CE") {
            row.callLTP = ltp;
            row.callOI = oi;
            row.callVolume = vol;
            row.callBid = bp;
            row.callAsk = sp_val;
            totalCallOI += oi;
          } else {
            row.putLTP = ltp;
            row.putOI = oi;
            row.putVolume = vol;
            row.putBid = bp;
            row.putAsk = sp_val;
            totalPutOI += oi;
          }
        }
      }

      niftyChain = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
      console.log(`Built option chain: ${niftyChain.length} strikes, callOI: ${totalCallOI}, putOI: ${totalPutOI}`);
    } else {
      // Fallback: empty chain with ATM structure
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

    const result = {
      niftySpot,
      sensexSpot: 0,
      niftyChange,
      sensexChange: 0,
      niftyPCR,
      sensexPCR: 0,
      niftyATM: atmStrike,
      sensexATM: 0,
      niftyChain,
      sensexChain: [],
      timestamp: Date.now(),
    };

    return new Response(JSON.stringify({ success: true, data: result }), { headers });

  } catch (error) {
    console.error("Market data error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Internal server error", code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});
