import { Zap, X, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TradeSignal } from '@/hooks/useMarketData';

interface SignalPanelProps {
  signals: TradeSignal[];
  onConfirm: (signal: TradeSignal) => void;
  onDismiss: (signalId: string) => void;
  riskLimitReached: boolean;
}

export function SignalPanel({ signals, onConfirm, onDismiss, riskLimitReached }: SignalPanelProps) {
  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-signal" />
          <span>Trade Signals</span>
        </div>
        <span className="text-signal font-mono">{signals.length}</span>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {riskLimitReached && (
          <div className="bg-loss/10 border border-loss/30 rounded-md p-2 text-xs text-loss">
            ⚠ Risk limit reached — signals paused
          </div>
        )}
        {signals.length === 0 && !riskLimitReached && (
          <div className="text-center text-muted-foreground text-xs py-8">
            Monitoring for signals...
          </div>
        )}
        {signals.map((signal) => (
          <div key={signal.id} className="signal-card animate-slide-in">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="w-3 h-3 text-signal" />
                <span className="text-xs font-semibold text-signal">{signal.strategy}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                  signal.strength === 'HIGH' ? 'bg-profit/20 text-profit' : 'bg-warning/20 text-warning'
                }`}>
                  {signal.strength}
                </span>
                <button onClick={() => onDismiss(signal.id)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs mb-2">
              <div>
                <span className="text-muted-foreground">Index </span>
                <span className="font-mono">{signal.index}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Strike </span>
                <span className="font-mono">{signal.strike}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Type </span>
                <span className={`font-mono font-bold ${signal.optionType === 'CE' ? 'text-profit' : 'text-loss'}`}>
                  {signal.optionType}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Price </span>
                <span className="font-mono">₹{signal.currentPrice.toFixed(2)}</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">{signal.reason}</p>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground font-mono">
                Qty: {signal.suggestedQty}
              </span>
              <Button
                variant="buy"
                size="sm"
                className="h-7 text-xs px-3"
                onClick={() => onConfirm(signal)}
                disabled={riskLimitReached}
              >
                CONFIRM BUY
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
