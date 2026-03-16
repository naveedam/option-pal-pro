import { useState, useEffect, useCallback, useRef } from 'react';
import { KotakMarketFeed, type FeedHealth } from '@/services/kotakMarketFeed';

// ─── Types ───────────────────────────────────────────────────────────
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
  confidence: number;
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
  dbId?: string;
}

export interface RiskSettings {
  maxTradesPerDay: number;
  maxDailyLoss: number;
  cooldownMinutes: number;
}

// ─── Signal Generation (works on real data) ──────────────────────────
function computeConfidence(factors: number[]): number {
  const avg = factors.reduce((s, f) => s + f, 0) / factors.length;
  return Math.max(0, Math.min(100, Math.round(avg)));
}

function generateSignals(data: MarketData): TradeSignal[] {
  const signals: TradeSignal[] = [];
  const now = Date.now();

  const niftyATM = data.niftyChain.find(o => o.isATM);
  if (!niftyATM) return signals;

  let maxCallOI = 0, maxCallOIStrike = 0;
  let maxPutOI = 0, maxPutOIStrike = 0;
  for (const row of data.niftyChain) {
    if (row.callOI > maxCallOI) { maxCallOI = row.callOI; maxCallOIStrike = row.strike; }
    if (row.putOI > maxPutOI) { maxPutOI = row.putOI; maxPutOIStrike = row.strike; }
  }

  // PCR Reversal
  if (data.niftyPCR < 0.8 && niftyATM.putOIChange > 0) {
    const pcrFactor = Math.min(100, ((0.8 - data.niftyPCR) / 0.3) * 100);
    const oiFactor = Math.min(100, (niftyATM.putOIChange / 3000) * 100);
    signals.push({
      id: `sig-${now}-1`, index: 'NIFTY', strike: niftyATM.strike, optionType: 'PE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} < 0.8, Put OI building +${niftyATM.putOIChange.toLocaleString()}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 50, timestamp: now,
      strength: 'HIGH', confidence: computeConfidence([pcrFactor, oiFactor]),
    });
  }

  if (data.niftyPCR > 1.2 && niftyATM.callOIChange > 0) {
    const pcrFactor = Math.min(100, ((data.niftyPCR - 1.2) / 0.3) * 100);
    const oiFactor = Math.min(100, (niftyATM.callOIChange / 3000) * 100);
    signals.push({
      id: `sig-${now}-2`, index: 'NIFTY', strike: niftyATM.strike, optionType: 'CE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} > 1.2, Call OI building +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 50, timestamp: now,
      strength: 'HIGH', confidence: computeConfidence([pcrFactor, oiFactor]),
    });
  }

  // Call Wall Breakdown
  if (maxCallOIStrike > 0 && data.niftySpot > maxCallOIStrike) {
    const breakFactor = Math.min(100, ((data.niftySpot - maxCallOIStrike) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.callVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-3`, index: 'NIFTY', strike: maxCallOIStrike, optionType: 'CE',
      strategy: 'Call Wall Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke call resistance at ${maxCallOIStrike}, OI ${maxCallOI.toLocaleString()}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 25, timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([breakFactor, volFactor]),
    });
  }

  // Put Support Breakdown
  if (maxPutOIStrike > 0 && data.niftySpot < maxPutOIStrike) {
    const breakFactor = Math.min(100, ((maxPutOIStrike - data.niftySpot) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.putVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-4`, index: 'NIFTY', strike: maxPutOIStrike, optionType: 'PE',
      strategy: 'Put Support Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke put support at ${maxPutOIStrike}, OI ${maxPutOI.toLocaleString()}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 25, timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([breakFactor, volFactor]),
    });
  }

  // ATM Volatility Spike
  if (niftyATM.callVolume > 7000 && niftyATM.putVolume > 7000) {
    const volFactor = Math.min(100, ((niftyATM.callVolume + niftyATM.putVolume) / 20000) * 100);
    const oiFactor = Math.min(100, ((Math.abs(niftyATM.callOIChange) + Math.abs(niftyATM.putOIChange)) / 6000) * 100);
    const isBullish = niftyATM.callVolume > niftyATM.putVolume;
    signals.push({
      id: `sig-${now}-5`, index: 'NIFTY', strike: niftyATM.strike,
      optionType: isBullish ? 'CE' : 'PE', strategy: 'ATM Volatility Spike',
      reason: `ATM volume surge: CE ${niftyATM.callVolume.toLocaleString()} + PE ${niftyATM.putVolume.toLocaleString()}`,
      currentPrice: isBullish ? niftyATM.callLTP : niftyATM.putLTP,
      suggestedQty: 25, timestamp: now,
      strength: volFactor > 70 ? 'HIGH' : 'MEDIUM',
      confidence: computeConfidence([volFactor, oiFactor]),
    });
  }

  // ATM Momentum
  if (niftyATM.callVolume > 7000 && niftyATM.callOIChange > 2000) {
    const volFactor = Math.min(100, (niftyATM.callVolume / 10000) * 100);
    const oiFactor = Math.min(100, (niftyATM.callOIChange / 4000) * 100);
    signals.push({
      id: `sig-${now}-6`, index: 'NIFTY', strike: niftyATM.strike, optionType: 'CE',
      strategy: 'ATM Momentum',
      reason: `Volume spike ${niftyATM.callVolume.toLocaleString()}, OI +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 25, timestamp: now,
      strength: 'MEDIUM', confidence: computeConfidence([volFactor, oiFactor]),
    });
  }

  return signals;
}

// ─── Hook ────────────────────────────────────────────────────────────
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
  const [feedHealth, setFeedHealth] = useState<FeedHealth>({
    status: 'disconnected',
    latencyMs: 0,
    lastTickTime: null,
    errorMessage: null,
    consecutiveErrors: 0,
  });

  const feedRef = useRef<KotakMarketFeed | null>(null);

  // Handle incoming market data from the feed
  const handleMarketData = useCallback((data: MarketData) => {
    setMarketData(data);

    // Generate signals from real data
    if (!riskLimitReached) {
      const newSignals = generateSignals(data);
      if (newSignals.length > 0) {
        setSignals(prev => {
          const combined = [...newSignals, ...prev];
          return combined.slice(0, 20);
        });
      }
    }

    // Update position prices from live data
    setPositions(prev =>
      prev.map(p => {
        // Find matching option in chain
        const chain = p.symbol === 'NIFTY' ? data.niftyChain : data.sensexChain;
        const row = chain.find(r => r.strike === p.strike);
        if (row) {
          const livePrice = p.optionType === 'CE' ? row.callLTP : row.putLTP;
          if (livePrice > 0) {
            const pnl = Math.round((livePrice - p.entryPrice) * p.quantity * 100) / 100;
            return { ...p, currentPrice: livePrice, pnl };
          }
        }
        return p;
      })
    );
  }, [riskLimitReached]);

  // Start/stop the market feed
  useEffect(() => {
    const feed = new KotakMarketFeed(handleMarketData, setFeedHealth);
    feedRef.current = feed;
    feed.start();
    return () => feed.stop();
  }, [handleMarketData]);

  // Risk limit check
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
    if (now - lastTradeTime < cooldownMs) return { success: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min between trades` };
    if (tradesToday >= riskSettings.maxTradesPerDay) return { success: false, reason: 'Max daily trades reached' };
    if (dailyPnL <= -riskSettings.maxDailyLoss) return { success: false, reason: 'Daily loss limit reached' };

    const position: Position = {
      id: `pos-${now}`, orderId: `PAPER-${now}`, symbol: signal.index,
      strike: signal.strike, optionType: signal.optionType,
      quantity: signal.suggestedQty, entryPrice: signal.currentPrice,
      currentPrice: signal.currentPrice, pnl: 0, timestamp: now,
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
    if (now - lastTradeTime < cooldownMs) return { ok: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min between trades` };
    if (tradesToday >= riskSettings.maxTradesPerDay) return { ok: false, reason: 'Max daily trades reached' };
    if (dailyPnL <= -riskSettings.maxDailyLoss) return { ok: false, reason: 'Daily loss limit reached' };
    return { ok: true };
  }, [lastTradeTime, tradesToday, dailyPnL, riskSettings]);

  const addLivePosition = useCallback((signal: TradeSignal, orderId: string) => {
    const now = Date.now();
    const position: Position = {
      id: `pos-${now}`, orderId, symbol: signal.index,
      strike: signal.strike, optionType: signal.optionType,
      quantity: signal.suggestedQty, entryPrice: signal.currentPrice,
      currentPrice: signal.currentPrice, pnl: 0, timestamp: now,
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
    feedHealth,
  };
}
