/**
 * Resilient Market Data Provider
 * 
 * Priority: Kotak REST API (real data) → Yahoo Finance (fallback)
 * 
 * Features:
 * - Kotak-first with Yahoo fallback
 * - Retry with exponential backoff
 * - Circuit breaker (5 consecutive failures → 30s cooldown)
 * - In-memory cache with TTL
 * - Rate limiting & request deduplication
 * - Stale data fallback
 * - Data source tracking (kotak vs yahoo)
 */

import { supabase } from '@/integrations/supabase/client';
import type { MarketData } from '@/hooks/useMarketData';

// ─── Types ───────────────────────────────────────────────────────────
export type ActiveDataSource = 'kotak' | 'yahoo' | 'none';

export interface MarketDataResult {
  data: MarketData;
  isStale: boolean;
  lastFreshAt: number | null;
  error?: string;
  source: ActiveDataSource;
  oiSource: 'nse' | 'synthetic' | 'kotak';
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  source: ActiveDataSource;
  oiSource: 'nse' | 'synthetic' | 'kotak';
}

type CircuitState = 'closed' | 'open' | 'half-open';

// ─── Cache ───────────────────────────────────────────────────────────
class DataCache {
  private store = new Map<string, CacheEntry<any>>();

  set<T>(key: string, data: T, ttlMs: number, source: ActiveDataSource, oiSource: 'nse' | 'synthetic' | 'kotak'): void {
    this.store.set(key, { data, timestamp: Date.now(), ttl: ttlMs, source, oiSource });
  }

  get<T>(key: string): { data: T; fresh: boolean; source: ActiveDataSource; oiSource: 'nse' | 'synthetic' | 'kotak' } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.timestamp;
    return { data: entry.data as T, fresh: age < entry.ttl, source: entry.source, oiSource: entry.oiSource };
  }

  getStale<T>(key: string): { data: T; source: ActiveDataSource; oiSource: 'nse' | 'synthetic' | 'kotak' } | null {
    const entry = this.store.get(key);
    return entry ? { data: entry.data as T, source: entry.source, oiSource: entry.oiSource } : null;
  }
}

// ─── Circuit Breaker ─────────────────────────────────────────────────
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;

  constructor(maxFailures = 5, cooldownMs = 30_000) {
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
  getFailures(): number { return this.failures; }
}

// ─── Rate Limiter ────────────────────────────────────────────────────
class RateLimiter {
  private lastRequestTime = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 3_000) { this.minIntervalMs = minIntervalMs; }

  canRequest(key: string): boolean {
    const last = this.lastRequestTime.get(key) || 0;
    return Date.now() - last >= this.minIntervalMs;
  }

  record(key: string): void { this.lastRequestTime.set(key, Date.now()); }
}

// ─── Deduplicator ────────────────────────────────────────────────────
class Deduplicator {
  private inflight = new Map<string, Promise<any>>();

  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.inflight.has(key)) return this.inflight.get(key) as Promise<T>;
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

