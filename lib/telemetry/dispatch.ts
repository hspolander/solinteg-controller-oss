/**
 * Dispatch-loop-facing telemetry: `control_actions` (read, written by
 * scripts/services/dispatch_loop.py) and `optimizer_runs` (written here, read by the loop).
 */
import { getDb } from './core';
import type { OptimizerSlot, DispatchSlot } from '../optimizer';

/**
 * The exact figures behind a dispatch decision — dispatch_loop.py's `detail_json`
 * column (see deploy/schema.sql). Deliberately NOT parsed out of the human-readable
 * `detail` text (regex on a log sentence is fragile); both are built independently
 * from the same source numbers in Python. Every field is optional: a key is simply
 * absent when that particular check didn't run for this decision (e.g. solar-funding
 * numbers on a discharge row, or next-action fields on a non-idle row).
 */
export interface ControlActionDetail {
  buyOre?: number;
  sellOre?: number;
  solarShortfallKwh?: number;
  solarShortfallLimitKwh?: number;
  socDriftKwh?: number;
  socDriftLimitKwh?: number;
  gridKwh?: number; // discharge only: the plan's net grid exchange, +import/−export
  nextAction?: 'charge' | 'discharge';
  nextActionTime?: string;
}

export interface LatestControlAction {
  timestamp: string; // UTC ISO — when the dispatch loop logged this decision
  slotTime: string | null; // naive Stockholm local slot start, matches DispatchSlot.startTime
  plannedAction: 'charge' | 'discharge' | 'idle';
  powerW: number | null;
  armed: boolean;
  outcome: string; // 'applied' | 'skipped_divergence' | 'skipped_solar_shortfall' | 'error_reverted' | 'error_revert_failed'
  detail: string;
  detailJson: ControlActionDetail | null;
}

type ControlActionRow = {
  timestamp: string;
  slot_time: string | null;
  planned_action: string;
  power_w: number | null;
  armed: number;
  outcome: string;
  detail: string;
  detail_json: string | null;
};

function parseDetailJson(raw: string | null): ControlActionDetail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const detail: ControlActionDetail = {};
    if (typeof parsed.buy_ore === 'number') detail.buyOre = parsed.buy_ore;
    if (typeof parsed.sell_ore === 'number') detail.sellOre = parsed.sell_ore;
    if (typeof parsed.solar_shortfall_kwh === 'number') detail.solarShortfallKwh = parsed.solar_shortfall_kwh;
    if (typeof parsed.solar_shortfall_limit_kwh === 'number') detail.solarShortfallLimitKwh = parsed.solar_shortfall_limit_kwh;
    if (typeof parsed.soc_drift_kwh === 'number') detail.socDriftKwh = parsed.soc_drift_kwh;
    if (typeof parsed.soc_drift_limit_kwh === 'number') detail.socDriftLimitKwh = parsed.soc_drift_limit_kwh;
    if (typeof parsed.grid_kwh === 'number') detail.gridKwh = parsed.grid_kwh;
    if (parsed.next_action === 'charge' || parsed.next_action === 'discharge') detail.nextAction = parsed.next_action;
    if (typeof parsed.next_action_time === 'string') detail.nextActionTime = parsed.next_action_time;
    return detail;
  } catch {
    return null; // malformed JSON (shouldn't happen — Python always json.dumps a plain dict)
  }
}

function rowToControlAction(row: ControlActionRow): LatestControlAction {
  return {
    timestamp: row.timestamp,
    slotTime: row.slot_time,
    plannedAction: row.planned_action as LatestControlAction['plannedAction'],
    powerW: row.power_w,
    armed: row.armed === 1,
    outcome: row.outcome,
    detail: row.detail,
    detailJson: parseDetailJson(row.detail_json),
  };
}

/**
 * The last `limit` dispatch decisions, oldest first (most recent last), from
 * control_actions (written by scripts/services/dispatch_loop.py — see deploy/schema.sql). The
 * most recent entry is what the Dispatch card's "current" state is built from
 * (lib/dispatch-card.ts); the full list feeds its decision timeline. Returns [] if the
 * table doesn't exist yet (the service creates it on first run) or telemetry is off. No
 * staleness cutoff here unlike live.json: the loop only re-logs on a slot change or its
 * ~5 min reassert interval by design, so a few-minutes-old latest row is normal, not a
 * sign of trouble.
 */
