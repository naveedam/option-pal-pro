// Market Data via Yahoo Finance v8 + best-effort NSE OI overlay

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

let cache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 5000;

const YAHOO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const NSE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

interface ChartMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  symbol?: string;
}

interface NseOiRow {
  strikePrice: number;
  CE?: { openInterest?: number; changeinOpenInterest?: number; totalTradedVolume?: number };
  PE?: { openInterest?: number; changeinOpenInterest?: number; totalTradedVolume?: number };
}

async function fetchYahooChart(symbol: string): Promise<ChartMeta | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  console.log(`[Yahoo] Fetching chart: ${url}`);
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  console.log(`[Yahoo] ${symbol} status: ${res.status}`);
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Yahoo] ${symbol} error: ${text.substring(0, 300)}`);
    return null;
  }
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta as ChartMeta | undefined;
  if (!meta?.regularMarketPrice) {
    console.error(`[Yahoo] ${symbol} no price`);
    return null;
  }
  console.log(`[Yahoo] ${symbol} price=${meta.regularMarketPrice} prevClose=${meta.previousClose}`);
  return meta;
}

async function fetchNseOptionChain(symbol: string): Promise<Map<number, NseOiRow> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    // First get cookies from main page
    const mainRes = await fetch("https://www.nseindia.com", {
      headers: NSE_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    const cookies = mainRes.headers.get("set-cookie") || "";
    const nsCookie = cookies.split(",").map(c => c.split(";")[0].trim()).join("; ");

    const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { ...NSE_HEADERS, Cookie: nsCookie },
      signal: controller.signal,
    });
    console.log(`[NSE] ${symbol} status: ${res.status}`);
    if (!res.ok) return null;

    const json = await res.json();
    const records = json?.records?.data;
    if (!Array.isArray(records)) return null;

    const map = new Map<number, NseOiRow>();
    for (const row of records) {
      if (row.strikePrice) {
        map.set(row.strikePrice, row);
      }
    }
    console.log(`[NSE] ${symbol} got ${map.size} strikes`);
    return map;
  } catch (e) {
    console.log(`[NSE] ${symbol} failed (expected): ${e.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function calculateMaxPain(chain: { strike: number; callOI: number; putOI: number }[]): number {
  if (chain.length === 0) return 0;
  let minPain = Infinity;
  let maxPainStrike = 0;
  for (const candidate of chain) {
    let pain = 0;
    for (const row of chain) {
      if (row.strike < candidate.strike) {
        pain += (candidate.strike - row.strike) * row.callOI;
      }
      if (row.strike > candidate.strike) {
        pain += (row.strike - candidate.strike) * row.putOI;
      }
    }
    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = candidate.strike;
    }
  }
  return maxPainStrike;
}

