// Compares our Ecowitt GW1000 station's measured solar irradiance against SMHI's
// "Göteborg Sol" station (71415) — the same station used for the historical
// climatology in lib/irradiance-data.ts — to check whether the station reads
// consistently higher than the reference site (previously eyeballed as ~+23% for
// a single June sample) across other months.
//
// Pulls real (non-forecast, non-climatological) hourly-ish data from both APIs
// for the same UTC window, aligns to UTC hour, and reports the ratio by month.
//
// Usage:  node scripts/tools/compare-ecowitt-smhi.mjs [startDate] [endDate] [--out-csv path.csv]
//   Dates are YYYY-MM-DD (UTC). Defaults: startDate = 2026-02-22 (earliest date
//   SMHI's "latest-months" rolling window reliably returns), endDate = today.
//   --out-csv also dumps our own station's raw fetched points as timestamp,solar_wm2
//   (UTC ISO) — the same shape fetch-cams-solar.py's comparison reads, for reuse against
//   other reference sources without refetching.
//
// Requires env vars (source /opt/solinteg/solinteg.env on the NUC first):
//   ECOWITT_APPLICATION_KEY, ECOWITT_API_KEY, ECOWITT_MAC
//
// Ecowitt's device/history endpoint silently coarsens resolution on long date
// ranges (observed: full-month requests collapse to ~4h spacing even when
// cycle_type=30min is requested), so this fetches in 7-day chunks to keep fine
// resolution, then re-aggregates to hourly to match SMHI's native cadence.

const APP_KEY = process.env.ECOWITT_APPLICATION_KEY;
const API_KEY = process.env.ECOWITT_API_KEY;
const MAC = process.env.ECOWITT_MAC;
if (!APP_KEY || !API_KEY || !MAC) {
  console.error('Set ECOWITT_APPLICATION_KEY, ECOWITT_API_KEY and ECOWITT_MAC before running.');
  process.exit(1);
}

const SMHI_STATION = 71415;
const SMHI_PARAM = 11; // Global Irradians, 1h mean, W/m²
const ECOWITT_HISTORY_URL = 'https://api.ecowitt.net/api/v3/device/history';
const CHUNK_DAYS = 7; // stays inside the fine-resolution regime (see header note)

// Ecowitt's cloud API throttles bursts of requests ("the number of interface accesses
// reached the upper limit", code -1) — observed to hit roughly 1-in-19 back-to-back
// chunk requests with no delay between them, then recover on its own for later chunks
// (not a hard daily/monthly quota — a quota exhaustion would fail every subsequent
// request too, and it didn't). A fixed pacing delay plus retry-with-backoff on that
// specific error covers it without guessing at Ecowitt's exact limit.
const REQUEST_DELAY_MS = 2000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rawArgs = process.argv.slice(2);
const outCsvIdx = rawArgs.indexOf('--out-csv');
const outCsvPath = outCsvIdx >= 0 ? rawArgs[outCsvIdx + 1] : null;
const positional = outCsvIdx >= 0 ? [...rawArgs.slice(0, outCsvIdx), ...rawArgs.slice(outCsvIdx + 2)] : rawArgs;
const [startArg, endArg] = positional;
const startDate = startArg ?? '2026-02-22';
const endDate = endArg ?? new Date().toISOString().slice(0, 10);

const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// ── 1. Ecowitt: fetch history in weekly chunks, average to UTC-hour buckets ──
async function fetchEcowittChunkOnce(chunkStart, chunkEnd) {
  const params = new URLSearchParams({
    application_key: APP_KEY,
    api_key: API_KEY,
    mac: MAC,
    start_date: fmt(chunkStart),
    end_date: fmt(chunkEnd),
    cycle_type: '30min',
    call_back: 'solar_and_uvi',
    solar_irradiance_unitid: '16',
  });
  const res = await fetch(`${ECOWITT_HISTORY_URL}?${params}`);
  return res.json();
}

async function fetchEcowittChunk(chunkStart, chunkEnd) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const json = await fetchEcowittChunkOnce(chunkStart, chunkEnd);
    if (json.code === 0) {
      const list = json.data?.solar_and_uvi?.solar?.list ?? {};
      return Object.entries(list).map(([epochSec, v]) => [Number(epochSec), parseFloat(v)]);
    }
    const isRateLimit = /upper limit|too many|rate limit/i.test(json.msg ?? '');
    if (!isRateLimit || attempt === MAX_RETRIES) {
      console.warn(`  Ecowitt chunk ${fmt(chunkStart)}..${fmt(chunkEnd)} failed: ${json.code} ${json.msg}` +
        (isRateLimit ? ` (gave up after ${attempt + 1} attempts)` : ''));
      return [];
    }
    const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`  Ecowitt chunk ${fmt(chunkStart)}..${fmt(chunkEnd)} rate-limited ` +
      `(attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoff / 1000}s...`);
    await sleep(backoff);
  }
  return []; // unreachable, keeps TS/linters happy
}

