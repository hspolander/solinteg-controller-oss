import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ghiToKwh } from '../solar';
import { slotIndex } from '../slot-utils';
import { solarCalibrationByMonth } from '../consumption-data';

// The second-tier fallback used when Open-Meteo itself errors while SOLAR_FORECAST_MODEL is
// 'metno_nordic' (see DOMAIN.md §5 / lib/plan.ts). Untested until now. 'next/cache' is mocked
// (cacheLife is only meaningful inside a real Next.js request/build); global.fetch is mocked to
// avoid any real network/OPeNDAP call. Not covered here: the SITE_LATITUDE/SITE_LONGITUDE
// out-of-Nordic-grid guard (siteGridIndex() returning null) — these tests all use the reference
// deployment's own (in-domain) coordinates, so that branch is never exercised.
vi.mock('next/cache', () => ({ cacheLife: vi.fn() }));

import { fetchSolarForecastDirect, fetchDailyMeanTempDirect } from '../metno-thredds';

const SHORTWAVE_VAR = 'integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time';
const TEMP_VAR = 'air_temperature_2m';

/** Builds a minimal OPeNDAP .ascii response body in the exact block format extractSeries()
 * parses: a "<var>.<var>[N][1][1]" header line, then one "[i][0], value" line per hour. */
function opendapAscii(shortwaveCumulative: number[], tempKelvin: number[]): string {
  const block = (varName: string, values: number[]) => {
    const header = `${varName}.${varName}[${values.length}][1][1]`;
    const lines = values.map((v, i) => `[${i}][0], ${v}`);
    return [header, ...lines].join('\n');
  };
  return [
    block(SHORTWAVE_VAR, shortwaveCumulative),
    block(TEMP_VAR, tempKelvin),
    // Trailing coordinate-map blocks the server always appends, with a different header shape —
    // extractSeries must stop at the first non-matching line, not choke on these.
    'time, 1, 2, 3',
  ].join('\n\n');
}

function expectedKwhPerSlot(avgWm2: number, month: number): number {
  const cal = solarCalibrationByMonth[month - 1];
  return Math.round(((ghiToKwh(avgWm2) * cal) / 4) * 100) / 100;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchSolarForecastDirect', () => {
  it('converts the cumulative shortwave integral into a per-hour average GHI, bucketed by Stockholm date/hour', async () => {
    // Run reference time 2026-01-15T00:00Z (a run boundary); winter -> Stockholm = UTC+1, so
    // hour 0 UTC is Stockholm hour 1 of the SAME date.
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    // Cumulative integral in J/m² accumulates 3600 * avgWm2 each hour: hour0->hour1 delta of
    // 3600*100 means avg 100 W/m² for that hour.
    const cumulative = [0, 3600 * 100, 3600 * 100 + 3600 * 200];
    const kelvin = [270, 271, 272];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii(cumulative, kelvin),
    } as Response);

    const result = await fetchSolarForecastDirect();

    // hour i=0 -> UTC 00:00-01:00 -> Stockholm hour 1, date 2026-01-15, avg 100 W/m²
    expect(result['2026-01-15'][slotIndex(1, 0)]).toBe(expectedKwhPerSlot(100, 1));
    // hour i=1 -> UTC 01:00-02:00 -> Stockholm hour 2, avg 200 W/m²
    expect(result['2026-01-15'][slotIndex(2, 0)]).toBe(expectedKwhPerSlot(200, 1));
  });

  it('repeats each hour’s value across all four 15-min slots', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    const cumulative = [0, 3600 * 150];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii(cumulative, [270, 271]),
    } as Response);

    const result = await fetchSolarForecastDirect();
    const expected = expectedKwhPerSlot(150, 1);
    for (const minute of [0, 15, 30, 45]) {
      expect(result['2026-01-15'][slotIndex(1, minute)]).toBe(expected);
    }
  });

  it('walks back to an earlier 6-hourly run when the latest run’s fetch fails', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z')); // latest run boundary: 00Z
    const goodBody = opendapAscii([0, 3600 * 100], [270, 271]);

    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('T00Z')) throw new Error('run not published yet'); // the latest (00Z) run fails
      return { ok: true, text: async () => goodBody } as Response; // the 18Z run (6h earlier) succeeds
    });

    const result = await fetchSolarForecastDirect();
    // The successful run is the 18Z run one day EARLIER (2026-01-14T18:00Z) -> Stockholm
    // 19:00 on 2026-01-14 (winter CET, +1h), not 2026-01-15 — the walk-back moves the run's
    // own reference time, not just its hour-of-day.
    expect(result['2026-01-14'][slotIndex(19, 0)]).toBe(expectedKwhPerSlot(100, 1));
    // Confirms it actually walked back, not that it coincidentally returned data some other way.
    const calledUrls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('T00Z'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('T18Z'))).toBe(true);
  });

  it('throws after exhausting every lookback attempt', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockRejectedValue(new Error('met.no unreachable'));

    await expect(fetchSolarForecastDirect()).rejects.toThrow(/met\.no unreachable/);
  });
});

describe('fetchDailyMeanTempDirect', () => {
  it('averages Kelvin readings into a per-Stockholm-date mean Celsius figure', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    // Two hourly Kelvin readings both landing on Stockholm date 2026-01-15 (hours 1 and 2).
    const kelvin = [273.15, 275.15]; // 0.0°C and 2.0°C
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii([0, 3600], kelvin),
    } as Response);

    const result = await fetchDailyMeanTempDirect();
    expect(result['2026-01-15']).toBeCloseTo(1.0, 1); // mean of 0.0°C and 2.0°C
  });
});

describe('OPeNDAP ASCII parsing edge cases (via fetchSolarForecastDirect)', () => {
  it('propagates a parse error when the expected variable block is missing from the response', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => 'some_other_var.some_other_var[2][1][1]\n[0][0], 1\n[1][0], 2',
    } as Response);

    await expect(fetchSolarForecastDirect()).rejects.toThrow(new RegExp(SHORTWAVE_VAR));
  });

  it('throws when the run file fetch itself returns a non-ok status', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(fetchSolarForecastDirect()).rejects.toThrow(/404/);
  });
});
