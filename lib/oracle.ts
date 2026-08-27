/**
 * Hindsight-optimal ("oracle") dispatch scoring.
 *
 * For each completed day D this computes what a dispatcher with perfect information could have
 * earned, next to what the system actually earned, on one identical accounting basis. Pure
 * module — no I/O. The DB reads/writes live in lib/telemetry/oracle.ts, the per-day orchestration in
 * app/api/oracle/route.ts, and the nightly trigger is deploy/solinteg-oracle.timer.
 *
 * ── Fairness design ─────────────────────────────────────────────────────────────────────────
 * A day-D-only oracle with terminal value 0 would always drain the battery to the floor by
 * midnight, while the real planner (correctly) carries SoC into tomorrow whenever tonight's
 * leftover energy beats tomorrow's prices — the naive comparison punishes the controller for
 * its best behaviour. So day D is scored inside a 48 h window with the day-after's actuals:
 *
 *   oracleTotal    = value of the DP run over [D 00:00, D+1 24:00] from the actual start SoC
 *                    (its terminal-0 drain now sits a full day away from any day-D decision,
 *                    and the window is a superset of every horizon production had during D:
 *                    24 h before the ~13:00 price release, ~35 h after)
 *   achievedTotal  = actual day-D meter cash − wear + contV(achieved end SoC)
 *                    where contV(s) = value of the DP run over D+1 alone starting at s — the
 *                    hindsight-true worth of the SoC the system handed to tomorrow
 *   regret         = oracleTotal − achievedTotal      (money left on the table during day D)
 *
 * The regret further splits along the one decision boundary that matters (all three parts are
 * ≥ 0 up to model-vs-reality mismatch, since each subtracts a more-restricted optimum):
 *
 *   regretIntraday = constrainedValue − (cash − wear)  where constrainedValue is the DP over
 *                    day D forced to END at the achieved end SoC (same start, same end — pure
 *                    within-day timing: recompute cadence, guard skips, forecast timing)
 *   regretCarry    = regret − regretIntraday           (cost of handing tomorrow the wrong SoC
 *                    — the number that audits terminal-value-0/horizon design itself)
 *
 * A materially NEGATIVE regret is a diagnostic, not noise: it means the model's physics
 * (RT_EFF, caps, wear basis) diverge from the real inverter's — see diagnostics.balance.
 * The dominant such divergence is closed before scoring: each window's measured energy-balance
 * residual (DC-side pv_w vs the AC bus, standby, battery losses beyond the modeled η — on the
 * reference install systematically +1–3 kWh/day) is removed from the solar series the oracle
 * re-dispatches, net of the battery losses the DP already models, so the oracle plays with the
 * energy the real day demonstrably had instead of selling phantom kWh the meters never saw
 * (see windowEnergyBalance; params.pvDerate records the applied factor). Without this the
 * oracle's re-dispatch sells energy that never existed at the day's best prices, and regret is
 * inflated by roughly the residual × the day's price spread.
 *
 * Everything is valued through evaluateDispatch (the DP's own arithmetic) with the same
 * buy/sell definitions economics.ts uses, so the comparison can't drift apart in accounting.
 * Consequence of needing D+1 actuals: day D becomes scorable only after D+1 completes — the
 * nightly job always scores two days back.
 */
import {
  optimizeDispatch,
  evaluateDispatch,
  BATTERY_KWH,
  BATTERY_MIN_SOC_KWH,
  BATTERY_MAX_KW,
  GRID_KW,
} from './optimizer';
import type { OptimizerSlot, DispatchSlot } from './optimizer';
import type { PriceSlot } from './prices';
import { BATTERY_RT_EFF, BATTERY_WEAR_COST_ORE_PER_KWH, SKATT_OVERFÖRING } from './constants';

const SLOT_MS = 900_000; // 15 min
const SLOT_MAX_KWH = Math.min(GRID_KW, BATTERY_MAX_KW) / 4; // 2.75 kWh — same binding cap as the DP
/** Poller gaps up to this many consecutive empty slots are linearly interpolated; longer runs
 *  are filled with 0 and the day is flagged degraded instead of silently trusted. */
const MAX_INTERP_SLOTS = 4;
const MIN_READING_COVERAGE = 0.95;
/** The dispatch loop logs a control_actions row every ~5 min while asserting a charge/
 *  discharge, but during idle stretches only on the 15-min slot change (measured 2026-07-04..08:
 *  p50 gap 309 s, p90 903 s). The cap must clear that 15-min idle cadence or armed idle time is
 *  systematically undercounted (a 10-min cap scored fully-armed days at ~0.85); silence longer
 *  than this means the loop was down ⇒ counted NOT armed. Callers should fetch events from
 *  one cap-length BEFORE the window so a pre-midnight row covers the day's first minutes. */
