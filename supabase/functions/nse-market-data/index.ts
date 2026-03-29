// NSE Market Data - public data, no auth required

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// In-memory cache (per isolate)
let cache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 3000;

const NSE_BASE = "https://www.nseindia.com";
const NSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://www.nseindia.com/option-chain",
  Connection: "keep-alive",
};

// Cookie jar — NSE requires a valid session cookie
let nseCookies: string | null = null;
let cookieExpiry = 0;

async function refreshCookies(): Promise<void> {
  try {
    const res = await fetch(NSE_BASE, {
      headers: NSE_HEADERS,
      redirect: "follow",
    });
    const setCookies = res.headers.get("set-cookie");
    if (setCookies) {
      // Extract cookie key=value pairs
      nseCookies = setCookies
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
      cookieExpiry = Date.now() + 5 * 60 * 1000; // 5 min
    }
    // Consume body
    await res.text();
  } catch (e) {
    console.log(`[NSE] Cookie refresh failed: ${e}`);
  }
}

async function fetchOptionChain(symbol = "NIFTY"): Promise<unknown> {
  // Ensure cookies
  if (!nseCookies || Date.now() > cookieExpiry) {
    await refreshCookies();
  }

  const url = `${NSE_BASE}/api/option-chain-indices?symbol=${symbol}`;
  const headers: Record<string, string> = { ...NSE_HEADERS };
  if (nseCookies) {
    headers["Cookie"] = nseCookies;
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    // If 401/403, retry with fresh cookies once
    if ((res.status === 401 || res.status === 403) && nseCookies) {
      console.log(`[NSE] Got ${res.status}, refreshing cookies and retrying`);
      nseCookies = null;
      await refreshCookies();
      if (nseCookies) {
        headers["Cookie"] = nseCookies;
        const retry = await fetch(url, { headers });
        if (!retry.ok) {
          const retryText = await retry.text();
          throw new Error(`NSE API ${retry.status}: ${retryText.substring(0, 200)}`);
        }
        return retry.json();
      }
    }
    throw new Error(`NSE API ${res.status}: ${text.substring(0, 200)}`);
  }

  return res.json();
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

    // Fetch from NSE
    const json = (await fetchOptionChain("NIFTY")) as {
      records?: {
        underlyingValue?: number;
        data?: Array<{
          strikePrice: number;
          CE?: {
            lastPrice?: number;
            openInterest?: number;
            changeinOpenInterest?: number;
            totalTradedVolume?: number;
            bidprice?: number;
            askPrice?: number;
          };
          PE?: {
            lastPrice?: number;
            openInterest?: number;
            changeinOpenInterest?: number;
            totalTradedVolume?: number;
            bidprice?: number;
            askPrice?: number;
          };
        }>;
      };
    };

    const spot = json?.records?.underlyingValue || 0;
    const rows = json?.records?.data || [];
    const atm = spot > 0 ? Math.round(spot / 50) * 50 : 0;

    const chain = rows.map((row) => ({
      strike: row.strikePrice,
      callLTP: row.CE?.lastPrice || 0,
      putLTP: row.PE?.lastPrice || 0,
      callOI: row.CE?.openInterest || 0,
      putOI: row.PE?.openInterest || 0,
      callOIChange: row.CE?.changeinOpenInterest || 0,
      putOIChange: row.PE?.changeinOpenInterest || 0,
      callVolume: row.CE?.totalTradedVolume || 0,
      putVolume: row.PE?.totalTradedVolume || 0,
      callBid: row.CE?.bidprice || 0,
      callAsk: row.CE?.askPrice || 0,
      putBid: row.PE?.bidprice || 0,
      putAsk: row.PE?.askPrice || 0,
      isATM: row.strikePrice === atm,
    }));

    // Compute PCR
    const totalCallOI = chain.reduce((s, r) => s + r.callOI, 0);
    const totalPutOI = chain.reduce((s, r) => s + r.putOI, 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    const responseData = {
      success: true,
      data: {
        niftySpot: spot,
        niftyATM: atm,
        niftyChange: 0,
        niftyPCR: Math.round(pcr * 100) / 100,
        niftyChain: chain,
        sensexSpot: 0,
        sensexATM: 0,
        sensexChange: 0,
        sensexPCR: 0,
        sensexChain: [],
        timestamp: Date.now(),
      },
    };

    // Cache it
    cache = { data: responseData, timestamp: Date.now() };

    return new Response(JSON.stringify(responseData), { headers });
  } catch (error) {
    console.error(`[NSE] Error: ${error.message}`);
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
