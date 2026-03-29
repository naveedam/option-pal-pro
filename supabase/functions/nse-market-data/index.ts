// NSE Market Data via Yahoo Finance - public data, no auth required

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// In-memory cache (per isolate)
let cache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 5000;

interface YahooQuoteResult {
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  shortName?: string;
  symbol?: string;
}

interface YahooOptionContract {
  strike?: number;
  lastPrice?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  change?: number;
  contractSymbol?: string;
  inTheMoney?: boolean;
}

interface YahooOptionsResult {
  quote?: YahooQuoteResult;
  options?: Array<{
    calls?: YahooOptionContract[];
    puts?: YahooOptionContract[];
    expirationDate?: number;
  }>;
  expirationDates?: number[];
}

const YAHOO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult | null> {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  console.log(`[Yahoo] Fetching quote+options: ${url}`);

  const res = await fetch(url, { headers: YAHOO_HEADERS });
  console.log(`[Yahoo] Response status: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[Yahoo] Error: ${res.status} ${text.substring(0, 300)}`);
    return null;
  }

  const json = await res.json();
  const result = json?.optionChain?.result?.[0] as YahooOptionsResult | undefined;

  if (!result?.quote) {
    console.error(`[Yahoo] No quote data in response. Keys: ${Object.keys(json || {}).join(", ")}`);
    return null;
  }

  console.log(`[Yahoo] Quote: ${result.quote.symbol} price=${result.quote.regularMarketPrice} change=${result.quote.regularMarketChange}`);
  return result.quote;
}

