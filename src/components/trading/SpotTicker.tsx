import { TrendingUp, TrendingDown } from 'lucide-react';

interface SpotTickerProps {
  label: string;
  price: number;
  change: number;
  pcr: number;
  atm: number;
}

export function SpotTicker({ label, price, change, pcr, atm }: SpotTickerProps) {
  const isPositive = change >= 0;

  return (
    <div className="panel p-3 min-w-[200px]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">{label}</span>
        <div className={`flex items-center gap-1 text-xs ${isPositive ? 'text-profit' : 'text-loss'}`}>
          {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          <span className="font-mono">{isPositive ? '+' : ''}{change.toFixed(2)}</span>
        </div>
      </div>
      <div className="ticker-value text-xl font-bold terminal-glow">
        {price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
      </div>
      <div className="flex gap-4 mt-1.5">
        <div className="text-xs">
          <span className="text-muted-foreground">PCR </span>
          <span className={`font-mono ${pcr > 1.2 ? 'text-profit' : pcr < 0.8 ? 'text-loss' : 'text-foreground'}`}>
            {pcr.toFixed(2)}
          </span>
        </div>
        <div className="text-xs">
          <span className="text-muted-foreground">ATM </span>
          <span className="font-mono">{atm}</span>
        </div>
      </div>
    </div>
  );
}
