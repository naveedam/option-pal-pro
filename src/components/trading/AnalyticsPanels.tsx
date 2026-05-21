import { useMemo } from 'react';
import type { OptionData, MarketData } from '@/hooks/useMarketData';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, BarChart3, Flame, Target } from 'lucide-react';

interface AnalyticsPanelsProps {
  chain: OptionData[];
  spotPrice: number;
  index: string;
  maxPain?: number;
}

interface GammaWallData {
  strike: number;
  combinedOI: number;
  proximity: number;
  warning: boolean;
}

interface DealerData {
  strike: number;
  netPosition: number;
}

interface OIChangeData {
  strike: number;
  callOIChange: number;
  putOIChange: number;
}

function computeGammaWall(chain: OptionData[], spotPrice: number): GammaWallData {
  let maxOI = 0, gammaStrike = 0;
  for (const row of chain) {
    const combined = row.callOI + row.putOI;
    if (combined > maxOI) { maxOI = combined; gammaStrike = row.strike; }
  }
  const proximity = spotPrice > 0 ? Math.abs(gammaStrike - spotPrice) / spotPrice * 100 : 0;
  return { strike: gammaStrike, combinedOI: maxOI, proximity, warning: proximity < 0.5 };
}

function computeDealerPositioning(chain: OptionData[]): DealerData[] {
  return chain.map(row => ({ strike: row.strike, netPosition: row.putOI - row.callOI }));
}

function computeOIChanges(chain: OptionData[]): { majorCallWriting: number; majorPutWriting: number; topChanges: OIChangeData[] } {
  let maxCallChange = 0, maxCallStrike = 0;
  let maxPutChange = 0, maxPutStrike = 0;
  for (const row of chain) {
    if (row.callOIChange > maxCallChange) { maxCallChange = row.callOIChange; maxCallStrike = row.strike; }
    if (row.putOIChange > maxPutChange) { maxPutChange = row.putOIChange; maxPutStrike = row.strike; }
  }
  const topChanges = chain
    .filter(r => Math.abs(r.callOIChange) > 0 || Math.abs(r.putOIChange) > 0)
    .sort((a, b) => (Math.abs(b.callOIChange) + Math.abs(b.putOIChange)) - (Math.abs(a.callOIChange) + Math.abs(a.putOIChange)))
    .slice(0, 5)
    .map(r => ({ strike: r.strike, callOIChange: r.callOIChange, putOIChange: r.putOIChange }));
  return { majorCallWriting: maxCallStrike, majorPutWriting: maxPutStrike, topChanges };
}

function calculateMaxPain(chain: OptionData[]): number {
  if (chain.length === 0) return 0;
  const strikes = chain.map(r => r.strike);
  let minPain = Infinity;
  let maxPainStrike = 0;
  for (const expiry of strikes) {
    let totalPain = 0;
    for (const row of chain) {
      // Call pain: call writers lose when spot > strike
      if (expiry > row.strike) totalPain += (expiry - row.strike) * row.callOI;
      // Put pain: put writers lose when spot < strike
      if (expiry < row.strike) totalPain += (row.strike - expiry) * row.putOI;
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = expiry; }
  }
  return maxPainStrike;
}

