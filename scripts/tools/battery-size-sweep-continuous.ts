// Battery-size sizing analysis: what would a bigger (or smaller) battery have been worth, in
// hindsight, over real historical data? Sweeps a hypothetical `SOLINTEG_BATTERY_KWH` through the
// repo's own hindsight-oracle DP (lib/oracle.ts / lib/optimizer.ts — same code the nightly oracle
// job uses) and reports the total value it would have captured.
//
// An earlier version of this scored each day independently (one oracle_daily-style run per day)
// and stitched the totals together — that silently discards any value a bigger battery earns by
// carrying charge across midnight, because each day was re-scored from the REAL (actual-capacity)
// historical SoC regardless of what a hypothetical bigger pack would have chosen to carry into
// the next day. That's a bug that penalizes bigger capacities more the bigger they get (a 76.8
// kWh oracle correctly choosing to end a day at 31.5 kWh instead of 5.9 kWh, to sell into a
// better next-day price, has that deferred value vanish into the void under day-by-day scoring).
//
// Fix: run ONE continuous DP over the whole [--from, --to] window (thousands of 15-min slots)
// instead of one per day, so a carry decision is only ever truncated once, at the very end of
// the whole sample, not at every midnight. Free terminal SoC (no endSoc constraint) — over a
// multi-week window the terminal edge effect is a tiny fraction of the total, unlike the daily
// version where it compounded every night.
//
// Usage (dump readings + price_snapshots from your telemetry.db into a local copy first — see
// deploy/README.md for how, or point TELEMETRY_DB_PATH straight at a copy of the live DB):
//   SOLINTEG_BATTERY_KWH=32 TELEMETRY_DB_PATH=<path> npx tsx \
//     scripts/tools/battery-size-sweep-continuous.ts --from 2026-07-04 --to 2026-09-08 [--json]

import { stockholmMidnightUtc } from '../../lib/prices';
import type { PriceSlot } from '../../lib/prices';
import { readOracleReadings, readPriceSnapshot } from '../../lib/telemetry';
import {
  bucketActuals,
  socAtInstant,
  socSeries,
  windowEnergyBalance,
  baselineCashOre,
  toOptimizerSlots,
} from '../../lib/oracle';
import { optimizeDispatch, evaluateDispatch, BATTERY_KWH } from '../../lib/optimizer';

const SLOT_MS = 900_000;

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function midnightMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return stockholmMidnightUtc(y, m - 1, d).getTime();
}
function slotsForDay(prices: PriceSlot[] | undefined, dateStr: string): PriceSlot[] {
  return (prices ?? []).filter((p) => p.startTime.startsWith(dateStr));
}
function priceSlotsFor(date: string): PriceSlot[] {
  const own = slotsForDay(readPriceSnapshot(date)?.prices, date);
  if (own.length) return own;
  return slotsForDay(readPriceSnapshot(addDays(date, -1))?.prices, date);
}
function expectedSlots(date: string): number {
  return (midnightMs(addDays(date, 1)) - midnightMs(date)) / SLOT_MS;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = opt('--from');
  const to = opt('--to');
  if (!from || !to) {
    console.error('usage: --from YYYY-MM-DD --to YYYY-MM-DD [--json]   (TELEMETRY_DB_PATH must be set)');
    process.exit(2);
  }
  if (!process.env.TELEMETRY_DB_PATH) {
    console.error('TELEMETRY_DB_PATH is unset — nothing to read.');
    process.exit(2);
  }

  const days: string[] = [];
  for (let d = from!; d <= to!; d = addDays(d, 1)) days.push(d);

  const priceSlots: PriceSlot[] = [];
  const missing: string[] = [];
  for (const date of days) {
    const s = priceSlotsFor(date);
    if (s.length !== expectedSlots(date)) {
      missing.push(date);
      continue;
    }
    priceSlots.push(...s);
  }
  if (missing.length) {
    console.error(`missing/incomplete price slots for: ${missing.join(', ')} — aborting (no silent gaps)`);
    process.exit(1);
  }

  const windowStartMs = midnightMs(from!);
  const windowEndMs = midnightMs(addDays(to!, 1));
  const iso = (ms: number) => new Date(ms).toISOString();
  const readings = readOracleReadings(iso(windowStartMs), iso(windowEndMs));
  const lastTs = readings.length ? Date.parse(readings[readings.length - 1].timestamp) : 0;
  const shortfallMin = (windowEndMs - lastTs) / 60_000;
  if (!readings.length || shortfallMin > 30) {
    console.error(`readings stop ${Math.round(shortfallMin)} min before the window ends — aborting`);
    process.exit(1);
  }

  const n = priceSlots.length;
  const actuals = bucketActuals(readings, windowStartMs, n);
  const soc = socSeries(readings);
  const startSoc = socAtInstant(soc, windowStartMs);
  if (!startSoc) {
    console.error('no SoC reading near window start — aborting');
    process.exit(1);
  }

  const bal = windowEnergyBalance(actuals, soc, windowStartMs, n);
  if (bal.solarDerate !== 1) actuals.solarKwh = actuals.solarKwh.map((s: number) => s * bal.solarDerate);

  const slots = toOptimizerSlots(priceSlots, actuals);
  const baselineOre = baselineCashOre(slots);
  const dispatch = optimizeDispatch(slots, startSoc.soc);
  const evalResult = evaluateDispatch(slots, dispatch, startSoc.soc);

  const prizeOre = evalResult.valueOre - baselineOre;
  const result = {
    batteryKwh: BATTERY_KWH,
    slots: n,
    days: n / (SLOT_MS === 900_000 ? 96 : 1),
    startSocKwh: Math.round(startSoc.soc * 1000) / 1000,
    endSocKwh: Math.round(dispatch[dispatch.length - 1].socAfter * 1000) / 1000,
    solarDerate: Math.round(bal.solarDerate * 10000) / 10000,
    cashOre: Math.round(evalResult.cashOre),
    wearOre: Math.round(evalResult.wearOre),
    valueOre: Math.round(evalResult.valueOre),
    baselineOre: Math.round(baselineOre),
    prizeKr: Math.round((prizeOre / 100) * 10) / 10,
    prizeKrPerDay: Math.round((prizeOre / 100 / (n / 96)) * 100) / 100,
  };

  if (args.includes('--json')) console.log(JSON.stringify(result));
  else console.log(result);
}

main();
