// Market Data via Yahoo Finance v8 chart API - no auth/crumb required

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

interface ChartMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  symbol?: string;
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
    console.error(`[Yahoo] ${symbol} no price. Keys: ${Object.keys(json?.chart?.result?.[0] || {}).join(", ")}`);
    return null;
  }

  console.log(`[Yahoo] ${symbol} price=${meta.regularMarketPrice} prevClose=${meta.previousClose}`);
  return meta;
}

function buildSyntheticChain(spot: number, stepSize: number) {
  if (spot <= 0) return [];
  const atm = Math.round(spot / stepSize) * stepSize;
  const strikes: number[] = [];
  for (let i = -10; i <= 10; i++) {
    strikes.push(atm + i * stepSize);
  }

  return strikes.map((strike) => {
    const diff = strike - spot;
    const absDiff = Math.abs(diff);
    // Approximate option prices using distance from spot
    const timeValue = Math.max(2, (stepSize * 3 - absDiff) * 0.15);
    const callIntrinsic = Math.max(0, spot - strike);
    const putIntrinsic = Math.max(0, strike - spot);
    const callLTP = Math.round((callIntrinsic + timeValue) * 100) / 100;
    const putLTP = Math.round((putIntrinsic + timeValue) * 100) / 100;

    // Synthetic OI - higher near ATM, decreasing outward
    const oiFactor = Math.max(0.1, 1 - absDiff / (stepSize * 12));
    const baseOI = 30000;

    return {
      strike,
      callLTP,
      putLTP,
      callOI: Math.round(baseOI * oiFactor * (0.8 + Math.random() * 0.4)),
      putOI: Math.round(baseOI * oiFactor * (0.8 + Math.random() * 0.4)),
      callOIChange: 0,
      putOIChange: 0,
      callVolume: Math.round(5000 * oiFactor * (0.5 + Math.random() * 0.5)),
      putVolume: Math.round(5000 * oiFactor * (0.5 + Math.random() * 0.5)),
      callBid: Math.round((callLTP - 0.5) * 100) / 100,
      callAsk: Math.round((callLTP + 0.5) * 100) / 100,
      putBid: Math.round((putLTP - 0.5) * 100) / 100,
      putAsk: Math.round((putLTP + 0.5) * 100) / 100,
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
    if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
      return new Response(JSON.stringify(cache.data), { headers });
    }

    // Fetch NIFTY and SENSEX in parallel
    const [niftyMeta, sensexMeta] = await Promise.all([
      fetchYahooChart("^NSEI"),
      fetchYahooChart("^BSESN"),
    ]);

    const niftySpot = niftyMeta?.regularMarketPrice || 0;
    const niftyPrevClose = niftyMeta?.previousClose || niftyMeta?.chartPreviousClose || 0;
    const niftyChange = niftyPrevClose > 0 ? Math.round((niftySpot - niftyPrevClose) * 100) / 100 : 0;

    const sensexSpot = sensexMeta?.regularMarketPrice || 0;
    const sensexPrevClose = sensexMeta?.previousClose || sensexMeta?.chartPreviousClose || 0;
    const sensexChange = sensexPrevClose > 0 ? Math.round((sensexSpot - sensexPrevClose) * 100) / 100 : 0;

    const niftyChain = buildSyntheticChain(niftySpot, 50);
    const sensexChain = buildSyntheticChain(sensexSpot, 100);

    // Compute PCR
    const nCallOI = niftyChain.reduce((s, r) => s + r.callOI, 0);
    const nPutOI = niftyChain.reduce((s, r) => s + r.putOI, 0);
    const niftyPCR = nCallOI > 0 ? Math.round((nPutOI / nCallOI) * 100) / 100 : 0;

    const sCallOI = sensexChain.reduce((s, r) => s + r.callOI, 0);
    const sPutOI = sensexChain.reduce((s, r) => s + r.putOI, 0);
    const sensexPCR = sCallOI > 0 ? Math.round((sPutOI / sCallOI) * 100) / 100 : 0;

    const responseData = {
      success: true,
      source: "yahoo-finance-v8",
      data: {
        niftySpot,
        niftyATM: niftySpot > 0 ? Math.round(niftySpot / 50) * 50 : 0,
        niftyChange,
        niftyPCR,
        niftyChain,
        sensexSpot,
        sensexATM: sensexSpot > 0 ? Math.round(sensexSpot / 100) * 100 : 0,
        sensexChange,
        sensexPCR,
        sensexChain,
        timestamp: Date.now(),
      },
    };

    console.log(`[Market] NIFTY=${niftySpot} (${niftyChange}) SENSEX=${sensexSpot} (${sensexChange}) chain=${niftyChain.length}`);

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
