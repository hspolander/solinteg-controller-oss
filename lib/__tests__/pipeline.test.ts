import { describe, it, expect } from 'vitest';
import { buildSolarProfiles, buildOptimizerSlots } from '../pipeline';
import { SKATT_OVERFÖRING } from '../constants';
import { avgDailyConsumptionByMonth, hourShareByMonth } from '../consumption-data';
import type { PriceData } from '../prices';

function makeData(overrides: Partial<PriceData> = {}): PriceData {
  return {
    today: '2026-06-28',
    tomorrow: '2026-06-29',
    hasTomorrow: true,
    maxForMonth: 200,
    minForMonth: 50,
    maxAge: 3600,
    prices: [
      {
        startTime: '2026-06-28T12:00:00',
        endTime: '2026-06-28T12:15:00',
        price: 80,
        priceIncludingTaxAndSurcharge: 110,
      },
      {
        startTime: '2026-06-28T14:00:00',
        endTime: '2026-06-28T14:15:00',
        price: 120,
        priceIncludingTaxAndSurcharge: 160,
      },
    ],
    ...overrides,
  };
}

describe('buildSolarProfiles', () => {
  it('includes a profile for today', () => {
    const data = makeData();
    const profiles = buildSolarProfiles(data);
    expect(profiles[6]).toBeDefined(); // June = month 6
    expect(profiles[6]).toHaveLength(24);
  });

  it('includes a profile for tomorrow when it is the same month', () => {
    const data = makeData({ today: '2026-06-28', tomorrow: '2026-06-29' });
    const profiles = buildSolarProfiles(data);
    expect(Object.keys(profiles)).toHaveLength(1); // same month — one entry
  });

  it('adds a second profile when today and tomorrow span a month boundary', () => {
    const data = makeData({ today: '2026-06-30', tomorrow: '2026-07-01' });
    const profiles = buildSolarProfiles(data);
    expect(profiles[6]).toBeDefined();
    expect(profiles[7]).toBeDefined();
  });
});

describe('buildOptimizerSlots', () => {
  it('returns the same number of slots as input prices', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots).toHaveLength(data.prices.length);
  });

  it('buyPrice = priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].buyPrice).toBe(110 + SKATT_OVERFÖRING);
    expect(slots[1].buyPrice).toBe(160 + SKATT_OVERFÖRING);
  });

  it('sellPrice = raw price field only', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].sellPrice).toBe(80);
    expect(slots[1].sellPrice).toBe(120);
  });

  it('uses forecast kWh when a forecast entry is present for the date and slot', () => {
    const data = makeData();
    // slotIndex(12, 0) = 48
    const forecast: Record<string, number[]> = {
      '2026-06-28': Array(96).fill(0).map((_, i) => (i === 48 ? 1.5 : 0)),
    };
    const slots = buildOptimizerSlots(data, forecast, buildSolarProfiles(data));
    expect(slots[0].solarKwh).toBeCloseTo(1.5);
  });

  it('falls back to profile kWh when forecast is null', () => {
    const data = makeData();
    const profiles = buildSolarProfiles(data);
    const slots = buildOptimizerSlots(data, null, profiles);
    // Both slots are daytime in June — expect non-zero solar from the static profile
    expect(slots[0].solarKwh).toBeGreaterThan(0);
  });

  it('preserves startTime from the source price slot', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].startTime).toBe('2026-06-28T12:00:00');
    expect(slots[1].startTime).toBe('2026-06-28T14:00:00');
  });

  it('populates consumptionKwh from the weather-aware load model', () => {
    const data = makeData(); // June
    // At the month-normal HDD (June hddNormal 0.2 → today HDD 0.2 at 12.8 °C) the
    // adjustment cancels, so the daily baseline distributes by the measured hour shares
    // (slot 0 starts 12:00 → June's hour-12 share, quartered per 15-min slot).
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data), { '2026-06-28': 12.8 });
    expect(slots[0].consumptionKwh).toBeGreaterThan(0);
    expect(slots[0].consumptionKwh).toBeCloseTo((avgDailyConsumptionByMonth[5] * hourShareByMonth[5][12]) / 4, 3);
  });

  it('falls back to the baseline load when no temperature map is provided', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].consumptionKwh).toBeCloseTo((avgDailyConsumptionByMonth[5] * hourShareByMonth[5][12]) / 4, 2);
  });

  // ── Provenance tags (for telemetry: forecast-vs-actual validation needs to tell a real
  // forecast/model miss apart from a climatology/baseline fallback slot) ──

  it('tags solarSource as forecast when a forecast entry is present', () => {
    const data = makeData();
    const forecast: Record<string, number[]> = {
      '2026-06-28': Array(96).fill(0).map((_, i) => (i === 48 ? 1.5 : 0)),
    };
    const slots = buildOptimizerSlots(data, forecast, buildSolarProfiles(data));
    expect(slots[0].solarSource).toBe('forecast');
  });

  it('tags solarSource as typical when forecast is null', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].solarSource).toBe('typical');
  });

  it('tags loadSource as modeled when a temperature map covers the date', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data), { '2026-06-28': 12.8 });
    expect(slots[0].loadSource).toBe('modeled');
  });

  it('tags loadSource as baseline when no temperature map is provided', () => {
    const data = makeData();
    const slots = buildOptimizerSlots(data, null, buildSolarProfiles(data));
    expect(slots[0].loadSource).toBe('baseline');
  });
});
