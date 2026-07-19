import { stockholmMidnightUtc } from './prices';
import type { PriceSlot } from './prices';

const SLOT_MS = 900_000; // 15 min — same elapsed-time slot width lib/oracle.ts's bucketActuals uses

/**
 * Measured per-slot battery flows (kWh/15 min) — same shape/semantics as the optimizer's
 * PLANNED flows (DispatchSlot in lib/optimizer.ts), attributed from the poller's raw readings
 * so the chart hover can show "planned vs actually happened" side by side (see
 * PLAN-plan-vs-actual-hover.md). Deliberately NOT reconciled against measured grid_w: the
 * residual (inverter losses, standby draw, ~1-3%) is real, and forcing a match would
 * misattribute it as a battery flow — this is a model over the measured DC/AC points, the same
 * stance lib/oracle.ts's own energy-balance diagnostics take.
 */
export interface ActualSlotFlows {
  gridToBatteryKwh: number;
  batteryToGridKwh: number;
  batteryToLoadKwh: number;
  loadFromGridKwh: number;
}

/**
 * One poller reading's fields needed for flow attribution (a subset of the `readings` table —
 * see deploy/schema.sql). All three physical fields must be present for a reading to
 * contribute anything; a reading missing any of them is skipped entirely.
 */
export interface FlowReading {
  timestamp: string; // UTC ISO, as written by the poller
  pv_w: number | null;
  house_load_w: number | null;
  battery_w: number | null; // schema.sql convention: −ve = charge, +ve = discharge
}

interface FlowPowersW {
  gridToBatteryW: number;
  batteryToGridW: number;
  batteryToLoadW: number;
  loadFromGridW: number;
}

/**
 * Attributes one reading's instantaneous powers (W) to flows, mirroring the optimizer's own
 * computeFlows (lib/optimizer.ts): solar serves the house load first; a DISCHARGING battery
 * covers remaining load first, then exports the rest; a CHARGING battery draws from remaining
 * solar first, then the grid makes up the difference. Unlike computeFlows this needs no
 * round-trip-efficiency conversion — battery_w is the already-real power crossing the battery
 * terminals here, not a required SoC delta to solve backward from.
 *
 * pv_w/house_load_w are clamped to ≥0 (conversion noise can dip either slightly negative — the
 * same clamp lib/oracle.ts's bucketActuals applies to its own pv/load sums).
 */
export function attributeReadingFlows(pvW: number, houseLoadW: number, batteryW: number): FlowPowersW {
  const pv = Math.max(0, pvW);
  const load = Math.max(0, houseLoadW);

  if (batteryW > 0) {
    // discharging: covers remaining load first, then exports whatever's left
    const solarToLoad = Math.min(pv, load);
    const loadRem = load - solarToLoad;
    const batteryToLoadW = Math.min(batteryW, loadRem);
    const batteryToGridW = batteryW - batteryToLoadW;
    const loadFromGridW = loadRem - batteryToLoadW;
    return { gridToBatteryW: 0, batteryToGridW, batteryToLoadW, loadFromGridW };
  }

  // charging, or idle (batteryW === 0): draws from remaining solar first, then the grid
  const need = -batteryW;
  const solarToLoad = Math.min(pv, load);
  const fromSolar = Math.min(pv - solarToLoad, need);
  const gridToBatteryW = need - fromSolar;
  const loadFromGridW = load - solarToLoad;
  return { gridToBatteryW, batteryToGridW: 0, batteryToLoadW: 0, loadFromGridW };
}

/**
 * Buckets readings into per-slot ACTUAL flows by elapsed time since windowStartMs — the same
 * DST-safe indexing lib/oracle.ts's bucketActuals uses, never wall-clock hour/minute (CLAUDE.md
 * key invariants). A slot with zero contributing readings is `null` — absence must read as "no
 * data", never as "nothing happened" (a zero-filled slot would look like a confirmed non-event).
 * Readings missing any of the three physical fields are skipped entirely (all three are needed
 * to attribute anything). A slot with readings on both sides of a sign flip (e.g. it started
 * discharging then switched to charging) accumulates both sides correctly by construction —
 * each reading is attributed independently before being summed into its slot.
 */
