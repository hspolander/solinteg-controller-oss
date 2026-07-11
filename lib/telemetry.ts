/**
 * Decision-side telemetry — the price curves and optimizer runs the web app sees.
 *
 * Written to the same SQLite file the Python poller appends inverter readings to
 * ($TELEMETRY_DB_PATH, default /opt/solinteg/telemetry.db). This module writes two of the
 * five tables (canonical schema: deploy/schema.sql):
 *   price_snapshots  — the daily price curve the optimizer planned against
 *   optimizer_runs   — optimizer inputs (forecast solar/load, start SoC) + dispatch output
 * The other three are written elsewhere: readings (scripts/modbus_poller.py), weather
 * (scripts/weather_poller.py), control_actions (scripts/dispatch_loop.py).
 *
 * Joining optimizer_runs (forecast) against readings (actual) by timestamp is the
 * forecast-vs-actual feedback loop described in DESIGN-reserve.md.
 *
 * Everything here is best-effort: a telemetry failure must never break a page render.
 * When TELEMETRY_DB_PATH is unset (local dev, `next build`, tests) this is a no-op, so
 * nothing touches SQLite outside the NUC.
 */
import { DatabaseSync } from 'node:sqlite';
import { stockholmParts, stockholmToUtc } from './prices';
import type { PriceData, PriceSlot } from './prices';
import type { OptimizerSlot, DispatchSlot } from './optimizer';
import type { OracleReadingRow, ArmedEventRow, OracleDayRow } from './oracle';
import {
  computeDailyEconomics,
  mergeDailyEconomics,
  priceSlotsToMap,
  stockholmDateOf,
  stockholmSlotKey,
  type EconReading,
  type EconTotals,
  type PriceLookup,
} from './economics';

const DB_PATH = process.env.TELEMETRY_DB_PATH;

let db: DatabaseSync | null = null;
let initFailed = false;

function getDb(): DatabaseSync | null {
  if (!DB_PATH || initFailed) return null;
  if (db) return db;
  try {
    const handle = new DatabaseSync(DB_PATH);
    handle.exec('PRAGMA journal_mode=WAL'); // concurrent access with the Python poller
    handle.exec('PRAGMA busy_timeout=5000');
    // Canonical schema for all telemetry.db tables: deploy/schema.sql — keep this in sync.
    handle.exec(`
      CREATE TABLE IF NOT EXISTS price_snapshots (
        date         TEXT PRIMARY KEY,  -- Stockholm 'today'; row holds today+tomorrow slots
        logged_at    TEXT NOT NULL,
        has_tomorrow INTEGER NOT NULL,
        prices_json  TEXT NOT NULL       -- PriceData.prices: buy/sell per 15-min slot
      )
    `);
    handle.exec(`
      CREATE TABLE IF NOT EXISTS optimizer_runs (
        id            INTEGER PRIMARY KEY,
        logged_at     TEXT NOT NULL,
        price_date    TEXT NOT NULL,     -- links to price_snapshots.date
        has_tomorrow  INTEGER NOT NULL,
        start_soc_kwh REAL NOT NULL,
        inputs_json   TEXT NOT NULL,     -- OptimizerSlot[]: buy, sell, solarKwh, consumptionKwh
        dispatch_json TEXT NOT NULL      -- DispatchSlot[]: action, gridKwh, socAfter per slot
      )
    `);
    handle.exec('CREATE INDEX IF NOT EXISTS idx_runs_date ON optimizer_runs(price_date)');
    handle.exec(`
      CREATE TABLE IF NOT EXISTS oracle_daily (
        date                      TEXT PRIMARY KEY,  -- Stockholm day D being scored
        computed_at               TEXT NOT NULL,
        status                    TEXT NOT NULL,     -- 'ok'|'shadow'|'degraded'|'skipped_no_readings'
        armed_fraction            REAL,
        reading_coverage          REAL,
        start_soc_kwh             REAL,
        achieved_end_soc_kwh      REAL,
        oracle_end_soc_kwh        REAL,
        baseline_net_ore          REAL,
        achieved_cash_ore         REAL,
        achieved_wear_ore         REAL,
        achieved_continuation_ore REAL,
        achieved_total_ore        REAL,
        oracle_day_cash_ore       REAL,
        oracle_day_wear_ore       REAL,
        oracle_total_ore          REAL,
        regret_ore                REAL,
        regret_intraday_ore       REAL,
        regret_carry_ore          REAL,
        params_json               TEXT NOT NULL,
        oracle_dispatch_json      TEXT,
        diagnostics_json          TEXT
      )
    `);
    db = handle;
    return db;
  } catch {
    initFailed = true; // stop retrying every render once it's clear the DB is unusable
    return null;
  }
}

