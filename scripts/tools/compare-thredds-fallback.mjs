// Backtests the TWO solar-forecast sources actually live in production today — Open-Meteo's
// metno_nordic model (fetchSolarForecast, lib/forecast.ts — the primary path) and the direct
// MET Norway Thredds fetch (fetchSolarForecastDirect, lib/metno-thredds.ts — used only as a
// fallback on the ~30% of days Open-Meteo 502s, see that file's header) — against the site's
// own measured GHI, to answer a genuinely open question nobody had measured yet: are these two
// paths actually equivalent in accuracy (in which case "fallback for reliability only" is the
// right framing), or does one systematically beat the other (in which case the fallback's role
// might be worth reconsidering)? Both draw on the same underlying MET Nordic model, so any
// measured gap here is attributable to the data path (Open-Meteo's own processing/interpolation
// of the grid vs. reading it directly) or to publish-latency differences, NOT model choice —
// scripts/tools/compare-metno-solar.mjs already settled the model-choice question separately.
//
// Ground truth: the station's own measured GHI (CSV: timestamp,solar_wm2, UTC ISO timestamps),
// already validated against SMHI + CAMS (see CLAUDE.md) — disagreements here are forecast
// error, not station error.
//
// Thredds sampling: ALL FOUR daily synoptic runs (00/06/12/18Z), stitched by taking, for each
// target hour, the value from the FRESHEST run available at/before that hour — this is the
// fair match for Open-Meteo's own documented reconstruction method for this exact API
// ("a continuous hourly timeseries built by stitching the first hours of each successive model
// run" — confirmed against Open-Meteo's docs 2026-07-25). An earlier version of this script
// used a single fixed 06Z run held for the whole day, which measured Thredds as far worse
// (MAE 104 vs 78 W/m²) — that comparison was invalid: it compared a stale, up-to-18h-old
// forecast against Open-Meteo's continuously-refreshed one, not the same lead time. This
// version fixes that. Sequential, not parallel, requests: each Thredds point-query subsets a
// live ~4GB NetCDF file server-side (~8-25s per request, see lib/metno-thredds.ts's
// THREDDS_FETCH_TIMEOUT_MS comment) — hammering it in parallel would be both slow to fail and
// impolite to MET Norway's server. ~100 requests for a 25-day window; budget 20-40 minutes.
//
// Usage: node scripts/tools/compare-thredds-fallback.mjs [--csv solar-data/own_station_july.csv]
//            [--lat 57.64] [--lon 11.78]
//
// FINDINGS (2026-07-25, 2026-07-01..07-25, 412-433 shared daylight hours; recorded here
// because the numbers gate the fallback's role — see also lib/metno-thredds.ts's header):
//   - An earlier single-06Z-run-per-day version of this script measured Open-Meteo far ahead
//     (MAE 78.3 vs 104.1 W/m²) — that methodology was invalid (stale-all-day Thredds vs.
//     Open-Meteo's continuously-refreshed reconstruction, not the same lead time). Re-run with
//     the fair stitched-multi-run method above (all 4 daily synoptic runs, freshest-at-each-
//     hour): result is nearly IDENTICAL — MAE 78.3 vs 103.0 W/m², bias 36.5 vs 35.0, head-to-
//     head 68%/32%, consistent across clear (74%)/mixed (56%)/overcast (66%) days. The fresher
//     runs available via stitching did NOT meaningfully close the gap.
//   - Conclusion: the gap is REAL, not a lead-time artifact. Likely cause: Open-Meteo does real
//     spatial interpolation/post-processing on the raw MET Nordic grid; this script's (and
//     production's, see lib/metno-thredds.ts's siteGridIndex) direct-Thredds path is a simple
//     nearest-grid-cell lookup with no interpolation. MET Nordic's own forecast skill doesn't
//     improve much between ~2h and ~8h lead for shortwave radiation at this site in this
//     window — so freshness isn't the lever; grid-interpolation quality likely is.
//   - Keep the direct Thredds fetch as a RELIABILITY-only fallback (better than no forecast at
//     all on an Open-Meteo outage). Do NOT promote it to primary or blend it in on the
//     assumption the two paths are equivalent just because they're nominally the same model —
//     confirmed, twice now, that they are not equivalent in accuracy as currently implemented.
//     A real fix (if ever worth the effort) would be bilinear/area-weighted interpolation
//     across the surrounding grid cells instead of nearest-cell — untested, not attempted here.

