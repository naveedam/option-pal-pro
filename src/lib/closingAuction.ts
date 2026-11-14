// Closing Auction Session (CAS) — NSE/BSE equity cash segment.
//
// Two SEBI frameworks are encoded:
//  • V1 (live 3 Aug 2026 → 6 Dec 2026, SEBI circular 16 Jan 2026 / NSE SOP 18 Mar 2026)
//      Reference price = VWAP 15:00–15:15, CAS 15:15–15:35, random close of order entry 15:28–15:30.
//      Index F&O trades until 15:40 (non-expiring); expiring index contracts settle on CAS closing prices.
//  • V2 (from 7 Dec 2026, SEBI circular 15 Oct 2026)
//      Continuous trading until 15:30. CAS 15:30–15:40:
//        15:30–15:31 reference price + order transition
//        15:31–15:36 limit + market orders
//        15:36–15:40 limit only, random close 15:38–15:40
//      Reference price = VWAP of last 15 min of continuous trading (15:15–15:30).
//      Index derivatives trade until 15:45; expiring index contracts stop at 15:30 and settle on the
//      index computed from constituents' VWAP of the last 30 min of continuous trading (15:00–15:30).
//
// All times are IST minutes-of-day.

export type CasFramework = 'V1' | 'V2';

export type CasPhase =
  | 'PRE_CLOSE'          // normal continuous trading, before any closing window
  | 'SETTLEMENT_WINDOW'  // expiry-day settlement-VWAP window (V2: 15:00–15:30)
  | 'REFERENCE_WINDOW'   // VWAP window that sets the CAS reference price
  | 'CAS_TRANSITION'     // reference price calc / order transition
  | 'CAS_ORDER_ENTRY'    // limit + market orders
  | 'CAS_LIMIT_ONLY'     // limit orders only
  | 'CAS_RANDOM_CLOSE'   // order entry may close at any moment
  | 'CAS_MATCHING'       // V1 only: matching after order entry closes
  | 'DERIVATIVES_ONLY'   // cash closed, index F&O still trading
  | 'CLOSED';

export interface CasConfig {
  framework: CasFramework;
  refWindow: [number, number];
  settlementWindow: [number, number] | null; // expiry-day VWAP settlement window (V2 only)
  casStart: number;
  casEnd: number;
  phases: { phase: CasPhase; start: number; end: number }[];
  indexDerivativesClose: number;   // non-expiring
  expiringIndexClose: number;
}

const m = (h: number, min: number) => h * 60 + min;

export const V2_EFFECTIVE_DATE = '2026-12-07';

const V1: CasConfig = {
  framework: 'V1',
  refWindow: [m(15, 0), m(15, 15)],
  settlementWindow: null,
  casStart: m(15, 15),
  casEnd: m(15, 35),
  phases: [
    { phase: 'CAS_TRANSITION', start: m(15, 15), end: m(15, 16) },
    { phase: 'CAS_ORDER_ENTRY', start: m(15, 16), end: m(15, 28) },
    { phase: 'CAS_RANDOM_CLOSE', start: m(15, 28), end: m(15, 30) },
    { phase: 'CAS_MATCHING', start: m(15, 30), end: m(15, 35) },
  ],
  indexDerivativesClose: m(15, 40),
  expiringIndexClose: m(15, 30),
};

const V2: CasConfig = {
  framework: 'V2',
  refWindow: [m(15, 15), m(15, 30)],
  settlementWindow: [m(15, 0), m(15, 30)],
  casStart: m(15, 30),
  casEnd: m(15, 40),
  phases: [
    { phase: 'CAS_TRANSITION', start: m(15, 30), end: m(15, 31) },
    { phase: 'CAS_ORDER_ENTRY', start: m(15, 31), end: m(15, 36) },
    { phase: 'CAS_LIMIT_ONLY', start: m(15, 36), end: m(15, 38) },
    { phase: 'CAS_RANDOM_CLOSE', start: m(15, 38), end: m(15, 40) },
  ],
  indexDerivativesClose: m(15, 45),
  expiringIndexClose: m(15, 30),
};

/** IST calendar date (YYYY-MM-DD), weekday (0=Sun) and minutes-of-day with seconds fraction. */
export function istClock(ts: number = Date.now()) {
  const d = new Date(ts + 5.5 * 3600_000);
  const date = d.toISOString().slice(0, 10);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return { date, weekday: d.getUTCDay(), minutes };
}

export function getCasConfig(ts: number = Date.now()): CasConfig {
  return istClock(ts).date >= V2_EFFECTIVE_DATE ? V2 : V1;
}

