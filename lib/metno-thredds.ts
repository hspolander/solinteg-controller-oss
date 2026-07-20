import { cacheLife } from 'next/cache';
import { ghiToKwh } from './solar';
import { slotIndex } from './slot-utils';
import { solarCalibrationByMonth } from './consumption-data';
import { SITE_LATITUDE, SITE_LONGITUDE } from './constants';

// Second-tier fallback for fetchSolarForecast/fetchDailyMeanTemp (lib/forecast.ts): when
// Open-Meteo itself errors (a transient 502/503/timeout, not a sustained model outage — see
// TELEMETRY.md's Open-Meteo-fallback-frequency check), fetch the same MET Nordic model straight
// from MET Norway's own Thredds server instead of giving up straight to seasonal-average
// climatology. Only meaningful when SOLAR_FORECAST_MODEL is 'metno_nordic' (see DOMAIN.md §5) —
// this fetches that exact model by a different transport, not a substitute for whatever else you
// configured, so the caller (lib/plan.ts) only reaches for it in that case.
//
// api.met.no's friendly Locationforecast API doesn't carry solar radiation at all (checked
// 2026-07-20 against its own docs/FAQ) — the raw MET Nordic shortwave-radiation grid only
// exists on thredds.met.no as gridded NetCDF, hence this being a direct OPeNDAP point-query
// rather than a simple second JSON endpoint.
//
// Grid: 1km Lambert Conformal Conic, tangent at 63°N, central meridian 15°E
// (+proj=lcc +lat_0=63 +lon_0=15 +lat_1=63 +lat_2=63 +R=6371000) — read live from the dataset's
// own .das 2026-07-20, not documented anywhere as a stable public contract, so this is pinned to
// what was observed, not derived from a spec. Grid origin/spacing (x0, y0, cell size, 1796x2321
// extent) likewise read from the x/y coordinate arrays themselves. Covers Norway/Sweden/Denmark/
// Finland only (same domain as metno_nordic itself) — outside that, see the bounds check below.
const LCC_LAT0 = (63 * Math.PI) / 180;
const LCC_LON0 = (15 * Math.PI) / 180;
const LCC_R = 6371000;
const GRID_X0 = -897442.2;
const GRID_Y0 = -1104322.0;
const GRID_CELL_M = 1000;
const GRID_NX = 1796;
const GRID_NY = 2321;

// Lambert Conformal Conic forward projection (tangent case, since lat_1 = lat_2 = lat_0 here) —
// Snyder's formulas. Returns the nearest grid cell to SITE_LATITUDE/SITE_LONGITUDE, or null if
// that falls outside the grid's 1796x2321 extent (i.e. your site isn't in the Nordic domain
// metno_nordic covers — see DOMAIN.md §5). Verified live 2026-07-20 that an in-domain cell's own
// lat/lon (fetched back from the dataset) lands within ~400m of the site, well inside 1 cell.
function siteGridIndex(): { ix: number; iy: number } | null {
  const lat = (SITE_LATITUDE * Math.PI) / 180;
  const lon = (SITE_LONGITUDE * Math.PI) / 180;
  const n = Math.sin(LCC_LAT0);
  const F = (Math.cos(LCC_LAT0) * Math.tan(Math.PI / 4 + LCC_LAT0 / 2) ** n) / n;
  const rho0 = (LCC_R * F) / Math.tan(Math.PI / 4 + LCC_LAT0 / 2) ** n;
  const rho = (LCC_R * F) / Math.tan(Math.PI / 4 + lat / 2) ** n;
  const theta = n * (lon - LCC_LON0);
  const x = rho * Math.sin(theta);
  const y = rho0 - rho * Math.cos(theta);
  const ix = Math.round((x - GRID_X0) / GRID_CELL_M);
  const iy = Math.round((y - GRID_Y0) / GRID_CELL_M);
  if (ix < 0 || ix >= GRID_NX || iy < 0 || iy >= GRID_NY) return null;
  return { ix, iy };
}

