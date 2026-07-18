// Backtests two free Open-Meteo solar-forecast models against the site's own measured
// irradiance, to decide whether the dedicated Nordic model should replace (or blend into)
// the current default for dispatch planning — the deferred investigation from the
// 2026-07-03 nowcasting research (see also DESIGN-reserve.md §9's deferred solar haircut):
//
//   - best_match (the pipeline's current source): Open-Meteo's default model blend,
//     centered on Central-Europe high-res models (ICON-D2 etc.) — this site at 57.6°N
//     sits at the edge of that domain.
//   - metno_nordic: the MET Nordic 1km MetCoOp-based model, explicitly built for
//     Norway/Sweden/Denmark/Finland. Hourly-only (no minutely_15) — the open question
//     is whether better model skill outweighs the coarser cadence.
//
// Forecasts come from the Historical Forecast API (archived model runs, stitched at
// short lead — i.e. this measures roughly same-day forecast skill, the regime that
// matters for intraday dispatch and the morning-oversell case). Ground truth is the
// station's own measured GHI (CSV in the --out-csv shape compare-ecowitt-smhi.mjs
// produces: timestamp,solar_wm2 with UTC ISO timestamps), already validated against
// SMHI + CAMS (see lib/consumption-data.ts history) — so disagreements here are model
// error, not station error.
//
// Alignment note: Open-Meteo hourly radiation is the average of an hour-long window;
// whether the timestamp marks the window's start or end differs by convention, so the
// script tries both offsets on the measured series and keeps whichever correlates better
// (chosen once, from the default model, applied to BOTH models — fair comparison).
//
// Reported per model: overall + per-month bias/MAE/RMSE (daylight hours only), skill by
// sky condition (days classed clear/mixed/overcast by their measured total vs the month's
// P90 day — "does the Nordic model win specifically on overcast days" is the question the
// 2026-07-18 forecast-vs-actual run raised), and the per-morning (06-12 local) total-ratio
// distribution in the same shape as compare-forecast-actual.py's haircut input.
//
// Usage:  node scripts/tools/compare-metno-solar.mjs [--csv solar-data/own_station_feb_jul.csv]
//             [--lat 57.640842] [--lon 11.776609]     (or SITE_LATITUDE/SITE_LONGITUDE env)
//   No API keys needed. Three archived-forecast requests total.
//
// FINDINGS from the first run (2026-02-21..2026-07-02, 1934 shared daylight hours,
// recorded here because the numbers gate a pipeline decision):
//   - Open-Meteo's best_match HOURLY series is now byte-identical to metno_nordic at this
//     site (verified live and in the archive) — but the pipeline consumes minutely_15,
//     which is routed differently and measures WORSE: MAE 96.6 vs 82.9 W/m² (-14% for
//     metno), head-to-head metno better on 64% of hours (68% clear / 59% overcast).
//   - Mornings (the oversell window): pipeline_minutely15 over-forecasts — per-morning
//     actual/forecast median 0.89, P20 0.66, P05 0.46; metno_nordic is near-unbiased:
//     median 1.06, P20 0.84, P05 0.59. Switching the source is worth roughly as much as
//     any haircut for the morning-oversell case, and costs nothing.
//   - Both models share the June under-forecast (bias ~ -66 W/m²) — that is the site's
//     real June sunniness (see solarCalibrationByMonth), a conversion-layer concern, not
//     a model-choice concern.
//   - Trade-off of switching: metno_nordic is hourly-only (no minutely_15) — 15-min slot
//     values would be interpolated from hourly instead of natively 15-min. The measured
//     skill gap dwarfs whatever the finer cadence was worth.

import fs from 'node:fs';

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const CSV = argVal('--csv', 'solar-data/own_station_feb_jul.csv');
const LAT = parseFloat(argVal('--lat', process.env.SITE_LATITUDE ?? '57.640842'));
const LON = parseFloat(argVal('--lon', process.env.SITE_LONGITUDE ?? '11.776609'));
const DAYLIGHT_WM2 = 5;

// ── 1. Measured GHI → UTC-hour means ──
const lines = fs.readFileSync(CSV, 'utf-8').trim().split('\n').slice(1);
const hourAcc = new Map(); // 'YYYY-MM-DDTHH' -> [sum, n]
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

// ── 2. Archived forecasts, one request per model ──
async function fetchModel(models) {
  const params = new URLSearchParams({
    latitude: LAT,
    longitude: LON,
    hourly: 'shortwave_radiation',
    timezone: 'UTC',
    start_date: startDate,
    end_date: endDate,
  });
  if (models) params.set('models', models);
  const res = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`open-meteo ${models ?? 'best_match'}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const out = new Map();
  json.hourly.time.forEach((t, i) => {
    const v = json.hourly.shortwave_radiation[i];
    if (v != null) out.set(t.slice(0, 13), v);
  });
  return out;
}

// The series the pipeline ACTUALLY consumes: minutely_15 with no models param (matching
// lib/forecast.ts's call shape), aggregated to hourly means. Fetched separately because
// best_match's hourly and minutely_15 series come from DIFFERENT model routings at this
// site (verified 2026-07-18: hourly best_match == metno_nordic exactly, while minutely_15
// diverges from both — it comes from the 15-min-capable Central-Europe blend).
async function fetchPipelineMinutely() {
  const params = new URLSearchParams({
    latitude: LAT,
    longitude: LON,
    minutely_15: 'shortwave_radiation',
    timezone: 'UTC',
    start_date: startDate,
    end_date: endDate,
  });
  const res = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`open-meteo minutely_15: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const acc = new Map();
  json.minutely_15.time.forEach((t, i) => {
    const v = json.minutely_15.shortwave_radiation[i];
    if (v == null) return;
    const key = t.slice(0, 13);
    const a = acc.get(key) ?? [0, 0];
    a[0] += v;
    a[1] += 1;
    acc.set(key, a);
  });
  return new Map([...acc].filter(([, [, n]]) => n === 4).map(([k, [s, n]]) => [k, s / n]));
}

