
export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------- RSI (Wilder 14) ----------
export function rsiWilder(
  closes: number[],
  period = 14
): number[] {
  if (closes.length === 0) return [];

  const rsi = new Array(closes.length).fill(50);

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  rsi[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];

    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;

    if (avgLoss === 0) rsi[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }

  return rsi;
}

// ---------- EMA ----------
function ema(values: number[], length: number): number[] {
  const k = 2 / (length + 1);
  const out: number[] = [];

  let prev = values[0];
  out.push(prev);

  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

// ---------- MACD ----------
export function macdLines(closes: number[]) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);

  return { macdLine, signalLine, histogram };
}

// ---------- OHLC Resampling ----------
export function resampleOHLC(
  candles: Candle[],
  timeframe: "W-FRI" | "ME"
): Candle[] {
  if (candles.length === 0) return [];

  const groups = new Map<string, Candle[]>();

  for (const c of candles) {
    const d = new Date(c.date);
    let key = "";

    if (timeframe === "ME") {
      key = `${d.getUTCFullYear()}-${String(
        d.getUTCMonth() + 1
      ).padStart(2, "0")}`;
    } else {
      const tmp = new Date(d);
      const day = tmp.getUTCDay();
      const diff = (5 - day + 7) % 7;
      tmp.setUTCDate(tmp.getUTCDate() + diff);

      key = tmp.toISOString().slice(0, 10);
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const out: Candle[] = [];

  for (const [key, rows] of groups.entries()) {
    rows.sort((a, b) => a.date.localeCompare(b.date));

    out.push({
      date: key,
      open: rows[0].open,
      high: Math.max(...rows.map(r => r.high)),
      low: Math.min(...rows.map(r => r.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((s, r) => s + r.volume, 0),
    });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