export function bucketActualFlows(
  rows: FlowReading[],
  windowStartMs: number,
  slotCount: number,
): (ActualSlotFlows | null)[] {
  const sums: FlowPowersW[] = Array.from({ length: slotCount }, () => ({
    gridToBatteryW: 0,
    batteryToGridW: 0,
    batteryToLoadW: 0,
    loadFromGridW: 0,
  }));
  const counts = new Array<number>(slotCount).fill(0);

  for (const r of rows) {
    if (r.pv_w == null || r.house_load_w == null || r.battery_w == null) continue;
    const t = Date.parse(r.timestamp);
    const i = Math.floor((t - windowStartMs) / SLOT_MS);
    if (i < 0 || i >= slotCount) continue;
    const flow = attributeReadingFlows(r.pv_w, r.house_load_w, r.battery_w);
    sums[i].gridToBatteryW += flow.gridToBatteryW;
    sums[i].batteryToGridW += flow.batteryToGridW;
    sums[i].batteryToLoadW += flow.batteryToLoadW;
    sums[i].loadFromGridW += flow.loadFromGridW;
    counts[i]++;
  }

  const meanKwh = (sumW: number, n: number) => (sumW / n / 1000) * 0.25; // mean W over 15 min → kWh
  return sums.map((s, i) => {
    const n = counts[i];
    if (n === 0) return null;
    return {
      gridToBatteryKwh: meanKwh(s.gridToBatteryW, n),
      batteryToGridKwh: meanKwh(s.batteryToGridW, n),
      batteryToLoadKwh: meanKwh(s.batteryToLoadW, n),
      loadFromGridKwh: meanKwh(s.loadFromGridW, n),
    };
  });
}

/**
 * Keys bucketed actual flows by `prices`' own startTime strings — index-aligned with `flows` by
 * construction (both are built from the same elapsed-time-since-windowStartMs indexing, the
 * same reasoning lib/oracle.ts's price-slot bucketing relies on). Drops any slot still in
 * progress or in the future: a partial integration always under-reads and would falsely look
 * like a shortfall, so a slot is included only once its END instant is at or before `nowMs`.
 */
export function actualFlowsByTime(
  prices: PriceSlot[],
  flows: (ActualSlotFlows | null)[],
  windowStartMs: number,
  nowMs: number,
): Record<string, ActualSlotFlows> {
  const out: Record<string, ActualSlotFlows> = {};
  const n = Math.min(prices.length, flows.length);
  for (let i = 0; i < n; i++) {
    const f = flows[i];
    if (!f) continue;
    const slotEndMs = windowStartMs + (i + 1) * SLOT_MS;
    if (slotEndMs > nowMs) continue; // still in progress or future — never a complete reading
    out[prices[i].startTime] = f;
  }
  return out;
}

/**
 * Convenience wrapper for the page-render call site: slices `prices` down to `todayDate`'s own
 * slots (readings only ever cover today — see lib/telemetry readTodayFlowRows), derives
 * windowStartMs directly from the date string (no Date object needed — mirrors
 * currentSlotIndexInPrices' pattern in lib/prices.ts), buckets, and keys by time.
 */
export function buildActualFlowsByTime(
  prices: PriceSlot[],
  todayDate: string,
  rows: FlowReading[],
  nowMs: number,
): Record<string, ActualSlotFlows> {
  const todaysPrices = prices.filter((p) => p.startTime.startsWith(todayDate));
  const [y, m, d] = todayDate.split('-').map(Number);
  const windowStartMs = stockholmMidnightUtc(y, m - 1, d).getTime();
  const flows = bucketActualFlows(rows, windowStartMs, todaysPrices.length);
  return actualFlowsByTime(todaysPrices, flows, windowStartMs, nowMs);
}