export const ARMED_SEGMENT_CAP_MS = 20 * 60_000;
/** Armed-coverage floor for status 'ok'. Not 0.999: without solinteg-telemetry.timer's 00:03
 *  Stockholm entry the dispatch loop is structurally planless (and silent — it logs nothing
 *  while it has no plan for the new day) for the first 1–2 h after EVERY Stockholm midnight,
 *  until the next top-of-hour telemetry render produces the new day's optimizer run — armed
 *  days then measure only 0.92–0.97. That lull is part of the pipeline being scored — its cost
 *  belongs INSIDE regret, not a reason to exclude the day, and the floor must keep admitting
 *  such days. With the midnight entry armed days score ~0.99; the floor only filters genuinely
 *  disarmed/shadow days. */
const FULLY_ARMED = 0.9;
/** A midnight SoC interpolated across a reading gap wider than this can't anchor the day. */
const SOC_BOUNDARY_MAX_SPAN_MS = 30 * 60_000;

// ── Input row shapes (as read from telemetry.db by lib/telemetry/oracle.ts) ─────────────────────────

export interface OracleReadingRow {
  timestamp: string; // UTC ISO (poller convention)
  pv_w: number | null;
  house_load_w: number | null;
  soc_kwh: number | null;
  grid_w: number | null; // +export / −import (inverter convention — OPPOSITE of DispatchSlot.gridKwh)
}

export interface ArmedEventRow {
  timestamp: string; // UTC ISO
  armed: number; // 0 | 1
  outcome: string;
}

// ── Output row (mirrors the oracle_daily table — deploy/schema.sql) ──────────────────────────

export type OracleDayStatus = 'ok' | 'shadow' | 'degraded' | 'skipped_no_readings';

export interface OracleDayRow {
  date: string;
  status: OracleDayStatus;
  armedFraction: number | null;
  readingCoverage: number | null;
  startSocKwh: number | null;
  achievedEndSocKwh: number | null;
  oracleEndSocKwh: number | null;
  baselineNetOre: number | null;
  achievedCashOre: number | null;
  achievedWearOre: number | null;
  achievedContinuationOre: number | null;
  achievedTotalOre: number | null;
  oracleDayCashOre: number | null;
  oracleDayWearOre: number | null;
  oracleTotalOre: number | null;
  regretOre: number | null;
  regretIntradayOre: number | null;
  regretCarryOre: number | null;
  params: Record<string, number | string>;
  oracleDispatchD: DispatchSlot[] | null; // day-D slice of the 48 h oracle trajectory
  diagnostics: Record<string, unknown>;
}

// ── Slot bucketing (elapsed-time indexed, DST-safe) ──────────────────────────────────────────

export interface SlotActuals {
  solarKwh: number[]; // per-slot kWh (gaps interpolated/zero-filled — see coverage)
  loadKwh: number[];
  importKwh: number[]; // metered grid import per slot (diagnostics only)
  exportKwh: number[];
  /** Fraction of slots that had at least one real reading BEFORE interpolation. */
  coverage: number;
  interpolatedSlots: number;
  zeroFilledSlots: number;
}

/**
 * Bucket poller readings into 15-min slots by ELAPSED TIME since the window start — never by
 * wall-clock hour/minute, which drifts ±4 positions after a DST transition (CLAUDE.md key
 * invariants). `slotCount` comes from the price feed's own slot list (96 normally, 92/100 on
 * transition days), so the buckets line up with the price array by construction.
 */
