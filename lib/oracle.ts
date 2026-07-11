/**
 * Hindsight-optimal ("oracle") dispatch scoring.
 *
 * For each completed day D this computes what a dispatcher with perfect information could have
 * earned, next to what the system actually earned, on one identical accounting basis. Pure
 * module — no I/O. The DB reads/writes live in lib/telemetry.ts, the per-day orchestration in
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

// ── Input row shapes (as read from telemetry.db by lib/telemetry.ts) ─────────────────────────

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
  for (let i = 1; i <= nD; i++) {
    const b = socAtInstant(soc, dayStartMs + i * SLOT_MS);
    if (b) {
      achievedWearOre += BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(b.soc - prevSoc);
      prevSoc = b.soc;
    }
  }

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

  // Day-D energy-balance residual: pv + import − load − export − ΔSoC. Systematically nonzero
  // ⇒ the model's physics (DC-side pv_w, RT_EFF, derived load) drift from the real meter —
  // exactly the case where small negative regrets stop being noise. In kWh and as a fraction
  // of throughput.
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const pvD = sum(actualsD.solarKwh);
  const impD = sum(actualsD.importKwh);
  const loadD = sum(actualsD.loadKwh);
  const expD = sum(actualsD.exportKwh);
  const residualKwh = pvD + impD - loadD - expD - (endSoc.soc - startSoc.soc);
  diagnostics.balance = {
    pvKwh: round3(pvD),
    importKwh: round3(impD),
    loadKwh: round3(loadD),
    exportKwh: round3(expD),
    deltaSocKwh: round3(endSoc.soc - startSoc.soc),
    residualKwh: round3(residualKwh),
    residualFrac: pvD + impD > 0 ? round3(residualKwh / (pvD + impD)) : null,
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
