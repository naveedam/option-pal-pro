/**
 * Instrument Token Resolver & Store
 * Loads Kotak scrip master via edge function, caches in memory,
 * and resolves signal → instrument token for order placement.
 */
import { supabase } from '@/integrations/supabase/client';

export interface Instrument {
  token: string;
  neoSymbol: string;      // "nse_fo|<token>"
  symbol: string;         // "NIFTY"
  strike: number;
  optionType: 'CE' | 'PE';
  expiry: string;         // "YYYY-MM-DD" or raw from scrip master
  lotSize: number;
  tradingSymbol: string;  // e.g. "NIFTY24APR22450CE"
}

export interface ResolvedInstrument {
  token: string;
  neoSymbol: string;
  lotSize: number;
  strike: number;
  optionType: 'CE' | 'PE';
  expiry: string;
  tradingSymbol: string;
}

interface InstrumentStoreState {
  instruments: Instrument[];
  loaded: boolean;
  loading: boolean;
  lastLoaded: number;
  error: string | null;
  expiry: string | null;
}

const STORE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const NIFTY_LOT_SIZE = 25;

class InstrumentStore {
  private state: InstrumentStoreState = {
    instruments: [],
    loaded: false,
    loading: false,
    lastLoaded: 0,
    error: null,
    expiry: null,
  };

  private listeners: Set<() => void> = new Set();

  getState(): Readonly<InstrumentStoreState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  isStale(): boolean {
    return !this.state.loaded || (Date.now() - this.state.lastLoaded > STORE_TTL_MS);
  }

  /**
   * Load instruments from the kotak-scrip-master edge function.
   * Silently skips if already loaded and fresh.
   */
  async load(force = false): Promise<void> {
    if (this.state.loading) return;
    if (!force && !this.isStale()) return;

    this.state = { ...this.state, loading: true, error: null };
    this.notify();

    try {
      const { data, error } = await supabase.functions.invoke('kotak-scrip-master', {
        body: { symbol: 'NIFTY' },
      });

      if (error) throw new Error(error.message || 'Failed to fetch scrip master');
      if (!data?.success || !data?.instruments?.length) {
        throw new Error(data?.error || 'No instruments returned');
      }

      const instruments: Instrument[] = data.instruments.map((inst: any) => ({
        token: inst.token,
        neoSymbol: `nse_fo|${inst.token}`,
        symbol: inst.symbol || 'NIFTY',
        strike: inst.strike,
        optionType: inst.optionType,
        expiry: inst.expiry,
        lotSize: inst.lotSize || NIFTY_LOT_SIZE,
        tradingSymbol: inst.tradingSymbol || `NIFTY${inst.expiry}${inst.strike}${inst.optionType}`,
      }));

      this.state = {
        instruments,
        loaded: true,
        loading: false,
        lastLoaded: Date.now(),
        error: null,
        expiry: data.expiry || instruments[0]?.expiry || null,
      };
      console.log(`[InstrumentStore] Loaded ${instruments.length} instruments, expiry: ${this.state.expiry}`);
      this.notify();
    } catch (err: any) {
      console.error('[InstrumentStore] Load failed:', err.message);
      this.state = { ...this.state, loading: false, error: err.message };
      this.notify();
    }
  }

  /**
   * Find an instrument by symbol, strike, and option type.
   * Uses the current weekly expiry stored from the scrip master.
   */
  find(symbol: string, strike: number, optionType: 'CE' | 'PE', expiry?: string): Instrument | null {
    const targetExpiry = expiry || this.state.expiry;
    return this.state.instruments.find(
      i => i.symbol === symbol && i.strike === strike && i.optionType === optionType &&
           (!targetExpiry || i.expiry === targetExpiry)
    ) || null;
  }

  /**
   * Resolve a trade signal to a valid instrument token.
   * Throws descriptive errors if resolution fails.
   */
  resolve(signal: { index: string; strike: number; optionType: 'CE' | 'PE' }): ResolvedInstrument {
    if (!this.state.loaded) {
      throw new InstrumentError('Instrument data not loaded', 'NOT_LOADED');
    }

    const instrument = this.find(signal.index, signal.strike, signal.optionType);
    if (!instrument) {
      throw new InstrumentError(
        `Instrument not found: ${signal.index} ${signal.strike} ${signal.optionType}`,
        'NOT_FOUND'
      );
    }

    // Validate expiry matches current weekly
    if (this.state.expiry && instrument.expiry !== this.state.expiry) {
      throw new InstrumentError(
        `Invalid expiry: ${instrument.expiry} (expected ${this.state.expiry})`,
        'EXPIRY_MISMATCH'
      );
    }

    console.log(`[InstrumentStore] Resolved: ${signal.index} ${signal.strike} ${signal.optionType} → token=${instrument.token}`);

    return {
      token: instrument.token,
      neoSymbol: instrument.neoSymbol,
      lotSize: instrument.lotSize,
      strike: instrument.strike,
      optionType: instrument.optionType,
      expiry: instrument.expiry,
      tradingSymbol: instrument.tradingSymbol,
    };
  }
}

export class InstrumentError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'InstrumentError';
  }
}

/** Get the current weekly expiry (Thursday) in YYYY-MM-DD format */
export function getCurrentWeeklyExpiry(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  const daysUntilThursday = (4 - day + 7) % 7 || 7; // next Thursday, or today if Thursday and before market close
  const thursdayCheck = new Date(now);
  thursdayCheck.setDate(now.getDate() + (day === 4 ? 0 : daysUntilThursday));
  
  // If today is Thursday and past 15:30, use next Thursday
  if (day === 4 && now.getHours() >= 16) {
    thursdayCheck.setDate(thursdayCheck.getDate() + 7);
  }
  
  return thursdayCheck.toISOString().split('T')[0];
}

// Singleton
export const instrumentStore = new InstrumentStore();