export function bucketActuals(
  readings: OracleReadingRow[],
  windowStartMs: number,
  slotCount: number,
): SlotActuals {
  const pvSum = new Float64Array(slotCount);
  const pvN = new Int32Array(slotCount);
  const loadSum = new Float64Array(slotCount);
  const loadN = new Int32Array(slotCount);
  const impSum = new Float64Array(slotCount);
  const expSum = new Float64Array(slotCount);
  const gridN = new Int32Array(slotCount);

  for (const r of readings) {
    const t = Date.parse(r.timestamp);
    const i = Math.floor((t - windowStartMs) / SLOT_MS);
    if (i < 0 || i >= slotCount) continue;
    if (r.pv_w !== null) {
      pvSum[i] += Math.max(0, r.pv_w);
      pvN[i]++;
    }
    if (r.house_load_w !== null) {
      // The derived load (inverter_ac_w − grid_w) can dip below zero on conversion noise;
      // a negative household load is unphysical, so clamp.
      loadSum[i] += Math.max(0, r.house_load_w);
      loadN[i]++;
    }
    if (r.grid_w !== null) {
      // readings.grid_w: +export/−import. Clamp per READING, not per slot mean, so a slot
      // that both imported and exported contributes to both sides (reality does this around
      // zero-crossings; a netted mean would hide it).
      expSum[i] += Math.max(0, r.grid_w);
      impSum[i] += Math.max(0, -r.grid_w);
      gridN[i]++;
    }
  }

  const meanKwh = (sum: Float64Array, n: Int32Array, i: number): number | null =>
    n[i] > 0 ? (sum[i] / n[i] / 1000) * 0.25 : null;

  const solar: (number | null)[] = [];
  const load: (number | null)[] = [];
  const importKwh: number[] = [];
  const exportKwh: number[] = [];
  let covered = 0;
  for (let i = 0; i < slotCount; i++) {
    const s = meanKwh(pvSum, pvN, i);
    const l = meanKwh(loadSum, loadN, i);
    solar.push(s);
    load.push(l);
    importKwh.push(meanKwh(impSum, gridN, i) ?? 0);
    exportKwh.push(meanKwh(expSum, gridN, i) ?? 0);
    if (s !== null && l !== null) covered++;
  }

  const fillGaps = (arr: (number | null)[]): { out: number[]; interp: number; zeroed: number } => {
    const out = new Array<number>(arr.length);
    let interp = 0;
    let zeroed = 0;
    let i = 0;
    while (i < arr.length) {
      if (arr[i] !== null) {
        out[i] = arr[i] as number;
        i++;
        continue;
      }
      let j = i;
      while (j < arr.length && arr[j] === null) j++;
      const runLen = j - i;
      const before = i > 0 ? (arr[i - 1] as number) : null;
      const after = j < arr.length ? (arr[j] as number) : null;
      if (runLen <= MAX_INTERP_SLOTS && before !== null && after !== null) {
        for (let k = i; k < j; k++) {
          const frac = (k - i + 1) / (runLen + 1);
          out[k] = before + (after - before) * frac;
          interp++;
        }
      } else {
        for (let k = i; k < j; k++) {
          out[k] = 0;
          zeroed++;
        }
      }
      i = j;
    }
    return { out, interp, zeroed };
  };

  const fs = fillGaps(solar);
  const fl = fillGaps(load);
  return {
    solarKwh: fs.out,
    loadKwh: fl.out,
    importKwh,
    exportKwh,
    coverage: slotCount > 0 ? covered / slotCount : 0,
    interpolatedSlots: fs.interp + fl.interp,
    zeroFilledSlots: fs.zeroed + fl.zeroed,
  };
}

/**
 * SoC at an exact instant, linearly interpolated between the two surrounding readings.
 * Returns the interpolated value plus the span it was interpolated across — a midnight SoC
 * bridged over a long poller gap is too uncertain to anchor the whole day's accounting on.
 */
export function socAtInstant(
  socPoints: { t: number; soc: number }[],
  instantMs: number,
): { soc: number; spanMs: number } | null {
  if (socPoints.length === 0) return null;
  // Binary search for the first point at/after the instant.
  let lo = 0;
  let hi = socPoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (socPoints[mid].t < instantMs) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < socPoints.length ? socPoints[lo] : null;
  const before = lo > 0 ? socPoints[lo - 1] : null;
  if (before && after) {
    if (after.t === before.t) return { soc: before.soc, spanMs: 0 };
    const frac = (instantMs - before.t) / (after.t - before.t);
    return { soc: before.soc + (after.soc - before.soc) * frac, spanMs: after.t - before.t };
  }
  // Off the ends: accept the nearest reading if it's close enough to stand in.
  const nearest = before ?? after;
  if (!nearest) return null;
  const dist = Math.abs(nearest.t - instantMs);
  return dist <= SOC_BOUNDARY_MAX_SPAN_MS / 2 ? { soc: nearest.soc, spanMs: dist * 2 } : null;
}

export function socSeries(readings: OracleReadingRow[]): { t: number; soc: number }[] {
  const pts: { t: number; soc: number }[] = [];
  for (const r of readings) {
    if (r.soc_kwh !== null) pts.push({ t: Date.parse(r.timestamp), soc: r.soc_kwh });
  }
  return pts; // readings arrive ORDER BY timestamp, so this is already sorted
}

