/**
 * Shared telemetry.db connection for every lib/telemetry/* submodule.
 *
 * Written to the same SQLite file the Python poller appends inverter readings to
 * ($TELEMETRY_DB_PATH, default /opt/solinteg/telemetry.db). This module (getDb, called from
 * every sibling file) creates the three tables the web app itself writes (canonical schema:
 * deploy/schema.sql):
 *   price_snapshots  — the daily price curve the optimizer planned against
 *   optimizer_runs   — optimizer inputs (forecast solar/load, start SoC) + dispatch output
 *   oracle_daily     — nightly hindsight-oracle day scores (upsertOracleDaily, via /api/oracle)
 * The rest are written by the Python services under scripts/services/: readings
 * (modbus_poller.py), weather (weather_poller.py), control_actions (dispatch_loop.py).
 *
 * Everything reading/writing through getDb() is best-effort: a telemetry failure must never
 * break a page render. When TELEMETRY_DB_PATH is unset (local dev, `next build`, tests) this
 * is a no-op, so nothing touches SQLite outside the NUC.
 */
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.TELEMETRY_DB_PATH;

let db: DatabaseSync | null = null;
let initFailed = false;

export function getDb(): DatabaseSync | null {
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
