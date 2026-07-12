import { describe, it, expect } from 'vitest';
import { dailyLoadKwh, slotConsumptionKwh } from '../load';
import {
  avgDailyConsumptionByMonth,
  hddNormalByMonth,
  HDD_T_BASE_C,
  hourShareByMonth,
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

describe('hourShareByMonth', () => {
  it('has 12 months × 24 hours, each row summing to 1', () => {
    expect(hourShareByMonth).toHaveLength(12);
    for (const row of hourShareByMonth) {
      expect(row).toHaveLength(24);
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
      for (const v of row) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('reflects the measured winter shape: midday trough below the morning/evening peaks', () => {
    // Only valid for this installation's measured profile (heat-pump household); a site
    // regenerating its own hourShareByMonth may have a different shape — the invariant
    // that matters for the formula is the sums-to-1 test above.
    const jan = hourShareByMonth[0];
    expect(jan[12]).toBeLessThan(jan[7]); // midday < morning peak
    expect(jan[12]).toBeLessThan(jan[17]); // midday < evening peak
  });
});

describe('slotConsumptionKwh', () => {
  it("distributes the daily load by the month's measured hour share, quartered per slot", () => {
    // 0.7°C is Jan's month-normal temp (adjustment cancels), so the day total is the baseline.
    const v = slotConsumptionKwh('2026-01-15T12:00:00', { '2026-01-15': 0.7 });
    expect(v).toBeCloseTo((avgDailyConsumptionByMonth[0] * hourShareByMonth[0][12]) / 4, 4);
  });

  it('sums back to the daily total across all 96 slots of a normal day', () => {
    let sum = 0;
    for (let h = 0; h < 24; h++) {
      for (const mm of ['00', '15', '30', '45']) {
        sum += slotConsumptionKwh(`2026-01-15T${String(h).padStart(2, '0')}:${mm}:00`, {
          '2026-01-15': 0.7,
        });
      }
    }
    // precision 1 (±0.05 kWh): the committed shares are rounded to 4 decimals, so a row
    // sums to 1±0.001 and the day total inherits that rounding, not a formula error.
    expect(sum).toBeCloseTo(avgDailyConsumptionByMonth[0], 1);
  });

  it('gives all four slots of an hour the same value', () => {
    const at = (mm: string) => slotConsumptionKwh(`2026-07-15T18:${mm}:00`, null);
    expect(at('15')).toBeCloseTo(at('00'), 10);
    expect(at('45')).toBeCloseTo(at('00'), 10);
  });

  it('falls back to the baseline day total when the date is missing from the temp map', () => {
    const v = slotConsumptionKwh('2026-01-15T12:00:00', { '2026-02-01': 5 });
    expect(v).toBeCloseTo((avgDailyConsumptionByMonth[0] * hourShareByMonth[0][12]) / 4, 4);
  });

  it('falls back to the baseline day total when no temp map is given', () => {
    const v = slotConsumptionKwh('2026-07-15T00:00:00', null);
    expect(v).toBeCloseTo((avgDailyConsumptionByMonth[6] * hourShareByMonth[6][0]) / 4, 4);
  });
});