// ── Energy-balance closure ──────────────────────────────────────────────────────

const ONE_WAY_EFF = Math.sqrt(BATTERY_RT_EFF);
/** Below this much window pv there is nothing meaningful to scale — the leftover
 *  (standby-sized) residual stays visible in diagnostics.balance instead. */
const BALANCE_MIN_PV_KWH = 2;
/** A correction past this is broken input data (BMS SoC recalibration jump, meter fault),
 *  not physics — refuse to silently absorb it. When it binds, the window is scored with an
 *  energy balance that does NOT close, so it is reported via WindowBalance.derateClamped /
 *  unclosedLossKwh rather than left to be inferred from solarDerate (0.9 is also a legal
 *  value for a genuinely lossy day) — status stays 'ok', deliberately: see the note in
 *  computeOracleDay's diagnostics.balance. */
const BALANCE_DERATE_FLOOR = 0.9;

export interface WindowBalance {
  pvKwh: number;
  importKwh: number;
  loadKwh: number;
  exportKwh: number;
  deltaSocKwh: number | null;
  residualKwh: number | null;
  /** Battery leg losses the DP's own arithmetic already models, computed on the REAL SoC
   *  trajectory: charge legs at 1/η−1, discharge legs at 1−η (pack-side view of an AC-side
   *  per-leg η) over the window's slot-boundary SoC deltas. */
  modeledBatteryLossKwh: number;
  unmodeledLossKwh: number | null;
  solarDerate: number;
  /** Model-unexplained energy the derate did NOT absorb (kWh, ≥ 0). Non-zero means this
   *  window was scored with an energy balance that does not close, so its regret carries
   *  that much phantom/missing energy at the day's prices. */
  unclosedLossKwh: number | null;
  /** The derate wanted to correct more than BALANCE_DERATE_FLOOR allows and was clamped. */
  derateClamped: boolean;
  /** pv below BALANCE_MIN_PV_KWH, so no closure was attempted at all. */
  closureSkippedLowPv: boolean;
}

/**
 * Measure a window's energy balance and the solar derate that closes its MODEL-UNEXPLAINED
 * share. `residual = pv + import − load − export − ΔSoC` captures every loss the meters saw
 * (systematically +1–3 kWh/day here, first measured 2026-07-13); feeding the oracle raw
 * DC-side pv_w (register 11028) hands its re-dispatch that much phantom energy to sell at
 * each day's best prices, while the achieved side is real meter cash — regret was inflated
 * by roughly the residual × price spread.
 *
 * Only the loss BEYOND the DP's own physics is phantom, though: the DP already charges
 * battery legs at ONE_WAY_EFF on whatever trajectory it evaluates, so the modeled share of
 * the real trajectory's battery losses must NOT be closed out of the solar series too —
 * closing the full residual would over-correct cycling-heavy days by about the same margin
 * in the other direction. A global fitted derate was rejected for the same reason:
 * residual/pv ranged 0.9–3.5% across the first ten scored days precisely because the battery
 * share varies with cycling, so a pv-proportional constant systematically under-corrects the
 * armed, high-throughput days the 07-23 review most cares about.
 *
 * The derate never inflates solar (a negative unmodeled residual is SoC-estimator drift, not
 * free energy) and never absorbs more than 10% (BALANCE_DERATE_FLOOR — a correction that big
 * is broken data). Both refusals — the clamp, and skipping windows under BALANCE_MIN_PV_KWH —
 * leave the window scored on a balance that does not close, so each is reported explicitly
 * (`derateClamped`, `closureSkippedLowPv`, `unclosedLossKwh`) instead of being inferable only
 * from the derate value. Missing SoC anchors ⇒ derate 1 and null residual: scoring proceeds
 * exactly as before this existed.
 */
