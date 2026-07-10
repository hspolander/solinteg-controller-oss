import { describe, it, expect } from 'vitest';
import { stockholmParts, stockholmToUtc, computeMaxAge, currentSlotIndexInPrices } from '../prices';

// ─── stockholmParts ───────────────────────────────────────────────────────────

describe('stockholmParts', () => {
  it('returns UTC+2 offset in summer (CEST)', () => {
    // 2026-06-15 08:00 UTC = 10:00 Stockholm (CEST = UTC+2)
    const { utcOffset, hour, dateStr } = stockholmParts(new Date('2026-06-15T08:00:00Z'));
    expect(utcOffset).toBe(2);
    expect(hour).toBe(10);
    expect(dateStr).toBe('2026-06-15');
  });

  it('returns UTC+1 offset in winter (CET)', () => {
    // 2026-01-15 09:00 UTC = 10:00 Stockholm (CET = UTC+1)
    const { utcOffset, hour, dateStr } = stockholmParts(new Date('2026-01-15T09:00:00Z'));
    expect(utcOffset).toBe(1);
    expect(hour).toBe(10);
    expect(dateStr).toBe('2026-01-15');
  });

  it('assigns the correct Stockholm date when UTC time is before midnight Stockholm', () => {
    // 2026-06-15 21:00 UTC = 23:00 Stockholm — still June 15
    const { dateStr, hour } = stockholmParts(new Date('2026-06-15T21:00:00Z'));
    expect(dateStr).toBe('2026-06-15');
    expect(hour).toBe(23);
  });

  it('rolls over to the next calendar date when UTC crosses Stockholm midnight', () => {
    // 2026-06-15 22:01 UTC = 00:01 Stockholm on June 16
    const { dateStr, hour } = stockholmParts(new Date('2026-06-15T22:01:00Z'));
    expect(dateStr).toBe('2026-06-16');
    expect(hour).toBe(0);
  });

  it('returns a zero-padded dateStr for single-digit months and days', () => {
    // 2026-03-05 11:00 UTC = 12:00 Stockholm (CET still in early March)
    const { dateStr } = stockholmParts(new Date('2026-03-05T11:00:00Z'));
    expect(dateStr).toBe('2026-03-05');
  });
});

// ─── stockholmToUtc ───────────────────────────────────────────────────────────

