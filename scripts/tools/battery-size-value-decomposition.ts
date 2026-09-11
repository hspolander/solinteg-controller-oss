// Follow-up to battery-size-sweep-continuous.ts: a natural question about that sweep's "prize" is
// whether it only counts sold electricity (export revenue) and ignores money saved by NOT buying
// (self-consumption avoiding grid import at the full retail buy price). It doesn't — cashOre in
// evaluateDispatch is `gridExport*sellPrice - gridImport*buyPrice`, so avoided import is already
// in every number quoted. This script proves it by splitting the same continuous-horizon run
// into the two components:
//   avoidedImportOre = baseline import cost  - battery-case import cost   (money saved by buying less)
//   exportTimingOre  = battery-case export revenue - baseline export revenue (money gained by
//                       selling at better moments / selling more instead of curtailing)
// avoidedImportOre + exportTimingOre - wearOre must equal the prize battery-size-sweep-
// continuous.ts already reported (same window, same capacity) — printed as a check.
//
// Reimplements computeFlows's dE>=0/dE<0 branches (not exported from lib/optimizer.ts) purely to
// read back gridImport/gridExport per slot from the DP's own socAfter trajectory — no new
// dispatch logic, just re-deriving the flows the DP already committed to.
//
// Usage: same as battery-size-sweep-continuous.ts.

import { stockholmMidnightUtc } from '../../lib/prices';
import type { PriceSlot } from '../../lib/prices';
import { readOracleReadings, readPriceSnapshot } from '../../lib/telemetry';
import {
  bucketActuals,
  socAtInstant,
  socSeries,
  windowEnergyBalance,
  toOptimizerSlots,
} from '../../lib/oracle';
import { optimizeDispatch, BATTERY_KWH } from '../../lib/optimizer';
import { BATTERY_RT_EFF } from '../../lib/constants';

const SLOT_MS = 900_000;
const ONE_WAY_EFF = Math.sqrt(BATTERY_RT_EFF);

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

/** Same physics as optimizer.ts's computeFlows (not exported) — read back gridImport/gridExport
 *  from a committed soc -> socNext transition, given that slot's solar/load already netted. */
function flows(soc: number, socNext: number, solarRem: number, loadRem: number) {
  const dE = socNext - soc;
  if (dE >= 0) {
    const need = dE / ONE_WAY_EFF;
    const fromSolar = Math.min(solarRem, need);
    const gridToBattery = need - fromSolar;
    let solarExport = solarRem - fromSolar;
    let gridExport = solarExport;
    const gridImport = gridToBattery + loadRem;
    return { gridImport, gridExport };
  } else {
    const out = -dE * ONE_WAY_EFF;
    const toLoad = Math.min(out, loadRem);
    const batteryToGrid = out - toLoad;
    const loadFromGrid = loadRem - toLoad;
    const gridExport = solarRem + batteryToGrid;
    return { gridImport: loadFromGrid, gridExport };
  }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = opt('--from');
  const to = opt('--to');
  if (!from || !to || !process.env.TELEMETRY_DB_PATH) {
    console.error('usage: --from YYYY-MM-DD --to YYYY-MM-DD   (TELEMETRY_DB_PATH must be set)');
    process.exit(2);
  }

  const days: string[] = [];
  for (let d = from!; d <= to!; d = addDays(d, 1)) days.push(d);

  const priceSlots: PriceSlot[] = [];
  for (const date of days) {
    const s = priceSlotsFor(date);
    if (s.length !== expectedSlots(date)) {
      console.error(`missing price slots for ${date}`);
      process.exit(1);
    }
    priceSlots.push(...s);
  }

  const windowStartMs = midnightMs(from!);
  const windowEndMs = midnightMs(addDays(to!, 1));
  const iso = (ms: number) => new Date(ms).toISOString();
  const readings = readOracleReadings(iso(windowStartMs), iso(windowEndMs));

  const n = priceSlots.length;
  const actuals = bucketActuals(readings, windowStartMs, n);
  const soc = socSeries(readings);
  const startSoc = socAtInstant(soc, windowStartMs)!;
  const bal = windowEnergyBalance(actuals, soc, windowStartMs, n);
  if (bal.solarDerate !== 1) actuals.solarKwh = actuals.solarKwh.map((s: number) => s * bal.solarDerate);

  const slots = toOptimizerSlots(priceSlots, actuals);
  const dispatch = optimizeDispatch(slots, startSoc.soc);

  let baselineImportOre = 0;
  let baselineExportOre = 0;
  let batteryImportOre = 0;
  let batteryExportOre = 0;
  let wearOre = 0;
  const BATTERY_WEAR_COST_ORE_PER_KWH = require('../../lib/constants').BATTERY_WEAR_COST_ORE_PER_KWH;

  let curSoc = startSoc.soc;
  for (let i = 0; i < n; i++) {
    const load = slots[i].consumptionKwh ?? 0;
    const solar = slots[i].solarKwh;
    const s2l = Math.min(solar, load);
    const solarRem = solar - s2l;
    const loadRem = load - s2l;

    // no-battery baseline: whatever isn't self-consumed directly is bought or sold outright.
    const netBaseline = loadRem - solarRem; // >0 buy, <0 sell
    if (netBaseline >= 0) baselineImportOre += netBaseline * slots[i].buyPrice;
    else baselineExportOre += -netBaseline * slots[i].sellPrice;

    const socNext = dispatch[i].socAfter;
    const f = flows(curSoc, socNext, solarRem, loadRem);
    batteryImportOre += f.gridImport * slots[i].buyPrice;
    batteryExportOre += f.gridExport * slots[i].sellPrice;
    wearOre += BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(socNext - curSoc);
    curSoc = socNext;
  }

  const avoidedImportOre = baselineImportOre - batteryImportOre; // money saved by buying less
  const exportTimingOre = batteryExportOre - baselineExportOre; // money gained by selling better/more
  const prizeOre = avoidedImportOre + exportTimingOre - wearOre;

  console.log({
    batteryKwh: BATTERY_KWH,
    days: n / 96,
    baselineImportKr: round(baselineImportOre),
    batteryImportKr: round(batteryImportOre),
    avoidedImportKr: round(avoidedImportOre),
    baselineExportKr: round(baselineExportOre),
    batteryExportKr: round(batteryExportOre),
    exportTimingKr: round(exportTimingOre),
    wearKr: round(wearOre),
    prizeKr: round(prizeOre),
    avoidedImportShare: round((avoidedImportOre / (avoidedImportOre + exportTimingOre)) * 100) + '%',
  });
}

function round(ore: number) {
  return Math.round((ore / 100) * 10) / 10;
}

main();
