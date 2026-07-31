import { describe, it, expect } from 'vitest';
import { buildWeatherCardData } from '../weather-card';
import type { LatestWeather } from '../telemetry';

function weather(overrides: Partial<LatestWeather> = {}): LatestWeather {
  return {
    timestamp: '2026-07-25T12:00:00.000Z',
    temp_c: 21.3,
    solar_wm2: 640,
    humidity_pct: 55,
    wind_ms: 3.1,
    rain_day_mm: 0,
    ...overrides,
  };
}

describe('buildWeatherCardData', () => {
  it('returns null when there is no reading yet', () => {
    expect(buildWeatherCardData(null, 600, 19.5, new Date('2026-07-25T12:00:00.000Z'))).toBeNull();
  });

  it('carries the live reading and forecast figures through unchanged', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    const result = buildWeatherCardData(weather(), 600, 19.5, now);
    expect(result).toMatchObject({
      tempC: 21.3,
      solarWm2: 640,
      humidityPct: 55,
      windMs: 3.1,
      rainDayMm: 0,
      forecastGhiWm2: 600,
      forecastMeanTempC: 19.5,
    });
  });

  it('is not stale just after the reading', () => {
    const now = new Date('2026-07-25T12:01:00.000Z');
    const result = buildWeatherCardData(weather({ timestamp: '2026-07-25T12:00:00.000Z' }), null, null, now);
    expect(result?.stale).toBe(false);
    expect(result?.secondsAgo).toBeCloseTo(60, 0);
  });

  it('is stale once the station has been silent a while', () => {
    const now = new Date('2026-07-25T12:20:00.000Z'); // 20 min after the reading
    const result = buildWeatherCardData(weather({ timestamp: '2026-07-25T12:00:00.000Z' }), null, null, now);
    expect(result?.stale).toBe(true);
  });

  it('tolerates a null forecast (Open-Meteo unreachable) without dropping the live reading', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    const result = buildWeatherCardData(weather(), null, null, now);
    expect(result?.tempC).toBe(21.3);
    expect(result?.forecastGhiWm2).toBeNull();
    expect(result?.forecastMeanTempC).toBeNull();
  });

  it('clamps secondsAgo at 0 for a reading that appears to be in the future (clock skew)', () => {
    const now = new Date('2026-07-25T11:00:00.000Z'); // before the reading's own timestamp
    const result = buildWeatherCardData(weather({ timestamp: '2026-07-25T12:00:00.000Z' }), null, null, now);
    expect(result?.secondsAgo).toBe(0);
  });
});
