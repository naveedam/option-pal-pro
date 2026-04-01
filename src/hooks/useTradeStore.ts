import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { TradeSignal, Position } from './useMarketData';

export interface StoredTrade {
  id: string;
  order_id: string;
  symbol: string;
  strike: number;
  option_type: 'CE' | 'PE';
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number;
  status: 'open' | 'closed';
  is_paper: boolean;
  created_at: string;
  closed_at: string | null;
  signal_type: string | null;
  signal_strategy: string | null;
  signal_confidence: number | null;
  stop_loss: number | null;
  notes: string | null;
}

export function useTradeStore() {
  const [trades, setTrades] = useState<StoredTrade[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrades = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (!error && data) {
      setTrades(data as unknown as StoredTrade[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTrades();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('trades-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades' }, () => {
        fetchTrades();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchTrades]);

  const saveTrade = useCallback(async (position: Position, isPaper: boolean): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;

    const { data, error } = await supabase.from('trades').insert({
      user_id: session.user.id,
      order_id: position.orderId,
      symbol: position.symbol,
      strike: position.strike,
      option_type: position.optionType,
      quantity: position.quantity,
      entry_price: position.entryPrice,
      pnl: 0,
      status: 'open',
      is_paper: isPaper,
    }).select('id').single();

    if (error) {
      console.error('Failed to save trade:', error);
      return null;
    }
    return data?.id || null;
  }, []);

  const closeTrade = useCallback(async (tradeId: string, exitPrice: number, pnl: number) => {
    const { error } = await supabase.from('trades').update({
      exit_price: exitPrice,
      pnl,
      status: 'closed',
      closed_at: new Date().toISOString(),
    }).eq('id', tradeId);

    if (error) console.error('Failed to close trade:', error);
  }, []);

  const openTrades = trades.filter(t => t.status === 'open');
  const closedTrades = trades.filter(t => t.status === 'closed');

  return { trades, openTrades, closedTrades, loading, saveTrade, closeTrade, fetchTrades };
}
