import { Shield, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RiskSettings } from '@/hooks/useMarketData';

interface RiskControlsProps {
  settings: RiskSettings;
  onUpdate: (settings: RiskSettings) => void;
  tradesToday: number;
  dailyPnL: number;
  riskLimitReached: boolean;
}

export function RiskControls({ settings, onUpdate, tradesToday, dailyPnL, riskLimitReached }: RiskControlsProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5" />
          <span>Risk Controls</span>
        </div>
        {riskLimitReached && (
          <div className="flex items-center gap-1 text-loss">
            <AlertTriangle className="w-3 h-3" />
            <span className="text-[10px]">LIMIT HIT</span>
          </div>
        )}
      </div>
      <div className="p-3 space-y-3">
        <div className="grid grid-cols-6 gap-3">
          <div>
            <Label className="text-[10px] text-muted-foreground">Max Trades/Day</Label>
            <Input
              type="number"
              value={settings.maxTradesPerDay}
              onChange={e => onUpdate({ ...settings, maxTradesPerDay: Number(e.target.value) })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
              Used: <span className={tradesToday >= settings.maxTradesPerDay ? 'text-loss' : 'text-foreground'}>{tradesToday}</span>/{settings.maxTradesPerDay}
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Max Daily Loss (₹)</Label>
            <Input
              type="number"
              value={settings.maxDailyLoss}
              onChange={e => onUpdate({ ...settings, maxDailyLoss: Number(e.target.value) })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
            <div className={`text-[10px] mt-0.5 font-mono ${dailyPnL <= -settings.maxDailyLoss ? 'text-loss' : 'text-muted-foreground'}`}>
              P&L: {dailyPnL >= 0 ? '+' : ''}₹{dailyPnL.toFixed(0)}
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Cooldown (min)</Label>
            <Input
              type="number"
              value={settings.cooldownMinutes}
              onChange={e => onUpdate({ ...settings, cooldownMinutes: Number(e.target.value) })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Capital (₹)</Label>
            <Input
              type="number"
              value={settings.capital}
              onChange={e => onUpdate({ ...settings, capital: Number(e.target.value) })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Risk/Trade (%)</Label>
            <Input
              type="number"
              step="0.5"
              value={(settings.riskPerTrade * 100)}
              onChange={e => onUpdate({ ...settings, riskPerTrade: Number(e.target.value) / 100 })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Stop Loss (%)</Label>
            <Input
              type="number"
              step="0.5"
              value={(settings.stopLossPct * 100)}
              onChange={e => onUpdate({ ...settings, stopLossPct: Number(e.target.value) / 100 })}
              className="h-7 text-xs font-mono bg-secondary border-border"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
