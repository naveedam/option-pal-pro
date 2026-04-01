import { TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface PnLTrackerProps {
  dailyPnL: number;
  tradesToday: number;
  openPositions: number;
}

export function PnLTracker({ dailyPnL, tradesToday, openPositions }: PnLTrackerProps) {
  const isProfit = dailyPnL >= 0;

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 bg-secondary/50 rounded-md border border-border">
      <div className="flex items-center gap-1.5">
        {isProfit ? (
          <TrendingUp className="w-3.5 h-3.5 text-profit" />
        ) : (
          <TrendingDown className="w-3.5 h-3.5 text-loss" />
        )}
        <span className="text-[10px] text-muted-foreground font-mono">P&L</span>
        <span className={`text-xs font-mono font-bold ${isProfit ? 'text-profit' : 'text-loss'}`}>
          {isProfit ? '+' : ''}₹{dailyPnL.toFixed(0)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Activity className="w-3 h-3 text-muted-foreground" />
        <span className="text-[10px] font-mono text-muted-foreground">
          {tradesToday} trades
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="status-dot status-connected" style={{ width: 6, height: 6 }} />
        <span className="text-[10px] font-mono text-muted-foreground">
          {openPositions} open
        </span>
      </div>
    </div>
  );
}
