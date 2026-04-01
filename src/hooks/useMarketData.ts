import { useState, useEffect, useCallback, useRef } from 'react';
import { KotakMarketFeed, type FeedHealth } from '@/services/kotakMarketFeed';
import { calculateQty } from '@/hooks/usePositionSizing';

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
  oiSource?: 'nse' | 'synthetic';
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
  niftyMaxPain: number;
  sensexMaxPain: number;
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

function generateOiSignals(data: MarketData): TradeSignal[] {
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

function generatePriceActionSignals(data: MarketData, priceHistory: number[]): TradeSignal[] {
  if (priceHistory.length < 5) return [];
  const signals: TradeSignal[] = [];
  const now = Date.now();
  const spot = data.niftySpot;
  const atm = data.niftyATM;
  const niftyATM = data.niftyChain.find(o => o.isATM);
  if (!niftyATM || spot <= 0) return signals;

  const high20 = Math.max(...priceHistory);
  const low20 = Math.min(...priceHistory);
  const range = high20 - low20;
  const proximityThreshold = spot * 0.003; // 0.3%

  // Trend direction from last 3 prices
  const recent = priceHistory.slice(-3);
  const rising = recent.length >= 2 && recent[recent.length - 1] > recent[0];
  const falling = recent.length >= 2 && recent[recent.length - 1] < recent[0];

  // Breakout Buy: spot exceeds 20-period high
  if (spot > high20 && range > 10) {
    signals.push({
      id: `sig-pa-${now}-1`, index: 'NIFTY', strike: atm, optionType: 'CE',
      strategy: 'Breakout Buy',
      reason: `Spot ${spot.toFixed(0)} broke 20-period high ${high20.toFixed(0)}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 50, timestamp: now, strength: 'HIGH',
      confidence: weightedConfidence([
        { value: Math.min(100, ((spot - high20) / 20) * 100), weight: 3 },
        { value: Math.min(100, (range / 100) * 100), weight: 2 },
        { value: rising ? 80 : 40, weight: 1 },
      ]),
    });
  }

  // Breakdown Sell: spot falls below 20-period low
  if (spot < low20 && range > 10) {
    signals.push({
      id: `sig-pa-${now}-2`, index: 'NIFTY', strike: atm, optionType: 'PE',
      strategy: 'Breakdown Sell',
      reason: `Spot ${spot.toFixed(0)} broke 20-period low ${low20.toFixed(0)}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 50, timestamp: now, strength: 'HIGH',
      confidence: weightedConfidence([
        { value: Math.min(100, ((low20 - spot) / 20) * 100), weight: 3 },
        { value: Math.min(100, (range / 100) * 100), weight: 2 },
        { value: falling ? 80 : 40, weight: 1 },
      ]),
    });
  }

  // Support Bounce: near low20 and rising
  if (Math.abs(spot - low20) < proximityThreshold && rising) {
    signals.push({
      id: `sig-pa-${now}-3`, index: 'NIFTY', strike: atm, optionType: 'CE',
      strategy: 'Support Bounce',
      reason: `Spot ${spot.toFixed(0)} bouncing off support ${low20.toFixed(0)}`,
      currentPrice: niftyATM.callLTP, suggestedQty: 25, timestamp: now, strength: 'MEDIUM',
      confidence: weightedConfidence([
        { value: Math.min(100, (1 - Math.abs(spot - low20) / proximityThreshold) * 100), weight: 3 },
        { value: rising ? 80 : 30, weight: 2 },
        { value: Math.min(100, (range / 80) * 100), weight: 1 },
      ]),
    });
  }

  // Resistance Rejection: near high20 and falling
  if (Math.abs(spot - high20) < proximityThreshold && falling) {
    signals.push({
      id: `sig-pa-${now}-4`, index: 'NIFTY', strike: atm, optionType: 'PE',
      strategy: 'Resistance Rejection',
      reason: `Spot ${spot.toFixed(0)} rejected at resistance ${high20.toFixed(0)}`,
      currentPrice: niftyATM.putLTP, suggestedQty: 25, timestamp: now, strength: 'MEDIUM',
      confidence: weightedConfidence([
        { value: Math.min(100, (1 - Math.abs(spot - high20) / proximityThreshold) * 100), weight: 3 },
        { value: falling ? 80 : 30, weight: 2 },
        { value: Math.min(100, (range / 80) * 100), weight: 1 },
      ]),
    });
  }

  // Momentum: last 3 prices show consistent directional move > 0.1%
  if (priceHistory.length >= 3) {
    const last3 = priceHistory.slice(-3);
    const allRising = last3[2] > last3[1] && last3[1] > last3[0];
    const allFalling = last3[2] < last3[1] && last3[1] < last3[0];
    const pctMove = Math.abs((last3[2] - last3[0]) / last3[0]) * 100;
    if (allRising && pctMove > 0.1) {
      signals.push({
        id: `sig-pa-${now}-5`, index: 'NIFTY', strike: atm, optionType: 'CE',
        strategy: 'Momentum Up',
        reason: `3 consecutive rising ticks, +${pctMove.toFixed(2)}% move`,
        currentPrice: niftyATM.callLTP, suggestedQty: 25, timestamp: now, strength: 'MEDIUM',
        confidence: weightedConfidence([
          { value: Math.min(100, pctMove * 200), weight: 3 },
          { value: 70, weight: 1 },
        ]),
      });
    }
    if (allFalling && pctMove > 0.1) {
      signals.push({
        id: `sig-pa-${now}-6`, index: 'NIFTY', strike: atm, optionType: 'PE',
        strategy: 'Momentum Down',
        reason: `3 consecutive falling ticks, -${pctMove.toFixed(2)}% move`,
        currentPrice: niftyATM.putLTP, suggestedQty: 25, timestamp: now, strength: 'MEDIUM',
        confidence: weightedConfidence([
          { value: Math.min(100, pctMove * 200), weight: 3 },
          { value: 70, weight: 1 },
        ]),
      });
    }
  }

  return signals;
}

function generateSignals(data: MarketData, priceHistory: number[]): TradeSignal[] {
  return [...generateOiSignals(data), ...generatePriceActionSignals(data, priceHistory)];
}

// ─── Hook ────────────────────────────────────────────────────────────
export function useMarketData(isPaperTrading: boolean, marketDataEnabled: boolean = false) {
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
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
  const priceHistoryRef = useRef<number[]>([]);

  const handleMarketData = useCallback((data: MarketData) => {
    setMarketData(data);
    // Generate signals BEFORE updating history so breakout/breakdown can trigger
    if (!riskLimitReached) {
      const newSignals = generateSignals(data, priceHistoryRef.current);

      if (newSignals.length > 0) {
        setSignals(prev => [...newSignals, ...prev].slice(0, 20));
      }
    }
    // Update rolling price history AFTER signal generation (max 20 entries)
    if (data.niftySpot > 0) {
      const history = priceHistoryRef.current;
      history.push(data.niftySpot);
      if (history.length > 20) history.shift();
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

  // Timeout fallback: if no data after 8s, show error
  useEffect(() => {
    if (marketData || !marketDataEnabled) return;
    const timeout = setTimeout(() => {
      if (!marketData) {
        setFeedHealth(prev => ({
          ...prev,
          status: 'error',
          errorMessage: feedHealth.errorMessage || 'Market data timeout — broker API may be unavailable',
        }));
      }
    }, 8000);
    return () => clearTimeout(timeout);
  }, [marketData, marketDataEnabled]);

  useEffect(() => {
    if (!marketDataEnabled) {
      setFeedHealth({
        status: 'disconnected',
        latencyMs: 0,
        lastTickTime: null,
        errorMessage: 'Market feed unavailable',
        consecutiveErrors: 0,
      });
      return;
    }

    const feed = new KotakMarketFeed(handleMarketData, setFeedHealth);
    feedRef.current = feed;
    feed.start();
    return () => feed.stop();
  }, [handleMarketData, marketDataEnabled]);

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

  const retryFeed = useCallback(() => {
    setFeedHealth({ status: 'disconnected', latencyMs: 0, lastTickTime: null, errorMessage: null, consecutiveErrors: 0 });
    if (feedRef.current) { feedRef.current.stop(); feedRef.current.start(); }
  }, []);

  return {
    marketData, signals, positions, tradesToday, dailyPnL,
    riskSettings, setRiskSettings, riskLimitReached,
    executePaperTrade, validateRiskLimits, addLivePosition,
    exitPosition, dismissSignal, feedHealth, retryFeed,
    autoTradeEnabled, setAutoTradeEnabled,
  };
}