function buildChain(spot: number, stepSize: number, nseOi: Map<number, NseOiRow> | null) {
  if (spot <= 0) return [];
  const atm = Math.round(spot / stepSize) * stepSize;
  const strikes: number[] = [];
  for (let i = -10; i <= 10; i++) strikes.push(atm + i * stepSize);

  return strikes.map((strike) => {
    const diff = strike - spot;
    const absDiff = Math.abs(diff);
    const timeValue = Math.max(2, (stepSize * 3 - absDiff) * 0.15);
    const callIntrinsic = Math.max(0, spot - strike);
    const putIntrinsic = Math.max(0, strike - spot);
    const callLTP = Math.round((callIntrinsic + timeValue) * 100) / 100;
    const putLTP = Math.round((putIntrinsic + timeValue) * 100) / 100;

    const oiFactor = Math.max(0.1, 1 - absDiff / (stepSize * 12));
    const baseOI = 30000;

    // Check for real NSE OI
    const nseRow = nseOi?.get(strike);
    const hasRealOi = !!(nseRow?.CE?.openInterest || nseRow?.PE?.openInterest);

    return {
      strike,
      callLTP,
      putLTP,
      callOI: nseRow?.CE?.openInterest ?? Math.round(baseOI * oiFactor * (0.8 + Math.random() * 0.4)),
      putOI: nseRow?.PE?.openInterest ?? Math.round(baseOI * oiFactor * (0.8 + Math.random() * 0.4)),
      callOIChange: nseRow?.CE?.changeinOpenInterest ?? 0,
      putOIChange: nseRow?.PE?.changeinOpenInterest ?? 0,
      callVolume: nseRow?.CE?.totalTradedVolume ?? Math.round(5000 * oiFactor * (0.5 + Math.random() * 0.5)),
      putVolume: nseRow?.PE?.totalTradedVolume ?? Math.round(5000 * oiFactor * (0.5 + Math.random() * 0.5)),
      callBid: Math.round((callLTP - 0.5) * 100) / 100,
      callAsk: Math.round((callLTP + 0.5) * 100) / 100,
      putBid: Math.round((putLTP - 0.5) * 100) / 100,
      putAsk: Math.round((putLTP + 0.5) * 100) / 100,
      isATM: strike === atm,
      oiSource: hasRealOi ? "nse" : "synthetic" as "nse" | "synthetic",
    };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
      return new Response(JSON.stringify(cache.data), { headers });
    }

    // Fetch Yahoo prices and attempt NSE OI in parallel
    const [niftyMeta, sensexMeta, niftyNseOi] = await Promise.all([
      fetchYahooChart("^NSEI"),
      fetchYahooChart("^BSESN"),
      fetchNseOptionChain("NIFTY").catch(() => null),
    ]);

    const niftySpot = niftyMeta?.regularMarketPrice || 0;
    const niftyPrevClose = niftyMeta?.previousClose || niftyMeta?.chartPreviousClose || 0;
    const niftyChange = niftyPrevClose > 0 ? Math.round((niftySpot - niftyPrevClose) * 100) / 100 : 0;

    const sensexSpot = sensexMeta?.regularMarketPrice || 0;
    const sensexPrevClose = sensexMeta?.previousClose || sensexMeta?.chartPreviousClose || 0;
    const sensexChange = sensexPrevClose > 0 ? Math.round((sensexSpot - sensexPrevClose) * 100) / 100 : 0;

    const niftyChain = buildChain(niftySpot, 50, niftyNseOi);
    const sensexChain = buildChain(sensexSpot, 100, null);

    const nCallOI = niftyChain.reduce((s, r) => s + r.callOI, 0);
    const nPutOI = niftyChain.reduce((s, r) => s + r.putOI, 0);
    const niftyPCR = nCallOI > 0 ? Math.round((nPutOI / nCallOI) * 100) / 100 : 0;

    const sCallOI = sensexChain.reduce((s, r) => s + r.callOI, 0);
    const sPutOI = sensexChain.reduce((s, r) => s + r.putOI, 0);
    const sensexPCR = sCallOI > 0 ? Math.round((sPutOI / sCallOI) * 100) / 100 : 0;

    const oiSource = niftyNseOi && niftyNseOi.size > 0 ? "nse" : "synthetic";

    const niftyMaxPain = calculateMaxPain(niftyChain);
    const sensexMaxPain = calculateMaxPain(sensexChain);

    const responseData = {
      success: true,
      source: "yahoo-finance-v8",
      oiSource,
      data: {
        niftySpot,
        niftyATM: niftySpot > 0 ? Math.round(niftySpot / 50) * 50 : 0,
        niftyChange,
        niftyPCR,
        niftyChain,
        niftyMaxPain,
        sensexSpot,
        sensexATM: sensexSpot > 0 ? Math.round(sensexSpot / 100) * 100 : 0,
        sensexChange,
        sensexPCR,
        sensexChain,
        sensexMaxPain,
        timestamp: Date.now(),
      },
    };

    console.log(`[Market] NIFTY=${niftySpot} SENSEX=${sensexSpot} oiSource=${oiSource} chain=${niftyChain.length}`);

    cache = { data: responseData, timestamp: Date.now() };
    return new Response(JSON.stringify(responseData), { headers });
  } catch (error) {
    console.error(`[Market] Error: ${error.message}`);
    return new Response(
      JSON.stringify({ success: false, error: error.message, data: null }),
      { status: 200, headers },
    );
  }
});