// Deliberately its own constant, not the shared FETCH_TIMEOUT_MS (tuned for Open-Meteo's fast
// JSON responses): a single OPeNDAP point query here measured ~8.6s over plain curl (2026-07-20,
// no server load spike involved) — this endpoint subsets a live ~4GB NetCDF file server-side per
// request rather than serving from a fast path, so a short timeout would make the fallback
// itself flaky on exactly the days it's needed.
const THREDDS_FETCH_TIMEOUT_MS = 25_000;

// Identifies this client per MET Norway's ToS (a missing/generic UA gets throttled or blocked,
// not just frowned upon — see api.met.no/doc/TermsOfService). Points at the project repo rather
// than a personal contact since this same default runs on every self-hoster's install.
const THREDDS_USER_AGENT = 'solinteg-controller/1.0 (+https://github.com/hspolander/solinteg-controller-oss)';
const SHORTWAVE_VAR = 'integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time';
const TEMP_VAR = 'air_temperature_2m';
// Runs are issued 00/06/12/18Z; this only needs ~2 days ahead (matching Open-Meteo's
// forecast_days=2), and every run observed 2026-07-20 (00Z/06Z/12Z) covered at least that —
// staying well under the shortest observed length (56) leaves margin without a discovery round trip.
const FORECAST_HOURS = 44;
// How many 6-hourly runs to walk back if the latest expected one isn't published/reachable yet
// (observed ~2h publish latency for the 12Z run; walking back avoids hardcoding that number).
const RUN_LOOKBACK_ATTEMPTS = 4;

function runFileUrl(runTime: Date): string {
  const yyyy = runTime.getUTCFullYear();
  const mm = String(runTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(runTime.getUTCDate()).padStart(2, '0');
  const hh = String(runTime.getUTCHours()).padStart(2, '0');
  return (
    `https://thredds.met.no/thredds/dodsC/metpparchive/${yyyy}/${mm}/${dd}/` +
    `met_forecast_1_0km_nordic_${yyyy}${mm}${dd}T${hh}Z.nc`
  );
}

// Most recent 00/06/12/18Z boundary at or before `from`.
function latestRunBoundary(from: Date): Date {
  const d = new Date(from);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 6) * 6);
  return d;
}

// The OPeNDAP ASCII response repeats each requested Grid variable as a
// "<var>.<var>[N][1][1]" block followed by "[i][0], value" lines — parse just that value
// column for the given variable name (skipping the trailing time/y/x coordinate-map blocks
// the server always appends, which use a different header).
function extractSeries(text: string, varName: string): number[] {
  const lines = text.split('\n');
  const header = `${varName}.${varName}[`;
  const startIdx = lines.findIndex((l) => l.startsWith(header));
  if (startIdx === -1) throw new Error(`met.no thredds: response missing ${varName}`);
  const values: number[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\[\d+\]\[0\], (.+)$/);
    if (!m) break;
    values.push(parseFloat(m[1]));
  }
  return values;
}

