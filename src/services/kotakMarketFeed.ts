import { supabase } from '@/integrations/supabase/client';
import type { MarketData, OptionData } from '@/hooks/useMarketData';

export type FeedStatus = 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'broker_disconnected';

export interface FeedHealth {
  status: FeedStatus;
  latencyMs: number;
  lastTickTime: number | null;
  errorMessage: string | null;
  consecutiveErrors: number;
}

const POLL_INTERVAL_MS = 5000; // 5s to avoid spamming
const MAX_CONSECUTIVE_ERRORS = 3;

export class KotakMarketFeed {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private health: FeedHealth = {
    status: 'disconnected',
    latencyMs: 0,
    lastTickTime: null,
    errorMessage: null,
    consecutiveErrors: 0,
  };
  private onData: (data: MarketData) => void;
  private onHealthChange: (health: FeedHealth) => void;
  private instruments: string[];
  private stopped = false;

  constructor(
    onData: (data: MarketData) => void,
    onHealthChange: (health: FeedHealth) => void,
    instruments: string[] = ['NIFTY', 'SENSEX']
  ) {
    this.onData = onData;
    this.onHealthChange = onHealthChange;
    this.instruments = instruments;
  }

  start() {
    this.stop();
    this.stopped = false;
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

    try {
      const { data, error } = await supabase.functions.invoke('kotak-market-data', {
        body: { instruments: this.instruments, strikeRange: 10 },
      });

      if (this.stopped) return;

      if (error) {
        throw new Error(error.message || 'Edge function error');
      }

      if (!data?.success) {
        const code = data?.code;
        // Session-level errors: stop polling entirely, show reconnect
        if (code === 'NO_SESSION' || code === 'SESSION_EXPIRED') {
          this.stopPolling();
          this.updateHealth({
            status: 'broker_disconnected',
            errorMessage: data?.error || 'Broker session expired — please reconnect',
            consecutiveErrors: 0,
          });
          return;
        }
        throw new Error(data?.error || 'Failed to fetch market data');
      }

      const latency = Date.now() - startTime;
      const raw = data.data;
      const niftySpot = raw.niftySpot;
      const sensexSpot = raw.sensexSpot;

      if ((!niftySpot || niftySpot <= 0) && (!sensexSpot || sensexSpot <= 0)) {
        throw new Error('Invalid spot prices received');
      }

      const niftyChain: OptionData[] = (raw.niftyChain || []).filter((r: any) => r.strike > 0);
      const sensexChain: OptionData[] = (raw.sensexChain || []).filter((r: any) => r.strike > 0);

      const marketData: MarketData = {
        niftySpot: niftySpot || 0,
        sensexSpot: sensexSpot || 0,
        niftyChange: raw.niftyChange || 0,
        sensexChange: raw.sensexChange || 0,
        niftyPCR: raw.niftyPCR || 0,
        sensexPCR: raw.sensexPCR || 0,
        niftyATM: raw.niftyATM || 0,
        sensexATM: raw.sensexATM || 0,
        niftyChain,
        sensexChain,
        timestamp: raw.timestamp || Date.now(),
      };

      this.onData(marketData);
      this.updateHealth({
        status: 'connected',
        latencyMs: latency,
        lastTickTime: Date.now(),
        errorMessage: null,
        consecutiveErrors: 0,
      });
    } catch (err: any) {
      if (this.stopped) return;
      const newErrors = this.health.consecutiveErrors + 1;
      console.error('Market feed error:', err.message);

      // Stop after MAX_CONSECUTIVE_ERRORS — no infinite retry
      if (newErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.stopPolling();
        this.updateHealth({
          status: 'error',
          errorMessage: err.message || 'Market data unavailable',
          consecutiveErrors: newErrors,
        });
      } else {
        this.updateHealth({
          status: 'reconnecting',
          errorMessage: err.message,
          consecutiveErrors: newErrors,
        });
      }
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

  getHealth(): FeedHealth {
    return { ...this.health };
  }
}
