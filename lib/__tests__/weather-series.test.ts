import { describe, it, expect } from 'vitest';
import {
  epochMs,
  buildWeatherSeries,
  latestReading,
  buildWeatherPayload,
  type WeatherRow,
} from '../weather-series';
import { ghiToKwh } from '../solar';
import { solarCalibrationByMonth } from '../consumption-data';

function row(overrides: Partial<WeatherRow>): WeatherRow {
  return {
    timestamp: '2026-07-03T10:00:00.000Z',
    solar_wm2: 500,
    temp_c: 21.4,
    uvi: 5.2,
    ...overrides,
  };
}

/** month0 is 0-based, so it indexes solarCalibrationByMonth directly — no `- 1`. */
function expectedPvKw(ghiWm2: number, month0: number): number {
  return Math.round(ghiToKwh(ghiWm2) * solarCalibrationByMonth[month0] * 100) / 100;
}

describe('epochMs', () => {
  it('parses the offset-carrying stamps the poller writes', () => {
    expect(epochMs('2026-07-03T10:00:00.000Z')).toBe(Date.parse('2026-07-03T10:00:00Z'));
    expect(epochMs('2026-07-03T10:00:00+00:00')).toBe(Date.parse('2026-07-03T10:00:00Z'));
    expect(epochMs('2026-07-03T12:00:00+02:00')).toBe(Date.parse('2026-07-03T10:00:00Z'));
  });

  it('reads a naive (offset-less) stamp as UTC, not as host-local', () => {
    // A bare Date.parse succeeds on these with local-time semantics, so the point would land
    // two hours off in Swedish summer instead of at the column's documented UTC meaning.
    expect(epochMs('2026-07-03T10:00:00')).toBe(Date.parse('2026-07-03T10:00:00Z'));
    expect(epochMs('2026-07-03 10:00:00')).toBe(Date.parse('2026-07-03T10:00:00Z'));
    expect(epochMs('2026-07-03T10:00:00.000')).toBe(Date.parse('2026-07-03T10:00:00Z'));
  });

  it('is null for an unparseable stamp', () => {
    expect(epochMs('not a timestamp')).toBeNull();
    expect(epochMs('')).toBeNull();
  });
});

describe('buildWeatherSeries', () => {
  it('scales the modelled production by the month calibration', () => {
    const july = 6;
    const [sample] = buildWeatherSeries([row({ solar_wm2: 500 })], july);
    expect(sample[2]).toBe(expectedPvKw(500, july));
  });

  it('does not emit the raw uncalibrated model output', () => {
    // The regression this pins: ghiToKwh() alone runs 13–43% low against measured production,
    // so an uncalibrated pvKw would sit systematically below the forecast series it is compared
    // against — and it reaches an HA sensor, where it reads as a measurement.
    const july = 6;
    const [sample] = buildWeatherSeries([row({ solar_wm2: 500 })], july);
    const uncalibrated = Math.round(ghiToKwh(500) * 100) / 100;
    expect(sample[2]).not.toBe(uncalibrated);
    expect(sample[2]).toBeGreaterThan(uncalibrated);
  });

  it('indexes the calibration table by month0 without an off-by-one', () => {
    // June (1.26) and July (1.16) differ, so a stray `- 1` would show up here.
    const june = 5;
    const july = 6;
    const [inJune] = buildWeatherSeries([row({ solar_wm2: 500 })], june);
    const [inJuly] = buildWeatherSeries([row({ solar_wm2: 500 })], july);
    expect(inJune[2]).toBe(expectedPvKw(500, june));
    expect(inJuly[2]).toBe(expectedPvKw(500, july));
    expect(inJune[2]).not.toBe(inJuly[2]);
  });

  it('skips rows without an irradiance reading', () => {
    const series = buildWeatherSeries(
      [row({ solar_wm2: null }), row({ timestamp: '2026-07-03T10:15:00.000Z', solar_wm2: 300 })],
      6,
    );
    expect(series).toHaveLength(1);
    expect(series[0][0]).toBe(Date.parse('2026-07-03T10:15:00.000Z'));
  });

  it('skips rows whose timestamp cannot be parsed', () => {
    const series = buildWeatherSeries([row({ timestamp: 'garbage' }), row({})], 6);
    expect(series).toHaveLength(1);
  });

  it('keeps rows with a naive timestamp, resolved as UTC', () => {
    const [sample] = buildWeatherSeries([row({ timestamp: '2026-07-03 10:00:00' })], 6);
    expect(sample[0]).toBe(Date.parse('2026-07-03T10:00:00Z'));
  });

  it('rounds irradiance to 1 decimal and production to 2', () => {
    const [sample] = buildWeatherSeries([row({ solar_wm2: 123.456 })], 6);
    expect(sample[1]).toBe(123.5);
    expect(sample[2]).toBe(expectedPvKw(123.456, 6));
  });

  it('preserves row order and is empty for no rows', () => {
    const series = buildWeatherSeries(
      [
        row({ timestamp: '2026-07-03T10:00:00.000Z' }),
        row({ timestamp: '2026-07-03T10:15:00.000Z' }),
      ],
      6,
    );
    expect(series.map((s) => s[0])).toEqual([
      Date.parse('2026-07-03T10:00:00.000Z'),
      Date.parse('2026-07-03T10:15:00.000Z'),
    ]);
    expect(buildWeatherSeries([], 6)).toEqual([]);
  });
});

describe('latestReading', () => {
  it('is the chronologically last row', () => {
    const latest = latestReading([
      row({ timestamp: '2026-07-03T10:00:00.000Z', temp_c: 20 }),
      row({ timestamp: '2026-07-03T10:15:00.000Z', temp_c: 22 }),
    ]);
    expect(latest).toEqual({
      t: Date.parse('2026-07-03T10:15:00.000Z'),
      wm2: 500,
      tempC: 22,
      uvi: 5.2,
    });
  });

  it('still reports a row that carries no irradiance, with wm2 null', () => {
    const latest = latestReading([row({ solar_wm2: null })]);
    expect(latest?.wm2).toBeNull();
    expect(latest?.tempC).toBe(21.4);
  });

  it('is null for no rows, and for an unparseable last stamp', () => {
    expect(latestReading([])).toBeNull();
    expect(latestReading([row({}), row({ timestamp: 'garbage' })])).toBeNull();
  });

  it('rounds each measurement to 1 decimal, keeping missing fields null', () => {
    const latest = latestReading([row({ solar_wm2: 123.456, temp_c: 21.44, uvi: null })]);
    expect(latest).toMatchObject({ wm2: 123.5, tempC: 21.4, uvi: null });
  });
});

describe('buildWeatherPayload', () => {
  it('assembles the wire form the publisher consumes', () => {
    const rows = [
      row({ timestamp: '2026-07-03T10:00:00.000Z', solar_wm2: null }),
      row({ timestamp: '2026-07-03T10:15:00.000Z', solar_wm2: 500 }),
    ];
    expect(buildWeatherPayload(rows, 6)).toEqual({
      source: 'weather',
      latest: {
        t: Date.parse('2026-07-03T10:15:00.000Z'),
        wm2: 500,
        tempC: 21.4,
        uvi: 5.2,
      },
      today: [[Date.parse('2026-07-03T10:15:00.000Z'), 500, expectedPvKw(500, 6)]],
    });
  });

  it('is the empty payload for no rows', () => {
    expect(buildWeatherPayload([], 6)).toEqual({ source: 'weather', latest: null, today: [] });
  });
});
