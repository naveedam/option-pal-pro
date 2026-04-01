import { useMemo } from 'react';
import type { TradeSignal } from './useMarketData';
import type { StoredTrade } from './useTradeStore';

export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpeApprox: number;
}

export function runBacktest(trades: StoredTrade[]): BacktestResult {
  const closed = trades.filter(t => t.status === 'closed' && t.exit_price !== null);
  
  if (closed.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnL: 0, avgWin: 0, avgLoss: 0, maxDrawdown: 0,
      profitFactor: 0, sharpeApprox: 0,
    };
  }

  const pnls = closed.map(t => Number(t.pnl));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);

  const totalPnL = pnls.reduce((s, p) => s + p, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length) : 0;
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

  // Max drawdown from equity curve
  let peak = 0;
  let maxDrawdown = 0;
  let equity = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Approximate Sharpe (daily returns proxy)
  const mean = totalPnL / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  const sharpeApprox = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / closed.length) * 100,
    totalPnL,
    avgWin,
    avgLoss,
    maxDrawdown,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpeApprox,
  };
}

export function useBacktest(trades: StoredTrade[]): BacktestResult {
  return useMemo(() => runBacktest(trades), [trades]);
}
