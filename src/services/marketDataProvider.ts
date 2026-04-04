/**
 * Market Data Provider — Kotak REST API ONLY
 * 
 * No fallback. If Kotak is unavailable, returns error state.
 * Signals and execution are gated on source === 'kotak'.
 */

import { supabase } from '@/integrations/supabase/client';
import type { MarketData } from '@/hooks/useMarketData';

// ─── Types ───────────────────────────────────────────────────────────
export type ActiveDataSource = 'kotak' | 'none';

export interface MarketDataResult {
  data: MarketData;
  isStale: boolean;
  lastFreshAt: number | null;
  error?: string;
  source: ActiveDataSource;
  oiSource: 'kotak' | 'none';
}

type CircuitState = 'closed' | 'open' | 'half-open';

// ─── Circuit Breaker ─────────────────────────────────────────────────
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;

  constructor(maxFailures = 3, cooldownMs = 20_000) {
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
  }

  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void { this.failures = 0; this.state = 'closed'; }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
      console.log(`[CircuitBreaker] OPEN — ${this.failures} failures, cooling ${this.cooldownMs / 1000}s`);
    }
  }

  getState(): CircuitState { return this.state; }
}

// ─── Rate Limiter ────────────────────────────────────────────────────
class RateLimiter {
  private lastRequestTime = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 3_000) { this.minIntervalMs = minIntervalMs; }

  canRequest(): boolean {
    return Date.now() - this.lastRequestTime >= this.minIntervalMs;
  }

  record(): void { this.lastRequestTime = Date.now(); }
}

// ─── Deduplicator ────────────────────────────────────────────────────
class Deduplicator {
  private inflight: Promise<any> | null = null;

  async dedupe<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight) return this.inflight as Promise<T>;
    const promise = fn().finally(() => { this.inflight = null; });
    this.inflight = promise;
    return promise;
  }
}

// ─── Empty Market Data ──────────────────────────────────────────────
function emptyMarketData(): MarketData {
  return {
    niftySpot: 0, sensexSpot: 0, niftyChange: 0, sensexChange: 0,
    niftyPCR: 0, sensexPCR: 0, niftyATM: 0, sensexATM: 0,
    niftyChain: [], sensexChain: [], niftyMaxPain: 0, sensexMaxPain: 0,
    timestamp: Date.now(),
  };
}

// ─── Market Data Provider ────────────────────────────────────────────
export class MarketDataProvider {
  private kotakCircuit = new CircuitBreaker(3, 20_000);
  private rateLimiter = new RateLimiter(3_000);
  private deduplicator = new Deduplicator();
  private lastFreshTimestamp: number | null = null;
  private lastGoodData: MarketData | null = null;

  async fetchMarketData(): Promise<MarketDataResult> {
    // Rate limit — return last good data if too fast
    if (!this.rateLimiter.canRequest() && this.lastGoodData) {
      const age = Date.now() - (this.lastFreshTimestamp || 0);
      return {
        data: this.lastGoodData,
        isStale: age > 5000,
        lastFreshAt: this.lastFreshTimestamp,
        source: 'kotak',
        oiSource: 'kotak',
      };
    }

    return this.deduplicator.dedupe(() => this.doFetch());
  }

  private async doFetch(): Promise<MarketDataResult> {
    this.rateLimiter.record();

    if (!this.kotakCircuit.canRequest()) {
      return {
        data: emptyMarketData(),
        isStale: true,
        lastFreshAt: this.lastFreshTimestamp,
        error: 'Kotak data unavailable — circuit breaker open. Retrying shortly.',
        source: 'none',
        oiSource: 'none',
      };
    }

    try {
      const { data, error } = await supabase.functions.invoke('kotak-market-data', {
        body: { strikeRange: 10, symbol: 'NIFTY' },
      });

      if (error) throw new Error(error.message || 'Kotak edge function error');

      if (data?.code === 'NO_SESSION' || data?.code === 'SESSION_EXPIRED') {
        return {
          data: emptyMarketData(),
          isStale: true,
          lastFreshAt: this.lastFreshTimestamp,
          error: data.code === 'NO_SESSION'
            ? 'No live data — connect Kotak broker to trade'
            : 'Kotak session expired — please reconnect',
          source: 'none',
          oiSource: 'none',
        };
      }

      if (!data?.success || !data?.data) {
        throw new Error(data?.error || 'Kotak data unavailable');
      }

      const d = data.data;
      if (d.niftySpot <= 0) {
        throw new Error('Kotak returned zero spot price');
      }

      this.kotakCircuit.recordSuccess();

      const marketData: MarketData = {
        niftySpot: d.niftySpot || 0,
        sensexSpot: d.sensexSpot || 0,
        niftyChange: d.niftyChange || 0,
        sensexChange: d.sensexChange || 0,
        niftyPCR: d.niftyPCR || 0,
        sensexPCR: d.sensexPCR || 0,
        niftyATM: d.niftyATM || 0,
        sensexATM: d.sensexATM || 0,
        niftyChain: (d.niftyChain || []).map((r: any) => ({ ...r, oiSource: 'kotak' as const })),
        sensexChain: d.sensexChain || [],
        niftyMaxPain: d.niftyMaxPain || 0,
        sensexMaxPain: d.sensexMaxPain || 0,
        timestamp: d.timestamp || Date.now(),
      };

      this.lastFreshTimestamp = Date.now();
      this.lastGoodData = marketData;

      return {
        data: marketData,
        isStale: false,
        lastFreshAt: this.lastFreshTimestamp,
        source: 'kotak',
        oiSource: 'kotak',
      };
    } catch (err: any) {
      this.kotakCircuit.recordFailure();
      console.log(`[MarketData] Kotak failed (${this.kotakCircuit.getState()}): ${err.message}`);

      return {
        data: emptyMarketData(),
        isStale: true,
        lastFreshAt: this.lastFreshTimestamp,
        error: `Kotak data unavailable: ${err.message}`,
        source: 'none',
        oiSource: 'none',
      };
    }
  }

  resetCircuitBreaker(): void {
    this.kotakCircuit = new CircuitBreaker(3, 20_000);
    this.lastGoodData = null;
  }
}

// Singleton
export const marketDataProvider = new MarketDataProvider();
