import { marketDataProvider } from '@/services/marketDataProvider';
import type { MarketData } from '@/hooks/useMarketData';

export type FeedStatus = 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'stale';

export interface FeedHealth {
  status: FeedStatus;
  latencyMs: number;
  lastTickTime: number | null;
  errorMessage: string | null;
  consecutiveErrors: number;
  isStale?: boolean;
}

const POLL_INTERVAL_MS = 5000;
const MAX_CONSECUTIVE_ERRORS = 5;

export class KotakMarketFeed {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private health: FeedHealth = {
    status: 'disconnected', latencyMs: 0, lastTickTime: null,
    errorMessage: null, consecutiveErrors: 0, isStale: false,
  };
  private onData: (data: MarketData) => void;
  private onHealthChange: (health: FeedHealth) => void;
  private stopped = false;

  constructor(
    onData: (data: MarketData) => void,
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

    const result = await marketDataProvider.fetchMarketData(['NIFTY', 'SENSEX'], 10);
    if (this.stopped) return;

    const latency = Date.now() - startTime;

    if (result.error) {
      console.log('[KotakMarketFeed] Feed response error', { error: result.error });
    }

    // We got data (fresh or stale)
    const hasRealData = result.data.niftySpot > 0 || result.data.sensexSpot > 0;

    if (hasRealData) {
      this.onData(result.data);
    }

    if (result.isStale && result.error) {
      const newErrors = this.health.consecutiveErrors + 1;

      if (newErrors >= MAX_CONSECUTIVE_ERRORS && !hasRealData) {
        this.stopPolling();
        this.updateHealth({
          status: 'error',
          latencyMs: latency,
          errorMessage: result.error,
          consecutiveErrors: newErrors,
          isStale: true,
        });
      } else {
        // Stale but we have cached data — keep going
        this.updateHealth({
          status: hasRealData ? 'stale' : 'reconnecting',
          latencyMs: latency,
          lastTickTime: result.lastFreshAt,
          errorMessage: result.error,
          consecutiveErrors: newErrors,
          isStale: true,
        });
      }
    } else if (hasRealData) {
      this.updateHealth({
        status: 'connected',
        latencyMs: latency,
        lastTickTime: Date.now(),
        errorMessage: null,
        consecutiveErrors: 0,
        isStale: false,
      });
    }
  }

  private stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private updateHealth(partial: Partial<FeedHealth>) {
    this.health = { ...this.health, ...partial };
    this.onHealthChange({ ...this.health });
  }

  getHealth(): FeedHealth { return { ...this.health }; }
}
