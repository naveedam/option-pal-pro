import { useState } from 'react';
import { Zap, X, TrendingUp, Maximize2, Minimize2, Target, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { TradeSignal } from '@/hooks/useMarketData';

interface SignalPanelProps {
  signals: TradeSignal[];
  onConfirm: (signal: TradeSignal) => void;
  onDismiss: (signalId: string) => void;
  riskLimitReached: boolean;
  onExecuteTrade?: (signal: TradeSignal) => void;
  onViewInChain?: (strike: number) => void;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color = confidence >= 75 ? 'text-profit bg-profit/20' 
    : confidence >= 50 ? 'text-warning bg-warning/20' 
    : 'text-muted-foreground bg-muted';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${color}`}>
      {confidence}%
    </span>
  );
}

function DirectionBadge({ optionType }: { optionType: 'CE' | 'PE' }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-black uppercase tracking-wider ${
      optionType === 'CE' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss'
    }`}>
      {optionType === 'CE' ? '▲ BUY' : '▼ SELL'}
    </span>
  );
}

function SignalCard({ signal, onConfirm, onDismiss, riskLimitReached, onExecuteTrade, onViewInChain, expanded }: {
  signal: TradeSignal;
  onConfirm: (signal: TradeSignal) => void;
  onDismiss: (signalId: string) => void;
  riskLimitReached: boolean;
  onExecuteTrade?: (signal: TradeSignal) => void;
  onViewInChain?: (strike: number) => void;
  expanded?: boolean;
}) {
  const stopLoss = signal.currentPrice * 0.98;
  const target = signal.currentPrice * 1.04;

  return (
    <div className="signal-card animate-slide-in">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <DirectionBadge optionType={signal.optionType} />
          <span className="text-xs font-mono font-bold text-foreground">
            {signal.index} {signal.strike} {signal.optionType}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ConfidenceBadge confidence={signal.confidence} />
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
            signal.strength === 'HIGH' ? 'bg-profit/20 text-profit' : 'bg-warning/20 text-warning'
          }`}>
            {signal.strength}
          </span>
          <button onClick={() => onDismiss(signal.id)} className="text-muted-foreground hover:text-foreground ml-1">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Strategy + reason */}
      <div className="flex items-center gap-1.5 mb-2">
        <TrendingUp className="w-3 h-3 text-signal" />
        <span className="text-[11px] font-semibold text-signal">{signal.strategy}</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ml-auto ${
          ['Breakout Buy','Breakdown Sell','Support Bounce','Resistance Rejection','Momentum Up','Momentum Down','MTF Strong Buy','MTF Strong Sell','Trend Continuation'].includes(signal.strategy)
            ? 'bg-signal/20 text-signal' : 'bg-accent text-accent-foreground'
        }`}>
          {['Breakout Buy','Breakdown Sell','Support Bounce','Resistance Rejection','Momentum Up','Momentum Down','MTF Strong Buy','MTF Strong Sell','Trend Continuation'].includes(signal.strategy) ? 'Price Action' : 'OI Analysis'}
        </span>
      </div>

      {/* Price grid */}
      <div className={`grid ${expanded ? 'grid-cols-4' : 'grid-cols-2'} gap-1 text-xs mb-2`}>
        <div>
          <span className="text-muted-foreground">Entry </span>
          <span className="font-mono">₹{signal.currentPrice.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Qty </span>
          <span className="font-mono">{signal.suggestedQty}</span>
        </div>
        <div>
          <span className="text-muted-foreground">SL </span>
          <span className="font-mono text-loss">₹{stopLoss.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Target </span>
          <span className="font-mono text-profit">₹{target.toFixed(2)}</span>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground mb-3">{signal.reason}</p>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant={signal.optionType === 'CE' ? 'buy' : 'sell'}
          size="sm"
          className="h-7 text-xs px-3 flex-1 font-mono font-bold"
          onClick={() => onExecuteTrade ? onExecuteTrade(signal) : onConfirm(signal)}
          disabled={riskLimitReached}
        >
          ⚡ Execute Trade
        </Button>
        {onViewInChain && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2 font-mono"
            onClick={() => onViewInChain(signal.strike)}
          >
            <Target className="w-3 h-3 mr-1" />
            Chain
          </Button>
        )}
      </div>
    </div>
  );
}

export function SignalPanel({ signals, onConfirm, onDismiss, riskLimitReached, onExecuteTrade, onViewInChain }: SignalPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const panelContent = (
    <>
      {riskLimitReached && (
        <div className="bg-loss/10 border border-loss/30 rounded-md p-2 text-xs text-loss">
          ⚠ Risk limit reached — signals paused
        </div>
      )}
      {signals.length === 0 && !riskLimitReached && (
        <div className="text-center text-muted-foreground text-xs py-8">
          <Zap className="w-5 h-5 mx-auto mb-2 opacity-30" />
          Monitoring for signals...
        </div>
      )}
      {signals.map((signal) => (
        <SignalCard
          key={signal.id}
          signal={signal}
          onConfirm={onConfirm}
          onDismiss={onDismiss}
          riskLimitReached={riskLimitReached}
          onExecuteTrade={onExecuteTrade}
          onViewInChain={onViewInChain}
          expanded={expanded}
        />
      ))}
    </>
  );

  return (
    <>
      {/* Collapsed sidebar panel */}
      <div className="panel flex flex-col h-full min-h-[200px]">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-signal" />
            <span>Trade Signals</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-signal font-mono">{signals.length}</span>
            <button onClick={() => setExpanded(true)} className="text-muted-foreground hover:text-foreground" title="Expand">
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-2">
          {panelContent}
        </div>
      </div>

      {/* Expanded drawer */}
      <Sheet open={expanded} onOpenChange={setExpanded}>
        <SheetContent side="right" className="w-[480px] sm:w-[520px] bg-card border-border p-0">
          <SheetHeader className="px-4 py-3 border-b border-border">
            <SheetTitle className="flex items-center gap-2 text-sm font-mono">
              <Zap className="w-4 h-4 text-signal" />
              Trade Signals
              <span className="text-signal font-mono ml-1">{signals.length}</span>
              <button onClick={() => setExpanded(false)} className="ml-auto text-muted-foreground hover:text-foreground">
                <Minimize2 className="w-4 h-4" />
              </button>
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {panelContent}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