export function readRecentControlActions(limit = 12): LatestControlAction[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(
        `SELECT timestamp, slot_time, planned_action, power_w, armed, outcome, detail, detail_json
         FROM control_actions ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit) as ControlActionRow[];
    return rows.map(rowToControlAction).reverse();
  } catch {
    return [];
  }
}

/**
 * Reconstructs the decision bands that were actually in force over the already-elapsed part of
 * `priceDate` — the live `dispatchSchedule` (lib/plan.ts) is sliced to start at "now" on every
 * render, so PriceChart's action bands (buildActionBands in lib/chart-utils.ts) only ever see
 * the forward-looking plan and past decisions vanish from the chart the moment they elapse.
 *
 * Every optimizer_runs row's dispatch_json itself starts at whatever slot was current when it
 * was logged (plan.ts slices from nowSlotIdx), so a run's first slot IS the exact boundary
 * where it superseded the previous one — no logged_at-vs-slot-time timezone conversion needed.
 * Runs are read oldest-first; each contributes its own slots up to (not including) the next
 * run's first slot. The newest row is deliberately excluded — it's the same plan already passed
 * to the chart as the live `dispatchSchedule` prop, so including it here would duplicate those
 * bands. Returns [] if telemetry is off, the table is empty, or there's no history yet (fewer
 * than two runs logged for this date).
 */
export function readPastDispatchSlots(priceDate: string): DispatchSlot[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare('SELECT dispatch_json FROM optimizer_runs WHERE price_date = ? ORDER BY id ASC')
      .all(priceDate) as { dispatch_json: string }[];
    const runs = rows
      .map((r) => JSON.parse(r.dispatch_json) as DispatchSlot[])
      .filter((d) => d.length > 0);
    const past: DispatchSlot[] = [];
    for (let i = 0; i < runs.length - 1; i++) {
      const cutoff = runs[i + 1][0].startTime;
      for (const slot of runs[i]) {
        if (slot.startTime >= cutoff) break;
        past.push(slot);
      }
    }
    return past;
  } catch {
    return [];
  }
}

/** JSON.stringify replacer: round every finite number to 3 decimals (Wh / milli-öre — far
 *  below any consumer's precision: forecast error is tens of percent, dispatch-loop guard
 *  thresholds are 0.5-3 kWh). Unrounded rows carried digits like
 *  `"consumptionKwh":0.20746110774818402` — 19 bytes where 5 carry all the meaning. The
 *  measured size saving is a modest ~15% (rows are mostly fixed JSON structure — timestamps,
 *  key names, provenance tags — not float digits); the real point is making consecutive runs
 *  byte-comparable for the dedup below (the trailing live-load profile drifts in the ~5th
 *  decimal every render, so unrounded payloads were never identical even when nothing
 *  meaningful changed). */
function roundForLog(_key: string, value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : value;
}

/** Record one optimizer execution: its inputs (forecast solar/load, start SoC) and output.
 *
 *  `socIsLive` is a publish gate: when live.json is missing/stale the page still computes and
 *  displays a plan (anchored to socKwhOrDefault's BATTERY_KWH/2 fallback), but that plan must
 *  never become a row — the dispatch loop takes the newest row as its authority, so publishing
 *  a fallback-anchored plan silently replaces a better one computed from a real SoC reading
 *  minutes earlier. Skipping keeps the last live-anchored plan in charge (its staleness is
 *  already bounded by the loop's SoC-divergence guard), and a dead poller is separately
 *  alerted via the healthcheck's live-data staleness rule, so the skip is never silent.
 *
 *  Deduplication (added 2026-07-19, with the 10-min timer cadence): if the newest row already
 *  carries byte-identical inputs/dispatch payloads for the same price date and horizon, skip
 *  the insert — colliding renders (timer + replan POST + open tab) and quiet 10-min ticks
 *  otherwise append identical rows minutes or seconds apart. start_soc_kwh is
 *  deliberately NOT part of the comparison: the SoC reading moves a few Wh between renders,
 *  but when the DP still snaps it to the same grid level the resulting plan — everything the
 *  dispatch loop and the forecast-vs-actual analyses consume — is unchanged, and keeping the
 *  previous row in charge is exactly equivalent. */
export function logOptimizerRun(
  priceDate: string,
  hasTomorrow: boolean,
  startSocKwh: number,
  inputs: OptimizerSlot[],
  dispatch: DispatchSlot[],
  socIsLive: boolean,
): void {
  const handle = getDb();
  if (!handle) return;
  if (!socIsLive) {
    console.error(
      'logOptimizerRun skipped: live.json missing/stale, plan is anchored to the fallback SoC — not published to optimizer_runs',
    );
    return;
  }
  try {
    const inputsJson = JSON.stringify(inputs, roundForLog);
    const dispatchJson = JSON.stringify(dispatch, roundForLog);
    const prev = handle
      .prepare(
        `SELECT price_date, has_tomorrow, inputs_json, dispatch_json
         FROM optimizer_runs ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | { price_date: string; has_tomorrow: number; inputs_json: string; dispatch_json: string }
      | undefined;
    if (
      prev &&
      prev.price_date === priceDate &&
      prev.has_tomorrow === (hasTomorrow ? 1 : 0) &&
      prev.inputs_json === inputsJson &&
      prev.dispatch_json === dispatchJson
    ) {
      return; // unchanged plan — the existing newest row stays in charge
    }
    handle
      .prepare(
        `INSERT INTO optimizer_runs
           (logged_at, price_date, has_tomorrow, start_soc_kwh, inputs_json, dispatch_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), priceDate, hasTomorrow ? 1 : 0, startSocKwh, inputsJson, dispatchJson);
  } catch (err) {
    // Best-effort (see readings.ts's logPriceSnapshot) — logged so a silent failure here
    // isn't invisible too.
    console.error('logOptimizerRun failed:', err);
  }
}