/**
 * Record the price curve as the optimizer saw it. Upsert keyed on date: the last write
 * of the day wins, so the post-13:00 snapshot (today + tomorrow) supersedes the morning's
 * today-only one.
 */
export function logPriceSnapshot(data: PriceData): void {
  const handle = getDb();
  if (!handle) return;
  try {
    handle
      .prepare(
        `INSERT INTO price_snapshots (date, logged_at, has_tomorrow, prices_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           logged_at = excluded.logged_at,
           has_tomorrow = excluded.has_tomorrow,
           prices_json = excluded.prices_json`,
      )
      .run(
        data.today,
        new Date().toISOString(),
        data.hasTomorrow ? 1 : 0,
        JSON.stringify(data.prices),
      );
  } catch (err) {
    // Best-effort (a telemetry failure must never break the page), but silently swallowing
    // this previously hid a real bug: this write failed for ~7 hours overnight 2026-07-02/03
    // while logOptimizerRun kept succeeding every hour on the same data, and there was no way
    // to tell why. Logged now so a recurrence shows up in journalctl instead of vanishing.
    console.error('logPriceSnapshot failed:', err);
  }
}

/**
 * Poller readings, oldest first, optionally restricted to a UTC timestamp range
 * (sinceIso inclusive, beforeIso exclusive — both compared as ISO strings, which sort
 * chronologically for the poller's UTC timestamps). Returns [] if telemetry is off or the
 * `readings` table doesn't exist yet (the poller creates it on its first successful poll).
 */
