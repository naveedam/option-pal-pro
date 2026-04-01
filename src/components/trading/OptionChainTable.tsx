import { useState } from 'react';
import type { OptionData } from '@/hooks/useMarketData';
import { useSmartMoney, LABEL_COLORS, LABEL_SHORT } from '@/hooks/useSmartMoney';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface OptionChainTableProps {
  chain: OptionData[];
  index: string;
  highlightedStrike?: number | null;
}

function HeatCell({ intensity, side }: { intensity: number; side: 'call' | 'put' }) {
  const alpha = Math.round((intensity / 100) * 40) / 100; // max 0.4 opacity
  const color = side === 'call' ? `hsl(var(--loss) / ${alpha})` : `hsl(var(--profit) / ${alpha})`;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ backgroundColor: color }}
    />
  );
}

export function OptionChainTable({ chain, index }: OptionChainTableProps) {
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);
  const smartMoney = useSmartMoney(chain);

  return (
    <div className="panel flex-1 flex flex-col min-h-0">
      <div className="panel-header">
        <span>{index} Option Chain</span>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="text-profit">S: {smartMoney.supportLevel}</span>
          <span className="text-loss">R: {smartMoney.resistanceLevel}</span>
          <span className="text-warning">γ: {smartMoney.gammaWall}</span>
          <span className="text-primary">Nearest Expiry</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="text-muted-foreground border-b border-border">
              <th className="px-2 py-1.5 text-right text-profit/70" colSpan={7}>— CALLS —</th>
              <th className="px-2 py-1.5 text-center border-x border-border">STRIKE</th>
              <th className="px-2 py-1.5 text-left text-loss/70" colSpan={7}>— PUTS —</th>
            </tr>
            <tr className="text-muted-foreground border-b border-border">
              <th className="px-1 py-1 text-center w-8">SM</th>
              <th className="px-2 py-1 text-right">OI</th>
              <th className="px-2 py-1 text-right">Chg</th>
              <th className="px-2 py-1 text-right">Vol</th>
              <th className="px-2 py-1 text-right">Bid</th>
              <th className="px-2 py-1 text-right">Ask</th>
              <th className="px-2 py-1 text-right">LTP</th>
              <th className="px-2 py-1 text-center border-x border-border"></th>
              <th className="px-2 py-1 text-right">LTP</th>
              <th className="px-2 py-1 text-right">Bid</th>
              <th className="px-2 py-1 text-right">Ask</th>
              <th className="px-2 py-1 text-right">Vol</th>
              <th className="px-2 py-1 text-right">Chg</th>
              <th className="px-2 py-1 text-right">OI</th>
              <th className="px-1 py-1 text-center w-8">SM</th>
            </tr>
          </thead>
          <tbody>
            {chain.map((row) => {
              const analysis = smartMoney.strikeAnalysis.get(row.strike);
              const callEvents = analysis?.events.filter(e => e.side === 'call') || [];
              const putEvents = analysis?.events.filter(e => e.side === 'put') || [];

              return (
                <tr
                  key={row.strike}
                  className={`border-b border-border/50 transition-colors ${
                    row.isATM ? 'atm-row' : ''
                  } ${analysis?.isSupport ? 'border-l-2 border-l-profit' : ''}
                    ${analysis?.isResistance ? 'border-r-2 border-r-loss' : ''}
                    ${hoveredStrike === row.strike ? 'bg-secondary/50' : 'hover:bg-secondary/30'}`}
                  onMouseEnter={() => setHoveredStrike(row.strike)}
                  onMouseLeave={() => setHoveredStrike(null)}
                >
                  {/* Call smart money labels */}
                  <td className="px-1 py-1 text-center relative">
                    <HeatCell intensity={analysis?.callHeatIntensity || 0} side="call" />
                    {callEvents.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={`text-[9px] font-bold cursor-help ${LABEL_COLORS[callEvents[0].label]}`}>
                            {LABEL_SHORT[callEvents[0].label]}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs">
                          {callEvents.map((e, i) => (
                            <div key={i} className={LABEL_COLORS[e.label]}>
                              {e.label.replace('_', ' ')} ({e.intensity}%)
                            </div>
                          ))}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right relative">
                    <HeatCell intensity={analysis?.callHeatIntensity || 0} side="call" />
                    <span className="relative">
                      {row.callOI.toLocaleString()}
                      {row.oiSource === 'nse' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-profit ml-1 align-middle" title="Real NSE OI" />}
                      {row.oiSource === 'synthetic' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning ml-1 align-middle" title="Estimated OI" />}
                    </span>
                  </td>
                  <td className={`px-2 py-1 text-right ${row.callOIChange > 0 ? 'text-profit' : 'text-loss'}`}>
                    {row.callOIChange > 0 ? '+' : ''}{row.callOIChange.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right">{row.callVolume.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right text-muted-foreground">{row.callBid.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-muted-foreground">{row.callAsk.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right font-semibold">{row.callLTP.toFixed(2)}</td>
                  <td className={`px-2 py-1 text-center font-bold border-x border-border ${
                    row.isATM ? 'text-primary terminal-glow' : ''
                  } ${analysis?.isGammaWall ? 'text-warning' : ''}`}>
                    {row.strike}
                    {analysis?.isGammaWall && <span className="text-[8px] text-warning ml-0.5">γ</span>}
                  </td>
                  <td className="px-2 py-1 text-right font-semibold">{row.putLTP.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-muted-foreground">{row.putBid.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-muted-foreground">{row.putAsk.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right">{row.putVolume.toLocaleString()}</td>
                  <td className={`px-2 py-1 text-right ${row.putOIChange > 0 ? 'text-profit' : 'text-loss'}`}>
                    {row.putOIChange > 0 ? '+' : ''}{row.putOIChange.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right relative">
                    <HeatCell intensity={analysis?.putHeatIntensity || 0} side="put" />
                    <span className="relative">
                      {row.putOI.toLocaleString()}
                      {row.oiSource === 'nse' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-profit ml-1 align-middle" title="Real NSE OI" />}
                      {row.oiSource === 'synthetic' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning ml-1 align-middle" title="Estimated OI" />}
                    </span>
                  </td>
                  {/* Put smart money labels */}
                  <td className="px-1 py-1 text-center relative">
                    <HeatCell intensity={analysis?.putHeatIntensity || 0} side="put" />
                    {putEvents.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={`text-[9px] font-bold cursor-help ${LABEL_COLORS[putEvents[0].label]}`}>
                            {LABEL_SHORT[putEvents[0].label]}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-xs">
                          {putEvents.map((e, i) => (
                            <div key={i} className={LABEL_COLORS[e.label]}>
                              {e.label.replace('_', ' ')} ({e.intensity}%)
                            </div>
                          ))}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Smart Money Legend */}
      <div className="px-3 py-1.5 border-t border-border flex items-center gap-3 text-[9px] font-mono text-muted-foreground flex-wrap">
        <span className="text-loss">CW=Call Writing</span>
        <span className="text-profit">PW=Put Writing</span>
        <span className="text-profit">LB=Long Buildup</span>
        <span className="text-loss">SB=Short Buildup</span>
        <span className="text-warning">SC=Short Covering</span>
        <span className="text-warning">LU=Long Unwinding</span>
        <span className="border-l border-border pl-3 ml-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-profit mr-0.5 align-middle" />Real OI
        </span>
        <span>
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning mr-0.5 align-middle" />Est
        </span>
      </div>
    </div>
  );
}