async function fetchPointSeries(
  runTime: Date,
  ix: number,
  iy: number,
): Promise<{ shortwaveCumulative: number[]; tempKelvin: number[] }> {
  const range = `0:1:${FORECAST_HOURS - 1}`;
  const url =
    `${runFileUrl(runTime)}.ascii?` +
    `${SHORTWAVE_VAR}[${range}][${iy}][${ix}],${TEMP_VAR}[${range}][${iy}][${ix}]`;
  const res = await fetch(url, {
    headers: { 'User-Agent': THREDDS_USER_AGENT },
    signal: AbortSignal.timeout(THREDDS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`met.no thredds fetch failed: ${res.status}`);
  const text = await res.text();
  return {
    shortwaveCumulative: extractSeries(text, SHORTWAVE_VAR),
    tempKelvin: extractSeries(text, TEMP_VAR),
  };
}

async function fetchLatestRun(): Promise<{
  runTime: Date;
  shortwaveCumulative: number[];
  tempKelvin: number[];
}> {
  const grid = siteGridIndex();
  if (!grid) {
    throw new Error(
      'met.no thredds: SITE_LATITUDE/SITE_LONGITUDE fall outside the MET Nordic grid ' +
        '(Norway/Sweden/Denmark/Finland only) — see DOMAIN.md §5',
    );
  }
  const { ix, iy } = grid;
  let runTime = latestRunBoundary(new Date());
  let lastErr: unknown;
  for (let attempt = 0; attempt < RUN_LOOKBACK_ATTEMPTS; attempt++) {
    try {
      const { shortwaveCumulative, tempKelvin } = await fetchPointSeries(runTime, ix, iy);
      return { runTime, shortwaveCumulative, tempKelvin };
    } catch (err) {
      lastErr = err;
      runTime = new Date(runTime.getTime() - 6 * 3600 * 1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('met.no thredds: all recent runs failed');
}

async function fetchMetNordicDirect() {
  'use cache';
  // Same cache window as fetchSolarForecast/fetchDailyMeanTemp (lib/forecast.ts) — this is
  // only ever reached when Open-Meteo has already failed, so there's no reason to refresh it
  // any more eagerly than the primary source.
  cacheLife({ revalidate: 3600, expire: 8 * 3600 });
  return fetchLatestRun();
}

// Converts a UTC instant to its Europe/Stockholm calendar date + wall-clock hour via Intl (not
// manual +1/+2 arithmetic, which gets the spring/autumn DST transitions wrong) — Intl's IANA tz
// data handles that correctly for free. If you've adapted SITE_LATITUDE/SITE_LONGITUDE outside
// Sweden but still within the Nordic grid, change this to your own local IANA zone.
function stockholmDateHour(utcMs: number): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const hour = parseInt(parts.hour, 10) % 24; // ICU emits "24" for midnight with hour12:false
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

// Same shape/units as fetchSolarForecast: date → 96-element kWh-per-15-min-slot array. Unlike
// Open-Meteo's hourly labels, the raw MET Nordic series has no alignment ambiguity — index i is
// unambiguously the cumulative shortwave-radiation integral i hours after this run's own
// forecast_reference_time, so hour i's average is just the delta to i+1 divided by 3600s.
export async function fetchSolarForecastDirect(): Promise<Record<string, number[]>> {
  const { runTime, shortwaveCumulative } = await fetchMetNordicDirect();
  const result: Record<string, number[]> = {};
  for (let i = 0; i < shortwaveCumulative.length - 1; i++) {
    const hourStartUtcMs = runTime.getTime() + i * 3600_000;
    const avgWm2 = (shortwaveCumulative[i + 1] - shortwaveCumulative[i]) / 3600;
    const { date, hour } = stockholmDateHour(hourStartUtcMs);
    const month = parseInt(date.slice(5, 7), 10);
    const cal = solarCalibrationByMonth[month - 1];
    const kwhPerSlot = Math.round(((ghiToKwh(avgWm2) * cal) / 4) * 100) / 100;
    if (!result[date]) result[date] = new Array(96).fill(0);
    for (let minute = 0; minute < 60; minute += 15) {
      result[date][slotIndex(hour, minute)] = kwhPerSlot;
    }
  }
  return result;
}

// Same shape as fetchDailyMeanTemp: date → forecast daily mean outdoor temperature (°C).
// air_temperature_2m is instantaneous per hour (not cumulative like shortwave), so this is a
// plain mean of the run's hourly readings that fall on each Stockholm calendar date.
export async function fetchDailyMeanTempDirect(): Promise<Record<string, number>> {
  const { runTime, tempKelvin } = await fetchMetNordicDirect();
  const byDate = new Map<string, { sum: number; n: number }>();
  for (let i = 0; i < tempKelvin.length; i++) {
    const { date } = stockholmDateHour(runTime.getTime() + i * 3600_000);
    const acc = byDate.get(date) ?? { sum: 0, n: 0 };
    acc.sum += tempKelvin[i] - 273.15;
    acc.n += 1;
    byDate.set(date, acc);
  }
  const result: Record<string, number> = {};
  for (const [date, { sum, n }] of byDate) result[date] = Math.round((sum / n) * 10) / 10;
  return result;
}