// ─── Retry ───────────────────────────────────────────────────────────
async function retryWithBackoff<T>(
  fn: () => Promise<T>, maxRetries = 2, baseDelayMs = 500,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`[Retry] Attempt ${attempt + 1}/${maxRetries}, waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── Market Data Provider ────────────────────────────────────────────
export class MarketDataProvider {
  private cache = new DataCache();
  private kotakCircuit = new CircuitBreaker(3, 20_000);
  private yahooCircuit = new CircuitBreaker(5, 30_000);
  private rateLimiter = new RateLimiter(3_000);
  private deduplicator = new Deduplicator();
  private lastFreshTimestamp: number | null = null;

  private readonly CACHE_KEY = 'marketData:all';
  private readonly CHAIN_TTL = 10_000;

  async fetchMarketData(instruments: string[] = ['NIFTY', 'SENSEX'], strikeRange = 10): Promise<MarketDataResult> {
    const cacheKey = this.CACHE_KEY;

    // Check rate limiter — return cache if too fast
    if (!this.rateLimiter.canRequest(cacheKey)) {
      const cached = this.cache.get<MarketData>(cacheKey);
      if (cached) {
        return { data: cached.data, isStale: !cached.fresh, lastFreshAt: this.lastFreshTimestamp, source: cached.source, oiSource: cached.oiSource };
      }
    }

    return this.deduplicator.dedupe(cacheKey, () => this.doFetch(instruments, strikeRange));
  }

  private async doFetch(instruments: string[], strikeRange: number): Promise<MarketDataResult> {
    const cacheKey = this.CACHE_KEY;
    this.rateLimiter.record(cacheKey);

    // ── Try Kotak first ──
    if (this.kotakCircuit.canRequest()) {
      try {
        const result = await this.fetchFromKotak();
        if (result) {
          this.kotakCircuit.recordSuccess();
          this.cache.set(cacheKey, result, this.CHAIN_TTL, 'kotak', 'kotak');
          this.lastFreshTimestamp = Date.now();
          return { data: result, isStale: false, lastFreshAt: this.lastFreshTimestamp, source: 'kotak', oiSource: 'kotak' };
        }
      } catch (err: any) {
        this.kotakCircuit.recordFailure();
        console.log(`[MarketData] Kotak failed (${this.kotakCircuit.getState()}): ${err.message}`);
      }
    }

    // ── Fall back to Yahoo ──
    if (this.yahooCircuit.canRequest()) {
      try {
        const result = await this.fetchFromYahoo();
        if (result.data) {
          this.yahooCircuit.recordSuccess();
          const oiSource = result.oiSource || 'synthetic';
          this.cache.set(cacheKey, result.data, this.CHAIN_TTL, 'yahoo', oiSource);
          this.lastFreshTimestamp = Date.now();
          return { data: result.data, isStale: false, lastFreshAt: this.lastFreshTimestamp, source: 'yahoo', oiSource };
        }
      } catch (err: any) {
        this.yahooCircuit.recordFailure();
        console.error(`[MarketData] Yahoo also failed: ${err.message}`);
      }
    }

    // ── Both failed — return stale cache ──
    return this.buildStaleResult('Both Kotak and Yahoo data sources unavailable');
  }

  private async fetchFromKotak(): Promise<MarketData | null> {
    const result = await retryWithBackoff(async () => {
      const { data, error } = await supabase.functions.invoke('kotak-market-data', {
        body: { strikeRange: 10, symbol: 'NIFTY' },
      });

      if (error) throw new Error(error.message || 'Kotak edge function error');

      // Session errors — don't retry
      if (data?.code === 'NO_SESSION' || data?.code === 'SESSION_EXPIRED') {
        console.log(`[Kotak] ${data.code} — skipping to Yahoo`);
        return null;
      }

      if (!data?.success || !data?.data) {
        throw new Error(data?.error || 'Kotak data unavailable');
      }

      const d = data.data;
      if (d.niftySpot <= 0) {
        throw new Error('Kotak returned zero spot price');
      }

      console.log(`[MarketData] Kotak: NIFTY=${d.niftySpot} chain=${d.niftyChain?.length}`);

      return {
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
      } as MarketData;
    }, 1, 1000);

    return result;
  }

  private async fetchFromYahoo(): Promise<{ data: MarketData; oiSource: 'nse' | 'synthetic' }> {
    const result = await retryWithBackoff(async () => {
      const { data, error } = await supabase.functions.invoke('nse-market-data');

      if (error) throw new Error(error.message || 'Yahoo edge function error');
      if (!data?.success || !data?.data) throw new Error(data?.error || 'Yahoo data unavailable');

      const d = data.data;
      const oiSource: 'nse' | 'synthetic' = data.oiSource === 'nse' ? 'nse' : 'synthetic';

      return {
        data: {
          niftySpot: d.niftySpot || 0,
          sensexSpot: d.sensexSpot || 0,
          niftyChange: d.niftyChange || 0,
          sensexChange: d.sensexChange || 0,
          niftyPCR: d.niftyPCR || 0,
          sensexPCR: d.sensexPCR || 0,
          niftyATM: d.niftyATM || 0,
          sensexATM: d.sensexATM || 0,
          niftyChain: d.niftyChain || [],
          sensexChain: d.sensexChain || [],
          niftyMaxPain: d.niftyMaxPain || 0,
          sensexMaxPain: d.sensexMaxPain || 0,
          timestamp: d.timestamp || Date.now(),
        } as MarketData,
        oiSource,
      };
    }, 2, 2000);

    return result;
  }

  private buildStaleResult(errorMessage: string): MarketDataResult {
    const cached = this.cache.getStale<MarketData>(this.CACHE_KEY);
    if (cached) {
      return { data: cached.data, isStale: true, lastFreshAt: this.lastFreshTimestamp, error: errorMessage, source: cached.source, oiSource: cached.oiSource };
    }

    return {
      data: {
        niftySpot: 0, sensexSpot: 0, niftyChange: 0, sensexChange: 0,
        niftyPCR: 0, sensexPCR: 0, niftyATM: 0, sensexATM: 0,
        niftyChain: [], sensexChain: [], niftyMaxPain: 0, sensexMaxPain: 0,
        timestamp: Date.now(),
      },
      isStale: true, lastFreshAt: null, error: errorMessage,
      source: 'none', oiSource: 'synthetic',
    };
  }

  resetCircuitBreaker(): void {
    this.kotakCircuit = new CircuitBreaker(3, 20_000);
    this.yahooCircuit = new CircuitBreaker(5, 30_000);
  }
}

// Singleton
export const marketDataProvider = new MarketDataProvider();
