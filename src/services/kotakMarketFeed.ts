import { marketDataProvider, type ActiveDataSource } from '@/services/marketDataProvider';
import type { MarketData } from '@/hooks/useMarketData';

export type FeedStatus = 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'stale';

export interface FeedHealth {
  status: FeedStatus;
  latencyMs: number;
  lastTickTime: number | null;
  errorMessage: string | null;
  consecutiveErrors: number;
  isStale?: boolean;
  lastApiResponseTime?: number | null;
  lastSuccessfulDataTime?: number | null;
  currentSource?: ActiveDataSource;
  sessionError?: 'SESSION_EXPIRED' | 'NO_SESSION' | null;
}

export interface FeedDataResult {
  data: MarketData;
  source: ActiveDataSource;
  oiSource: 'kotak' | 'none';
}

const POLL_INTERVAL_MS = 5000;
const BACKOFF_INTERVAL_MS = 10000;
const MAX_CONSECUTIVE_ERRORS_FOR_BACKOFF = 5;

export class KotakMarketFeed {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private health: FeedHealth = {
    status: 'disconnected', latencyMs: 0, lastTickTime: null,
    errorMessage: null, consecutiveErrors: 0, isStale: false,
    lastApiResponseTime: null, lastSuccessfulDataTime: null,
    currentSource: 'none', sessionError: null,
  };
  private onData: (result: FeedDataResult) => void;
  private onHealthChange: (health: FeedHealth) => void;
  private stopped = false;

  constructor(
    onData: (result: FeedDataResult) => void,
    onHealthChange: (health: FeedHealth) => void,
  ) {
    this.onData = onData;
    this.onHealthChange = onHealthChange;
  }

  start() {
    this.stop();
    this.stopped = false;
    marketDataProvider.resetCircuitBreaker();
    this.fetchData();
    this.intervalId = setInterval(() => this.fetchData(), POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    this.updateHealth({ status: 'disconnected' });
  }

  private async fetchData() {
    if (this.stopped) return;
    const startTime = Date.now();

    const result = await marketDataProvider.fetchMarketData();
    if (this.stopped) return;

    const latency = Date.now() - startTime;
    const hasRealData = result.source === 'kotak' && result.data.niftySpot > 0;

    // Log full API response for debugging
    console.log('[KotakFeed] API response:', {
      success: hasRealData,
      source: result.source,
      niftySpot: result.data.niftySpot,
      chainLength: result.data.niftyChain?.length || 0,
      error: result.error || null,
      isStale: result.isStale,
      latencyMs: latency,
    });

    // Detect session errors
    const sessionError = result.error?.includes('SESSION_EXPIRED')
      ? 'SESSION_EXPIRED' as const
      : result.error?.includes('NO_SESSION') || result.error?.includes('No live data')
        ? 'NO_SESSION' as const
        : null;

    if (hasRealData) {
      this.onData({ data: result.data, source: 'kotak', oiSource: 'kotak' });
      this.updateHealth({
        status: 'connected', latencyMs: latency, lastTickTime: Date.now(),
        errorMessage: null, consecutiveErrors: 0, isStale: false,
        lastApiResponseTime: Date.now(), lastSuccessfulDataTime: Date.now(),
        currentSource: 'kotak', sessionError: null,
      });
    } else {
      const newErrors = this.health.consecutiveErrors + 1;
      const errorMsg = result.error || 'No live data — connect Kotak broker to trade';

      // Send empty data so UI clears signals
      this.onData({ data: result.data, source: 'none', oiSource: 'none' });

      // Instead of stopping, slow down polling after many errors
      if (newErrors >= MAX_CONSECUTIVE_ERRORS_FOR_BACKOFF && this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = setInterval(() => this.fetchData(), BACKOFF_INTERVAL_MS);
        console.log(`[KotakFeed] Backing off to ${BACKOFF_INTERVAL_MS / 1000}s polling after ${newErrors} errors`);
      }

      this.updateHealth({
        status: newErrors >= MAX_CONSECUTIVE_ERRORS_FOR_BACKOFF ? 'error' : 'reconnecting',
        latencyMs: latency, lastTickTime: this.health.lastTickTime,
        errorMessage: errorMsg, consecutiveErrors: newErrors, isStale: true,
        lastApiResponseTime: Date.now(), currentSource: 'none', sessionError,
      });
    }
  }

  private updateHealth(partial: Partial<FeedHealth>) {
    this.health = { ...this.health, ...partial };
    this.onHealthChange({ ...this.health });
  }

  getHealth(): FeedHealth { return { ...this.health }; }
}
