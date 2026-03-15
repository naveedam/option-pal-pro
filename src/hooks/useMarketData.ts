import { useState, useEffect, useCallback, useRef } from 'react';

export interface OptionData {
  strike: number;
  callLTP: number;
  putLTP: number;
  callOI: number;
  putOI: number;
  callOIChange: number;
  putOIChange: number;
  callVolume: number;
  putVolume: number;
  callBid: number;
  callAsk: number;
  putBid: number;
  putAsk: number;
  isATM: boolean;
}

export interface MarketData {
  niftySpot: number;
  sensexSpot: number;
  niftyChange: number;
  sensexChange: number;
  niftyPCR: number;
  sensexPCR: number;
  niftyATM: number;
  sensexATM: number;
  niftyChain: OptionData[];
  sensexChain: OptionData[];
  timestamp: number;
}

export interface TradeSignal {
  id: string;
  index: 'NIFTY' | 'SENSEX';
  strike: number;
  optionType: 'CE' | 'PE';
  strategy: string;
  reason: string;
  currentPrice: number;
  suggestedQty: number;
  timestamp: number;
  strength: 'HIGH' | 'MEDIUM';
  confidence: number; // 0-100
}

export interface Position {
  id: string;
  orderId: string;
  symbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  timestamp: number;
  dbId?: string; // database trade id for persistence
}

export interface RiskSettings {
  maxTradesPerDay: number;
  maxDailyLoss: number;
  cooldownMinutes: number;
}

function generateOptionChain(spotPrice: number, stepSize: number): OptionData[] {
  const atmStrike = Math.round(spotPrice / stepSize) * stepSize;
  const strikes: OptionData[] = [];

  for (let i = -10; i <= 10; i++) {
    const strike = atmStrike + i * stepSize;
    const distFromATM = Math.abs(i);
    const isATM = i === 0;

    const baseCallLTP = Math.max(0, spotPrice - strike) + (10 - distFromATM) * 5 + Math.random() * 20;
    const basePutLTP = Math.max(0, strike - spotPrice) + (10 - distFromATM) * 5 + Math.random() * 20;

    strikes.push({
      strike,
      callLTP: Math.round(baseCallLTP * 100) / 100,
      putLTP: Math.round(basePutLTP * 100) / 100,
      callOI: Math.round((5000 + Math.random() * 50000) / 100) * 100,
      putOI: Math.round((5000 + Math.random() * 50000) / 100) * 100,
      callOIChange: Math.round((Math.random() - 0.4) * 5000),
      putOIChange: Math.round((Math.random() - 0.4) * 5000),
      callVolume: Math.round(Math.random() * 10000),
      putVolume: Math.round(Math.random() * 10000),
      callBid: Math.round((baseCallLTP - Math.random() * 2) * 100) / 100,
      callAsk: Math.round((baseCallLTP + Math.random() * 2) * 100) / 100,
      putBid: Math.round((basePutLTP - Math.random() * 2) * 100) / 100,
      putAsk: Math.round((basePutLTP + Math.random() * 2) * 100) / 100,
      isATM,
    });
  }
  return strikes;
}

function computeConfidence(factors: number[]): number {
  // Average of factor scores, clamped 0-100
  const avg = factors.reduce((s, f) => s + f, 0) / factors.length;
  return Math.max(0, Math.min(100, Math.round(avg)));
}

