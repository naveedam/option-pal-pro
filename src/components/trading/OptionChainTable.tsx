import { useState } from 'react';
import type { OptionData } from '@/hooks/useMarketData';

interface OptionChainTableProps {
  chain: OptionData[];
  index: string;
}

export function OptionChainTable({ chain, index }: OptionChainTableProps) {
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);

  return (
    <div className="panel flex-1 flex flex-col min-h-0">
      <div className="panel-header">
        <span>{index} Option Chain</span>
        <span className="text-primary font-mono">Nearest Expiry</span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="text-muted-foreground border-b border-border">
              <th className="px-2 py-1.5 text-right text-profit/70" colSpan={6}>— CALLS —</th>
              <th className="px-2 py-1.5 text-center border-x border-border">STRIKE</th>
              <th className="px-2 py-1.5 text-left text-loss/70" colSpan={6}>— PUTS —</th>
            </tr>
            <tr className="text-muted-foreground border-b border-border">
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
            </tr>
          </thead>
          <tbody>
            {chain.map((row) => (
              <tr
                key={row.strike}
                className={`border-b border-border/50 transition-colors ${
                  row.isATM ? 'atm-row' : ''
                } ${hoveredStrike === row.strike ? 'bg-secondary/50' : 'hover:bg-secondary/30'}`}
                onMouseEnter={() => setHoveredStrike(row.strike)}
                onMouseLeave={() => setHoveredStrike(null)}
              >
                <td className="px-2 py-1 text-right">{row.callOI.toLocaleString()}</td>
                <td className={`px-2 py-1 text-right ${row.callOIChange > 0 ? 'text-profit' : 'text-loss'}`}>
                  {row.callOIChange > 0 ? '+' : ''}{row.callOIChange.toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right">{row.callVolume.toLocaleString()}</td>
                <td className="px-2 py-1 text-right text-muted-foreground">{row.callBid.toFixed(2)}</td>
                <td className="px-2 py-1 text-right text-muted-foreground">{row.callAsk.toFixed(2)}</td>
                <td className="px-2 py-1 text-right font-semibold">{row.callLTP.toFixed(2)}</td>
                <td className={`px-2 py-1 text-center font-bold border-x border-border ${
                  row.isATM ? 'text-primary terminal-glow' : ''
                }`}>
                  {row.strike}
                </td>
                <td className="px-2 py-1 text-right font-semibold">{row.putLTP.toFixed(2)}</td>
                <td className="px-2 py-1 text-right text-muted-foreground">{row.putBid.toFixed(2)}</td>
                <td className="px-2 py-1 text-right text-muted-foreground">{row.putAsk.toFixed(2)}</td>
                <td className="px-2 py-1 text-right">{row.putVolume.toLocaleString()}</td>
                <td className={`px-2 py-1 text-right ${row.putOIChange > 0 ? 'text-profit' : 'text-loss'}`}>
                  {row.putOIChange > 0 ? '+' : ''}{row.putOIChange.toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right">{row.putOI.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