import fs from 'node:fs';

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const CSV = argVal('--csv', 'solar-data/own_station_july.csv');
const LAT = parseFloat(argVal('--lat', process.env.SITE_LATITUDE ?? '57.64'));
const LON = parseFloat(argVal('--lon', process.env.SITE_LONGITUDE ?? '11.78'));
const DAYLIGHT_WM2 = 5;

// ── 1. Measured GHI → UTC-hour means ──
const lines = fs.readFileSync(CSV, 'utf-8').trim().split('\n').slice(1);
const hourAcc = new Map();
for (const line of lines) {
  const [ts, v] = line.split(',');
  const w = parseFloat(v);
  if (!Number.isFinite(w)) continue;
  const key = ts.slice(0, 13);
  const a = hourAcc.get(key) ?? [0, 0];
  a[0] += w;
  a[1] += 1;
  hourAcc.set(key, a);
}
const actual = new Map([...hourAcc].map(([k, [s, n]]) => [k, s / n]));
const hours = [...actual.keys()].sort();
const startDate = hours[0].slice(0, 10);
const endDate = hours[hours.length - 1].slice(0, 10);
console.log(`Measured GHI: ${actual.size} UTC-hour buckets, ${startDate}..${endDate}\n`);

// ── 2a. Open-Meteo metno_nordic, archived (one request, whole range) ──
async function fetchOpenMeteoMetno() {
  const params = new URLSearchParams({
    latitude: LAT, longitude: LON, hourly: 'shortwave_radiation',
    models: 'metno_nordic', timezone: 'UTC', start_date: startDate, end_date: endDate,
  });
  const res = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`open-meteo metno_nordic: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const out = new Map();
  json.hourly.time.forEach((t, i) => {
    const v = json.hourly.shortwave_radiation[i];
    if (v != null) out.set(t.slice(0, 13), v);
  });
  return out;
}

// ── 2b. Direct MET Norway Thredds, one run per day ──
// Lambert Conformal Conic projection + grid constants, ported verbatim from
// lib/metno-thredds.ts (kept in sync by hand — this is a standalone analysis script, not
// something the app imports, so it can't share that module's Next.js-cached export directly).
const LCC_LAT0 = (63 * Math.PI) / 180;
const LCC_LON0 = (15 * Math.PI) / 180;
const LCC_R = 6371000;
const GRID_X0 = -897442.2;
const GRID_Y0 = -1104322.0;
const GRID_CELL_M = 1000;
const SHORTWAVE_VAR = 'integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time';
// Identifies this client per MET Norway's ToS — same reasoning as lib/metno-thredds.ts's own
// UA: point at the project repo, not a personal contact, because this default ships to every
// self-hoster. A missing or generic UA gets throttled or blocked, not just frowned upon (see
// api.met.no/doc/TermsOfService). If you run this at any volume, put your own contact here.
const THREDDS_USER_AGENT =
  'solinteg-controller/1.0 (offline backtest; +https://github.com/hspolander/solinteg-controller-oss)';

function siteGridIndex(lat, lon) {
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const n = Math.sin(LCC_LAT0);
  const F = (Math.cos(LCC_LAT0) * Math.tan(Math.PI / 4 + LCC_LAT0 / 2) ** n) / n;
  const rho0 = (LCC_R * F) / Math.tan(Math.PI / 4 + LCC_LAT0 / 2) ** n;
  const rho = (LCC_R * F) / Math.tan(Math.PI / 4 + latR / 2) ** n;
  const theta = n * (lonR - LCC_LON0);
  const x = rho * Math.sin(theta);
  const y = rho0 - rho * Math.cos(theta);
  return { ix: Math.round((x - GRID_X0) / GRID_CELL_M), iy: Math.round((y - GRID_Y0) / GRID_CELL_M) };
}

function runFileUrl(runTime) {
  const yyyy = runTime.getUTCFullYear();
  const mm = String(runTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(runTime.getUTCDate()).padStart(2, '0');
  const hh = String(runTime.getUTCHours()).padStart(2, '0');
  return `https://thredds.met.no/thredds/dodsC/metpparchive/${yyyy}/${mm}/${dd}/met_forecast_1_0km_nordic_${yyyy}${mm}${dd}T${hh}Z.nc`;
}

