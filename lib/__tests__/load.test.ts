import { describe, it, expect } from 'vitest';
import { dailyLoadKwh, slotConsumptionKwh } from '../load';
import {
  avgDailyConsumptionByMonth,
  hddNormalByMonth,
  HDD_T_BASE_C,
  LOAD_SLOPE_KWH_PER_HDD,
} from '../consumption-data';

// Derives the expected value from the SAME formula dailyLoadKwh implements, rather than
// hand-copying this household's fitted numbers — so these tests verify the formula/wiring
// (and keep working if a different site regenerates its own consumption-data.ts, see DOMAIN.md's
// "Adapting to a new site"), not this one installation's specific fit.
function expectedLoad(month: number, tempC: number): number {
  const baseline = avgDailyConsumptionByMonth[month - 1];
  const hdd = Math.max(0, HDD_T_BASE_C - tempC);
  return baseline + LOAD_SLOPE_KWH_PER_HDD * (hdd - hddNormalByMonth[month - 1]);
}

describe('dailyLoadKwh', () => {
  it('returns the monthly baseline when no temperature is given', () => {
    expect(dailyLoadKwh(1, null)).toBe(avgDailyConsumptionByMonth[0]);
    expect(dailyLoadKwh(7, undefined)).toBe(avgDailyConsumptionByMonth[6]);
  });

  it('equals the baseline at the month-normal temperature (adjustment cancels)', () => {
    const normalTemp = HDD_T_BASE_C - hddNormalByMonth[0]; // the mean temp whose HDD == hddNormal
    expect(dailyLoadKwh(1, normalTemp)).toBeCloseTo(avgDailyConsumptionByMonth[0], 1);
  });

  it('raises load on a colder-than-normal winter day', () => {
    expect(dailyLoadKwh(1, -7)).toBeCloseTo(expectedLoad(1, -7), 1);
  });

  it('lowers load on a warmer-than-normal winter day', () => {
    expect(dailyLoadKwh(1, 5)).toBeCloseTo(expectedLoad(1, 5), 1);
  });

  it('self-zeroes in summer: a warm July day stays at the baseline', () => {
    // Only valid while July's hddNormal is 0 (true for this installation) — a warmer-climate
    // site regenerating its own hddNormalByMonth could have a nonzero July value, in which case
    // this specific scenario (not the formula) would need a different month.
    expect(hddNormalByMonth[6]).toBe(0);
    expect(dailyLoadKwh(7, 25)).toBeCloseTo(expectedLoad(7, 25), 1);
  });

  it('raises summer load on an unusually cool day', () => {
    expect(dailyLoadKwh(7, 8)).toBeCloseTo(expectedLoad(7, 8), 1);
  });

  it('never returns below the floor, across the whole year and temperature range', () => {
    for (let m = 1; m <= 12; m++) {
      for (let t = -25; t <= 35; t += 5) {
        expect(dailyLoadKwh(m, t)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('slotConsumptionKwh', () => {
  it('spreads the daily load uniformly across 96 slots', () => {
    // 0.7°C is Jan's month-normal temp (adjustment cancels), so this is just the baseline/96.
    const v = slotConsumptionKwh('2026-01-15T12:00:00', { '2026-01-15': 0.7 });
    expect(v).toBeCloseTo(avgDailyConsumptionByMonth[0] / 96, 4);
  });

  it('falls back to the baseline when the date is missing from the temp map', () => {
    const v = slotConsumptionKwh('2026-01-15T12:00:00', { '2026-02-01': 5 });
    expect(v).toBeCloseTo(avgDailyConsumptionByMonth[0] / 96, 4);
  });

  it('falls back to the baseline when no temp map is given', () => {
    const v = slotConsumptionKwh('2026-07-15T00:00:00', null);
    expect(v).toBeCloseTo(avgDailyConsumptionByMonth[6] / 96, 4);
  });
});
