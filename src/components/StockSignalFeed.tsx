import { useEffect, useState } from "react";
import { supabase } from "../integrations/supabase/client";

interface StockSignal {
  id: string;
  ticker: string;
  name: string;
  classification: "bullish" | "weak";
  price: number;
  reason: string;
  triggered_at: string;
  dismissed: boolean;
}

export default function StockSignalFeed() {
  const [signals, setSignals] = useState<StockSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    // Poll every minute — signals only get written when the edge function's
    // 15-min cache refreshes a ticker, so this is just to catch new ones
    // without a manual page reload.
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function load() {
    const { data } = await supabase
      .from("stock_signals")
      .select("*")
      .eq("dismissed", false)
      .order("triggered_at", { ascending: false })
      .limit(30);
    setSignals(data ?? []);
    setLoading(false);
  }

  async function dismiss(id: string) {
    setSignals((prev) => prev.filter((s) => s.id !== id));
    await supabase.from("stock_signals").update({ dismissed: true }).eq("id", id);
  }

  return (
    <div className="flex h-full flex-col rounded-md border border-border bg-secondary/30">
      <div className="flex-shrink-0 border-b border-border px-3 py-2">
        <span className="text-xs font-mono uppercase text-muted-foreground">Stock Signals</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading && <div className="p-2 text-xs text-muted-foreground">Loading…</div>}
        {!loading && signals.length === 0 && (
          <div className="p-2 text-xs text-muted-foreground">
            No new signals yet. You'll see an alert here when a stock newly enters Bullish or Weak.
          </div>
        )}
        {signals.map((s) => (
          <div
            key={s.id}
            className={`rounded-md border p-2 text-xs ${
              s.classification === "bullish"
                ? "border-emerald-900/60 bg-emerald-950/30"
                : "border-red-900/60 bg-red-950/30"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono font-semibold text-foreground">{s.name}</span>
              <button
                onClick={() => dismiss(s.id)}
                className="text-muted-foreground hover:text-foreground"
                title="Dismiss"
              >
                ✕
              </button>
            </div>
            <div
              className={`mt-0.5 font-mono uppercase text-[10px] ${
                s.classification === "bullish" ? "text-emerald-400" : "text-red-400"
              }`}
            >
              Entered {s.classification} · ₹{Number(s.price).toLocaleString("en-IN")}
            </div>
            <div className="mt-1 text-muted-foreground">{s.reason}</div>
            <div className="mt-1 text-[10px] text-muted-foreground/70">
              {new Date(s.triggered_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
