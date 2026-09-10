import { useEffect, useMemo, useState } from "react";
import { supabase } from "../integrations/supabase/client";
import StockSignalFeed from "./StockSignalFeed";

type Timeframe = "Daily" | "Weekly" | "Monthly";

interface StockResult {
  ticker: string;
  name: string;
  price: number;
  dayChangePct: number;
  dayChangeAbs: number;
  high52w: number;
  low52w: number;
  pctOfHigh: number | null;
  tf: Record<Timeframe, { rsi: number | null; macdAbove: boolean | null }>;
  volRatio: number | null;
  classification: "bullish" | "watch" | "weak" | "neutral";
}

type SortCol = "name" | "pctOfHigh" | "dayChangePct";

export default function StockScreener() {
  const [stocks, setStocks] = useState<StockResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>("pctOfHigh");
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke("screener-data");
    if (error) setError(error.message);
    else setStocks(data?.stocks ?? []);
    setLoading(false);
  }

  const bullish = useMemo(
    () =>
      stocks
        .filter((s) => s.classification === "bullish" || s.classification === "watch")
        .sort((a, b) => (a.classification === "bullish" ? -1 : 1))
        .slice(0, 6),
    [stocks]
  );
  const weak = useMemo(() => stocks.filter((s) => s.classification === "weak").slice(0, 6), [stocks]);

  const sorted = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return [...stocks].sort((a, b) => {
      if (sortCol === "name") return dir * b.name.localeCompare(a.name);
      const av = sortCol === "pctOfHigh" ? a.pctOfHigh ?? -1 : a.dayChangePct;
      const bv = sortCol === "pctOfHigh" ? b.pctOfHigh ?? -1 : b.dayChangePct;
      return dir * (bv - av);
    });
  }, [stocks, sortCol, sortDesc]);

  function toggleSort(col: SortCol) {
    if (col === sortCol) setSortDesc((d) => !d);
    else {
      setSortCol(col);
      setSortDesc(true);
    }
  }

  if (loading) return <div className="p-6 text-sm text-zinc-400">Loading screener…</div>;
  if (error) return <div className="p-6 text-sm text-red-400">Couldn't load screener data: {error}</div>;

  return (
    <div className="flex h-full min-h-0 gap-4">
    <div className="flex-1 min-w-0 space-y-6 overflow-y-auto text-zinc-100">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">Stock Screener</h1>
          <p className="text-xs text-zinc-500">RSI (14, Wilder) · MACD (12,26,9) · Daily / Weekly / Monthly · NSE</p>
        </div>
        <button
          onClick={load}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </header>

      {bullish.length > 0 && (
        <Section title="Fully Bullish" tone="bull">
          {bullish.map((s) => (
            <Card key={s.ticker} stock={s} tone="bull" />
          ))}
        </Section>
      )}

      {weak.length > 0 && (
        <Section title="Weak / Oversold" tone="weak">
          {weak.map((s) => (
            <Card key={s.ticker} stock={s} tone="weak" />
          ))}
        </Section>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-zinc-900 text-[11px] uppercase tracking-wide text-zinc-400">
            <tr>
              <Th onClick={() => toggleSort("name")}>Stock</Th>
              <th className="px-3 py-2 text-left">Price (₹)</th>
              <Th onClick={() => toggleSort("pctOfHigh")}>% of 52W High</Th>
              <Th onClick={() => toggleSort("dayChangePct")}>Day Change</Th>
              <th className="px-3 py-2 text-left">Timeframe</th>
              <th className="px-3 py-2 text-left">RSI</th>
              <th className="px-3 py-2 text-left">MACD</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <StockRows key={s.ticker} stock={s} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-600">
        Data refreshes every 15 minutes. Informational only, not investment advice.
      </p>
    </div>
    <div className="w-[300px] flex-shrink-0">
      <StockSignalFeed />
    </div>
    </div>
  );
}

function Th({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <th className="cursor-pointer select-none px-3 py-2 text-left hover:text-zinc-200" onClick={onClick}>
      {children}
    </th>
  );
}

function Section({ title, tone, children }: { title: string; tone: "bull" | "weak"; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            tone === "bull" ? "bg-emerald-900 text-emerald-300" : "bg-red-900 text-red-300"
          }`}
        >
          {tone === "bull" ? "RSI > 60 + MACD above, all 3 TFs" : "RSI < 40 daily + MACD below"}
        </span>
      </div>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

function Card({ stock, tone }: { stock: StockResult; tone: "bull" | "weak" }) {
  return (
    <div
      className={`min-w-[210px] flex-1 rounded-md border p-3 ${
        tone === "bull" ? "border-emerald-900/60 bg-emerald-950/30" : "border-red-900/60 bg-red-950/30"
      }`}
    >
      <div className="text-sm font-semibold">{stock.name}</div>
      <div className="mt-0.5 text-xs text-zinc-400">
        ₹{stock.price.toLocaleString("en-IN")} · {stock.pctOfHigh ?? "–"}% of 52W high
      </div>
      {(["Daily", "Weekly", "Monthly"] as Timeframe[]).map((label) => (
        <div key={label} className="mt-1 flex justify-between text-xs text-zinc-400">
          <span>{label} RSI</span>
          <span className="font-medium text-zinc-200">{stock.tf[label].rsi?.toFixed(2) ?? "–"}</span>
        </div>
      ))}
    </div>
  );
}

function StockRows({ stock }: { stock: StockResult }) {
  return (
    <>
      {(["Daily", "Weekly", "Monthly"] as Timeframe[]).map((label, i) => (
        <tr key={label} className={i === 0 ? "border-t border-zinc-800" : ""}>
          {i === 0 && (
            <>
              <td rowSpan={3} className="px-3 py-2 align-top font-medium">
                {stock.name}
              </td>
              <td rowSpan={3} className="px-3 py-2 align-top text-xs text-zinc-400">
                ₹{stock.price.toLocaleString("en-IN")}
                <div>52W Hi {stock.high52w.toLocaleString("en-IN")}</div>
                <div className="text-red-400">52W Lo {stock.low52w.toLocaleString("en-IN")}</div>
              </td>
              <td rowSpan={3} className="px-3 py-2 align-top">
                {stock.pctOfHigh ?? "–"}%
              </td>
              <td
                rowSpan={3}
                className={`px-3 py-2 align-top font-medium ${
                  stock.dayChangePct >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {stock.dayChangePct >= 0 ? "▲" : "▼"} {Math.abs(stock.dayChangePct).toFixed(2)}%
              </td>
            </>
          )}
          <td className="px-3 py-2 text-zinc-400">{label}</td>
          <td className="px-3 py-2">{stock.tf[label].rsi?.toFixed(2) ?? "–"}</td>
          <td className="px-3 py-2">
            {stock.tf[label].macdAbove == null ? (
              <span className="text-zinc-600">N/A</span>
            ) : stock.tf[label].macdAbove ? (
              <span className="rounded-full bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300">▲ Above</span>
            ) : (
              <span className="rounded-full bg-red-900/60 px-2 py-0.5 text-xs text-red-300">▼ Below</span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}
