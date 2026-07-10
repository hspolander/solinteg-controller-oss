import { describe, it, expect } from 'vitest';
import { SKATT_OVERFÖRING } from '../constants';
import {
  computeDailyEconomics,
  mergeDailyEconomics,
  summarize,
  stockholmDateOf,
  stockholmSlotKey,
  priceSlotsToMap,
  type EconReading,
  type PriceLookup,
} from '../economics';

// Fixed price everywhere: buy 200 öre/kWh, sell 50 öre/kWh.
const flatPrice: PriceLookup = () => ({ buy: 200, sell: 50 });

// Test opts: count only gap-based intervals (last reading contributes nothing), no gap cap.
const OPTS = { defaultIntervalMs: 0, maxGapMs: 7_200_000 };

/** Readings spaced exactly 1 h apart from a base UTC time. */
function hourly(base: string, gridWs: number[]): EconReading[] {
  const t0 = Date.parse(base);
  return gridWs.map((grid_w, i) => ({
    grid_w,
    timestamp: new Date(t0 + i * 3_600_000).toISOString(),
  }));
}

describe('computeDailyEconomics', () => {
  it('returns an empty map for no readings', () => {
    expect(computeDailyEconomics([], flatPrice).size).toBe(0);
  });

  it('values grid import at the buy price', () => {
    // Importing 1 kW for two 1 h intervals (third reading is the last → 0 h).
    const readings = hourly('2026-07-01T00:00:00Z', [-1000, -1000, -1000]);
    const day = computeDailyEconomics(readings, flatPrice, OPTS).get('2026-07-01')!;
    expect(day.boughtKwh).toBeCloseTo(2.0);
    expect(day.costKr).toBeCloseTo(4.0); // 2 kWh × 2.00 kr/kWh
    expect(day.soldKwh).toBe(0);
    expect(day.incomeKr).toBe(0);
    expect(day.netKr).toBeCloseTo(-4.0);
  });

  it('values export at the sell price', () => {
    const readings = hourly('2026-07-01T00:00:00Z', [2000, 2000, 2000]);
    const day = computeDailyEconomics(readings, flatPrice, OPTS).get('2026-07-01')!;
    expect(day.soldKwh).toBeCloseTo(4.0);
    expect(day.incomeKr).toBeCloseTo(2.0); // 4 kWh × 0.50 kr/kWh
    expect(day.boughtKwh).toBe(0);
    expect(day.costKr).toBe(0);
    expect(day.netKr).toBeCloseTo(2.0);
  });

  it('a zero grid flow contributes neither bought nor sold kWh', () => {
    const readings = hourly('2026-07-01T00:00:00Z', [0, 0, 0]);
    const day = computeDailyEconomics(readings, flatPrice, OPTS).get('2026-07-01')!;
    expect(day.boughtKwh).toBe(0);
    expect(day.soldKwh).toBe(0);
    expect(day.netKr).toBe(0);
  });

  it('caps the interval so downtime is not billed', () => {
    // Two readings 10 min apart, gap cap 90 s → first reading bills only 90 s.
    const t0 = Date.parse('2026-07-01T00:00:00Z');
    const readings: EconReading[] = [
      { timestamp: new Date(t0).toISOString(), grid_w: -1000 },
      { timestamp: new Date(t0 + 600_000).toISOString(), grid_w: -1000 },
    ];
    const day = computeDailyEconomics(readings, flatPrice, { defaultIntervalMs: 0 }).get(
      '2026-07-01',
    )!;
    // 90 s × 1 kW = 0.025 kWh × 2.00 kr = 0.05 kr (not the full 10 min)
    expect(day.costKr).toBeCloseTo(0.05);
  });

  it('skips readings with no matching price', () => {
    const noPrice: PriceLookup = () => null;
    const readings = hourly('2026-07-01T00:00:00Z', [-1000, -1000]);
    expect(computeDailyEconomics(readings, noPrice, OPTS).size).toBe(0);
  });

  it('buckets readings by Stockholm calendar day', () => {
    // 2026-07-01T23:30Z = 2026-07-02 01:30 Stockholm (CEST +2) → next day.
    const readings: EconReading[] = [
      { timestamp: '2026-07-01T09:00:00Z', grid_w: -1000 },
      { timestamp: '2026-07-01T23:30:00Z', grid_w: -1000 },
    ];
    const daily = computeDailyEconomics(readings, flatPrice, OPTS);
    expect([...daily.keys()].sort()).toEqual(['2026-07-01', '2026-07-02']);
  });
});