const [blend, metno, pipelineMin] = await Promise.all([
  fetchModel(null),
  fetchModel('metno_nordic'),
  fetchPipelineMinutely(),
]);
console.log(`Forecast hours: best_match=${blend.size}  metno_nordic=${metno.size}  pipeline_minutely15=${pipelineMin.size}`);
if ([...blend].every(([k, v]) => metno.get(k) === v)) {
  console.log('NOTE: best_match hourly is byte-identical to metno_nordic at this site — the real comparison is metno vs pipeline_minutely15.');
}

// ── 3. Pick the timestamp alignment that best matches reality (using the default model) ──
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
const offsets = [-1, 0, 1].map((o) => [o, corrAtOffset(blend, o)]);
offsets.sort((a, b) => b[1] - a[1]);
const OFFSET = offsets[0][0];
console.log(`Alignment: forecast hour = measured hour ${OFFSET >= 0 ? '+' : ''}${OFFSET} ` +
  `(r=${offsets[0][1].toFixed(4)}; alternatives ${offsets.slice(1).map(([o, r]) => `${o}:${r.toFixed(4)}`).join(' ')})\n`);

// ── 4. Joined daylight observations ──
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

// Sky classes from measured daily totals vs the month's P90 day.
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

const models = {
  metno_nordic: joined(metno),
  pipeline_minutely15: joined(pipelineMin),
};
for (const [name, rows] of Object.entries(models)) {
  console.log(`${name}`);
  console.log(`  overall            ${stats(rows)}`);
  for (const m of [...new Set(rows.map((r) => r.month))].sort()) {
    console.log(`  ${m}            ${stats(rows.filter((r) => r.month === m))}`);
  }
  for (const cls of ['clear', 'mixed', 'overcast']) {
    console.log(`  ${cls.padEnd(8)} days      ${stats(rows.filter((r) => skyClass(r.date) === cls))}`);
  }
  // Per-morning totals ratio (06-12 local ≈ 04-10 UTC in summer, 05-11 UTC in winter —
  // use 04-10 UTC uniformly; the point is a like-for-like model comparison, not calendar
  // precision, and both models get the identical window).
  const mornings = new Map();
  for (const r of rows) {
    if (r.hourUtc < 4 || r.hourUtc >= 10) continue;
    const m = mornings.get(r.date) ?? { f: 0, a: 0, n: 0 };
    m.f += r.f; m.a += r.a; m.n++;
    mornings.set(r.date, m);
  }
  const ratios = [...mornings.values()].filter((m) => m.n >= 5 && m.f > 50).map((m) => m.a / m.f).sort((x, y) => x - y);
  console.log(`  mornings (04-10 UTC) actual/forecast: n=${ratios.length}  ` +
    `P05=${quantile(ratios, 0.05).toFixed(2)}  P20=${quantile(ratios, 0.2).toFixed(2)}  ` +
    `median=${quantile(ratios, 0.5).toFixed(2)}  P80=${quantile(ratios, 0.8).toFixed(2)}\n`);
}

// Head-to-head: metno_nordic vs the pipeline's minutely_15 source, same joined hours.
const metnoByKey = new Map(models.metno_nordic.map((r) => [r.key, r]));
let winsM = 0, winsP = 0;
const paired = [];
for (const r of models.pipeline_minutely15) {
  const m = metnoByKey.get(r.key);
  if (!m) continue;
  paired.push([r, m]);
  if (Math.abs(m.f - m.a) < Math.abs(r.f - r.a)) winsM++;
  else if (Math.abs(r.f - r.a) < Math.abs(m.f - m.a)) winsP++;
}
console.log(`Head-to-head on ${paired.length} shared daylight hours: metno_nordic better ${winsM} ` +
  `(${(100 * winsM / paired.length).toFixed(0)}%), pipeline_minutely15 better ${winsP} (${(100 * winsP / paired.length).toFixed(0)}%)`);
for (const cls of ['clear', 'mixed', 'overcast']) {
  const sub = paired.filter(([r]) => skyClass(r.date) === cls);
  const wm = sub.filter(([r, m]) => Math.abs(m.f - m.a) < Math.abs(r.f - r.a)).length;
  console.log(`  ${cls.padEnd(8)}: metno better on ${wm}/${sub.length} hours (${(100 * wm / Math.max(1, sub.length)).toFixed(0)}%)`);
}
