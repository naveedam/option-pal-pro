// supabase/functions/screener-data/index.ts
//
// Deno edge function. Fetches daily OHLCV from Yahoo Finance's public
// chart endpoint per ticker, resamples to weekly/monthly, computes
// RSI(14, Wilder) + MACD(12,26,9), classifies bullish/watch/weak, and
// caches the result in `screener_cache` (see 001_screener_cache.sql)
// so repeat calls within CACHE_MINUTES don't re-hit Yahoo for all 90
// tickers.
//
// Deploy: npx supabase functions deploy screener-data
// (remember the blank-line-before-deploy trick if the redeploy doesn't
// pick up changes)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rsiWilder, macdLines, resampleOHLC, type Candle } from "../_shared/indicators.ts";

const CACHE_MINUTES = 15;
const BULLISH_RSI = 60;
const WEAK_RSI = 40;

const DEFAULT_WATCHLIST = [
  { ticker: "RELIANCE.NS", name: "RELIANCE" },
  { ticker: "TCS.NS", name: "TCS" },
  { ticker: "INFY.NS", name: "INFY" },
  { ticker: "HDFCBANK.NS", name: "HDFCBANK" },
  { ticker: "ICICIBANK.NS", name: "ICICIBANK" },
  { ticker: "SBIN.NS", name: "SBIN" },
  { ticker: "LT.NS", name: "LT" },
  { ticker: "ITC.NS", name: "ITC" },
  { ticker: "BHARTIARTL.NS", name: "BHARTIARTL" },
  { ticker: "KOTAKBANK.NS", name: "KOTAKBANK" },
  { ticker: "AXISBANK.NS", name: "AXISBANK" },
  { ticker: "BAJFINANCE.NS", name: "BAJFINANCE" },
  { ticker: "HCLTECH.NS", name: "HCLTECH" },
  { ticker: "ASIANPAINT.NS", name: "ASIANPAINT" },
  { ticker: "MARUTI.NS", name: "MARUTI" },
  { ticker: "TITAN.NS", name: "TITAN" },
  { ticker: "SUNPHARMA.NS", name: "SUNPHARMA" },
  { ticker: "TATASTEEL.NS", name: "TATASTEEL" },
  { ticker: "JSWSTEEL.NS", name: "JSWSTEEL" },
  { ticker: "M&M.NS", name: "M&M" },
  { ticker: "TATAMOTORS.NS", name: "TATAMOTORS" },
  { ticker: "TRENT.NS", name: "TRENT" },
  { ticker: "POWERGRID.NS", name: "POWERGRID" },
  { ticker: "NTPC.NS", name: "NTPC" },
  { ticker: "ONGC.NS", name: "ONGC" },
  { ticker: "COALINDIA.NS", name: "COALINDIA" },
  { ticker: "ADANIENT.NS", name: "ADANIENT" },
  { ticker: "ADANIPORTS.NS", name: "ADANIPORTS" },
  { ticker: "HINDALCO.NS", name: "HINDALCO" },
  { ticker: "TECHM.NS", name: "TECHM" }
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let watchlist = DEFAULT_WATCHLIST;
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (body?.tickers?.length) watchlist = body.tickers;
    }

    const results = await Promise.all(
      watchlist.map((w) => getOrRefresh(supabase, w.ticker, w.name))
    );

    return new Response(JSON.stringify({ stocks: results.filter(Boolean) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function getOrRefresh(supabase: any, ticker: string, name: string) {
  const { data: cached } = await supabase
    .from("screener_cache")
    .select("data, updated_at")
    .eq("ticker", ticker)
    .single();

  if (cached) {
    const ageMin = (Date.now() - new Date(cached.updated_at).getTime()) / 60000;
    if (ageMin < CACHE_MINUTES) return cached.data;
  }

  const fresh = await analyzeTicker(ticker, name);
  if (fresh) {
    // Only log a signal on a genuine transition into bullish/weak — not
    // on cold start (no prior cache) and not on steady-state re-caching.
    const prevClassification = cached?.data?.classification;
    if (
      prevClassification &&
      prevClassification !== fresh.classification &&
      (fresh.classification === "bullish" || fresh.classification === "weak")
    ) {
      await supabase.from("stock_signals").insert({
        ticker,
        name,
        classification: fresh.classification,
        price: fresh.price,
        reason: reasonForTransition(fresh),
      });
    }

    await supabase.from("screener_cache").upsert({
      ticker,
      display_name: name,
      data: fresh,
      updated_at: new Date().toISOString(),
    });
    return fresh;
  }
  return cached?.data ?? null; // fall back to stale cache if Yahoo failed
}

async function fetchDaily(ticker: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return [];

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (q.close?.[i] == null) continue;
    candles.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] ?? 0,
    });
  }
  return candles;
}

