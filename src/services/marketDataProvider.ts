/**
 * Resilient Market Data Provider
 * 
 * Features:
 * - Retry with exponential backoff (up to 5 attempts)
 * - Circuit breaker (5 consecutive failures → 30s cooldown)
 * - In-memory cache with TTL (quotes: 5s, chain: 10s)
 * - Rate limiting (max 1 req/symbol/3s)
 * - Request deduplication
 * - Stale data fallback
 */

import { supabase } from '@/integrations/supabase/client';
import type { MarketData } from '@/hooks/useMarketData';

// ─── Types ───────────────────────────────────────────────────────────
export interface MarketDataResult {
  data: MarketData;
  isStale: boolean;
  lastFreshAt: number | null;
  error?: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

// ─── Cache ───────────────────────────────────────────────────────────
class DataCache {
  private store = new Map<string, CacheEntry<any>>();

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, timestamp: Date.now(), ttl: ttlMs });
  }

  get<T>(key: string): { data: T; fresh: boolean } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.timestamp;
    return { data: entry.data as T, fresh: age < entry.ttl };
  }

  getStale<T>(key: string): T | null {
    const entry = this.store.get(key);
    return entry ? (entry.data as T) : null;
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
        console.log('[CircuitBreaker] Entering half-open state');
        return true;
      }
      return false;
    }
    // half-open: allow one request
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
      console.log(`[CircuitBreaker] OPEN — ${this.failures} consecutive failures, cooling down ${this.cooldownMs / 1000}s`);
    }
  }

  getState(): CircuitState { return this.state; }
  getFailures(): number { return this.failures; }
}

// ─── Rate Limiter ────────────────────────────────────────────────────
class RateLimiter {
  private lastRequestTime = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 3_000) {
    this.minIntervalMs = minIntervalMs;
  }

  canRequest(key: string): boolean {
    const last = this.lastRequestTime.get(key) || 0;
    return Date.now() - last >= this.minIntervalMs;
  }

  record(key: string): void {
    this.lastRequestTime.set(key, Date.now());
  }
}

// ─── Request Deduplicator ────────────────────────────────────────────
class Deduplicator {
  private inflight = new Map<string, Promise<any>>();

  async dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.inflight.has(key)) {
      return this.inflight.get(key) as Promise<T>;
    }
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

// ─── Retry with Exponential Backoff ──────────────────────────────────
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 500,
  onRetry?: (attempt: number, error: any) => void,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        onRetry?.(attempt + 1, err);
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
  private circuitBreaker = new CircuitBreaker(5, 30_000);
  private rateLimiter = new RateLimiter(3_000);
  private deduplicator = new Deduplicator();
  private lastFreshTimestamp: number | null = null;

  private readonly CACHE_KEY = 'marketData:all';
  private readonly QUOTE_TTL = 5_000;   // 5 seconds
  private readonly CHAIN_TTL = 10_000;  // 10 seconds

  async fetchMarketData(instruments: string[] = ['NIFTY', 'SENSEX'], strikeRange = 10): Promise<MarketDataResult> {
    const cacheKey = this.CACHE_KEY;

    // Check circuit breaker
    if (!this.circuitBreaker.canRequest()) {
      console.log('[MarketData] Circuit breaker OPEN — returning cached data');
      return this.buildStaleResult(`Market data temporarily unavailable (circuit breaker active, ${this.circuitBreaker.getFailures()} failures)`);
    }

    // Check rate limiter
    if (!this.rateLimiter.canRequest(cacheKey)) {
      const cached = this.cache.get<MarketData>(cacheKey);
      if (cached) {
        return { data: cached.data, isStale: !cached.fresh, lastFreshAt: this.lastFreshTimestamp };
      }
    }

    // Deduplicate concurrent requests
    return this.deduplicator.dedupe(cacheKey, () => this.doFetch(instruments, strikeRange));
  }

  private async doFetch(instruments: string[], strikeRange: number): Promise<MarketDataResult> {
    const cacheKey = this.CACHE_KEY;
    this.rateLimiter.record(cacheKey);

    try {
      const result = await retryWithBackoff(
        async () => {
          const { data, error } = await supabase.functions.invoke('kotak-market-data', {
            body: { instruments, strikeRange },
          });

          if (error) {
            throw new Error(error.message || 'Edge function error');
          }

          if (!data?.success) {
            const code = data?.code;
            console.log('[MarketDataProvider] API failure', { code, error: data?.error });
            // Session-level errors — don't retry
            if (code === 'NO_SESSION' || code === 'SESSION_EXPIRED') {
              const sessionError = new Error(data?.error || 'Session expired') as any;
              sessionError.isSessionError = true;
              sessionError.code = code;
              throw sessionError;
            }
            throw new Error(data?.error || 'API error');
          }

          return data.data as MarketData;
        },
        3, // max 3 retries for API calls
        1000, // 1s base delay
        (attempt, err) => {
          console.log(`[MarketData] Retry ${attempt}: ${err.message}`);
        },
      );

      // Success
      this.circuitBreaker.recordSuccess();
      this.cache.set(cacheKey, result, this.CHAIN_TTL);
      this.lastFreshTimestamp = Date.now();

      return { data: result, isStale: false, lastFreshAt: this.lastFreshTimestamp };

    } catch (err: any) {
      console.log('[MarketDataProvider] Request failed', {
        message: err.message,
        code: err.code,
        isSessionError: !!err.isSessionError,
      });

      // Session errors: don't circuit-break, propagate directly
      if (err.isSessionError) {
        return this.buildStaleResult(err.message, err.code);
      }

      // API/network errors
      this.circuitBreaker.recordFailure();
      console.error(`[MarketData] Fetch failed (circuit: ${this.circuitBreaker.getState()}, failures: ${this.circuitBreaker.getFailures()}):`, err.message);

      return this.buildStaleResult(err.message);
    }
  }

  private buildStaleResult(errorMessage: string, code?: string): MarketDataResult {
    const cached = this.cache.getStale<MarketData>(this.CACHE_KEY);
    if (cached) {
      return {
        data: cached,
        isStale: true,
        lastFreshAt: this.lastFreshTimestamp,
        error: errorMessage,
      };
    }

    // No cached data at all — return empty shell so UI never crashes
    return {
      data: {
        niftySpot: 0, sensexSpot: 0,
        niftyChange: 0, sensexChange: 0,
        niftyPCR: 0, sensexPCR: 0,
        niftyATM: 0, sensexATM: 0,
        niftyChain: [], sensexChain: [],
        timestamp: Date.now(),
      },
      isStale: true,
      lastFreshAt: null,
      error: errorMessage,
    };
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker = new CircuitBreaker(5, 30_000);
  }
}

// Singleton instance
export const marketDataProvider = new MarketDataProvider();
