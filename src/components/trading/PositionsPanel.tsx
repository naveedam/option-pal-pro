import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { X } from 'lucide-react';
import type { Position } from '@/hooks/useMarketData';
import type { StoredTrade } from '@/hooks/useTradeStore';

interface PositionsPanelProps {
  positions: Position[];
  dailyPnL: number;
  tradesToday: number;
  onExitPosition: (positionId: string) => void;
  tradeHistory: StoredTrade[];
}

export function PositionsPanel({ positions, dailyPnL, tradesToday, onExitPosition, tradeHistory }: PositionsPanelProps) {
  const [tab, setTab] = useState('open');

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <Tabs value={tab} onValueChange={setTab} className="flex-1">
          <div className="flex items-center justify-between w-full">
            <TabsList className="bg-secondary border border-border h-6">
              <TabsTrigger value="open" className="text-[10px] h-5 px-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                Open ({positions.length})
              </TabsTrigger>
              <TabsTrigger value="history" className="text-[10px] h-5 px-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                History ({tradeHistory.length})
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono">
                Trades: <span className="text-foreground">{tradesToday}</span>
              </span>
              <span className={`text-xs font-mono font-bold ${dailyPnL >= 0 ? 'text-profit' : 'text-loss'}`}>
                P&L: {dailyPnL >= 0 ? '+' : ''}₹{dailyPnL.toFixed(2)}
              </span>
            </div>
          </div>
        </Tabs>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'open' && (
          <>
            {positions.length === 0 ? (
              <div className="text-center text-muted-foreground text-xs py-6">
                No open positions
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
                    <th className="px-2 py-1.5 text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos) => (
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
                      <td className="px-2 py-1 text-center">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-5 text-[10px] px-2 gap-0.5"
                          onClick={() => onExitPosition(pos.id)}
                        >
                          <X className="w-2.5 h-2.5" />
                          EXIT
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {tab === 'history' && (
          <>
            {tradeHistory.length === 0 ? (
              <div className="text-center text-muted-foreground text-xs py-6">
                No trade history
              </div>
            ) : (
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="px-2 py-1.5 text-left">Time</th>
                    <th className="px-2 py-1.5 text-left">Symbol</th>
                    <th className="px-2 py-1.5 text-right">Strike</th>
                    <th className="px-2 py-1.5 text-center">Type</th>
                    <th className="px-2 py-1.5 text-right">Qty</th>
                    <th className="px-2 py-1.5 text-right">Entry</th>
                    <th className="px-2 py-1.5 text-right">Exit</th>
                    <th className="px-2 py-1.5 text-right">P&L</th>
                    <th className="px-2 py-1.5 text-center">Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.map((trade) => (
                    <tr key={trade.id} className="border-b border-border/50 hover:bg-secondary/30">
                      <td className="px-2 py-1 text-muted-foreground text-[10px]">
                        {new Date(trade.created_at).toLocaleTimeString()}
                      </td>
                      <td className="px-2 py-1">{trade.symbol}</td>
                      <td className="px-2 py-1 text-right">{trade.strike}</td>
                      <td className={`px-2 py-1 text-center font-bold ${trade.option_type === 'CE' ? 'text-profit' : 'text-loss'}`}>
                        {trade.option_type}
                      </td>
                      <td className="px-2 py-1 text-right">{trade.quantity}</td>
                      <td className="px-2 py-1 text-right">₹{Number(trade.entry_price).toFixed(2)}</td>
                      <td className="px-2 py-1 text-right">
                        {trade.exit_price ? `₹${Number(trade.exit_price).toFixed(2)}` : '—'}
                      </td>
                      <td className={`px-2 py-1 text-right font-bold ${Number(trade.pnl) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {Number(trade.pnl) >= 0 ? '+' : ''}₹{Number(trade.pnl).toFixed(2)}
                      </td>
                      <td className="px-2 py-1 text-center">
                        <span className={`text-[9px] px-1 py-0.5 rounded ${trade.is_paper ? 'bg-warning/20 text-warning' : 'bg-loss/20 text-loss'}`}>
                          {trade.is_paper ? 'PAPER' : 'LIVE'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
