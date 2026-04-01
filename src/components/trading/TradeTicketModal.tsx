import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TradeSignal } from '@/hooks/useMarketData';

interface TradeTicketModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signal: TradeSignal | null;
  onExecute: (params: {
    symbol: string;
    strike: number;
    optionType: 'CE' | 'PE';
    quantity: number;
    orderType: string;
    transactionType: 'BUY' | 'SELL';
  }) => void;
  isPaperTrading: boolean;
}

export function TradeTicketModal({ open, onOpenChange, signal, onExecute, isPaperTrading }: TradeTicketModalProps) {
  const [quantity, setQuantity] = useState(signal?.suggestedQty || 25);
  const [orderType, setOrderType] = useState('MARKET');
  const [transactionType, setTransactionType] = useState<'BUY' | 'SELL'>('BUY');

  // Update qty when signal changes
  if (signal && quantity !== signal.suggestedQty && quantity === 25) {
    setQuantity(signal.suggestedQty);
  }

  if (!signal) return null;

  const stopLoss = signal.optionType === 'CE'
    ? signal.currentPrice * 0.98
    : signal.currentPrice * 0.98;
  const target = signal.currentPrice * 1.04;

  const handleExecute = (side: 'BUY' | 'SELL') => {
    onExecute({
      symbol: signal.index,
      strike: signal.strike,
      optionType: signal.optionType,
      quantity,
      orderType,
      transactionType: side,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <span className={signal.optionType === 'CE' ? 'text-profit' : 'text-loss'}>
              {signal.optionType === 'CE' ? '▲' : '▼'}
            </span>
            {signal.index} {signal.strike} {signal.optionType}
            <span className="text-xs text-muted-foreground ml-auto">
              {isPaperTrading ? '📝 PAPER' : '🔴 LIVE'}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Signal info */}
          <div className="bg-secondary/50 rounded-md p-3 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Strategy</span>
              <span className="font-mono text-signal">{signal.strategy}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Confidence</span>
              <span className={`font-mono font-bold ${signal.confidence >= 75 ? 'text-profit' : signal.confidence >= 50 ? 'text-warning' : 'text-muted-foreground'}`}>
                {signal.confidence}%
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Entry Price</span>
              <span className="font-mono">₹{signal.currentPrice.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Stop Loss</span>
              <span className="font-mono text-loss">₹{stopLoss.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Target</span>
              <span className="font-mono text-profit">₹{target.toFixed(2)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1 border-t border-border">{signal.reason}</p>
          </div>

          {/* Order params */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Quantity</Label>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="font-mono text-sm h-9 bg-secondary border-border"
                min={1}
                step={signal.index === 'NIFTY' ? 25 : 10}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Order Type</Label>
              <Select value={orderType} onValueChange={setOrderType}>
                <SelectTrigger className="h-9 text-xs font-mono bg-secondary border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MARKET">MARKET</SelectItem>
                  <SelectItem value="LIMIT">LIMIT</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Risk summary */}
          <div className="bg-secondary/30 rounded-md p-2 text-[10px] font-mono text-muted-foreground">
            Max Risk: ₹{(quantity * stopLoss * 0.02).toFixed(0)} | 
            Target P&L: ₹{(quantity * (target - signal.currentPrice)).toFixed(0)} |
            R:R = 1:{((target - signal.currentPrice) / (signal.currentPrice - stopLoss)).toFixed(1)}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              variant="default"
              className="flex-1 bg-profit text-primary-foreground hover:bg-profit/90 font-mono font-bold"
              onClick={() => handleExecute('BUY')}
            >
              BUY
            </Button>
            <Button
              variant="default"
              className="flex-1 bg-loss text-destructive-foreground hover:bg-loss/90 font-mono font-bold"
              onClick={() => handleExecute('SELL')}
            >
              SELL
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
