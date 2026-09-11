// Follow-up: does the system already balance "buy cheap now to sell later" against "buy cheap
// now to self-consume later" (avoid an expensive future purchase), not just pure export
// arbitrage? lib/plan.ts and lib/oracle.ts call the exact same optimizeDispatch DP — there's no
// separate code path for the two; both fall out of one cost-minimizing backward induction over
// buyPrice/sellPrice each slot. This just quantifies how much of each flow actually happened over
// a real window, at the deployment's real capacity, to show the mechanism is live, not just
// theoretically present — and how small grid-charging can be in a solar-abundant season, which is
// the mechanistic reason a summer-only sample underrepresents this question.
import { stockholmMidnightUtc } from '../../lib/prices';
import type { PriceSlot } from '../../lib/prices';
import { readOracleReadings, readPriceSnapshot } from '../../lib/telemetry';
import { bucketActuals, socAtInstant, socSeries, windowEnergyBalance, toOptimizerSlots } from '../../lib/oracle';
import { optimizeDispatch, BATTERY_KWH } from '../../lib/optimizer';
import { BATTERY_RT_EFF } from '../../lib/constants';

const SLOT_MS = 900_000;
const ONE_WAY_EFF = Math.sqrt(BATTERY_RT_EFF);
function addDays(d: string, n: number) { const [y,m,dd]=d.split('-').map(Number); return new Date(Date.UTC(y,m-1,dd+n)).toISOString().slice(0,10); }
function midnightMs(d: string) { const [y,m,dd]=d.split('-').map(Number); return stockholmMidnightUtc(y,m-1,dd).getTime(); }
function slotsForDay(p: PriceSlot[]|undefined, d: string) { return (p??[]).filter(x=>x.startTime.startsWith(d)); }
function priceSlotsFor(d: string) { const own=slotsForDay(readPriceSnapshot(d)?.prices,d); if(own.length) return own; return slotsForDay(readPriceSnapshot(addDays(d,-1))?.prices,d); }
function expectedSlots(d: string) { return (midnightMs(addDays(d,1))-midnightMs(d))/SLOT_MS; }

function flows(soc: number, socNext: number, solarRem: number, loadRem: number) {
  const dE = socNext - soc;
  if (dE >= 0) {
    const need = dE / ONE_WAY_EFF;
    const fromSolar = Math.min(solarRem, need);
    const gridToBattery = need - fromSolar;
    return { fromSolar, gridToBattery, batteryToLoad: 0, batteryToGrid: 0, solarExport: solarRem - fromSolar };
  } else {
    const out = -dE * ONE_WAY_EFF;
    const toLoad = Math.min(out, loadRem);
    const batteryToGrid = out - toLoad;
    return { fromSolar: 0, gridToBattery: 0, batteryToLoad: toLoad, batteryToGrid, solarExport: solarRem };
  }
}

const from = '2026-07-04', to = '2026-09-08';
const days: string[] = [];
for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
const priceSlots: PriceSlot[] = [];
for (const d of days) priceSlots.push(...priceSlotsFor(d));
const windowStartMs = midnightMs(from), windowEndMs = midnightMs(addDays(to, 1));
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

let fromSolarKwh=0, gridToBatteryKwh=0, batteryToLoadKwh=0, batteryToGridKwh=0;
let gridChargeCostOre=0, gridChargeSlots=0;
let cur = startSoc.soc;
for (let i=0;i<n;i++){
  const load = slots[i].consumptionKwh ?? 0, solar = slots[i].solarKwh;
  const s2l = Math.min(solar, load);
  const solarRem = solar - s2l, loadRem = load - s2l;
  const f = flows(cur, dispatch[i].socAfter, solarRem, loadRem);
  fromSolarKwh += f.fromSolar; gridToBatteryKwh += f.gridToBattery;
  batteryToLoadKwh += f.batteryToLoad; batteryToGridKwh += f.batteryToGrid;
  if (f.gridToBattery > 0.001) { gridChargeCostOre += f.gridToBattery*slots[i].buyPrice; gridChargeSlots++; }
  cur = dispatch[i].socAfter;
}
console.log({
  windowDays: n/96,
  totalChargedKwh: Math.round(fromSolarKwh+gridToBatteryKwh),
  fromSolarKwh: Math.round(fromSolarKwh), gridToBatteryKwh: Math.round(gridToBatteryKwh*10)/10,
  gridChargeShare: (gridToBatteryKwh/(fromSolarKwh+gridToBatteryKwh)*100).toFixed(2)+'%',
  gridChargeSlots, avgGridChargePriceOre: gridChargeSlots? Math.round(gridChargeCostOre/gridToBatteryKwh):null,
  totalDischargedKwh: Math.round(batteryToLoadKwh+batteryToGridKwh),
  batteryToLoadKwh: Math.round(batteryToLoadKwh), batteryToGridKwh: Math.round(batteryToGridKwh),
  batteryToLoadShare: (batteryToLoadKwh/(batteryToLoadKwh+batteryToGridKwh)*100).toFixed(1)+'%',
});
