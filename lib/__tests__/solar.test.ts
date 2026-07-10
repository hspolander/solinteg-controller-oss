import { describe, it, expect } from 'vitest';
import { ghiToKwh, getSolarProfileByMonth, estimateDailyKwh } from '../solar';

describe('ghiToKwh', () => {
  it('returns 0 for zero irradiance', () => {
    expect(ghiToKwh(0)).toBe(0);
  });

  it('scales linearly with GHI', () => {
    const at100 = ghiToKwh(100);
    const at200 = ghiToKwh(200);
    expect(at200).toBeCloseTo(at100 * 2, 10);
  });

  it('produces a plausible kWh/h for 500 W/m² (typical summer midday)', () => {
    // 14.06 kWp system, combined PR ≈ 0.68 → expect ~4–6 kWh at 500 W/m²
    const kwh = ghiToKwh(500);
    expect(kwh).toBeGreaterThan(3);
    expect(kwh).toBeLessThan(8);
  });

  it('is never negative', () => {
    expect(ghiToKwh(0)).toBeGreaterThanOrEqual(0);
    expect(ghiToKwh(1000)).toBeGreaterThanOrEqual(0);
  });
});

describe('getSolarProfileByMonth', () => {
  it('returns exactly 24 values', () => {
    for (let m = 1; m <= 12; m++) {
      expect(getSolarProfileByMonth(m)).toHaveLength(24);
    }
  });

  it('all values are non-negative', () => {
    for (let m = 1; m <= 12; m++) {
      getSolarProfileByMonth(m).forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    }
  });

  it('summer peak (June) is higher than winter (December)', () => {
    const junePeak = Math.max(...getSolarProfileByMonth(6));
    const decPeak = Math.max(...getSolarProfileByMonth(12));
    expect(junePeak).toBeGreaterThan(decPeak);
  });

  it('early night hours are near-zero in every month', () => {
    // UTC 00:00–01:00 should be negligible in Gothenburg (sun rises no earlier than ~02:00 UTC in summer)
    // Historical data may have tiny non-zero values due to sensor noise, so use a low threshold.
    for (let m = 1; m <= 12; m++) {
      const profile = getSolarProfileByMonth(m);
      expect(profile[0]).toBeLessThan(0.05);
      expect(profile[1]).toBeLessThan(0.05);
    }
  });
});

describe('estimateDailyKwh', () => {
  it('returns the sum of the hourly profile', () => {
    for (let m = 1; m <= 12; m++) {
      const profile = getSolarProfileByMonth(m);
      const sum = Math.round(profile.reduce((s, v) => s + v, 0) * 10) / 10;
      expect(estimateDailyKwh(m)).toBeCloseTo(sum, 1);
    }
  });

  it('seasonal ordering: Jun > Apr > Jan', () => {
    expect(estimateDailyKwh(6)).toBeGreaterThan(estimateDailyKwh(4));
    expect(estimateDailyKwh(4)).toBeGreaterThan(estimateDailyKwh(1));
  });
});