async function analyzeTicker(ticker: string, name: string) {
  const daily = await fetchDaily(ticker);
  if (daily.length < 60) return null;

  const weekly = resampleOHLC(daily, "W-FRI");
  const monthly = resampleOHLC(daily, "ME");

  const tf: Record<string, { rsi: number | null; macdAbove: boolean | null }> = {};
  for (const [label, frame] of [
    ["Daily", daily],
    ["Weekly", weekly],
    ["Monthly", monthly],
  ] as const) {
    if (frame.length < 16) {
      tf[label] = { rsi: null, macdAbove: null };
      continue;
    }
    const closes = frame.map((c) => c.close);
    const rsi = rsiWilder(closes).at(-1)!;
    const { macdLine, signalLine } = macdLines(closes);
    tf[label] = {
      rsi: Math.round(rsi * 100) / 100,
      macdAbove: macdLine.at(-1)! > signalLine.at(-1)!,
    };
  }

  const currentPrice = daily.at(-1)!.close;
  const prevClose = daily.length >= 2 ? daily.at(-2)!.close : currentPrice;
  const dayChangePct = prevClose ? Math.round(((currentPrice - prevClose) / prevClose) * 10000) / 100 : 0;
  const dayChangeAbs = Math.round((currentPrice - prevClose) * 100) / 100;

  const lookback = daily.slice(-252);
  const high52w = Math.max(...lookback.map((c) => c.high));
  const low52w = Math.min(...lookback.map((c) => c.low));
  const pctOfHigh = high52w ? Math.round((currentPrice / high52w) * 100) : null;

  const latestVolume = daily.at(-1)!.volume;
  const avgVolume20 = daily.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, daily.length);
  const volRatio = avgVolume20 ? Math.round((latestVolume / avgVolume20) * 100) : null;

  const classification = classify(tf);

  return {
    ticker,
    name,
    price: currentPrice,
    dayChangePct,
    dayChangeAbs,
    high52w,
    low52w,
    pctOfHigh,
    tf,
    latestVolume,
    avgVolume20,
    volRatio,
    classification,
  };
}

function classify(tf: Record<string, { rsi: number | null; macdAbove: boolean | null }>): "bullish" | "watch" | "weak" | "neutral" {
  if (["Daily", "Weekly", "Monthly"].some((t) => tf[t].rsi == null)) return "neutral";

  const allBull = ["Daily", "Weekly", "Monthly"].every(
    (t) => tf[t].rsi! > BULLISH_RSI && tf[t].macdAbove
  );
  if (allBull) return "bullish";

  const wmBull =
    tf.Weekly.rsi! > BULLISH_RSI && tf.Weekly.macdAbove && tf.Monthly.rsi! > BULLISH_RSI && tf.Monthly.macdAbove;
  if (wmBull) return "watch";

  if (tf.Daily.rsi! < WEAK_RSI && !tf.Daily.macdAbove) return "weak";

  return "neutral";
}

function reasonForTransition(fresh: { classification: string; tf: Record<string, { rsi: number | null; macdAbove: boolean | null }> }): string {
  if (fresh.classification === "bullish") {
    return `RSI > ${BULLISH_RSI} + MACD above signal on Daily, Weekly, and Monthly`;
  }
  if (fresh.classification === "weak") {
    return `Daily RSI ${fresh.tf.Daily.rsi?.toFixed(1)} (< ${WEAK_RSI}) with MACD below signal`;
  }
  return "Classification changed";
}
