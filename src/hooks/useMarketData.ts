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

function generateSignals(data: MarketData): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const now = Date.now();

  // PCR Reversal - NIFTY
  if (data.niftyPCR < 0.8) {
    const atmOption = data.niftyChain.find(o => o.isATM);
    if (atmOption && atmOption.putOIChange > 0) {
      signals.push({
        id: `sig-${now}-1`,
        index: 'NIFTY',
        strike: atmOption.strike,
        optionType: 'PE',
        strategy: 'PCR Reversal',
        reason: `PCR ${data.niftyPCR.toFixed(2)} < 0.8, Put OI building up`,
        currentPrice: atmOption.putLTP,
        suggestedQty: 50,
        timestamp: now,
        strength: 'HIGH',
      });
    }
  }

  if (data.niftyPCR > 1.2) {
    const atmOption = data.niftyChain.find(o => o.isATM);
    if (atmOption && atmOption.callOIChange > 0) {
      signals.push({
        id: `sig-${now}-2`,
        index: 'NIFTY',
        strike: atmOption.strike,
        optionType: 'CE',
        strategy: 'PCR Reversal',
        reason: `PCR ${data.niftyPCR.toFixed(2)} > 1.2, Call OI building up`,
        currentPrice: atmOption.callLTP,
        suggestedQty: 50,
        timestamp: now,
        strength: 'HIGH',
      });
    }
  }

  // ATM Momentum
  const niftyATM = data.niftyChain.find(o => o.isATM);
  if (niftyATM && niftyATM.callVolume > 7000 && niftyATM.callOIChange > 2000) {
    signals.push({
      id: `sig-${now}-3`,
      index: 'NIFTY',
      strike: niftyATM.strike,
      optionType: 'CE',
      strategy: 'ATM Momentum',
      reason: `Volume spike ${niftyATM.callVolume.toLocaleString()}, OI +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP,
      suggestedQty: 25,
      timestamp: now,
      strength: 'MEDIUM',
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

    // Generate signals
    if (!riskLimitReached) {
      const newSignals = generateSignals(data);
      if (newSignals.length > 0) {
        setSignals(prev => {
          const combined = [...newSignals, ...prev];
          return combined.slice(0, 20);
        });
      }
    }

    // Update position prices
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
    const interval = setInterval(updateData, 3000);
    return () => clearInterval(interval);
  }, [updateData]);

  // Check risk limits
  useEffect(() => {
    const totalPnL = positions.reduce((s, p) => s + p.pnl, 0);
    setDailyPnL(totalPnL);
    if (totalPnL <= -riskSettings.maxDailyLoss || tradesToday >= riskSettings.maxTradesPerDay) {
      setRiskLimitReached(true);
    }
  }, [positions, tradesToday, riskSettings]);

  const executeTrade = useCallback((signal: TradeSignal) => {
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
      orderId: isPaperTrading ? `PAPER-${now}` : `NEO-${now}`,
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
  }, [isPaperTrading, lastTradeTime, tradesToday, dailyPnL, riskSettings]);

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
    executeTrade,
    dismissSignal,
  };
}
