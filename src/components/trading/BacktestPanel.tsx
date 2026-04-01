import { TrendingUp, TrendingDown, BarChart3, Target } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BacktestResult } from '@/hooks/useBacktest';

interface BacktestPanelProps {
  result: BacktestResult;
}

export function BacktestPanel({ result }: BacktestPanelProps) {
  if (result.totalTrades === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-mono flex items-center gap-1.5">
            <BarChart3 className="w-3 h-3 text-primary" />
            PERFORMANCE
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2">
          <p className="text-xs text-muted-foreground text-center py-2">No closed trades yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="py-2 px-3">
        <CardTitle className="text-xs font-mono flex items-center gap-1.5">
          <BarChart3 className="w-3 h-3 text-primary" />
          PERFORMANCE
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-2 space-y-1">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Stat label="Win Rate" value={`${result.winRate.toFixed(1)}%`} color={result.winRate >= 50 ? 'text-profit' : 'text-loss'} />
          <Stat label="Total P&L" value={`₹${result.totalPnL.toFixed(0)}`} color={result.totalPnL >= 0 ? 'text-profit' : 'text-loss'} />
          <Stat label="Wins/Losses" value={`${result.wins}/${result.losses}`} />
          <Stat label="Profit Factor" value={result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)} color={result.profitFactor >= 1 ? 'text-profit' : 'text-loss'} />
          <Stat label="Avg Win" value={`₹${result.avgWin.toFixed(0)}`} color="text-profit" />
          <Stat label="Avg Loss" value={`₹${result.avgLoss.toFixed(0)}`} color="text-loss" />
          <Stat label="Max Drawdown" value={`₹${result.maxDrawdown.toFixed(0)}`} color="text-loss" />
          <Stat label="Sharpe" value={result.sharpeApprox.toFixed(2)} color={result.sharpeApprox >= 1 ? 'text-profit' : 'text-muted-foreground'} />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, color = 'text-foreground' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between text-xs font-mono">
      <span className="text-muted-foreground">{label}</span>
      <span className={color}>{value}</span>
    </div>
  );
}