async function fetchAllEcowitt(start, end) {
  const points = [];
  let cursor = new Date(start);
  const endD = new Date(end);
  let first = true;
  while (cursor < endD) {
    if (!first) await sleep(REQUEST_DELAY_MS);
    first = false;
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 86400_000, endD.getTime()));
    const chunk = await fetchEcowittChunk(cursor, chunkEnd);
    points.push(...chunk);
    cursor = chunkEnd;
  }
  return points;
}

// ── 2. SMHI: fetch raw hourly readings for the same window ────────────────────
async function fetchSmhi() {
  const url = `https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/${SMHI_PARAM}/station/${SMHI_STATION}/period/latest-months/data.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SMHI fetch failed: ${res.status}`);
  const json = await res.json();
  return (json.value ?? [])
    .filter((v) => v.quality === 'G')
    .map((v) => [Math.floor(v.date / 1000), parseFloat(v.value)]);
}

// ── 3. Align both series to UTC-hour buckets ───────────────────────────────────
function toHourBuckets(points) {
  const buckets = new Map(); // hourEpochSec -> {sum, n}
  for (const [epochSec, val] of points) {
    if (!isFinite(val)) continue;
    const hour = Math.floor(epochSec / 3600) * 3600;
    const b = buckets.get(hour) ?? { sum: 0, n: 0 };
    b.sum += val;
    b.n += 1;
    buckets.set(hour, b);
  }
  const out = new Map();
  for (const [hour, { sum, n }] of buckets) out.set(hour, sum / n);
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
console.log(`Fetching Ecowitt history ${startDate}..${endDate} (weekly chunks)...`);
const ecowittRaw = await fetchAllEcowitt(startDate, `${endDate} 23:59:59`);
console.log(`  ${ecowittRaw.length} raw Ecowitt readings`);

if (outCsvPath) {
  const fs = await import('node:fs');
  const rows = ecowittRaw
    .filter(([, val]) => isFinite(val))
    .sort(([a], [b]) => a - b)
    .map(([epochSec, val]) => `${new Date(epochSec * 1000).toISOString()},${val}`);
  fs.writeFileSync(outCsvPath, ['timestamp,solar_wm2', ...rows].join('\n') + '\n');
  console.log(`  wrote ${rows.length} raw readings to ${outCsvPath}`);
}

console.log('Fetching SMHI Göteborg Sol (71415) latest-months...');
const smhiRaw = await fetchSmhi();
console.log(`  ${smhiRaw.length} quality-G SMHI hourly readings\n`);

const ecowittHourly = toHourBuckets(ecowittRaw);
const smhiHourly = toHourBuckets(smhiRaw);

// Only compare hours with meaningful daylight on the reference station, to
// avoid divide-by-near-zero noise skewing the ratio at dawn/dusk/night.
const MIN_SMHI_WM2 = 20;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const byMonth = Array.from({ length: 12 }, () => ({ ecoSum: 0, smhiSum: 0, n: 0 }));

for (const [hour, smhiVal] of smhiHourly) {
  const ecoVal = ecowittHourly.get(hour);
  if (ecoVal == null || smhiVal < MIN_SMHI_WM2) continue;
  const month = new Date(hour * 1000).getUTCMonth();
  const m = byMonth[month];
  m.ecoSum += ecoVal;
  m.smhiSum += smhiVal;
  m.n += 1;
}

console.log(`Comparing matched daylight hours (SMHI >= ${MIN_SMHI_WM2} W/m²):\n`);
console.log('Month  n_hours  avg_ecowitt  avg_smhi  ratio  pct_diff');
let totalEco = 0, totalSmhi = 0, totalN = 0;
for (let m = 0; m < 12; m++) {
  const { ecoSum, smhiSum, n } = byMonth[m];
  if (n === 0) continue;
  const avgEco = ecoSum / n;
  const avgSmhi = smhiSum / n;
  const ratio = avgEco / avgSmhi;
  console.log(
    `${MONTH_NAMES[m].padEnd(5)}  ${String(n).padStart(7)}  ${avgEco.toFixed(1).padStart(11)}  ` +
    `${avgSmhi.toFixed(1).padStart(8)}  ${ratio.toFixed(3).padStart(5)}  ${((ratio - 1) * 100).toFixed(1).padStart(6)}%`,
  );
  totalEco += ecoSum;
  totalSmhi += smhiSum;
  totalN += n;
}
if (totalN > 0) {
  const overallRatio = totalEco / totalSmhi;
  console.log(`\nOverall (${totalN} matched hours): ratio=${overallRatio.toFixed(3)}  (${((overallRatio - 1) * 100).toFixed(1)}% vs SMHI)`);
} else {
  console.log('\nNo overlapping hours found — check date range and env credentials.');
}