export function AnalyticsPanels({ chain, spotPrice, index, maxPain = 0 }: AnalyticsPanelsProps) {
  const gamma = useMemo(() => computeGammaWall(chain, spotPrice), [chain, spotPrice]);
  const dealer = useMemo(() => computeDealerPositioning(chain), [chain]);
  const oiChanges = useMemo(() => computeOIChanges(chain), [chain]);

  const totalNet = useMemo(() => dealer.reduce((s, d) => s + d.netPosition, 0), [dealer]);
  const dealerGammaLabel = totalNet > 0 ? 'Long Gamma' : 'Short Gamma';
  const dealerGammaColor = totalNet > 0 ? 'text-profit' : 'text-loss';

  const topDealerStrikes = useMemo(() =>
    [...dealer].sort((a, b) => Math.abs(b.netPosition) - Math.abs(a.netPosition)).slice(0, 5),
    [dealer]
  );

  const computedMaxPain = useMemo(() => calculateMaxPain(chain), [chain]);
  const effectiveMaxPain = maxPain > 0 ? maxPain : computedMaxPain;
  const maxPainDistance = spotPrice > 0 && effectiveMaxPain > 0 ? effectiveMaxPain - spotPrice : 0;
  const maxPainPct = spotPrice > 0 && effectiveMaxPain > 0 ? ((maxPainDistance) / spotPrice * 100) : 0;
  const maxPainBias = maxPainDistance > 0 ? 'Bullish Pull' : maxPainDistance < 0 ? 'Bearish Pull' : 'Neutral';
  const maxPainBiasColor = maxPainDistance > 0 ? 'text-profit' : maxPainDistance < 0 ? 'text-loss' : 'text-muted-foreground';

  if (chain.length === 0) return null;

  return (
    <div className="grid grid-cols-4 gap-2">
      {/* Gamma Wall */}
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-mono flex items-center gap-1.5">
            <Flame className="w-3 h-3 text-warning" />
            GAMMA WALL
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2 space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Strike</span>
            <span className={gamma.warning ? 'text-warning font-bold' : 'text-foreground'}>
              {gamma.strike || '—'}
            </span>
          </div>
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Combined OI</span>
            <span>{gamma.combinedOI.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Proximity</span>
            <span className={gamma.warning ? 'text-warning' : 'text-muted-foreground'}>
              {gamma.proximity.toFixed(2)}%
            </span>
          </div>
          {gamma.warning && (
            <div className="flex items-center gap-1 text-[10px] text-warning font-mono mt-1">
              <AlertTriangle className="w-3 h-3" />
              Dealer hedge zone approaching
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dealer Positioning */}
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-mono flex items-center gap-1.5">
            <BarChart3 className="w-3 h-3 text-primary" />
            DEALER POSITIONING
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2 space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Dealer Gamma</span>
            <span className={dealerGammaColor}>{dealerGammaLabel}</span>
          </div>
          <div className="text-[10px] text-muted-foreground font-mono mb-1">
            {totalNet > 0 ? 'Expect mean reversion' : 'Expect trending moves'}
          </div>
          <div className="space-y-0.5">
            {topDealerStrikes.map(d => {
              const maxAbs = Math.max(...topDealerStrikes.map(x => Math.abs(x.netPosition)), 1);
              const pct = Math.abs(d.netPosition) / maxAbs * 100;
              return (
                <div key={d.strike} className="flex items-center gap-1 text-[10px] font-mono">
                  <span className="w-10 text-right text-muted-foreground">{d.strike}</span>
                  <div className="flex-1 h-2 bg-secondary rounded overflow-hidden">
                    <div
                      className={`h-full rounded ${d.netPosition > 0 ? 'bg-profit/60' : 'bg-loss/60'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* OI Change Heatmap */}
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-mono flex items-center gap-1.5">
            <Flame className="w-3 h-3 text-loss" />
            OI CHANGE
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2 space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Major Call Writing</span>
            <span className="text-loss">{oiChanges.majorCallWriting || '—'}</span>
          </div>
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Major Put Writing</span>
            <span className="text-profit">{oiChanges.majorPutWriting || '—'}</span>
          </div>
          <div className="border-t border-border mt-1 pt-1 space-y-0.5">
            {oiChanges.topChanges.map(tc => (
              <div key={tc.strike} className="flex items-center gap-1 text-[10px] font-mono">
                <span className="w-10 text-right text-muted-foreground">{tc.strike}</span>
                <span className={`w-14 text-right ${tc.callOIChange > 0 ? 'text-loss' : 'text-profit'}`}>
                  C:{tc.callOIChange > 0 ? '+' : ''}{(tc.callOIChange / 1000).toFixed(1)}k
                </span>
                <span className={`w-14 text-right ${tc.putOIChange > 0 ? 'text-profit' : 'text-loss'}`}>
                  P:{tc.putOIChange > 0 ? '+' : ''}{(tc.putOIChange / 1000).toFixed(1)}k
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Max Pain */}
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-mono flex items-center gap-1.5">
            <Target className="w-3 h-3 text-signal" />
            MAX PAIN
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2 space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Strike</span>
            <span className="text-foreground font-bold">{effectiveMaxPain || '—'}</span>
          </div>
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">Distance</span>
            <span className={maxPainBiasColor}>
              {maxPainDistance > 0 ? '+' : ''}{maxPainDistance.toFixed(0)} pts
            </span>
          </div>
          <div className="flex justify-between text-xs font-mono">
            <span className="text-muted-foreground">% Away</span>
            <span className={maxPainBiasColor}>
              {maxPainPct > 0 ? '+' : ''}{maxPainPct.toFixed(2)}%
            </span>
          </div>
          <div className="flex justify-between text-xs font-mono mt-1">
            <span className="text-muted-foreground">Bias</span>
            <span className={maxPainBiasColor}>{maxPainBias}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
