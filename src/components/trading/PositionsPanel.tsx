import type { Position } from '@/hooks/useMarketData';

interface PositionsPanelProps {
  positions: Position[];
  dailyPnL: number;
  tradesToday: number;
}

export function PositionsPanel({ positions, dailyPnL, tradesToday }: PositionsPanelProps) {
  const openPositions = positions.slice(0, 10);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Positions & Trade Log</span>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono">
            Trades: <span className="text-foreground">{tradesToday}</span>
          </span>
          <span className={`text-xs font-mono font-bold ${dailyPnL >= 0 ? 'text-profit' : 'text-loss'}`}>
            P&L: {dailyPnL >= 0 ? '+' : ''}₹{dailyPnL.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {positions.length === 0 ? (
          <div className="text-center text-muted-foreground text-xs py-6">
            No positions yet
          </div>
        ) : (
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-card">
              <tr className="text-muted-foreground border-b border-border">
                <th className="px-2 py-1.5 text-left">Order</th>
                <th className="px-2 py-1.5 text-left">Symbol</th>
                <th className="px-2 py-1.5 text-right">Strike</th>
                <th className="px-2 py-1.5 text-center">Type</th>
                <th className="px-2 py-1.5 text-right">Qty</th>
                <th className="px-2 py-1.5 text-right">Entry</th>
                <th className="px-2 py-1.5 text-right">CMP</th>
                <th className="px-2 py-1.5 text-right">P&L</th>
              </tr>
            </thead>
            <tbody>
              {openPositions.map((pos) => (
                <tr key={pos.id} className="border-b border-border/50 hover:bg-secondary/30">
                  <td className="px-2 py-1 text-muted-foreground text-[10px]">{pos.orderId.slice(0, 12)}</td>
                  <td className="px-2 py-1">{pos.symbol}</td>
                  <td className="px-2 py-1 text-right">{pos.strike}</td>
                  <td className={`px-2 py-1 text-center font-bold ${pos.optionType === 'CE' ? 'text-profit' : 'text-loss'}`}>
                    {pos.optionType}
                  </td>
                  <td className="px-2 py-1 text-right">{pos.quantity}</td>
                  <td className="px-2 py-1 text-right">₹{pos.entryPrice.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right">₹{pos.currentPrice.toFixed(2)}</td>
                  <td className={`px-2 py-1 text-right font-bold ${pos.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {pos.pnl >= 0 ? '+' : ''}₹{pos.pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