function extractSeries(text, varName) {
  const lines = text.split('\n');
  const header = `${varName}.${varName}[`;
  const startIdx = lines.findIndex((l) => l.startsWith(header));
  if (startIdx === -1) throw new Error(`met.no thredds: response missing ${varName}`);
  const values = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\[\d+\]\[0\], (.+)$/);
    if (!m) break;
    values.push(parseFloat(m[1]));
  }
  return values;
}

async function fetchRun(runTime, ix, iy) {
  const range = '0:1:43'; // 44 hours, matches lib/metno-thredds.ts's FORECAST_HOURS
  const url = `${runFileUrl(runTime)}.ascii?${SHORTWAVE_VAR}[${range}][${iy}][${ix}]`;
  const res = await fetch(url, { headers: { 'User-Agent': THREDDS_USER_AGENT }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractSeries(await res.text(), SHORTWAVE_VAR);
}

// Fetches every 6-hourly synoptic run (00/06/12/18Z) covering [startDate-1day, endDate], then
// stitches: for each target hour, use the value from the FRESHEST run at/before that hour —
// the fair match for Open-Meteo's own "stitch first hours of each successive run" method (see
// header). startDate-1 is included so early hours of startDate have a valid preceding run to
// stitch from instead of falling back to nothing.
async function fetchThreddsStitched(dates) {
  const { ix, iy } = siteGridIndex(LAT, LON);
  const runs = []; // { runTime: Date, series: number[] (cumulative shortwave) }
  const firstDate = new Date(`${dates[0]}T00:00:00Z`);
  firstDate.setUTCDate(firstDate.getUTCDate() - 1);
  const allRunTimes = [];
  for (let d = new Date(firstDate); d <= new Date(`${dates[dates.length - 1]}T18:00:00Z`); d.setUTCHours(d.getUTCHours() + 6)) {
    allRunTimes.push(new Date(d));
  }
  const now = new Date();
  let ok = 0, failed = 0;
  for (const runTime of allRunTimes) {
    if (runTime > now) continue;
    try {
      const series = await fetchRun(runTime, ix, iy);
      runs.push({ runTime, series });
      ok++;
    } catch (err) {
      failed++;
      process.stderr.write(`  run ${runTime.toISOString()} failed (${err.message}), skipping\n`);
    }
    if ((ok + failed) % 10 === 0) process.stdout.write(`  ...${ok + failed}/${allRunTimes.length} runs fetched (${ok} ok, ${failed} failed)\n`);
  }
  runs.sort((a, b) => a.runTime - b.runTime);
  console.log(`  ${ok} runs fetched ok, ${failed} failed, out of ${allRunTimes.length} attempted\n`);

  // Stitch: for each target hour, the freshest run at/before it.
  const out = new Map();
  for (const dateStr of dates) {
    for (let h = 0; h < 24; h++) {
      const targetMs = new Date(`${dateStr}T00:00:00Z`).getTime() + h * 3600_000;
      // Runs are sorted ascending; find the last one with runTime <= target.
      let best = null;
      for (const r of runs) {
        if (r.runTime.getTime() > targetMs) break;
        best = r;
      }
      if (!best) continue;
      const idx = Math.round((targetMs - best.runTime.getTime()) / 3600_000);
      if (idx < 0 || idx + 1 >= best.series.length) continue;
      const avgWm2 = (best.series[idx + 1] - best.series[idx]) / 3600;
      out.set(new Date(targetMs).toISOString().slice(0, 13), avgWm2);
    }
  }
  return out;
}

const dateList = [];
for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  dateList.push(d.toISOString().slice(0, 10));
}

console.log('Fetching Open-Meteo metno_nordic (archived, one request)...');
const openMeteo = await fetchOpenMeteoMetno();
console.log(`  ${openMeteo.size} hours\n`);

console.log(`Fetching direct MET Norway Thredds (all 4 daily synoptic runs, stitched, ${dateList.length} days, sequential)...`);
const thredds = await fetchThreddsStitched(dateList);
console.log(`  ${thredds.size} hours\n`);

// ── 3. Alignment offset (reuse the same correlation-pick approach as compare-metno-solar.mjs) ──
function corrAtOffset(fc, offsetH) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (const [k, a] of actual) {
    const d = new Date(`${k}:00:00Z`);
    d.setUTCHours(d.getUTCHours() + offsetH);
    const f = fc.get(d.toISOString().slice(0, 13));
    if (f == null || (a < DAYLIGHT_WM2 && f < DAYLIGHT_WM2)) continue;
    sx += f; sy += a; sxx += f * f; syy += a * a; sxy += f * a; n++;
  }
  return (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
}
const offsets = [-1, 0, 1].map((o) => [o, corrAtOffset(openMeteo, o)]);
offsets.sort((a, b) => b[1] - a[1]);
const OFFSET = offsets[0][0];
console.log(`Alignment: forecast hour = measured hour ${OFFSET >= 0 ? '+' : ''}${OFFSET} (r=${offsets[0][1].toFixed(4)})\n`);

function joined(fc) {
  const rows = [];
  for (const [k, a] of actual) {
    const d = new Date(`${k}:00:00Z`);
    d.setUTCHours(d.getUTCHours() + OFFSET);
    const f = fc.get(d.toISOString().slice(0, 13));
    if (f == null || (a < DAYLIGHT_WM2 && f < DAYLIGHT_WM2)) continue;
    rows.push({ key: k, date: k.slice(0, 10), month: k.slice(0, 7), hourUtc: +k.slice(11, 13), f, a });
  }
  return rows;
}

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : NaN;

function stats(rows) {
  if (!rows.length) return 'no data';
  const errs = rows.map((r) => r.f - r.a);
  const bias = errs.reduce((s, e) => s + e, 0) / errs.length;
  const mae = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  return `n=${String(rows.length).padStart(5)}  bias=${bias.toFixed(1).padStart(7)}  MAE=${mae.toFixed(1).padStart(6)}  RMSE=${rmse.toFixed(1).padStart(6)} W/m²`;
}

const dailyTotal = new Map();
for (const [k, a] of actual) {
  const day = k.slice(0, 10);
  dailyTotal.set(day, (dailyTotal.get(day) ?? 0) + a);
}
const monthP90 = new Map();
const byMonth = new Map();
for (const [day, tot] of dailyTotal) {
  const m = day.slice(0, 7);
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(tot);
}
for (const [m, tots] of byMonth) monthP90.set(m, quantile([...tots].sort((x, y) => x - y), 0.9));
const skyClass = (day) => {
  const rel = dailyTotal.get(day) / monthP90.get(day.slice(0, 7));
  return rel < 0.4 ? 'overcast' : rel < 0.75 ? 'mixed' : 'clear';
};

const models = { openmeteo_metno_nordic: joined(openMeteo), thredds_direct: joined(thredds) };
for (const [name, rows] of Object.entries(models)) {
  console.log(name);
  console.log(`  overall            ${stats(rows)}`);
  for (const cls of ['clear', 'mixed', 'overcast']) {
    console.log(`  ${cls.padEnd(8)} days      ${stats(rows.filter((r) => skyClass(r.date) === cls))}`);
  }
  console.log();
}

// Head-to-head on shared hours only (both sources must have a value).
const omByKey = new Map(models.openmeteo_metno_nordic.map((r) => [r.key, r]));
let winsOm = 0, winsTh = 0;
const paired = [];
for (const r of models.thredds_direct) {
  const om = omByKey.get(r.key);
  if (!om) continue;
  paired.push([r, om]);
  if (Math.abs(om.f - om.a) < Math.abs(r.f - r.a)) winsOm++;
  else if (Math.abs(r.f - r.a) < Math.abs(om.f - om.a)) winsTh++;
}
console.log(`Head-to-head on ${paired.length} shared daylight hours: openmeteo_metno_nordic better ${winsOm} ` +
  `(${(100 * winsOm / Math.max(1, paired.length)).toFixed(0)}%), thredds_direct better ${winsTh} ` +
  `(${(100 * winsTh / Math.max(1, paired.length)).toFixed(0)}%)`);
for (const cls of ['clear', 'mixed', 'overcast']) {
  const sub = paired.filter(([r]) => skyClass(r.date) === cls);
  const wOm = sub.filter(([r, om]) => Math.abs(om.f - om.a) < Math.abs(r.f - r.a)).length;
  console.log(`  ${cls.padEnd(8)}: openmeteo_metno_nordic better on ${wOm}/${sub.length} hours (${(100 * wOm / Math.max(1, sub.length)).toFixed(0)}%)`);
}
