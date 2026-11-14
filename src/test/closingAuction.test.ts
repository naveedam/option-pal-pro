import { describe, it, expect } from 'vitest';
import { getCasState, isExpiryDay, windowAverage, normaliseExpiry } from '@/lib/closingAuction';

// IST helper: build a UTC timestamp for a given IST date/time
const ist = (date: string, hh: number, mm: number, ss = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+05:30`);

describe('closing auction session', () => {
  it('uses V1 before 7 Dec 2026 and V2 from then', () => {
    expect(getCasState(false, ist('2026-11-16', 15, 20)).framework).toBe('V1');
    expect(getCasState(false, ist('2026-12-07', 15, 20)).framework).toBe('V2');
  });

  it('V2 phases on a normal day', () => {
    const d = '2026-12-08';
    expect(getCasState(false, ist(d, 14, 0)).phase).toBe('PRE_CLOSE');
    expect(getCasState(false, ist(d, 15, 20)).phase).toBe('REFERENCE_WINDOW');
    expect(getCasState(false, ist(d, 15, 30, 30)).phase).toBe('CAS_TRANSITION');
    expect(getCasState(false, ist(d, 15, 33)).phase).toBe('CAS_ORDER_ENTRY');
    expect(getCasState(false, ist(d, 15, 37)).phase).toBe('CAS_LIMIT_ONLY');
    expect(getCasState(false, ist(d, 15, 39)).phase).toBe('CAS_RANDOM_CLOSE');
    expect(getCasState(false, ist(d, 15, 42)).phase).toBe('DERIVATIVES_ONLY');
    expect(getCasState(false, ist(d, 15, 46)).phase).toBe('CLOSED');
    expect(getCasState(false, ist(d, 15, 20)).blockNewEntries).toBe(false);
    expect(getCasState(false, ist(d, 15, 33)).blockNewEntries).toBe(true);
  });

  it('V2 expiry day: settlement window and entry cut-off', () => {
    const d = '2026-12-08';
    expect(getCasState(true, ist(d, 15, 5)).phase).toBe('SETTLEMENT_WINDOW');
    expect(getCasState(true, ist(d, 15, 15)).blockNewEntries).toBe(false);
    expect(getCasState(true, ist(d, 15, 21)).blockNewEntries).toBe(true);
  });

  it('V1 phases', () => {
    const d = '2026-11-16';
    expect(getCasState(false, ist(d, 15, 5)).phase).toBe('REFERENCE_WINDOW');
    expect(getCasState(false, ist(d, 15, 20)).phase).toBe('CAS_ORDER_ENTRY');
    expect(getCasState(false, ist(d, 15, 29)).phase).toBe('CAS_RANDOM_CLOSE');
    expect(getCasState(false, ist(d, 15, 37)).phase).toBe('DERIVATIVES_ONLY');
  });

  it('expiry detection', () => {
    expect(isExpiryDay('NIFTY', null, ist('2026-11-17', 10, 0))).toBe(true); // Tuesday
    expect(isExpiryDay('NIFTY', '2026-11-18', ist('2026-11-17', 10, 0))).toBe(false);
    expect(normaliseExpiry('18NOV2026')).toBe('2026-11-18');
    expect(normaliseExpiry('18-Nov-2026')).toBe('2026-11-18');
  });

  it('time-weighted window average', () => {
    const d = '2026-12-08';
    const samples = [0, 1, 2, 3, 4, 5].map(i => ({ t: ist(d, 15, 15 + i), spot: 24000 + i * 10 }));
    const r = windowAverage(samples, [15 * 60 + 15, 15 * 60 + 30], ist(d, 15, 21));
    expect(r).not.toBeNull();
    expect(r!.avg).toBeGreaterThan(24000);
    expect(r!.avg).toBeLessThan(24050);
  });
});
