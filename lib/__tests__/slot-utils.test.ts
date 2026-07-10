import { describe, it, expect } from 'vitest';
import { slotIndex, stockholmUtcOffset, slotSolarKwh } from '../slot-utils';

describe('slotIndex', () => {
  it('maps :00 minutes to quarter 0', () => {
    expect(slotIndex(0, 0)).toBe(0);
    expect(slotIndex(6, 0)).toBe(24);
    expect(slotIndex(23, 0)).toBe(92);
  });

  it('maps :15 to quarter 1', () => {
    expect(slotIndex(0, 15)).toBe(1);
    expect(slotIndex(14, 15)).toBe(57);
  });

  it('maps :30 to quarter 2', () => {
    expect(slotIndex(0, 30)).toBe(2);
  });

  it('maps :45 to quarter 3', () => {
    expect(slotIndex(0, 45)).toBe(3);
    expect(slotIndex(23, 45)).toBe(95);
  });

  it('produces 96 unique indices for a full day', () => {
    const indices = new Set<number>();
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        indices.add(slotIndex(h, m));
      }
    }
    expect(indices.size).toBe(96);
    expect(Math.min(...indices)).toBe(0);
    expect(Math.max(...indices)).toBe(95);
  });
});

describe('stockholmUtcOffset', () => {
  it('returns 2 for summer months (CEST)', () => {
    for (const month of [4, 5, 6, 7, 8, 9, 10]) {
      expect(stockholmUtcOffset(month)).toBe(2);
    }
  });

  it('returns 1 for winter months (CET)', () => {
    for (const month of [1, 2, 3, 11, 12]) {
      expect(stockholmUtcOffset(month)).toBe(1);
    }
  });
});

describe('slotSolarKwh', () => {
  const profiles: Record<number, number[]> = {
    // June: 24 hourly values (kWh/h), non-zero midday UTC hours
    6: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 16 ? 4.0 : 0)),
  };

  it('returns forecast value when available', () => {
    const forecast: Record<string, number[]> = {
      '2026-06-15': Array(96).fill(0).map((_, i) => (i === slotIndex(12, 0) ? 1.23 : 0)),
    };
    const { kwh, source } = slotSolarKwh('2026-06-15T12:00:00', forecast, profiles);
    expect(kwh).toBeCloseTo(1.23);
    expect(source).toBe('forecast');
  });

  it('falls back to static profile when forecast is null', () => {
    // June (month 6), Stockholm CEST = UTC+2, so local 14:00 = UTC 12:00
    // profiles[6][12] = 4.0 kWh/h → per slot = 4.0/4 = 1.0 kWh
    const { kwh, source } = slotSolarKwh('2026-06-15T14:00:00', null, profiles);
    expect(kwh).toBeCloseTo(1.0);
    expect(source).toBe('typical');
  });

  it('falls back to static profile when forecast has no entry for that date', () => {
    const forecast: Record<string, number[]> = { '2026-06-16': Array(96).fill(0) };
    const { kwh, source } = slotSolarKwh('2026-06-15T14:00:00', forecast, profiles);
    expect(kwh).toBeCloseTo(1.0);
    expect(source).toBe('typical');
  });

  it('returns 0 for night slots in static profile', () => {
    // Local 02:00 in June → UTC 00:00, profiles[6][0] = 0
    const { kwh } = slotSolarKwh('2026-06-15T02:00:00', null, profiles);
    expect(kwh).toBe(0);
  });
});
