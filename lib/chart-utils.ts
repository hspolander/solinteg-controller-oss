import { slotSolarKwh } from './slot-utils';
import { stockholmSlotKey } from './economics';
import type { PriceSlot } from './prices';
import type { DispatchSlot, Action } from './optimizer';

// A zone marks a DELIBERATE optimizer decision — something a plain self-consumption battery
// would never do on its own. Default behaviour draws nothing: discharging to cover load at
// night, charging from solar surplus, and exporting solar when the battery is full are all what
// the inverter's auto mode does anyway, and are readable from the SoC line against the solar
// curve. The three decisions:
//   buy  — the plan grid-funds the battery (charging beyond what solar provides)
//   sell — the plan exports battery energy to the grid (selling into a price peak)
//   hold — the plan lets the GRID cover house load while the battery sits on usable charge,
//          reserving it for a better hour — the least obvious decision, hence made visible
// Classification runs on the ATTRIBUTED flows the optimizer emits (batteryToGridKwh etc.), not
// on net gridKwh: the net number mixes house load into the picture (a solar-funded charge while
// the house imports a little for load is not a grid-buy decision, and a discharge that mostly
// covers load with a dribble of export is not a sell). A one-slot gap inside a sell/buy run is
// deliberately rendered as a gap — "not this slot" (a momentary price dip) is itself a decision
// worth seeing, so bands are never merged across sub-threshold slots.
export type BandKind = 'buy' | 'sell' | 'hold';

// kWh per 15-min slot (≈2 kW average) — below this a battery-grid flow is slot-granularity
// slop around covering load, not a decision. Real planned buys/sells run ~2-2.7 kWh/slot.
const DECISION_GRID_KWH = 0.5;
// Grid-covered load before a slot reads as a "hold". Must clear the DP's SoC discretisation
// step (~0.123 kWh for the reference 25.6 kWh battery): a discharge-to-load slot can leave up
// to one step of load to the grid purely from snap-to-grid rounding, which is not a reserve
// decision.
const HOLD_LOAD_FROM_GRID_KWH = 0.15;
// The battery must hold at least this much above the discharge floor for "reserving" to be a
// meaningful choice — an empty battery isn't holding back, it has nothing to give.
const HOLD_SOC_HEADROOM_KWH = 1;

export interface ActionBand {
  x1: string;
  x2: string;
  kind: BandKind;
  kwh: number; // planned energy behind the decision, summed over the band's slots (see bandFlowKwh)
}

/** The flow a band's kind is classified from — buy: grid→battery, sell: battery→grid,
 *  hold: load left to the grid (what the battery is deliberately not covering). */
function bandFlowKwh(d: DispatchSlot, kind: BandKind): number {
  if (kind === 'buy') return d.gridToBatteryKwh;
  if (kind === 'sell') return d.batteryToGridKwh;
  return d.loadFromGridKwh;
}

/** Classify a slot's deliberate decision; null for default self-use behaviour. batteryFloorKwh
 *  is the operational SoC floor (BATTERY_MIN_SOC_KWH) — passed in rather than imported so this
 *  stays usable from the 'use client' chart hook (see buildChartData's own note below). */
export function classifyBand(d: DispatchSlot, batteryFloorKwh: number): BandKind | null {
  if (d.gridToBatteryKwh >= DECISION_GRID_KWH) return 'buy';
  if (d.batteryToGridKwh >= DECISION_GRID_KWH) return 'sell';
  if (d.loadFromGridKwh >= HOLD_LOAD_FROM_GRID_KWH && d.socAfter >= batteryFloorKwh + HOLD_SOC_HEADROOM_KWH) {
    return 'hold';
  }
  return null;
}

export interface ChartPoint {
  time: string;
  buy: number; // full consumer buy price: priceIncludingTaxAndSurcharge + skatt/överföring
  sell: number; // the sell price (spot + EXPORT_BONUS_ORE nätnytta) — the export/sell price
  socPct: number | null; // planned battery SoC % after this slot (null when there is no plan)
  actualSocPct: number | null; // real measured SoC %, averaged into this slot (null: future, or no readings)
  solarKwh: number;
  solarSource: 'forecast' | 'typical';
  action: Action;
  decision: BandKind | null; // the slot's deliberate decision (classifyBand), for the tooltip
  // Planned per-slot battery flows (kWh/15 min), for the tooltip's dispatch quantities —
  // null when the slot has no dispatch plan. Same attribution semantics as DispatchSlot.
  gridToBatteryKwh: number | null;
  batteryToGridKwh: number | null;
  batteryToLoadKwh: number | null;
}

/**
 * Buckets raw poller readings (30 s cadence) into 15-min slot averages, keyed the same way
 * buildPriceLookup keys price slots (stockholmSlotKey — "YYYY-MM-DDTHH:MM", no seconds) so a
 * ChartPoint can look itself up with `slot.startTime.slice(0, 16)`, matching priceSlotsToMap's
 * own convention.
 */