describe('mergeDailyEconomics', () => {
  it('sums overlapping days, copies disjoint ones, and mutates neither input', () => {
    // Day 1 appears in both maps (1 kWh bought each); day 2 only in b (2 kWh sold).
    const a = computeDailyEconomics(hourly('2026-07-01T08:00:00Z', [-1000, -1000]), flatPrice, OPTS);
    const b = mergeDailyEconomics(
      computeDailyEconomics(hourly('2026-07-01T10:00:00Z', [-1000, -1000]), flatPrice, OPTS),
      computeDailyEconomics(hourly('2026-07-02T08:00:00Z', [2000, 2000]), flatPrice, OPTS),
    );

    const merged = mergeDailyEconomics(a, b);
    expect(merged.get('2026-07-01')!.boughtKwh).toBeCloseTo(2.0);
    expect(merged.get('2026-07-01')!.netKr).toBeCloseTo(-4.0);
    expect(merged.get('2026-07-02')!.soldKwh).toBeCloseTo(2.0);
    expect(merged.size).toBe(2);

    // Inputs are cloned, not aliased.
    expect(a.get('2026-07-01')!.boughtKwh).toBeCloseTo(1.0);
    expect(b.get('2026-07-01')!.boughtKwh).toBeCloseTo(1.0);
  });
});

describe('summarize', () => {
  it('rolls days into today / month / all-time', () => {
    const readings: EconReading[] = [
      // June day: 1 kW export for 2 h
      { timestamp: '2026-06-15T10:00:00Z', grid_w: 1000 },
      { timestamp: '2026-06-15T11:00:00Z', grid_w: 1000 },
      // July 1 (the "today"): 1 kW export for 1 h
      { timestamp: '2026-07-01T10:00:00Z', grid_w: 1000 },
      { timestamp: '2026-07-01T11:00:00Z', grid_w: 1000 },
    ];
    // 1 h gap cap: each day's two readings bill 1 h each (the cross-day gap caps to 1 h too).
    const daily = computeDailyEconomics(readings, flatPrice, {
      defaultIntervalMs: 0,
      maxGapMs: 3_600_000,
    });
    const s = summarize(daily, '2026-07-01');
    expect(s.days).toBe(2);
    expect(s.latestDate).toBe('2026-07-01');
    expect(s.today.soldKwh).toBeCloseTo(1.0); // July 1: one 1 h interval
    expect(s.today.netKr).toBeCloseTo(0.5); // 1 kWh × 0.50 kr
    expect(s.month.netKr).toBeCloseTo(0.5); // only July 1 is in July
    expect(s.allTime.soldKwh).toBeCloseTo(3.0); // June (2 h) + July (1 h)
    expect(s.allTime.netKr).toBeCloseTo(1.5);
  });
});

describe('time helpers', () => {
  it('stockholmSlotKey floors to 15 min and applies DST offset', () => {
    expect(stockholmSlotKey('2026-07-01T11:07:00Z')).toBe('2026-07-01T13:00'); // CEST +2
    expect(stockholmSlotKey('2026-01-01T11:07:00Z')).toBe('2026-01-01T12:00'); // CET +1
    expect(stockholmSlotKey('2026-07-01T11:22:00Z')).toBe('2026-07-01T13:15'); // floors 22→15
  });

  it('stockholmDateOf returns the Stockholm calendar date', () => {
    expect(stockholmDateOf('2026-07-01T23:30:00Z')).toBe('2026-07-02'); // +2 crosses midnight
  });

  it('priceSlotsToMap keys by minute and adds the buy-side surcharge', () => {
    const map = priceSlotsToMap([
      { startTime: '2026-07-01T13:00:00', price: 50, priceIncludingTaxAndSurcharge: 80 },
    ]);
    expect(map.get('2026-07-01T13:00')).toEqual({ buy: 80 + SKATT_OVERFÖRING, sell: 50 });
  });
});
