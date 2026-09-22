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

import {
  fetchSolarForecastDirect,
  fetchDailyMeanTempDirect,
  probeMetNordicDirect,
} from '../metno-thredds';
import { cacheLife } from 'next/cache';

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
    // System time is already on an hour boundary, so latestRunBoundary leaves it unchanged:
    // run reference time 2026-01-15T02:00Z. Winter -> Stockholm = UTC+1, so hour 0 UTC is
    // Stockholm hour 3 of the SAME date.
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

    // hour i=0 -> UTC 02:00-03:00 -> Stockholm hour 3, date 2026-01-15, avg 100 W/m²
    expect(result['2026-01-15'][slotIndex(3, 0)]).toBe(expectedKwhPerSlot(100, 1));
    // hour i=1 -> UTC 03:00-04:00 -> Stockholm hour 4, avg 200 W/m²
    expect(result['2026-01-15'][slotIndex(4, 0)]).toBe(expectedKwhPerSlot(200, 1));
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
      expect(result['2026-01-15'][slotIndex(3, minute)]).toBe(expected);
    }
  });

  it('walks back to an earlier hourly run when the latest run’s fetch fails', async () => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z')); // latest run boundary: 2026-01-15T00Z
    const goodBody = opendapAscii([0, 3600 * 100], [270, 271]);

    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      // the latest (00Z) run fails
      if (u.includes('20260115T00Z')) throw new Error('run not published yet');
      return { ok: true, text: async () => goodBody } as Response; // the run 1h earlier succeeds
    });

    const result = await fetchSolarForecastDirect();
    // The successful run is one hour EARLIER, the previous UTC day (2026-01-14T23:00Z) ->
    // Stockholm 2026-01-15T00:00 (winter CET, +1h) — the walk-back moves the run's own
    // reference time, not just its hour-of-day, and this exercises the UTC-day rollover.
    expect(result['2026-01-15'][slotIndex(0, 0)]).toBe(expectedKwhPerSlot(100, 1));
    // Confirms it actually walked back, not that it coincidentally returned data some other way.
    const calledUrls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('20260115T00Z'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('20260114T23Z'))).toBe(true);
  });

  it('percent-encodes the subset brackets — a raw [ or ] is a 400 from met.no', async () => {
    // Regression: thredds.met.no is fronted by Tomcat, which rejects a raw `[`/`]` anywhere in
    // the request target ("Invalid character found in the request target ... RFC 7230 and RFC
    // 3986"). Every run in the walk-back then fails identically, so the whole fallback goes dead
    // and the chain drops to the seasonal climatology — silently, because this path only runs
    // once the primary source has already failed.
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii([0, 3600 * 100], [270, 271]),
    } as Response);

    await fetchSolarForecastDirect();

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).not.toMatch(/[[\]]/);
    expect(url).toContain('%5B0:1:43%5D');
  });

  it('queries metpplatest, not the dated metpparchive path', async () => {
    // Regression: metpparchive (yyyy/mm/dd/-nested, 6-hourly runs) started 404ing on every date
    // tried, including a run that had served fine the day before — confirmed live 2026-09-22 to
    // be a rolling-retention archive that a just-issued run hadn't been populated into yet, not a
    // "latest" mirror. metpplatest is what actually carries near-real-time runs (same MEPS model,
    // same grid, confirmed live 2026-09-22), as a flat directory of hourly-named files with no
    // date subdirectory at all — so both the collection name AND the path shape had to change,
    // not just one or the other.
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii([0, 3600 * 100], [270, 271]),
    } as Response);

    await fetchSolarForecastDirect();

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toContain('/thredds/dodsC/metpplatest/met_forecast_1_0km_nordic_20260115T02Z.nc');
    expect(url).not.toContain('metpparchive');
    expect(url).not.toContain('/2026/01/15/'); // no dated subdirectory on metpplatest
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

describe('probeMetNordicDirect', () => {
  // The liveness probe behind GET /api/weather-fallback-check. It exists because this whole
  // module is only reached when Open-Meteo has already failed, so it can be — and on the
  // reference deployment was, for weeks — completely dead without anything noticing.
  it('reports the run it reached and how many hours it got', async () => {
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z')); // latest run boundary: 02Z
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii([0, 3600 * 100, 3600 * 300], [270, 271, 272]),
    } as Response);

    await expect(probeMetNordicDirect()).resolves.toEqual({
      runIso: '2026-01-15T02:00:00.000Z',
      hours: 3,
    });
  });

  it('does NOT answer from the cached wrapper — a cached success would hide a dead tier', async () => {
    // The one property that makes this a liveness probe rather than a cache read:
    // fetchMetNordicDirect is `'use cache'` with an 8 h expiry, so a probe routed through it
    // could keep reporting yesterday's success while every live request 400s. cacheLife() is
    // called only inside that wrapper, so its absence here is the proof.
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: async () => opendapAscii([0, 3600 * 100], [270, 271]),
    } as Response);
    // Module-level mock, so it carries calls from every test above this one.
    vi.mocked(cacheLife).mockClear();

    await probeMetNordicDirect();
    expect(vi.mocked(cacheLife)).not.toHaveBeenCalled();

    // ...and the contrast: the normal fallback path does go through it.
    await fetchSolarForecastDirect();
    expect(vi.mocked(cacheLife)).toHaveBeenCalled();
  });

  it('surfaces the fetch failure instead of swallowing it', async () => {
    // The shape that motivated it: every run in the walk-back returns the same status, so the
    // probe
    // must hand the caller a message the alert can name (healthcheck.py fingerprints on it).
    vi.setSystemTime(new Date('2026-01-15T02:00:00Z'));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as Response);

    await expect(probeMetNordicDirect()).rejects.toThrow('met.no thredds fetch failed: 400');
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