export function buildActualSocByTime(
  readings: { timestamp: string; soc_pct: number }[],
): Record<string, number> {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const r of readings) {
    if (r.soc_pct == null || !isFinite(r.soc_pct)) continue;
    const key = stockholmSlotKey(r.timestamp);
    const b = buckets.get(key) ?? { sum: 0, n: 0 };
    b.sum += r.soc_pct;
    b.n += 1;
    buckets.set(key, b);
  }
  const out: Record<string, number> = {};
  for (const [key, { sum, n }] of buckets) out[key] = Math.round((sum / n) * 10) / 10;
  return out;
}

/**
 * Collapses consecutive same-kind dispatch slots into contiguous decision bands (see the
 * taxonomy above classifyBand). Slots with no deliberate decision are skipped, and a
 * sub-threshold slot inside a run splits it — that gap is real signal, never merged over.
 */
export function buildActionBands(schedule: DispatchSlot[], batteryFloorKwh: number): ActionBand[] {
  const bands: ActionBand[] = [];
  let i = 0;
  while (i < schedule.length) {
    const kind = classifyBand(schedule[i], batteryFloorKwh);
    if (kind !== null) {
      const x1 = schedule[i].startTime;
      let j = i + 1;
      while (j < schedule.length && classifyBand(schedule[j], batteryFloorKwh) === kind) j++;
      let kwh = 0;
      for (let k = i; k < j; k++) kwh += bandFlowKwh(schedule[k], kind);
      bands.push({ x1, x2: schedule[j - 1].startTime, kind, kwh: Math.round(kwh * 100) / 100 });
      i = j;
    } else {
      i++;
    }
  }
  return bands;
}

/**
 * Maps each price slot to a chart-ready data point with BOTH prices shown at once:
 *  - buy  = full consumer price (priceIncludingTaxAndSurcharge + skatt/överföring) — what the
 *           optimizer decides on and what you pay to import.
 *  - sell = the sell price (spot + EXPORT_BONUS_ORE nätnytta) — what you actually receive per exported kWh.
 * dispatchByTime is a pre-keyed lookup. batteryKwh/skattOverforing/batteryFloorKwh are passed in
 * (rather than imported from lib/constants) because this runs inside a 'use client' hook
 * (useChartData) — Next.js never exposes non-NEXT_PUBLIC_ env vars to the client bundle, so a
 * direct import would silently read the hardcoded fallback instead of the deployment's real
 * env-configured value. Callers must pass the values resolved server-side (see app/page.tsx).
 */
export function buildChartData(
  prices: PriceSlot[],
  forecast: Record<string, number[]> | null | undefined,
  profiles: Record<number, number[]>,
  dispatchByTime: Record<string, DispatchSlot>,
  batteryKwh: number,
  skattOverforing: number,
  batteryFloorKwh: number,
  actualSocByTime: Record<string, number> = {},
): ChartPoint[] {
  return prices.map((slot) => {
    const { kwh: solarKwh, source: solarSource } = slotSolarKwh(slot.startTime, forecast, profiles);
    const dispatch = dispatchByTime[slot.startTime];
    return {
      time: slot.startTime,
      buy: slot.priceIncludingTaxAndSurcharge + skattOverforing,
      sell: slot.price,
      socPct: dispatch ? Math.round((dispatch.socAfter / batteryKwh) * 1000) / 10 : null,
      actualSocPct: actualSocByTime[slot.startTime.slice(0, 16)] ?? null,
      solarKwh,
      solarSource,
      action: dispatch?.action ?? 'idle',
      decision: dispatch ? classifyBand(dispatch, batteryFloorKwh) : null,
      gridToBatteryKwh: dispatch ? dispatch.gridToBatteryKwh : null,
      batteryToGridKwh: dispatch ? dispatch.batteryToGridKwh : null,
      batteryToLoadKwh: dispatch ? dispatch.batteryToLoadKwh : null,
    };
  });
}

/**
 * Returns the startTime of every even-hour :00 slot — the X-axis tick positions.
 */
export function buildXTicks(prices: PriceSlot[]): string[] {
  return prices
    .filter(
      (s) =>
        s.startTime.slice(14, 16) === '00' &&
        parseInt(s.startTime.slice(11, 13), 10) % 2 === 0,
    )
    .map((s) => s.startTime);
}

const STHLM_NOW_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * The current 15-min slot's startTime ("YYYY-MM-DDTHH:MM:00"), Stockholm local, floored to the
 * slot boundary — used to draw a "now" marker that lines up exactly with a loaded x value. Returns
 * null if that slot isn't among `availableTimes` (e.g. "now" falls outside the fetched horizon),
 * so the caller never renders a marker at a nonexistent point.
 */