function generateSignals(data: MarketData): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const now = Date.now();

  const niftyATM = data.niftyChain.find(o => o.isATM);
  if (!niftyATM) return signals;

  // Find max OI strikes for wall detection
  let maxCallOI = 0, maxCallOIStrike = 0;
  let maxPutOI = 0, maxPutOIStrike = 0;
  for (const row of data.niftyChain) {
    if (row.callOI > maxCallOI) { maxCallOI = row.callOI; maxCallOIStrike = row.strike; }
    if (row.putOI > maxPutOI) { maxPutOI = row.putOI; maxPutOIStrike = row.strike; }
  }

  // Strategy 1: PCR Reversal (OI buildup + price movement)
  if (data.niftyPCR < 0.8 && niftyATM.putOIChange > 0) {
    const pcrFactor = Math.min(100, ((0.8 - data.niftyPCR) / 0.3) * 100);
    const oiFactor = Math.min(100, (niftyATM.putOIChange / 3000) * 100);
    signals.push({
      id: `sig-${now}-1`,
      index: 'NIFTY',
      strike: niftyATM.strike,
      optionType: 'PE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} < 0.8, Put OI building +${niftyATM.putOIChange.toLocaleString()}`,
      currentPrice: niftyATM.putLTP,
      suggestedQty: 50,
      timestamp: now,
      strength: 'HIGH',
      confidence: computeConfidence([pcrFactor, oiFactor]),
    });
  }

  if (data.niftyPCR > 1.2 && niftyATM.callOIChange > 0) {
    const pcrFactor = Math.min(100, ((data.niftyPCR - 1.2) / 0.3) * 100);
    const oiFactor = Math.min(100, (niftyATM.callOIChange / 3000) * 100);
    signals.push({
      id: `sig-${now}-2`,
      index: 'NIFTY',
      strike: niftyATM.strike,
      optionType: 'CE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} > 1.2, Call OI building +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP,
      suggestedQty: 50,
      timestamp: now,
      strength: 'HIGH',
      confidence: computeConfidence([pcrFactor, oiFactor]),
    });
  }

  // Strategy 2: Call Wall Breakdown
  if (maxCallOIStrike > 0 && data.niftySpot > maxCallOIStrike) {
    const breakFactor = Math.min(100, ((data.niftySpot - maxCallOIStrike) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.callVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-3`,
      index: 'NIFTY',
      strike: maxCallOIStrike,
      optionType: 'CE',
      strategy: 'Call Wall Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke call resistance at ${maxCallOIStrike}, OI ${maxCallOI.toLocaleString()}`,
      currentPrice: niftyATM.callLTP,
      suggestedQty: 25,
      timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([breakFactor, volFactor]),
    });
  }

  // Strategy 3: Put Support Breakdown
  if (maxPutOIStrike > 0 && data.niftySpot < maxPutOIStrike) {
    const breakFactor = Math.min(100, ((maxPutOIStrike - data.niftySpot) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.putVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-4`,
      index: 'NIFTY',
      strike: maxPutOIStrike,
      optionType: 'PE',
      strategy: 'Put Support Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke put support at ${maxPutOIStrike}, OI ${maxPutOI.toLocaleString()}`,
      currentPrice: niftyATM.putLTP,
      suggestedQty: 25,
      timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([breakFactor, volFactor]),
    });
  }

  // Strategy 4: ATM Volatility Spike
  if (niftyATM.callVolume > 7000 && niftyATM.putVolume > 7000) {
    const volFactor = Math.min(100, ((niftyATM.callVolume + niftyATM.putVolume) / 20000) * 100);
    const oiFactor = Math.min(100, ((Math.abs(niftyATM.callOIChange) + Math.abs(niftyATM.putOIChange)) / 6000) * 100);
    const isBullish = niftyATM.callVolume > niftyATM.putVolume;
    signals.push({
      id: `sig-${now}-5`,
      index: 'NIFTY',
      strike: niftyATM.strike,
      optionType: isBullish ? 'CE' : 'PE',
      strategy: 'ATM Volatility Spike',
      reason: `ATM volume surge: CE ${niftyATM.callVolume.toLocaleString()} + PE ${niftyATM.putVolume.toLocaleString()}`,
      currentPrice: isBullish ? niftyATM.callLTP : niftyATM.putLTP,
      suggestedQty: 25,
      timestamp: now,
      strength: volFactor > 70 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([volFactor, oiFactor]),
    });
  }

  // Strategy 5: ATM Momentum (existing)
  if (niftyATM.callVolume > 7000 && niftyATM.callOIChange > 2000) {
    const volFactor = Math.min(100, (niftyATM.callVolume / 10000) * 100);
    const oiFactor = Math.min(100, (niftyATM.callOIChange / 4000) * 100);
    signals.push({
      id: `sig-${now}-6`,
      index: 'NIFTY',
      strike: niftyATM.strike,
      optionType: 'CE',
      strategy: 'ATM Momentum',
      reason: `Volume spike ${niftyATM.callVolume.toLocaleString()}, OI +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP,
      suggestedQty: 25,
      timestamp: now,
      strength: 'MEDIUM',
      confidence: computeConfidence([volFactor, oiFactor]),
    });
  }

  return signals;
}

export function useMarketData(isPaperTrading: boolean) {
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [tradesToday, setTradesToday] = useState(0);
  const [dailyPnL, setDailyPnL] = useState(0);
  const [lastTradeTime, setLastTradeTime] = useState(0);
  const [riskSettings, setRiskSettings] = useState<RiskSettings>({
    maxTradesPerDay: 10,
    maxDailyLoss: 3000,
    cooldownMinutes: 5,
  });
  const [riskLimitReached, setRiskLimitReached] = useState(false);

  const niftyBase = useRef(22450 + Math.random() * 200);
  const sensexBase = useRef(73800 + Math.random() * 500);

  const updateData = useCallback(() => {
    niftyBase.current += (Math.random() - 0.48) * 15;
    sensexBase.current += (Math.random() - 0.48) * 50;

    const niftySpot = Math.round(niftyBase.current * 100) / 100;
    const sensexSpot = Math.round(sensexBase.current * 100) / 100;
    const niftyChain = generateOptionChain(niftySpot, 50);
    const sensexChain = generateOptionChain(sensexSpot, 100);

    const niftyTotalCallOI = niftyChain.reduce((s, o) => s + o.callOI, 0);
    const niftyTotalPutOI = niftyChain.reduce((s, o) => s + o.putOI, 0);
    const sensexTotalCallOI = sensexChain.reduce((s, o) => s + o.callOI, 0);
    const sensexTotalPutOI = sensexChain.reduce((s, o) => s + o.putOI, 0);

    const data: MarketData = {
      niftySpot,
      sensexSpot,
      niftyChange: Math.round((Math.random() - 0.45) * 150 * 100) / 100,
      sensexChange: Math.round((Math.random() - 0.45) * 500 * 100) / 100,
      niftyPCR: Math.round((niftyTotalPutOI / niftyTotalCallOI) * 100) / 100,
      sensexPCR: Math.round((sensexTotalPutOI / sensexTotalCallOI) * 100) / 100,
      niftyATM: niftyChain.find(o => o.isATM)?.strike || 0,
      sensexATM: sensexChain.find(o => o.isATM)?.strike || 0,
      niftyChain,
      sensexChain,
      timestamp: Date.now(),
    };

    setMarketData(data);

    if (!riskLimitReached) {
      const newSignals = generateSignals(data);
      if (newSignals.length > 0) {
        setSignals(prev => {
          const combined = [...newSignals, ...prev];
          return combined.slice(0, 20);
        });
      }
    }

    setPositions(prev =>
      prev.map(p => {
        const priceChange = (Math.random() - 0.48) * 5;
        const newPrice = Math.round((p.currentPrice + priceChange) * 100) / 100;
        const pnl = Math.round((newPrice - p.entryPrice) * p.quantity * 100) / 100;
        return { ...p, currentPrice: newPrice, pnl };
      })
    );
  }, [riskLimitReached]);

  useEffect(() => {
    updateData();
    const interval = setInterval(updateData, 2000); // 2 second refresh
    return () => clearInterval(interval);
  }, [updateData]);

  useEffect(() => {
    const totalPnL = positions.reduce((s, p) => s + p.pnl, 0);
    setDailyPnL(totalPnL);
    if (totalPnL <= -riskSettings.maxDailyLoss || tradesToday >= riskSettings.maxTradesPerDay) {
      setRiskLimitReached(true);
    }
  }, [positions, tradesToday, riskSettings]);

  const executePaperTrade = useCallback((signal: TradeSignal): { success: true; position: Position } | { success: false; reason: string } => {
    const now = Date.now();
    const cooldownMs = riskSettings.cooldownMinutes * 60 * 1000;

    if (now - lastTradeTime < cooldownMs) {
      return { success: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min between trades` };
    }
    if (tradesToday >= riskSettings.maxTradesPerDay) {
      return { success: false, reason: 'Max daily trades reached' };
    }
    if (dailyPnL <= -riskSettings.maxDailyLoss) {
      return { success: false, reason: 'Daily loss limit reached' };
    }

    const position: Position = {
      id: `pos-${now}`,
      orderId: `PAPER-${now}`,
      symbol: signal.index,
      strike: signal.strike,
      optionType: signal.optionType,
      quantity: signal.suggestedQty,
      entryPrice: signal.currentPrice,
      currentPrice: signal.currentPrice,
      pnl: 0,
      timestamp: now,
    };

    setPositions(prev => [position, ...prev]);
    setTradesToday(prev => prev + 1);
    setLastTradeTime(now);
    setSignals(prev => prev.filter(s => s.id !== signal.id));

    return { success: true, position };
  }, [lastTradeTime, tradesToday, dailyPnL, riskSettings]);

  const validateRiskLimits = useCallback((): { ok: boolean; reason?: string } => {
    const now = Date.now();
    const cooldownMs = riskSettings.cooldownMinutes * 60 * 1000;
    if (now - lastTradeTime < cooldownMs) {
      return { ok: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min between trades` };
    }
    if (tradesToday >= riskSettings.maxTradesPerDay) {
      return { ok: false, reason: 'Max daily trades reached' };
    }
    if (dailyPnL <= -riskSettings.maxDailyLoss) {
      return { ok: false, reason: 'Daily loss limit reached' };
    }
    return { ok: true };
  }, [lastTradeTime, tradesToday, dailyPnL, riskSettings]);

  const addLivePosition = useCallback((signal: TradeSignal, orderId: string) => {
    const now = Date.now();
    const position: Position = {
      id: `pos-${now}`,
      orderId,
      symbol: signal.index,
      strike: signal.strike,
      optionType: signal.optionType,
      quantity: signal.suggestedQty,
      entryPrice: signal.currentPrice,
      currentPrice: signal.currentPrice,
      pnl: 0,
      timestamp: now,
    };
    setPositions(prev => [position, ...prev]);
    setTradesToday(prev => prev + 1);
    setLastTradeTime(now);
    setSignals(prev => prev.filter(s => s.id !== signal.id));
    return position;
  }, []);

  const exitPosition = useCallback((positionId: string) => {
    setPositions(prev => prev.filter(p => p.id !== positionId));
  }, []);

  const dismissSignal = useCallback((signalId: string) => {
    setSignals(prev => prev.filter(s => s.id !== signalId));
  }, []);

  return {
    marketData,
    signals,
    positions,
    tradesToday,
    dailyPnL,
    riskSettings,
    setRiskSettings,
    riskLimitReached,
    executePaperTrade,
    validateRiskLimits,
    addLivePosition,
    exitPosition,
    dismissSignal,
  };
}
