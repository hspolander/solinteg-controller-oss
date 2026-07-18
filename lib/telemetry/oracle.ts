/**
 * Hindsight-oracle wiring: everything app/api/oracle/route.ts needs to score a day
 * (lib/oracle.ts computes; this module reads the inputs and upserts the result into
 * `oracle_daily`) plus the summary rows the dashboard's Facit card reads back
 * (lib/oracle-card.ts).
 */
import { getDb } from './core';
import type { PriceSlot } from '../prices';
import type { OracleReadingRow, ArmedEventRow, OracleDayRow } from '../oracle';

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
    console.error('upsertOracleDaily failed:', err); // same visibility rule as readings.ts's logPriceSnapshot
    return false;
  }
}
