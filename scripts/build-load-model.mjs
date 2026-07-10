// Builds the weather-aware household load model from the committed plant reports.
//
// Reads every solar-data/*.csv (daily total household consumption), pairs each
// day with its daily-mean outdoor temperature from the Open-Meteo Archive (ERA5),
// and fits   consumption_day = base_load + slope * HDD,  HDD = max(0, Tbase - Tmean),
// scanning Tbase for the best R². Prints the fitted constants to paste into
// lib/consumption-data.ts plus a monthly sanity table.
//
// Usage:  node scripts/build-load-model.mjs
// Requires network (Open-Meteo Archive).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'solar-data');
// Keep in sync with lib/constants.ts's SITE_LATITUDE/SITE_LONGITUDE (the canonical source,
// overridable via env there) — this is a one-off offline script, not part of the running app.
const LAT = 57.64;
const LON = 11.78;

// ── 1. Read all plant reports → date → daily total consumption (kWh) ──────────
// CSV columns: Date | Daily PV Yield | Daily inverter output | Daily exported | Daily consumption | Daily imported
function readReport(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const r = line.split(',');
    const date = r[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips header row and blank lines
    const consumption = parseFloat(r[4]);
    if (!isFinite(consumption)) continue;
    out.push({ date, consumption });
  }
  return out;
}

const files = fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
const byDate = new Map(); // date → consumption (last file wins; dedupes the 2023-11-1 duplicate)
for (const f of files) {
  for (const { date, consumption } of readReport(path.join(DATA_DIR, f))) {
    byDate.set(date, consumption);
  }
}
const dates = [...byDate.keys()].sort();
console.log(`Read ${files.length} reports → ${dates.length} unique days (${dates[0]} .. ${dates.at(-1)})`);

// ── 2. Daily mean temperature from Open-Meteo Archive ─────────────────────────
const url =
  `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
  `&start_date=${dates[0]}&end_date=${dates.at(-1)}` +
  `&daily=temperature_2m_mean&timezone=Europe%2FStockholm`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Archive fetch failed: ${res.status}`);
const arch = await res.json();
const tempByDate = new Map();
arch.daily.time.forEach((d, i) => tempByDate.set(d, arch.daily.temperature_2m_mean[i]));

// ── 3. Join consumption ↔ temperature ─────────────────────────────────────────
const pts = [];
for (const d of dates) {
  const t = tempByDate.get(d);
  const c = byDate.get(d);
  if (t != null && isFinite(t) && isFinite(c) && c > 0) pts.push({ date: d, c, t });
}
console.log(`Paired ${pts.length} day-temperature points\n`);

// ── 4. Per-month baseline level + normal temperature ──────────────────────────
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const month = Array.from({ length: 12 }, () => ({ c: [], t: [] }));
for (const p of pts) {
  const m = parseInt(p.date.slice(5, 7), 10) - 1;
  month[m].c.push(p.c);
  month[m].t.push(p.t);
}
const baseline = month.map((m) => (m.c.length ? avg(m.c) : 0)); // observed avg daily kWh
const tNormal = month.map((m) => (m.t.length ? avg(m.t) : 0));  // observed avg daily mean °C

// ── 5. Weather slope = WITHIN-MONTH regression of consumption on HDD-deviation ──
// HDD = max(0, Tbase − Tmean). Centring each day on its own month removes the
// between-month seasonal confound (incl. the April level anomaly); using HDD
// rather than raw temp self-zeroes the adjustment in summer (HDD≈HDD_normal≈0),
// so a winter-derived heating slope is never applied to mild summer days.
function fitHddDeviation(tb) {
  const hddNormal = month.map((m) => (m.t.length ? avg(m.t.map((t) => Math.max(0, tb - t))) : 0));
  let sxy = 0, sxx = 0, syy = 0, n = 0, sse = 0;
  for (const p of pts) {
    const m = parseInt(p.date.slice(5, 7), 10) - 1;
    const dc = p.c - baseline[m];
    const dh = Math.max(0, tb - p.t) - hddNormal[m];
    sxy += dc * dh; sxx += dh * dh; syy += dc * dc; n++;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;     // kWh per HDD (positive: colder → more)
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  for (const p of pts) {
    const m = parseInt(p.date.slice(5, 7), 10) - 1;
    const pred = baseline[m] + slope * (Math.max(0, tb - p.t) - hddNormal[m]);
    sse += (p.c - pred) ** 2;
  }
  return { tb, slope, r2, rmse: Math.sqrt(sse / n), hddNormal, n };
}
let best = null;
for (let tb = 12; tb <= 20.0001; tb += 0.5) {
  const fit = fitHddDeviation(tb);
  if (!best || fit.r2 > best.r2) best = fit;
}

console.log('Weather-normalised model:  load = baseline[month] + slope * (HDD − HDD_normal[month]),  HDD = max(0, Tbase − Tmean)');
console.log(`  Tbase = ${best.tb} °C   slope = ${best.slope.toFixed(2)} kWh/HDD   within-R² = ${best.r2.toFixed(3)}   RMSE = ${best.rmse.toFixed(1)} kWh/day\n`);

console.log('Month  nDays  baseline/day  normalT °C  HDD_normal');
for (let m = 0; m < 12; m++) {
  if (!month[m].c.length) continue;
  console.log(`${MN[m].padEnd(5)}  ${String(month[m].c.length).padStart(5)}  ${baseline[m].toFixed(1).padStart(12)}  ${tNormal[m].toFixed(1).padStart(9)}  ${best.hddNormal[m].toFixed(1).padStart(9)}`);
}

const r1 = (x) => Math.round(x * 10) / 10;
console.log('\n// ── Paste into lib/consumption-data.ts ──────────────────────────────');
console.log(`/** Weather-normalised daily load: load = avgDailyConsumptionByMonth[m] + LOAD_SLOPE_KWH_PER_HDD * (HDD − hddNormalByMonth[m]),`);
console.log(` *  HDD = max(0, HDD_T_BASE_C − dailyMeanTemp °C). Keeps the measured monthly level (captures non-temperature`);
console.log(` *  seasonality incl. the April plateau) and adds a within-month heating sensitivity that self-zeroes in summer.`);
console.log(` *  Fitted by scripts/build-load-model.mjs over ${best.n} days (${dates[0]}..${dates.at(-1)}); within-R²=${best.r2.toFixed(3)}, RMSE=${best.rmse.toFixed(1)} kWh/day.`);
console.log(` *  NOTE: low within-R² — daily load is dominated by non-temperature factors; the seasonal baseline is the main signal. */`);
console.log(`export const HDD_T_BASE_C = ${best.tb};`);
console.log(`export const LOAD_SLOPE_KWH_PER_HDD = ${best.slope.toFixed(2)};`);
console.log(`export const hddNormalByMonth: number[] = ${JSON.stringify(best.hddNormal.map(r1))};`);
console.log(`// verify avgDailyConsumptionByMonth (measured here): ${JSON.stringify(baseline.map(r1))}`);