export function windowEnergyBalance(
  actuals: SlotActuals,
  soc: { t: number; soc: number }[],
  windowStartMs: number,
  slotCount: number,
): WindowBalance {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const pvKwh = sum(actuals.solarKwh);
  const importKwh = sum(actuals.importKwh);
  const loadKwh = sum(actuals.loadKwh);
  const exportKwh = sum(actuals.exportKwh);

  const socStart = socAtInstant(soc, windowStartMs);
  const socEnd = socAtInstant(soc, windowStartMs + slotCount * SLOT_MS);

  // Modeled battery losses over the real trajectory — same boundary walk (and the same
  // carry-last-value-across-gaps semantics) as the achieved-wear computation below.
  let chgPackKwh = 0;
  let disPackKwh = 0;
  if (socStart && socEnd) {
    let prev = socStart.soc;
    for (let i = 1; i <= slotCount; i++) {
      const b = socAtInstant(soc, windowStartMs + i * SLOT_MS);
      if (b) {
        const delta = b.soc - prev;
        if (delta > 0) chgPackKwh += delta;
        else disPackKwh += -delta;
        prev = b.soc;
      }
    }
  }
  const modeledBatteryLossKwh =
    chgPackKwh * (1 / ONE_WAY_EFF - 1) + disPackKwh * (1 - ONE_WAY_EFF);

  if (!socStart || !socEnd) {
    return {
      pvKwh, importKwh, loadKwh, exportKwh,
      deltaSocKwh: null, residualKwh: null,
      modeledBatteryLossKwh, unmodeledLossKwh: null, solarDerate: 1,
      unclosedLossKwh: null, derateClamped: false, closureSkippedLowPv: false,
    };
  }

  const deltaSocKwh = socEnd.soc - socStart.soc;
  const residualKwh = pvKwh + importKwh - loadKwh - exportKwh - deltaSocKwh;
  const unmodeledLossKwh = residualKwh - modeledBatteryLossKwh;
  // The factor that would close the balance exactly, before either guard applies. Keeping it
  // separate is what makes "the closure was refused" observable instead of inferable — a
  // clamped or skipped window looks identical to a healthy one in solarDerate alone (0.9 is a
  // legal value for a genuinely lossy day), and 2026-07-25 was scored 'ok' on a clamped derate
  // with nothing in the row saying so.
  const closureSkippedLowPv = pvKwh < BALANCE_MIN_PV_KWH;
  const wantedDerate = pvKwh > 0 ? 1 - Math.max(0, unmodeledLossKwh) / pvKwh : 1;
  const solarDerate = closureSkippedLowPv
    ? 1
    : Math.max(BALANCE_DERATE_FLOOR, Math.min(1, wantedDerate));
  const derateClamped = !closureSkippedLowPv && wantedDerate < BALANCE_DERATE_FLOOR;

  return {
    pvKwh, importKwh, loadKwh, exportKwh,
    deltaSocKwh, residualKwh, modeledBatteryLossKwh, unmodeledLossKwh, solarDerate,
    unclosedLossKwh: Math.max(0, Math.max(0, unmodeledLossKwh) - (1 - solarDerate) * pvKwh),
    derateClamped, closureSkippedLowPv,
  };
}

// ── Armed coverage ────────────────────────────────────────────────────────────────────────────

/**
 * Time-weighted fraction of [dayStartMs, dayEndMs) the dispatch loop was armed. Each armed=1
 * row covers until the next row, capped at ARMED_SEGMENT_CAP_MS — the loop logs at least every
 * ~5 min while alive, so a longer silence means it was down and nothing was being dispatched.
 * Time before the first row is unknown ⇒ counted not-armed (conservative).
 */
export function armedStats(
  events: ArmedEventRow[],
  dayStartMs: number,
  dayEndMs: number,
): { fraction: number; revertFailedCount: number } {
  let armedMs = 0;
  let revertFailedCount = 0;
  for (let i = 0; i < events.length; i++) {
    const t = Date.parse(events[i].timestamp);
    if (t >= dayEndMs) break;
    if (events[i].outcome === 'error_revert_failed') revertFailedCount++;
    if (events[i].armed !== 1 || t < dayStartMs - ARMED_SEGMENT_CAP_MS) continue;
    const from = Math.max(t, dayStartMs);
    const next = i + 1 < events.length ? Date.parse(events[i + 1].timestamp) : Infinity;
    const to = Math.min(t + ARMED_SEGMENT_CAP_MS, next, dayEndMs);
    if (to > from) armedMs += to - from;
  }
  const dayMs = dayEndMs - dayStartMs;
  return { fraction: dayMs > 0 ? armedMs / dayMs : 0, revertFailedCount };
}

// ── No-battery baseline ───────────────────────────────────────────────────────────────────────

/**
 * What the same day would have cost with no battery at all: solar serves the house, the
 * surplus exports (curtailed above the grid cap, same rule as the DP), the deficit imports.
 * Day-D-only cash with no storage state, so no boundary credit is needed or possible.
 */
export function baselineCashOre(slots: OptimizerSlot[]): number {
  let cash = 0;
  for (const s of slots) {
    const net = (s.consumptionKwh ?? 0) - s.solarKwh;
    if (net >= 0) cash -= net * s.buyPrice;
    else cash += Math.min(-net, SLOT_MAX_KWH) * s.sellPrice;
  }
  return cash;
}