/** Normalise an expiry string (YYYY-MM-DD, DD-MMM-YYYY, DDMMMYYYY, 26NOV18…) to YYYY-MM-DD, or null. */
export function normaliseExpiry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const mt = s.match(/^(\d{1,2})[-\s]?([A-Z]{3})[-\s]?(\d{2,4})$/);
  if (mt) {
    const mon = months.indexOf(mt[2]);
    if (mon < 0) return null;
    const yr = mt[3].length === 2 ? 2000 + Number(mt[3]) : Number(mt[3]);
    return `${yr}-${String(mon + 1).padStart(2, '0')}-${mt[1].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Is today an expiry day for the index? Uses the loaded contract expiry when available,
 * otherwise the standard weekly expiry weekday (NIFTY Tuesday, SENSEX Thursday).
 * Holiday-shifted expiries are only caught when the scrip-master expiry is loaded.
 */
export function isExpiryDay(index: 'NIFTY' | 'SENSEX', contractExpiry: string | null, ts: number = Date.now()): boolean {
  const { date, weekday } = istClock(ts);
  const exp = normaliseExpiry(contractExpiry);
  if (exp) return exp === date;
  return index === 'NIFTY' ? weekday === 2 : weekday === 4;
}

export interface CasState {
  framework: CasFramework;
  phase: CasPhase;
  expiryDay: boolean;
  /** seconds until the current phase ends (0 if not applicable) */
  secondsToPhaseEnd: number;
  /** true when the index spot is no longer a continuous-trading price (cash in auction / closed) */
  spotIsIndicative: boolean;
  /** true when new option entries should not be generated for the traded (nearest) contract */
  blockNewEntries: boolean;
  blockReason: string | null;
  config: CasConfig;
}

export function getCasState(expiryDay: boolean, ts: number = Date.now()): CasState {
  const cfg = getCasConfig(ts);
  const { minutes, weekday } = istClock(ts);
  const weekend = weekday === 0 || weekday === 6;
  const derivClose = expiryDay ? cfg.expiringIndexClose : cfg.indexDerivativesClose;

  let phase: CasPhase = 'PRE_CLOSE';
  let phaseEnd = 0;

  const casPhase = cfg.phases.find(p => minutes >= p.start && minutes < p.end);
  if (weekend || minutes < m(9, 15) || minutes >= Math.max(derivClose, cfg.casEnd)) {
    phase = 'CLOSED';
  } else if (casPhase) {
    phase = casPhase.phase; phaseEnd = casPhase.end;
  } else if (minutes >= cfg.casEnd) {
    phase = 'DERIVATIVES_ONLY'; phaseEnd = derivClose;
  } else if (minutes >= cfg.refWindow[0] && minutes < cfg.refWindow[1]) {
    phase = 'REFERENCE_WINDOW'; phaseEnd = cfg.refWindow[1];
  } else if (expiryDay && cfg.settlementWindow && minutes >= cfg.settlementWindow[0] && minutes < cfg.settlementWindow[1]) {
    phase = 'SETTLEMENT_WINDOW'; phaseEnd = cfg.refWindow[0];
  }

  const spotIsIndicative = !weekend && minutes >= cfg.casStart;

  let blockReason: string | null = null;
  if (phase === 'CLOSED') blockReason = 'Market closed';
  else if (minutes >= derivClose) blockReason = expiryDay ? 'Expiring contracts have stopped trading' : 'Index derivatives closed';
  else if (expiryDay && minutes >= derivClose - 10) blockReason = 'Expiry day: no new entries in the last 10 min before expiring contracts stop';
  else if (spotIsIndicative) blockReason = 'Cash market in closing auction — spot is indicative';

  return {
    framework: cfg.framework,
    phase,
    expiryDay,
    secondsToPhaseEnd: phaseEnd ? Math.max(0, Math.round((phaseEnd - minutes) * 60)) : 0,
    spotIsIndicative,
    blockNewEntries: blockReason !== null,
    blockReason,
    config: cfg,
  };
}

export const CAS_PHASE_LABEL: Record<CasPhase, string> = {
  PRE_CLOSE: 'Continuous',
  SETTLEMENT_WINDOW: 'Settlement VWAP',
  REFERENCE_WINDOW: 'CAS Ref VWAP',
  CAS_TRANSITION: 'CAS · Transition',
  CAS_ORDER_ENTRY: 'CAS · Order Entry',
  CAS_LIMIT_ONLY: 'CAS · Limit Only',
  CAS_RANDOM_CLOSE: 'CAS · Random Close',
  CAS_MATCHING: 'CAS · Matching',
  DERIVATIVES_ONLY: 'F&O Only',
  CLOSED: 'Closed',
};

// ─── Spot sampling ────────────────────────────────────────────────────
// Kotak's index quote has no traded volume, so window "VWAPs" are approximated with a
// time-weighted average of spot samples (each sample weighted by the time until the next one).
export interface SpotSample { t: number; spot: number }

export function windowAverage(samples: SpotSample[], window: [number, number], ts: number = Date.now()): { avg: number; coverage: number } | null {
  const { date } = istClock(ts);
  const inWin = samples.filter(s => {
    const c = istClock(s.t);
    return c.date === date && c.minutes >= window[0] && c.minutes < window[1];
  });
  if (inWin.length < 3) return null;
  let wSum = 0, sum = 0;
  for (let i = 0; i < inWin.length; i++) {
    const next = inWin[i + 1]?.t ?? Math.min(ts, inWin[i].t + 5000);
    const w = Math.max(1, next - inWin[i].t);
    wSum += w; sum += inWin[i].spot * w;
  }
  const first = istClock(inWin[0].t).minutes;
  const last = istClock(inWin[inWin.length - 1].t).minutes;
  const coverage = Math.min(1, (last - first) / (window[1] - window[0]));
  return { avg: sum / wSum, coverage };
}

/** Fraction of a window elapsed at ts (0..1). */
export function windowProgress(window: [number, number], ts: number = Date.now()): number {
  const { minutes } = istClock(ts);
  return Math.max(0, Math.min(1, (minutes - window[0]) / (window[1] - window[0])));
}
