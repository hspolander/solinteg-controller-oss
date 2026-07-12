// Reads the combined inverter CSV exported from the old system and outputs:
//   1. A human-readable monthly summary table
//   2. TypeScript-ready constants to paste into lib/consumption-data.ts
//
// Usage: npx tsx scripts/tools/process-inverter-data.ts "path/to/Plant Reports 2022-2026.csv"
//
// Expected CSV columns (comma-separated, no quotes):
//   Date, Daily PV Yield(kWh), Daily inverter output(kWh),
//   Daily exported energy(kWh), Daily consumption(kWh), Daily imported energy(kWh)

import * as fs from 'node:fs';
import * as path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/tools/process-inverter-data.ts <csv-file>');
  process.exit(1);
}

const lines = fs.readFileSync(path.resolve(file), 'utf-8').trim().split(/\r?\n/);

// Verify header
const header = lines[0];
if (!header.includes('PV Yield') || !header.includes('consumption')) {
  console.error('Unexpected header — check that this is the right file.');
  console.error('Got:', header);
  process.exit(1);
}

type MonthBucket = { pvYield: number[]; consumption: number[]; exported: number[]; imported: number[] };
const byMonth: Record<number, MonthBucket> = {};

let skipped = 0;
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const cols = line.split(',');
  if (cols.length < 6) { skipped++; continue; }

  const date = cols[0].trim();
  const month = parseInt(date.slice(5, 7), 10);
  if (isNaN(month) || month < 1 || month > 12) { skipped++; continue; }

  const pvYield     = parseFloat(cols[1]);
  const consumption = parseFloat(cols[4]);
  const exported    = parseFloat(cols[3]);
  const imported    = parseFloat(cols[5]);

  if (!byMonth[month]) byMonth[month] = { pvYield: [], consumption: [], exported: [], imported: [] };
  if (!isNaN(pvYield))     byMonth[month].pvYield.push(pvYield);
  if (!isNaN(consumption)) byMonth[month].consumption.push(consumption);
  if (!isNaN(exported))    byMonth[month].exported.push(exported);
  if (!isNaN(imported))    byMonth[month].imported.push(imported);
}

if (skipped > 0) console.warn(`Warning: skipped ${skipped} malformed rows\n`);

const avg  = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const r1   = (n: number)     => Math.round(n * 10) / 10;
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Summary table ──────────────────────────────────────────────────────────────
console.log('Monthly averages (daily kWh, averaged across all available years)\n');
console.log('Month  Days  PV prod  Consumption  Exported  Imported');
console.log('─────  ────  ───────  ───────────  ────────  ────────');
for (let m = 1; m <= 12; m++) {
  const d = byMonth[m];
  if (!d || d.pvYield.length === 0) {
    console.log(`${MONTH_NAMES[m - 1].padEnd(5)}    0         -            -         -         -`);
    continue;
  }
  console.log(
    `${MONTH_NAMES[m - 1].padEnd(5)}  ${String(d.pvYield.length).padStart(4)}` +
    `  ${String(r1(avg(d.pvYield))).padStart(7)}` +
    `  ${String(r1(avg(d.consumption))).padStart(11)}` +
    `  ${String(r1(avg(d.exported))).padStart(8)}` +
    `  ${String(r1(avg(d.imported))).padStart(8)}`,
  );
}

// ── TypeScript constants ───────────────────────────────────────────────────────
const prodArr = Array.from({ length: 12 }, (_, i) => r1(avg(byMonth[i + 1]?.pvYield ?? [])));
const consArr = Array.from({ length: 12 }, (_, i) => r1(avg(byMonth[i + 1]?.consumption ?? [])));

console.log('\n\n// ── Paste into lib/consumption-data.ts ──────────────────────────────');
console.log(`// avgDailyProductionByMonth[month-1] = average kWh produced per day`);
console.log(`// Source: inverter data ${lines[1]?.slice(0,7)} – ${lines[lines.length - 1]?.slice(0,7)}`);
console.log(`export const avgDailyProductionByMonth: number[] = ${JSON.stringify(prodArr)};`);
console.log();
console.log(`// avgDailyConsumptionByMonth[month-1] = average kWh consumed per day (grid + solar)`);
console.log(`export const avgDailyConsumptionByMonth: number[] = ${JSON.stringify(consArr)};`);