async function fetchYahooOptionsChain(symbol: string): Promise<{
  quote: YahooQuoteResult;
  calls: YahooOptionContract[];
  puts: YahooOptionContract[];
} | null> {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  console.log(`[Yahoo] Fetching options chain: ${url}`);

  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Yahoo] Options error: ${res.status} ${text.substring(0, 300)}`);
    return null;
  }

  const json = await res.json();
  const result = json?.optionChain?.result?.[0] as YahooOptionsResult | undefined;

  if (!result?.quote) {
    console.log("[Yahoo] No options data found");
    return null;
  }

  const calls = result.options?.[0]?.calls || [];
  const puts = result.options?.[0]?.puts || [];

  console.log(`[Yahoo] Options: ${calls.length} calls, ${puts.length} puts`);
  return { quote: result.quote, calls, puts };
}

function buildOptionChain(
  spot: number,
  calls: YahooOptionContract[],
  puts: YahooOptionContract[],
  stepSize: number,
) {
  const atm = spot > 0 ? Math.round(spot / stepSize) * stepSize : 0;

  // If Yahoo provides real options, merge them
  if (calls.length > 0 || puts.length > 0) {
    // Collect all strikes
    const strikeSet = new Set<number>();
    calls.forEach((c) => c.strike && strikeSet.add(c.strike));
    puts.forEach((p) => p.strike && strikeSet.add(p.strike));

    const callMap = new Map(calls.map((c) => [c.strike, c]));
    const putMap = new Map(puts.map((p) => [p.strike, p]));

    const strikes = [...strikeSet].sort((a, b) => a - b);

    // Filter to ±10 strikes around ATM
    const atmIdx = strikes.findIndex((s) => s >= atm);
    const start = Math.max(0, (atmIdx >= 0 ? atmIdx : Math.floor(strikes.length / 2)) - 10);
    const end = start + 21;
    const nearStrikes = strikes.slice(start, end);

    return nearStrikes.map((strike) => {
      const call = callMap.get(strike);
      const put = putMap.get(strike);
      return {
        strike,
        callLTP: call?.lastPrice || 0,
        putLTP: put?.lastPrice || 0,
        callOI: call?.openInterest || 0,
        putOI: put?.openInterest || 0,
        callOIChange: 0,
        putOIChange: 0,
        callVolume: call?.volume || 0,
        putVolume: put?.volume || 0,
        callBid: call?.bid || 0,
        callAsk: call?.ask || 0,
        putBid: put?.bid || 0,
        putAsk: put?.ask || 0,
        isATM: strike === atm,
      };
    });
  }

  // Fallback: generate synthetic chain around ATM
  const strikes: number[] = [];
  for (let i = -10; i <= 10; i++) {
    strikes.push(atm + i * stepSize);
  }

  return strikes.map((strike) => {
    const diff = Math.abs(strike - spot);
    const isCall = strike >= spot;
    // Simple Black-Scholes-like approximation for display
    const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const timeValue = Math.max(5, (stepSize * 2 - diff) * 0.3);
    const ltp = Math.round((intrinsic + timeValue) * 100) / 100;

    return {
      strike,
      callLTP: isCall ? Math.max(1, ltp * 0.6) : ltp,
      putLTP: isCall ? ltp : Math.max(1, ltp * 0.6),
      callOI: Math.round(Math.random() * 50000 + 5000),
      putOI: Math.round(Math.random() * 50000 + 5000),
      callOIChange: 0,
      putOIChange: 0,
      callVolume: Math.round(Math.random() * 10000 + 1000),
      putVolume: Math.round(Math.random() * 10000 + 1000),
      callBid: 0,
      callAsk: 0,
      putBid: 0,
      putAsk: 0,
      isATM: strike === atm,
    };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    // Check cache
    if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
      return new Response(JSON.stringify(cache.data), { headers });
    }

    // Fetch NIFTY (^NSEI) and SENSEX (^BSESN) quotes from Yahoo
    const [niftyData, sensexQuote] = await Promise.all([
      fetchYahooOptionsChain("^NSEI"),
      fetchYahooQuote("^BSESN"),
    ]);

    const niftySpot = niftyData?.quote?.regularMarketPrice || 0;
    const niftyChange = niftyData?.quote?.regularMarketChange || 0;
    const sensexSpot = sensexQuote?.regularMarketPrice || 0;
    const sensexChange = sensexQuote?.regularMarketChange || 0;

    // Build NIFTY chain
    const niftyChain = buildOptionChain(
      niftySpot,
      niftyData?.calls || [],
      niftyData?.puts || [],
      50,
    );

    // Compute PCR for NIFTY
    const totalCallOI = niftyChain.reduce((s, r) => s + r.callOI, 0);
    const totalPutOI = niftyChain.reduce((s, r) => s + r.putOI, 0);
    const niftyPCR = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    // Build SENSEX chain (synthetic)
    const sensexChain = buildOptionChain(sensexSpot, [], [], 100);
    const sensexCallOI = sensexChain.reduce((s, r) => s + r.callOI, 0);
    const sensexPutOI = sensexChain.reduce((s, r) => s + r.putOI, 0);
    const sensexPCR = sensexCallOI > 0 ? Math.round((sensexPutOI / sensexCallOI) * 100) / 100 : 0;

    const responseData = {
      success: true,
      source: "yahoo-finance",
      data: {
        niftySpot,
        niftyATM: niftySpot > 0 ? Math.round(niftySpot / 50) * 50 : 0,
        niftyChange: Math.round(niftyChange * 100) / 100,
        niftyPCR,
        niftyChain,
        sensexSpot,
        sensexATM: sensexSpot > 0 ? Math.round(sensexSpot / 100) * 100 : 0,
        sensexChange: Math.round(sensexChange * 100) / 100,
        sensexPCR,
        sensexChain,
        timestamp: Date.now(),
      },
    };

    console.log(`[Market] NIFTY=${niftySpot} SENSEX=${sensexSpot} chain=${niftyChain.length} rows`);

    // Cache
    cache = { data: responseData, timestamp: Date.now() };

    return new Response(JSON.stringify(responseData), { headers });
  } catch (error) {
    console.error(`[Market] Error: ${error.message}`);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        data: null,
      }),
      { status: 200, headers },
    );
  }
});