// ── Day assembly ──────────────────────────────────────────────────────────────────────────────

/** Same buy/sell derivation as economics.ts (priceSlotsToMap) and the live pipeline. */
export function toOptimizerSlots(priceSlots: PriceSlot[], actuals: SlotActuals): OptimizerSlot[] {
  return priceSlots.map((p, i) => ({
    startTime: p.startTime,
    buyPrice: p.priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING,
    sellPrice: p.price,
    solarKwh: actuals.solarKwh[i],
    consumptionKwh: actuals.loadKwh[i],
  }));
}

export interface OracleDayInputs {
  date: string; // Stockholm day D being scored
  dayStartMs: number; // UTC ms of D's Stockholm midnight (stockholmMidnightUtc)
  priceSlotsD: PriceSlot[]; // exactly day D's slots, chronological (92/96/100 entries)
  priceSlotsCont: PriceSlot[]; // the continuation horizon — normally exactly day D+1's slots
  readings: OracleReadingRow[]; // [D 00:00, end of continuation) UTC, ordered by timestamp
  armedEvents: ArmedEventRow[]; // [D 00:00, D+1 00:00) UTC, ordered by timestamp
  achievedCashOre: number | null; // day-D meter cash from computeDailyEconomics (netKr × 100)
}

export function computeOracleDay(inputs: OracleDayInputs): OracleDayRow {
  const { date, dayStartMs, priceSlotsD, priceSlotsCont, readings, armedEvents } = inputs;
  const nD = priceSlotsD.length;
  const dayEndMs = dayStartMs + nD * SLOT_MS;

  const params: Record<string, number | string> = {
    batteryKwh: BATTERY_KWH,
    minSocKwh: BATTERY_MIN_SOC_KWH,
    rtEff: BATTERY_RT_EFF,
    wearOrePerKwh: Math.round(BATTERY_WEAR_COST_ORE_PER_KWH * 1000) / 1000,
    slotMaxKwh: SLOT_MAX_KWH,
    skattOverforing: SKATT_OVERFÖRING,
    windowHours: ((nD + priceSlotsCont.length) * SLOT_MS) / 3_600_000,
    pvDerate: 1,
  };

  const actualsD = bucketActuals(readings, dayStartMs, nD);
  const actualsCont = bucketActuals(readings, dayEndMs, priceSlotsCont.length);
  const soc = socSeries(readings);
  const startSoc = socAtInstant(soc, dayStartMs);
  const endSoc = socAtInstant(soc, dayEndMs);
  const armed = armedStats(armedEvents, dayStartMs, dayEndMs);

  // Close each window's model-unexplained energy loss into its solar series BEFORE any slot
  // is built, so the oracle re-dispatches the energy the real day demonstrably had (see
  // windowEnergyBalance). Raw sums are kept for diagnostics.balance below.
  const balD = windowEnergyBalance(actualsD, soc, dayStartMs, nD);
  const balCont = windowEnergyBalance(actualsCont, soc, dayEndMs, priceSlotsCont.length);
  if (balD.solarDerate !== 1) actualsD.solarKwh = actualsD.solarKwh.map((s) => s * balD.solarDerate);
  if (balCont.solarDerate !== 1) actualsCont.solarKwh = actualsCont.solarKwh.map((s) => s * balCont.solarDerate);
  params.pvDerate = Math.round(balD.solarDerate * 10000) / 10000;

  const slotsD = toOptimizerSlots(priceSlotsD, actualsD);
  const baselineNetOre = baselineCashOre(slotsD);

  const diagnostics: Record<string, unknown> = {
    coverageD: round3(actualsD.coverage),
    coverageCont: round3(actualsCont.coverage),
    interpolatedSlots: actualsD.interpolatedSlots + actualsCont.interpolatedSlots,
    zeroFilledSlots: actualsD.zeroFilledSlots + actualsCont.zeroFilledSlots,
    startSocSpanMin: startSoc ? Math.round(startSoc.spanMs / 60_000) : null,
    endSocSpanMin: endSoc ? Math.round(endSoc.spanMs / 60_000) : null,
    revertFailedCount: armed.revertFailedCount,
  };

  const base = {
    date,
    armedFraction: round3(armed.fraction),
    readingCoverage: round3(Math.min(actualsD.coverage, actualsCont.coverage)),
    baselineNetOre: round1(baselineNetOre),
    params,
    diagnostics,
  };

  // Without both midnight SoC anchors and real meter economics there is nothing meaningful
  // to score — record the day as unscorable rather than inventing numbers.
  if (!startSoc || !endSoc || inputs.achievedCashOre === null) {
    diagnostics.reason = !startSoc
      ? 'no SoC reading near day start'
      : !endSoc
        ? 'no SoC reading near day end'
        : 'no meter economics for the day';
    return {
      ...base,
      status: 'skipped_no_readings',
      startSocKwh: startSoc ? round3(startSoc.soc) : null,
      achievedEndSocKwh: endSoc ? round3(endSoc.soc) : null,
      oracleEndSocKwh: null,
      achievedCashOre: inputs.achievedCashOre,
      achievedWearOre: null,
      achievedContinuationOre: null,
      achievedTotalOre: null,
      oracleDayCashOre: null,
      oracleDayWearOre: null,
      oracleTotalOre: null,
      regretOre: null,
      regretIntradayOre: null,
      regretCarryOre: null,
      oracleDispatchD: null,
    };
  }

  const slotsCont = toOptimizerSlots(priceSlotsCont, actualsCont);
  const slots48 = [...slotsD, ...slotsCont];

  // Oracle: perfect-information DP over the whole window from the REAL starting SoC.
  const dispatch48 = optimizeDispatch(slots48, startSoc.soc);
  const oracleAll = evaluateDispatch(slots48, dispatch48, startSoc.soc);
  const oracleD = evaluateDispatch(slotsD, dispatch48.slice(0, nD), startSoc.soc);
  const oracleEndSoc = dispatch48[nD - 1].socAfter;

  // Continuation value of the SoC the system ACTUALLY handed to D+1.
  const contDispatch = optimizeDispatch(slotsCont, endSoc.soc);
  const achievedContinuationOre = evaluateDispatch(slotsCont, contDispatch, endSoc.soc).valueOre;

  // Achieved wear on the DP's own basis (Σ|ΔSoC| across day-D slot boundaries), so the wear
  // term subtracts identically on both sides. Boundary SoC gaps carry the last known value
  // (Δ = 0 across the gap) — consistent with the coverage flagging above.
  let achievedWearOre = 0;
  let prevSoc = startSoc.soc;
  /** The trajectory the battery ACTUALLY followed, in the shape evaluateDispatch prices.
   *  A boundary with no reading repeats the last known SoC, so the Δ across a gap is counted
   *  once at the next real boundary — identical to the wear walk it shares this loop with. */
  const achievedTrajectory: { socAfter: number }[] = [];
  for (let i = 1; i <= nD; i++) {
    const b = socAtInstant(soc, dayStartMs + i * SLOT_MS);
    if (b) {
      achievedWearOre += BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(b.soc - prevSoc);
      prevSoc = b.soc;
    }
    achievedTrajectory.push({ socAfter: prevSoc });
  }

  // Day D's real trajectory priced on the model's own basis (see diagnostics.accounting below).
  const achievedModelCashOre = evaluateDispatch(slotsD, achievedTrajectory, startSoc.soc).cashOre;

  // Intraday: best possible day D forced to end where the real day ended. The target comes
  // from a real trajectory under the same physics, so it is reachable by construction; guard
  // anyway (a pathological SoC reading could still produce a fantasy target).
  let constrainedValueOre: number | null = null;
  try {
    const constrained = optimizeDispatch(slotsD, startSoc.soc, { endSoc: endSoc.soc });
    constrainedValueOre = evaluateDispatch(slotsD, constrained, startSoc.soc).valueOre;
  } catch (err) {
    diagnostics.constrainedError = err instanceof Error ? err.message : String(err);
  }

  const achievedDayValueOre = inputs.achievedCashOre - achievedWearOre;
  const achievedTotalOre = achievedDayValueOre + achievedContinuationOre;
  const oracleTotalOre = oracleAll.valueOre;
  const regretOre = oracleTotalOre - achievedTotalOre;
  const regretIntradayOre =
    constrainedValueOre !== null ? constrainedValueOre - achievedDayValueOre : null;
  const regretCarryOre = regretIntradayOre !== null ? regretOre - regretIntradayOre : null;

  // Day-D energy balance, RAW (pre-derate) — the measured physics gap this scoring run
  // closed into the solar series (see windowEnergyBalance). residualKwh stays the raw
  // observable; unmodeledLossKwh is the share actually absorbed via solarDerate, so a
  // residual explained by modeled battery losses shows up here as derate ≈ 1, not as a
  // scoring change.
  diagnostics.balance = {
    pvKwh: round3(balD.pvKwh),
    importKwh: round3(balD.importKwh),
    loadKwh: round3(balD.loadKwh),
    exportKwh: round3(balD.exportKwh),
    deltaSocKwh: balD.deltaSocKwh === null ? null : round3(balD.deltaSocKwh),
    residualKwh: balD.residualKwh === null ? null : round3(balD.residualKwh),
    residualFrac:
      balD.residualKwh !== null && balD.pvKwh + balD.importKwh > 0
        ? round3(balD.residualKwh / (balD.pvKwh + balD.importKwh))
        : null,
    modeledBatteryLossKwh: round3(balD.modeledBatteryLossKwh),
    unmodeledLossKwh: balD.unmodeledLossKwh === null ? null : round3(balD.unmodeledLossKwh),
    solarDerate: Math.round(balD.solarDerate * 10000) / 10000,
    solarDerateCont: Math.round(balCont.solarDerate * 10000) / 10000,
    // Whether the closure actually closed. status stays 'ok' when it didn't: 'degraded' would
    // drop such days out of the headline set, and how often either refusal binds is
    // install-specific and not worth guessing at. Filter on these before quoting a low-pv
    // day's regret — solarDerate alone can't tell you, since 0.9 is also a legal value for a
    // genuinely lossy day.
    unclosedLossKwh: balD.unclosedLossKwh === null ? null : round3(balD.unclosedLossKwh),
    derateClamped: balD.derateClamped,
    closureSkippedLowPv: balD.closureSkippedLowPv,
    unclosedLossContKwh: balCont.unclosedLossKwh === null ? null : round3(balCont.unclosedLossKwh),
  };

  // Model-vs-meter accounting gap — the answer to "can the oracle confirmation-bias itself?".
  // The regret comparison prices the oracle and constrained trajectories with evaluateDispatch
  // on 15-min slot means, but the achieved side is the meter's own cash, so any arithmetic
  // divergence between those two bases lands inside regretIntraday and is indistinguishable
  // there from real, recoverable timing loss. Pricing the trajectory the battery ACTUALLY
  // followed on the MODEL's basis isolates it: this cash should equal achievedCashOre, and
  // whatever it doesn't is accounting rather than money.
  //
  // Two biases sit inside this and largely cancel: evaluateDispatch scores self-consumption as
  // min(slot-mean solar, slot-mean load), which overstates it against a reading-cadence meter
  // (on the reference install ~0.4 kWh/day, worth ~0.36 kr), while the energy-balance closure
  // above removes about as much solar back out. Measured there at +0.07 kr/day mean against a
  // 1.47 kr/day intraday regret, i.e. ~5%. Watch your own install's mean over a few weeks and
  // treat a DRIFT, not the level, as the alarm; if the level ever becomes a large fraction of
  // regretIntraday, that column is measuring arithmetic more than dispatch quality.
  diagnostics.accounting = {
    modelCashOre: round1(achievedModelCashOre),
    meterCashOre: round1(inputs.achievedCashOre),
    gapOre: round1(achievedModelCashOre - inputs.achievedCashOre),
  };

  const degraded =
    Math.min(actualsD.coverage, actualsCont.coverage) < MIN_READING_COVERAGE ||
    startSoc.spanMs > SOC_BOUNDARY_MAX_SPAN_MS ||
    endSoc.spanMs > SOC_BOUNDARY_MAX_SPAN_MS;
  const status: OracleDayStatus = degraded
    ? 'degraded'
    : armed.fraction < FULLY_ARMED
      ? 'shadow'
      : 'ok';

  return {
    ...base,
    status,
    startSocKwh: round3(startSoc.soc),
    achievedEndSocKwh: round3(endSoc.soc),
    oracleEndSocKwh: round3(oracleEndSoc),
    achievedCashOre: round1(inputs.achievedCashOre),
    achievedWearOre: round1(achievedWearOre),
    achievedContinuationOre: round1(achievedContinuationOre),
    achievedTotalOre: round1(achievedTotalOre),
    oracleDayCashOre: round1(oracleD.cashOre),
    oracleDayWearOre: round1(oracleD.wearOre),
    oracleTotalOre: round1(oracleTotalOre),
    regretOre: round1(regretOre),
    regretIntradayOre: regretIntradayOre !== null ? round1(regretIntradayOre) : null,
    regretCarryOre: regretCarryOre !== null ? round1(regretCarryOre) : null,
    oracleDispatchD: dispatch48.slice(0, nD),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
