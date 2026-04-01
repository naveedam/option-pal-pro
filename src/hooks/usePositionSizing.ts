import { useCallback } from 'react';

export interface SizingParams {
  capital: number;
  riskPerTrade: number; // fraction, e.g. 0.02 = 2%
  stopLossPoints: number;
  lotSize: number; // minimum lot size (NIFTY=25, SENSEX=10)
}

export function calculateQty(params: SizingParams): number {
  const { capital, riskPerTrade, stopLossPoints, lotSize } = params;
  if (stopLossPoints <= 0 || capital <= 0 || lotSize <= 0) return lotSize;
  
  const riskAmount = capital * riskPerTrade;
  const rawQty = Math.floor(riskAmount / stopLossPoints);
  // Round down to nearest lot size
  const lots = Math.max(1, Math.floor(rawQty / lotSize));
  return lots * lotSize;
}

export function usePositionSizing() {
  const getSuggestedQty = useCallback((
    capital: number,
    riskPct: number,
    entryPrice: number,
    stopLossPct: number = 0.02, // default 2% SL
    index: 'NIFTY' | 'SENSEX' = 'NIFTY'
  ): { qty: number; stopLoss: number; riskAmount: number } => {
    const lotSize = index === 'NIFTY' ? 25 : 10;
    const stopLossPoints = entryPrice * stopLossPct;
    const stopLoss = entryPrice - stopLossPoints;
    
    const qty = calculateQty({
      capital,
      riskPerTrade: riskPct,
      stopLossPoints,
      lotSize,
    });

    return {
      qty,
      stopLoss: Math.round(stopLoss * 100) / 100,
      riskAmount: Math.round(qty * stopLossPoints * 100) / 100,
    };
  }, []);

  return { getSuggestedQty, calculateQty };
}
