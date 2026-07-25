import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ghiToKwh } from '../solar';
import { slotIndex } from '../slot-utils';
import { solarCalibrationByMonth } from '../consumption-data';

// fetchSolarForecast/fetchDailyMeanTemp are 'use cache' Server Components-only functions that
// hit Open-Meteo directly — untested until now. This is the exact file that shipped the
// hour-label-shift bug fixed 2026-07-20: Open-Meteo's hourly label is the average of the
// PRECEDING interval, so a naive same-hour mapping silently misattributes every slot by an
// hour (or, at 15-min granularity below, by one slot). 'next/cache' is mocked since cacheLife()
// is only meaningful inside a real Next.js request/build; global.fetch is mocked to avoid any
// real network call.
//
// fetchSolarForecast() branches on SOLAR_FORECAST_MODEL (lib/constants.ts, default
// 'metno_nordic'): a truthy model fetches hourly data (shift back one HOUR); '' falls back to
// Open-Meteo's default minutely_15 blend (shift back one 15-min SLOT instead). SOLAR_FORECAST_MODEL
// is a module-level const read from process.env at import time, so the minutely_15 branch is
// tested via vi.stubEnv + vi.resetModules() + a fresh dynamic import — the default-model tests
// use the normal static import.
vi.mock('next/cache', () => ({ cacheLife: vi.fn() }));

import { fetchSolarForecast, fetchDailyMeanTemp } from '../forecast';

function openMeteoHourlyResponse(hourlyTimes: string[], ghi: number[]) {
  return { hourly: { time: hourlyTimes, shortwave_radiation: ghi } };
}

function openMeteoMinutely15Response(times: string[], ghi: number[]) {
  return { minutely_15: { time: times, shortwave_radiation: ghi } };
}

function expectedKwhPerSlot(ghiWm2: number, month: number): number {
  const cal = solarCalibrationByMonth[month - 1];
  return Math.round(((ghiToKwh(ghiWm2) * cal) / 4) * 100) / 100;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('fetchSolarForecast — hourly model (default SOLAR_FORECAST_MODEL=metno_nordic)', () => {
  it('shifts each hourly label back one hour, since Open-Meteo labels an hour by its END', async () => {
    // label "13:00" describes the 12:00-13:00 average -> must land on hour=12's four slots,
    // not hour=13's. This is the exact bug fixed 2026-07-20 (see the module's own comment).
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoHourlyResponse(['2026-01-15T13:00'], [200]),
    } as Response);

    const result = await fetchSolarForecast();
    const expected = expectedKwhPerSlot(200, 1);
    expect(result['2026-01-15'][slotIndex(12, 0)]).toBe(expected);
    expect(result['2026-01-15'][slotIndex(13, 0)]).toBe(0); // NOT the mislabeled hour
  });

  it('repeats the same hourly value across all four 15-min slots of that hour', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoHourlyResponse(['2026-01-15T13:00'], [200]),
    } as Response);

    const result = await fetchSolarForecast();
    const expected = expectedKwhPerSlot(200, 1);
    for (const minute of [0, 15, 30, 45]) {
      expect(result['2026-01-15'][slotIndex(12, minute)]).toBe(expected);
    }
  });

  it('skips label hour 0 (its true hour is the previous, already-elapsed day)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoHourlyResponse(['2026-01-15T00:00', '2026-01-15T01:00'], [50, 100]),
    } as Response);

    const result = await fetchSolarForecast();
    expect(Object.keys(result)).toEqual(['2026-01-15']);
    expect(result['2026-01-15'][slotIndex(0, 0)]).toBe(expectedKwhPerSlot(100, 1));
  });

  it('applies the calibration factor for the slot\'s own month, not the fetch month', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoHourlyResponse(['2026-06-01T13:00'], [300]),
    } as Response);

    const result = await fetchSolarForecast();
    expect(result['2026-06-01'][slotIndex(12, 0)]).toBe(expectedKwhPerSlot(300, 6));
    expect(expectedKwhPerSlot(300, 6)).not.toBe(expectedKwhPerSlot(300, 1)); // sanity: months differ
  });

  it('throws when Open-Meteo responds with a non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(fetchSolarForecast()).rejects.toThrow(/503/);
  });
});

describe('fetchSolarForecast — default minutely_15 blend (SOLAR_FORECAST_MODEL="")', () => {
  it('shifts each 15-min label back one slot, at 15-min granularity rather than a full hour', async () => {
    vi.stubEnv('SOLAR_FORECAST_MODEL', '');
    vi.resetModules();
    const fresh = await import('../forecast');

    // label 13:15 describes the preceding 13:00-13:15 interval -> must land on slotIndex(13, 0),
    // not slotIndex(13, 15).
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoMinutely15Response(['2026-01-15T13:15'], [200]),
    } as Response);

    const result = await fresh.fetchSolarForecast();
    const expected = expectedKwhPerSlot(200, 1);
    expect(result['2026-01-15'][slotIndex(13, 0)]).toBe(expected);
    expect(result['2026-01-15'][slotIndex(13, 15)]).toBe(0); // NOT the mislabeled slot
  });

  it('skips label slot 0 (its true slot is the previous, already-elapsed day)', async () => {
    vi.stubEnv('SOLAR_FORECAST_MODEL', '');
    vi.resetModules();
    const fresh = await import('../forecast');

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => openMeteoMinutely15Response(['2026-01-15T00:00', '2026-01-15T00:15'], [50, 100]),
    } as Response);

    const result = await fresh.fetchSolarForecast();
    expect(Object.keys(result)).toEqual(['2026-01-15']);
    expect(result['2026-01-15'][slotIndex(0, 0)]).toBe(expectedKwhPerSlot(100, 1));
  });
});

describe('fetchDailyMeanTemp', () => {
  it('maps each daily date to its mean temperature', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        daily: { time: ['2026-01-15', '2026-01-16'], temperature_2m_mean: [-3.2, 1.5] },
      }),
    } as Response);

    await expect(fetchDailyMeanTemp()).resolves.toEqual({
      '2026-01-15': -3.2,
      '2026-01-16': 1.5,
    });
  });

  it('omits a date whose temperature reading is null', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        daily: { time: ['2026-01-15', '2026-01-16'], temperature_2m_mean: [-3.2, null] },
      }),
    } as Response);

    await expect(fetchDailyMeanTemp()).resolves.toEqual({ '2026-01-15': -3.2 });
  });

  it('throws when Open-Meteo responds with a non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 } as Response);
    await expect(fetchDailyMeanTemp()).rejects.toThrow(/502/);
  });
});