describe('stockholmToUtc', () => {
  it('subtracts CEST offset (2 h) to get UTC', () => {
    // Stockholm 14:00 CEST (utcOffset=2) → UTC 12:00
    const result = stockholmToUtc(2026, 5, 15, 2, 14, 0); // month0=5 = June
    expect(result.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('subtracts CET offset (1 h) to get UTC', () => {
    // Stockholm 14:00 CET (utcOffset=1) → UTC 13:00
    const result = stockholmToUtc(2026, 0, 15, 1, 14, 0); // month0=0 = January
    expect(result.toISOString()).toBe('2026-01-15T13:00:00.000Z');
  });

  it('handles h=24 overflow — midnight rolls to the next day', () => {
    // Stockholm midnight (h=24) on June 15 = UTC 22:00 on June 15 (CEST)
    const result = stockholmToUtc(2026, 5, 15, 2, 24, 0);
    expect(result.toISOString()).toBe('2026-06-15T22:00:00.000Z');
  });

  it('includes minutes correctly', () => {
    // Stockholm 13:05 CEST → UTC 11:05
    const result = stockholmToUtc(2026, 5, 15, 2, 13, 5);
    expect(result.toISOString()).toBe('2026-06-15T11:05:00.000Z');
  });
});

// ─── computeMaxAge ────────────────────────────────────────────────────────────

describe('computeMaxAge', () => {
  it('returns seconds until midnight when tomorrow prices are available', () => {
    // now = 22:00 UTC = midnight Stockholm (CEST), so midnight is at 22:00 UTC
    // Let's use 20:00 UTC = 22:00 Stockholm — 2 hours until Stockholm midnight
    const now = new Date('2026-06-15T20:00:00Z'); // Stockholm 22:00
    const parts = stockholmParts(now);
    const maxAge = computeMaxAge(true, now, parts);
    // midnight Stockholm = 22:00 UTC, which is now + 2h = 7200 s
    expect(maxAge).toBeCloseTo(7200, -2); // within ~100s tolerance
  });

  it('returns seconds until 13:05 when no tomorrow prices and hour < 13', () => {
    // Stockholm 10:00 (UTC 08:00 in CEST) — before the 13:05 release time
    const now = new Date('2026-06-15T08:00:00Z'); // Stockholm 10:00
    const parts = stockholmParts(now);
    const maxAge = computeMaxAge(false, now, parts);
    // 13:05 Stockholm = 11:05 UTC → 3h05m = 11100 s from 08:00 UTC
    expect(maxAge).toBeCloseTo(11100, -2);
  });

  it('returns 20 minutes when no tomorrow prices and hour >= 13', () => {
    // Stockholm 15:00 — prices should have been released but are still missing
    const now = new Date('2026-06-15T13:00:00Z'); // Stockholm 15:00
    const parts = stockholmParts(now);
    const maxAge = computeMaxAge(false, now, parts);
    expect(maxAge).toBe(20 * 60);
  });

  it('never returns less than 60 seconds', () => {
    // One second before midnight — should clamp to at least 60
    const now = new Date('2026-06-15T21:59:59Z'); // Stockholm 23:59:59
    const parts = stockholmParts(now);
    const maxAge = computeMaxAge(true, now, parts);
    expect(maxAge).toBeGreaterThanOrEqual(60);
  });
});

// ─── currentSlotIndexInPrices ─────────────────────────────────────────────────

describe('currentSlotIndexInPrices', () => {
  it('returns 0 at the very start of today', () => {
    // 2026-06-15 00:00 Stockholm = 2026-06-14 22:00 UTC (CEST)
    const now = new Date('2026-06-14T22:00:00Z');
    expect(currentSlotIndexInPrices('2026-06-15', now)).toBe(0);
  });

  it('returns the mid-day index matching hour*4 + quarter', () => {
    // 2026-06-15 11:37 Stockholm (CEST, UTC+2) → slot 46 (11*4 + floor(37/15)=2)
    const now = new Date('2026-06-15T09:37:00Z');
    expect(currentSlotIndexInPrices('2026-06-15', now)).toBe(46);
  });

  it('returns 95 for the last slot of the day', () => {
    // 2026-06-15 23:50 Stockholm → slot 95 (23*4 + 3)
    const now = new Date('2026-06-15T21:50:00Z');
    expect(currentSlotIndexInPrices('2026-06-15', now)).toBe(95);
  });

  it('rolls into the tomorrow half of the array (index >= 96) once past midnight', () => {
    // 2026-06-16 00:10 Stockholm — one day after todayDateStr, slot 0 of that day
    const now = new Date('2026-06-15T22:10:00Z');
    expect(currentSlotIndexInPrices('2026-06-15', now)).toBe(96);
  });

  it('returns a negative index when now is before todayDateStr (stale cache/clock skew)', () => {
    const now = new Date('2026-06-13T22:10:00Z'); // Stockholm 2026-06-14 00:10
    expect(currentSlotIndexInPrices('2026-06-15', now)).toBeLessThan(0);
  });

  it('handles the winter UTC+1 offset correctly', () => {
    // 2026-01-15 10:00 Stockholm (CET, UTC+1) → slot 40 (10*4 + 0)
    const now = new Date('2026-01-15T09:00:00Z');
    expect(currentSlotIndexInPrices('2026-01-15', now)).toBe(40);
  });

  // DST-transition days: the feed really returns 92 slots (spring) / 100 slots (fall),
  // verified against elprisetjustnu for 2026-03-29 and 2025-10-26. Wall-clock
  // hour*4 + quarter math is off by ±4 array positions after the 02:00/03:00 gap —
  // these pin the elapsed-time behavior that matches the actual array layout.

  it('indexes correctly after the spring-forward gap (92-slot day)', () => {
    // 2026-03-29: 02:00→03:00 CET skipped. 04:00 CEST = 02:00 UTC; midnight was
    // 2026-03-28T23:00Z (CET), so 3 elapsed hours → slot 12 (wall-clock math said 16).
    const now = new Date('2026-03-29T02:00:00Z');
    expect(currentSlotIndexInPrices('2026-03-29', now)).toBe(12);
  });

  it('rolls into tomorrow at index 92 after a spring-forward day', () => {
    // 2026-03-30 00:00 CEST = 2026-03-29T22:00Z; the 29th had 23 h = 92 slots.
    const now = new Date('2026-03-29T22:00:00Z');
    expect(currentSlotIndexInPrices('2026-03-29', now)).toBe(92);
  });

  it('indexes both occurrences of the repeated hour on the fall-back day (100-slot day)', () => {
    // 2026-10-25: 03:00 CEST → 02:00 CET, so 02:xx occurs twice. Midnight was
    // 2026-10-24T22:00Z (CEST). First 02:30 (CEST) = 00:30Z → slot 10;
    // second 02:30 (CET) = 01:30Z → slot 14. Naive wall-clock math maps both to 10.
    expect(currentSlotIndexInPrices('2026-10-25', new Date('2026-10-25T00:30:00Z'))).toBe(10);
    expect(currentSlotIndexInPrices('2026-10-25', new Date('2026-10-25T01:30:00Z'))).toBe(14);
  });

  it('indexes correctly for the rest of a fall-back day and rolls over at 100', () => {
    // 04:00 CET = 03:00Z → 5 elapsed hours → slot 20 (wall-clock math said 16);
    // next midnight (2026-10-25 24:00 CET = 23:00Z) → slot 100, the 25 h day's length.
    expect(currentSlotIndexInPrices('2026-10-25', new Date('2026-10-25T03:00:00Z'))).toBe(20);
    expect(currentSlotIndexInPrices('2026-10-25', new Date('2026-10-25T23:00:00Z'))).toBe(100);
  });
});