export function computeNowSlotTime(now: Date, availableTimes: string[]): string | null {
  const parts = STHLM_NOW_FORMAT.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour'); // some engines emit 24 at midnight
  const flooredMin = Math.floor(parseInt(get('minute'), 10) / 15) * 15;
  const candidate = `${get('year')}-${get('month')}-${get('day')}T${hour}:${String(flooredMin).padStart(2, '0')}:00`;
  return availableTimes.includes(candidate) ? candidate : null;
}

// ─── SVG chart geometry ──────────────────────────────────────────────────────
// The chart's horizon is variable-length (96 slots today-only, ~192 today+tomorrow), so x is
// scaled by array index rather than hour-of-day — unlike a fixed-width mockup, this needs no
// knowledge of how many hours are actually loaded.

export interface ChartGeometry {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  plotW: number;
  plotH: number;
  baseY: number;
}

export function buildChartGeometry(width = 1040, height = 388): ChartGeometry {
  const padL = 42;
  const padR = 46;
  const padT = 30;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  return { width, height, padL, padR, padT, padB, plotW, plotH, baseY: padT + plotH };
}

/** time → array index, so timeToX doesn't do a linear scan per lookup. */
export function buildTimeIndex(chartData: ChartPoint[]): Map<string, number> {
  const m = new Map<string, number>();
  chartData.forEach((d, i) => m.set(d.time, i));
  return m;
}

export function indexToX(index: number, count: number, geometry: ChartGeometry): number {
  if (count <= 1) return geometry.padL;
  return geometry.padL + (index / (count - 1)) * geometry.plotW;
}

/** Null when `time` isn't in chartData (e.g. "now" outside the fetched horizon) — mirrors
 *  computeNowSlotTime's contract so callers never draw a marker at a nonexistent point. */
export function timeToX(
  time: string,
  chartData: ChartPoint[],
  geometry: ChartGeometry,
  timeIndex?: Map<string, number>,
): number | null {
  const idx = timeIndex ? timeIndex.get(time) : chartData.findIndex((d) => d.time === time);
  if (idx == null || idx < 0) return null;
  return indexToX(idx, chartData.length, geometry);
}

/** Real-data-derived price axis max (öre/kWh): headroom above the highest buy/sell value,
 *  rounded up to a round number, floored so a flat/near-zero price day still gets a sane axis. */
export function computePriceMax(chartData: ChartPoint[]): number {
  const max = chartData.reduce((m, d) => Math.max(m, d.buy, d.sell), 0);
  return Math.max(100, Math.ceil((max + 10) / 20) * 20);
}

/** Real-data-derived price axis min (öre/kWh): 0 on a normal day, but a negative round number
 *  (with headroom, mirroring computePriceMax) when any price dips below zero — negative spot
 *  prices are real on sunny/windy days, and a 0-floored axis would draw them outside the plot. */
export function computePriceMin(chartData: ChartPoint[]): number {
  const min = chartData.reduce((m, d) => Math.min(m, d.buy, d.sell), 0);
  if (min >= 0) return 0; // headroom only once something actually dips below zero
  return Math.floor((min - 10) / 20) * 20;
}

/** Real-data-derived solar axis max (kWh/slot): headroom above the highest slot, floored so a
 *  near-zero solar day (winter) still gets a sane axis. */
export function computeSolarMax(chartData: ChartPoint[]): number {
  const max = chartData.reduce((m, d) => Math.max(m, d.solarKwh), 0);
  return Math.max(0.5, max * 1.15);
}

/** min defaults to 0 (the everyday case); pass computePriceMin's value so days with negative
 *  prices keep every point inside the plot instead of dropping below the baseline. */
export function priceYScale(value: number, max: number, geometry: ChartGeometry, min = 0): number {
  return geometry.padT + (1 - (value - min) / (max - min)) * geometry.plotH;
}

/** Battery SoC is always shown on a fixed 0–100% scale. */
export function socYScale(value: number, geometry: ChartGeometry): number {
  return geometry.padT + (1 - value / 100) * geometry.plotH;
}

/** Solar is drawn as a contextual band hugging the plot's baseline, not the full plot height,
 *  so it stays visually secondary to the price lines. `band` is the fraction of plotH it uses. */
export function solarYScale(value: number, max: number, geometry: ChartGeometry, band = 0.44): number {
  return geometry.baseY - (value / max) * (geometry.plotH * band);
}

export function buildLinePath(points: [number, number][]): string {
  if (!points.length) return '';
  return 'M ' + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ');
}

/** Closes a filled area under a top line, down to baseY, back along the baseline. */
export function buildAreaPath(topPoints: [number, number][], baseY: number): string {
  if (!topPoints.length) return '';
  const first = topPoints[0];
  const last = topPoints[topPoints.length - 1];
  const top = topPoints.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ');
  return `M ${first[0].toFixed(1)} ${baseY.toFixed(1)} L ${top} L ${last[0].toFixed(1)} ${baseY.toFixed(1)} Z`;
}
