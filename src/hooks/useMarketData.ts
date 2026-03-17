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

// ─── Analytics helpers ───────────────────────────────────────────────
function findGammaWall(chain: OptionData[]): { strike: number; combinedOI: number } {
  let max = 0, strike = 0;
  for (const r of chain) {
    const c = r.callOI + r.putOI;
    if (c > max) { max = c; strike = r.strike; }
  }
  return { strike, combinedOI: max };
}

function getDealerGamma(chain: OptionData[]): number {
  return chain.reduce((s, r) => s + (r.putOI - r.callOI), 0);
}

// ─── Signal Generation ──────────────────────────────────────────────
function weightedConfidence(factors: { value: number; weight: number }[]): number {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = factors.reduce((s, f) => s + f.value * f.weight, 0);
  return Math.max(0, Math.min(100, Math.round(weighted / totalWeight)));
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

  const gammaWall = findGammaWall(data.niftyChain);
  const dealerGamma = getDealerGamma(data.niftyChain);
  const gammaProximity = gammaWall.strike > 0
    ? Math.max(0, 100 - (Math.abs(data.niftySpot - gammaWall.strike) / 50) * 20)
    : 0;
  const dealerFactor = Math.min(100, Math.abs(dealerGamma) / 50000 * 100);

  // PCR Reversal
  if (data.niftyPCR < 0.8 && niftyATM.putOIChange > 0) {
    signals.push({
      id: `sig-${now}-1`, index: 'NIFTY', strike: niftyATM.strike, optionType: 'PE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} < 0.8, Put OI building +${niftyATM.putOIChange.toLocaleString()}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 50, timestamp: now, strength: 'HIGH',
      confidence: weightedConfidence([
        { value: Math.min(100, ((0.8 - data.niftyPCR) / 0.3) * 100), weight: 3 },
        { value: Math.min(100, (niftyATM.putOIChange / 3000) * 100), weight: 2 },
        { value: gammaProximity, weight: 1 },
        { value: dealerFactor, weight: 1 },
      ]),
    });
  }

  if (data.niftyPCR > 1.2 && niftyATM.callOIChange > 0) {
    signals.push({
      id: `sig-${now}-2`, index: 'NIFTY', strike: niftyATM.strike, optionType: 'CE',
      strategy: 'PCR Reversal',
      reason: `PCR ${data.niftyPCR.toFixed(2)} > 1.2, Call OI building +${niftyATM.callOIChange.toLocaleString()}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 50, timestamp: now, strength: 'HIGH',
      confidence: weightedConfidence([
        { value: Math.min(100, ((data.niftyPCR - 1.2) / 0.3) * 100), weight: 3 },
        { value: Math.min(100, (niftyATM.callOIChange / 3000) * 100), weight: 2 },
        { value: gammaProximity, weight: 1 },
        { value: dealerFactor, weight: 1 },
      ]),
    });
  }

  // Call Wall Breakdown
  if (maxCallOIStrike > 0 && data.niftySpot > maxCallOIStrike) {
    const breakFactor = Math.min(100, ((data.niftySpot - maxCallOIStrike) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.callVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-3`, index: 'NIFTY', strike: maxCallOIStrike, optionType: 'CE',
      strategy: 'Call Wall Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke call resistance at ${maxCallOIStrike}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 25, timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: weightedConfidence([
        { value: breakFactor, weight: 3 },
        { value: volFactor, weight: 2 },
        { value: gammaProximity, weight: 1 },
        { value: dealerGamma < 0 ? 80 : 30, weight: 1 },
      ]),
    });
  }

  // Put Support Breakdown
  if (maxPutOIStrike > 0 && data.niftySpot < maxPutOIStrike) {
    const breakFactor = Math.min(100, ((maxPutOIStrike - data.niftySpot) / 50) * 100);
    const volFactor = Math.min(100, (niftyATM.putVolume / 8000) * 100);
    signals.push({
      id: `sig-${now}-4`, index: 'NIFTY', strike: maxPutOIStrike, optionType: 'PE',
      strategy: 'Put Support Breakdown',
      reason: `Spot ${data.niftySpot.toFixed(0)} broke put support at ${maxPutOIStrike}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 25, timestamp: now,
      strength: breakFactor > 60 ? 'HIGH' : 'MEDIUM',
      confidence: weightedConfidence([
        { value: breakFactor, weight: 3 },
        { value: volFactor, weight: 2 },
        { value: gammaProximity, weight: 1 },
        { value: dealerGamma < 0 ? 80 : 30, weight: 1 },
      ]),
    });
  }

  // ATM Volatility Spike
  if (niftyATM.callVolume > 7000 && niftyATM.putVolume > 7000) {
    const volFactor = Math.min(100, ((niftyATM.callVolume + niftyATM.putVolume) / 20000) * 100);
    const isBullish = niftyATM.callVolume > niftyATM.putVolume;
    signals.push({
      id: `sig-${now}-5`, index: 'NIFTY', strike: niftyATM.strike,
      optionType: isBullish ? 'CE' : 'PE', strategy: 'ATM Volatility Spike',
      reason: `ATM volume surge: CE ${niftyATM.callVolume.toLocaleString()} + PE ${niftyATM.putVolume.toLocaleString()}`,
      currentPrice: isBullish ? niftyATM.callLTP : niftyATM.putLTP,
      suggestedQty: 25, timestamp: now,
      strength: volFactor > 70 ? 'HIGH' : 'MEDIUM',
      confidence: weightedConfidence([
        { value: volFactor, weight: 3 },
        { value: Math.min(100, ((Math.abs(niftyATM.callOIChange) + Math.abs(niftyATM.putOIChange)) / 6000) * 100), weight: 2 },
        { value: gammaProximity, weight: 1 },
        { value: dealerFactor, weight: 1 },
      ]),
    });
  }

  return signals;
}

// ─── Hook ────────────────────────────────────────────────────────────
export function useMarketData(isPaperTrading: boolean, brokerConnected: boolean = false) {
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [tradesToday, setTradesToday] = useState(0);
  const [dailyPnL, setDailyPnL] = useState(0);
  const [lastTradeTime, setLastTradeTime] = useState(0);
  const [riskSettings, setRiskSettings] = useState<RiskSettings>({
    maxTradesPerDay: 10, maxDailyLoss: 3000, cooldownMinutes: 5,
  });
  const [riskLimitReached, setRiskLimitReached] = useState(false);
  const [feedHealth, setFeedHealth] = useState<FeedHealth>({
    status: 'disconnected', latencyMs: 0, lastTickTime: null, errorMessage: null, consecutiveErrors: 0,
  });

  const feedRef = useRef<KotakMarketFeed | null>(null);

  const handleMarketData = useCallback((data: MarketData) => {
    setMarketData(data);
    if (!riskLimitReached) {
      const newSignals = generateSignals(data);
      if (newSignals.length > 0) {
        setSignals(prev => [...newSignals, ...prev].slice(0, 20));
      }
    }
    setPositions(prev =>
      prev.map(p => {
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

  useEffect(() => {
    // Only start the market feed when broker is connected
    if (!brokerConnected) {
      setFeedHealth({
        status: 'broker_disconnected',
        latencyMs: 0,
        lastTickTime: null,
        errorMessage: 'Broker not connected',
        consecutiveErrors: 0,
      });
      return;
    }

    const feed = new KotakMarketFeed(handleMarketData, setFeedHealth);
    feedRef.current = feed;
    feed.start();
    return () => feed.stop();
  }, [handleMarketData, brokerConnected]);

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
    if (now - lastTradeTime < cooldownMs) return { success: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min` };
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
    if (now - lastTradeTime < cooldownMs) return { ok: false, reason: `Cooldown: wait ${riskSettings.cooldownMinutes}min` };
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
    marketData, signals, positions, tradesToday, dailyPnL,
    riskSettings, setRiskSettings, riskLimitReached,
    executePaperTrade, validateRiskLimits, addLivePosition,
    exitPosition, dismissSignal, feedHealth,
  };
}