export function readReadings(sinceIso?: string, beforeIso?: string): EconReading[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (sinceIso) {
      where.push('timestamp >= ?');
      params.push(sinceIso);
    }
    if (beforeIso) {
      where.push('timestamp < ?');
      params.push(beforeIso);
    }
    const sql =
      'SELECT timestamp, grid_w FROM readings' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY timestamp';
    return handle.prepare(sql).all(...params) as unknown as EconReading[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

// buildPriceLookup parses every logged snapshot's JSON (one row per day, ~20 kB each), which
// grows without bound. A day's prices never change once published (day-ahead market), so the
// parsed map is cached and only rebuilt when the newest snapshot's identity changes: a new
// date (first render after midnight, or a late first snapshot after a prices outage) or its
// has_tomorrow flip (the ~13:00 release adding tomorrow's slots).
let priceLookupCache: PriceLookup | null = null;
let priceLookupKey: string | null = null;

/** A price lookup over all logged snapshots: UTC instant → that 15-min slot's buy/sell price. */
export function buildPriceLookup(): PriceLookup {
  const handle = getDb();
  if (!handle) return () => null;
  try {
    const newest = handle
      .prepare('SELECT date, has_tomorrow FROM price_snapshots ORDER BY date DESC LIMIT 1')
      .get() as { date: string; has_tomorrow: number } | undefined;
    const key = newest ? `${newest.date}:${newest.has_tomorrow}` : 'empty';
    if (priceLookupCache && key === priceLookupKey) return priceLookupCache;

    const rows = handle.prepare('SELECT prices_json FROM price_snapshots').all() as {
      prices_json: string;
    }[];
    const map = priceSlotsToMap(rows.flatMap((r) => JSON.parse(r.prices_json) as PriceSlot[]));
    priceLookupCache = (timestampUtc: string) => map.get(stockholmSlotKey(timestampUtc)) ?? null;
    priceLookupKey = key;
    return priceLookupCache;
  } catch {
    return () => null;
  }
}

// Per-day economics for fully elapsed Stockholm days, cached per process. Readings are
// append-only with now-timestamps and past days' prices are fixed, so days before today
// never change — recomputing them on every render made rendering O(all readings ever)
// (~1M rows/year at one reading per 30 s). The cache is rebuilt once per Stockholm day
// (and on process restart); per render only today's readings are read.
let frozenDaily: Map<string, EconTotals> | null = null;
let frozenBoundaryIso: string | null = null;
let frozenForDate: string | null = null;

/**
 * Daily buy/sell economics over all logged readings, split at (approximately) today's
 * Stockholm midnight: everything before it comes from the per-day cache above, only
 * readings after it are read and valued per call. The boundary uses the CURRENT UTC
 * offset, so on a DST transition day it can be an hour off real midnight — harmless,
 * because days are bucketed by true Stockholm date in both passes and a date landing in
 * both is summed by mergeDailyEconomics, never overwritten. The one reading straddling
 * the boundary is valued at defaultIntervalMs instead of its real successor gap (≤60 s
 * of one reading per day — noise).
 */
export function readDailyEconomics(now: Date = new Date()): Map<string, EconTotals> {
  const handle = getDb();
  if (!handle) return new Map();
  try {
    const today = stockholmDateOf(now.toISOString());
    if (frozenDaily === null || frozenForDate !== today) {
      const p = stockholmParts(now);
      const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
      frozenDaily = computeDailyEconomics(readReadings(undefined, boundary), buildPriceLookup());
      frozenBoundaryIso = boundary;
      frozenForDate = today;
    }
    const live = computeDailyEconomics(readReadings(frozenBoundaryIso!), buildPriceLookup());
    return mergeDailyEconomics(frozenDaily, live);
  } catch {
    return new Map();
  }
}

/**
 * Today's poller readings (Stockholm calendar day), timestamp + soc_pct only — the raw
 * material for the chart's "actual" SoC line. Bounded to today for the same reason
 * readDailyEconomics bounds its live pass: readings are append-only, so an unbounded scan
 * grows without limit as the deployment ages.
 */
export function readTodaySocHistory(now: Date = new Date()): { timestamp: string; soc_pct: number }[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const p = stockholmParts(now);
    const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
    return handle
      .prepare('SELECT timestamp, soc_pct FROM readings WHERE timestamp >= ? ORDER BY timestamp')
      .all(boundary) as unknown as { timestamp: string; soc_pct: number }[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

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
 * control_actions (written by scripts/dispatch_loop.py — see deploy/schema.sql). The
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
 * One scored day from oracle_daily, as the dashboard's Facit card consumes it
 * (lib/oracle-card.ts). Money fields are öre; regret splits can be NULL when the
 * terminal-constrained DP was infeasible for that day (see deploy/schema.sql).
 */
export interface OracleDaySummaryRow {
  date: string; // Stockholm day D
  status: string; // 'ok' | 'shadow' | 'degraded' | 'skipped_no_readings'
  armedFraction: number | null;
  regretOre: number | null;
  regretIntradayOre: number | null;
  regretCarryOre: number | null;
  achievedTotalOre: number | null;
  oracleTotalOre: number | null;
  baselineNetOre: number | null;
}

/**
 * The last `limit` scored days from oracle_daily, oldest first (most recent last) —
 * feeds the dashboard's Facit card. All statuses are returned (the card renders
 * non-'ok' days muted rather than hiding them); returns [] if the table doesn't
 * exist yet (first sweep hasn't run) or telemetry is off.
 */
export function readRecentOracleDays(limit = 14): OracleDaySummaryRow[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(
        `SELECT date, status, armed_fraction, regret_ore, regret_intraday_ore,
                regret_carry_ore, achieved_total_ore, oracle_total_ore, baseline_net_ore
         FROM oracle_daily ORDER BY date DESC LIMIT ?`,
      )
      .all(limit) as {
      date: string;
      status: string;
      armed_fraction: number | null;
      regret_ore: number | null;
      regret_intraday_ore: number | null;
      regret_carry_ore: number | null;
      achieved_total_ore: number | null;
      oracle_total_ore: number | null;
      baseline_net_ore: number | null;
    }[];
    return rows
      .map((r) => ({
        date: r.date,
        status: r.status,
        armedFraction: r.armed_fraction,
        regretOre: r.regret_ore,
        regretIntradayOre: r.regret_intraday_ore,
        regretCarryOre: r.regret_carry_ore,
        achievedTotalOre: r.achieved_total_ore,
        oracleTotalOre: r.oracle_total_ore,
        baselineNetOre: r.baseline_net_ore,
      }))
      .reverse();
  } catch {
    return [];
  }
}

// ── Hindsight-oracle wiring (lib/oracle.ts computes, app/api/oracle/route.ts orchestrates) ──

/** Full poller rows for oracle scoring, oldest first, UTC ISO range [sinceIso, beforeIso). */
export function readOracleReadings(sinceIso: string, beforeIso: string): OracleReadingRow[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    return handle
      .prepare(
        `SELECT timestamp, pv_w, house_load_w, soc_kwh, grid_w
         FROM readings WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
      )
      .all(sinceIso, beforeIso) as unknown as OracleReadingRow[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

/** One day's logged price curve; prices holds that day's slots + tomorrow's when has_tomorrow. */
export function readPriceSnapshot(date: string): { hasTomorrow: boolean; prices: PriceSlot[] } | null {
  const handle = getDb();
  if (!handle) return null;
  try {
    const row = handle
      .prepare('SELECT has_tomorrow, prices_json FROM price_snapshots WHERE date = ?')
      .get(date) as { has_tomorrow: number; prices_json: string } | undefined;
    if (!row) return null;
    return { hasTomorrow: row.has_tomorrow === 1, prices: JSON.parse(row.prices_json) as PriceSlot[] };
  } catch {
    return null;
  }
}

/** Dispatch-loop decisions (armed flag + outcome) in a UTC range, for armed-coverage scoring. */
export function readArmedEvents(sinceIso: string, beforeIso: string): ArmedEventRow[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    return handle
      .prepare(
        `SELECT timestamp, armed, outcome
         FROM control_actions WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
      )
      .all(sinceIso, beforeIso) as unknown as ArmedEventRow[];
  } catch {
    return []; // table absent (dispatch loop never ran) or unreadable
  }
}

/** Dates that already have an oracle_daily row, within [sinceDate, beforeDate) — for the
 *  nightly sweep to skip. Statuses are returned so callers can distinguish a scored day from
 *  one recorded as unscorable. */
export function readOracleDates(sinceDate: string, beforeDate: string): Map<string, string> {
  const handle = getDb();
  if (!handle) return new Map();
  try {
    const rows = handle
      .prepare('SELECT date, status FROM oracle_daily WHERE date >= ? AND date < ?')
      .all(sinceDate, beforeDate) as { date: string; status: string }[];
    return new Map(rows.map((r) => [r.date, r.status]));
  } catch {
    return new Map();
  }
}

/** Upsert one scored day. Returns false when telemetry is off or the write failed. */
export function upsertOracleDaily(row: OracleDayRow): boolean {
  const handle = getDb();
  if (!handle) return false;
  try {
    handle
      .prepare(
        `INSERT INTO oracle_daily (
           date, computed_at, status, armed_fraction, reading_coverage,
           start_soc_kwh, achieved_end_soc_kwh, oracle_end_soc_kwh,
           baseline_net_ore, achieved_cash_ore, achieved_wear_ore,
           achieved_continuation_ore, achieved_total_ore,
           oracle_day_cash_ore, oracle_day_wear_ore, oracle_total_ore,
           regret_ore, regret_intraday_ore, regret_carry_ore,
           params_json, oracle_dispatch_json, diagnostics_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           computed_at = excluded.computed_at,
           status = excluded.status,
           armed_fraction = excluded.armed_fraction,
           reading_coverage = excluded.reading_coverage,
           start_soc_kwh = excluded.start_soc_kwh,
           achieved_end_soc_kwh = excluded.achieved_end_soc_kwh,
           oracle_end_soc_kwh = excluded.oracle_end_soc_kwh,
           baseline_net_ore = excluded.baseline_net_ore,
           achieved_cash_ore = excluded.achieved_cash_ore,
           achieved_wear_ore = excluded.achieved_wear_ore,
           achieved_continuation_ore = excluded.achieved_continuation_ore,
           achieved_total_ore = excluded.achieved_total_ore,
           oracle_day_cash_ore = excluded.oracle_day_cash_ore,
           oracle_day_wear_ore = excluded.oracle_day_wear_ore,
           oracle_total_ore = excluded.oracle_total_ore,
           regret_ore = excluded.regret_ore,
           regret_intraday_ore = excluded.regret_intraday_ore,
           regret_carry_ore = excluded.regret_carry_ore,
           params_json = excluded.params_json,
           oracle_dispatch_json = excluded.oracle_dispatch_json,
           diagnostics_json = excluded.diagnostics_json`,
      )
      .run(
        row.date,
        new Date().toISOString(),
        row.status,
        row.armedFraction,
        row.readingCoverage,
        row.startSocKwh,
        row.achievedEndSocKwh,
        row.oracleEndSocKwh,
        row.baselineNetOre,
        row.achievedCashOre,
        row.achievedWearOre,
        row.achievedContinuationOre,
        row.achievedTotalOre,
        row.oracleDayCashOre,
        row.oracleDayWearOre,
        row.oracleTotalOre,
        row.regretOre,
        row.regretIntradayOre,
        row.regretCarryOre,
        JSON.stringify(row.params),
        row.oracleDispatchD ? JSON.stringify(row.oracleDispatchD) : null,
        JSON.stringify(row.diagnostics),
      );
    return true;
  } catch (err) {
    console.error('upsertOracleDaily failed:', err); // same visibility rule as logPriceSnapshot
    return false;
  }
}

/** Record one optimizer execution: its inputs (forecast solar/load, start SoC) and output. */
export function logOptimizerRun(
  priceDate: string,
  hasTomorrow: boolean,
  startSocKwh: number,
  inputs: OptimizerSlot[],
  dispatch: DispatchSlot[],
): void {
  const handle = getDb();
  if (!handle) return;
  try {
    handle
      .prepare(
        `INSERT INTO optimizer_runs
           (logged_at, price_date, has_tomorrow, start_soc_kwh, inputs_json, dispatch_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        priceDate,
        hasTomorrow ? 1 : 0,
        startSocKwh,
        JSON.stringify(inputs),
        JSON.stringify(dispatch),
      );
  } catch (err) {
    // Best-effort (see logPriceSnapshot) — logged so a silent failure here isn't invisible too.
    console.error('logOptimizerRun failed:', err);
  }
}
