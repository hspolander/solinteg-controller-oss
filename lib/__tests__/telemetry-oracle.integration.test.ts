/**
 * Integration tests for lib/telemetry/oracle.ts against a real temp SQLite database — the same pattern as telemetry-economics/actual-flows.
 *
 * Why (added 2026-08-09): the file was at flat 0% coverage. `upsertOracleDaily` in
 * particular had never been executed by a test despite being what PERSISTS every hindsight
 * score — a broken column list there fails at runtime on the NUC, nightly, into a `catch` that
 * logs and moves on, so the scoring card would simply stop gaining days without anything
 * saying why.
 *
 * These also pin the readOrFallback refactor (2026-08-07): every reader must degrade to its
 * fallback when its table is ABSENT, which is the normal state on a fresh install where the
 * poller or the nightly job has never run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { OracleDayRow } from '../oracle';

// Unique per run — see telemetry-economics.integration.test.ts for why a recycled path can
// inherit stale tables on Windows.
const DB_PATH = join(tmpdir(), `telemetry-oracle-test-${process.pid}-${Date.now()}.db`);
process.env.TELEMETRY_DB_PATH = DB_PATH;

let telemetry: typeof import('../telemetry');

const PARAMS = { batteryKwh: 25.6, rtEff: 0.96 };
const DIAGNOSTICS = { coverageD: 1, balance: { residualKwh: 1.4 } };

function oracleRow(date: string, over: Partial<OracleDayRow> = {}): OracleDayRow {
  return {
    date,
    status: 'ok',
    armedFraction: 0.99,
    readingCoverage: 1,
    startSocKwh: 12.8,
    achievedEndSocKwh: 20.1,
    oracleEndSocKwh: 21.0,
    baselineNetOre: -200,
    achievedCashOre: 950,
    achievedWearOre: 37,
    achievedContinuationOre: 0,
    achievedTotalOre: 913,
    oracleDayCashOre: 1030,
    oracleDayWearOre: 30,
    oracleTotalOre: 1000,
    regretOre: 87,
    regretIntradayOre: 40,
    regretCarryOre: 47,
    params: PARAMS,
    oracleDispatchD: null,
    diagnostics: DIAGNOSTICS,
    ...over,
  } as OracleDayRow;
}

beforeAll(async () => {
  telemetry = await import('../telemetry');

  const db = new DatabaseSync(DB_PATH);

  // oracle_daily is created by lib/telemetry/core.ts's own bootstrap on first getDb(), so it
  // is deliberately NOT created here — upsertOracleDaily writing into that bootstrapped table
  // is part of what these tests cover.

  db.exec(`CREATE TABLE readings (
    id INTEGER PRIMARY KEY, timestamp TEXT, soc_pct REAL, soc_kwh REAL,
    pv_w INTEGER, grid_w INTEGER, battery_w INTEGER, inverter_ac_w INTEGER,
    house_load_w INTEGER, work_mode TEXT, work_mode_raw INTEGER)`);
  const insReading = db.prepare(
    'INSERT INTO readings (timestamp, pv_w, house_load_w, soc_kwh, grid_w) VALUES (?, ?, ?, ?, ?)',
  );
  insReading.run('2026-06-27T23:59:00.000Z', 0, 400, 12.0, -400); // before the window
  insReading.run('2026-06-28T00:00:00.000Z', 0, 500, 12.8, -500); // inclusive lower bound
  insReading.run('2026-06-28T12:00:00.000Z', 6000, 800, 20.0, 5200);
  insReading.run('2026-06-29T00:00:00.000Z', 0, 600, 20.1, -600); // exclusive upper bound

  db.exec(`CREATE TABLE control_actions (
    id INTEGER PRIMARY KEY, timestamp TEXT, slot_time TEXT, planned_action TEXT,
    power_w INTEGER, armed INTEGER, outcome TEXT, detail TEXT, detail_json TEXT)`);
  const insAction = db.prepare(
    `INSERT INTO control_actions (timestamp, slot_time, planned_action, power_w, armed, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insAction.run('2026-06-27T23:00:00.000Z', null, 'idle', 0, 1, 'applied', '');
  insAction.run('2026-06-28T06:00:00.000Z', null, 'charge', 3000, 1, 'applied', '');
  insAction.run('2026-06-28T18:00:00.000Z', null, 'discharge', 2000, 0, 'applied', '');
  insAction.run('2026-06-29T06:00:00.000Z', null, 'idle', 0, 1, 'applied', ''); // past the window

  db.exec(`CREATE TABLE price_snapshots (
    date TEXT PRIMARY KEY, logged_at TEXT, has_tomorrow INTEGER, prices_json TEXT)`);
  const insSnap = db.prepare(
    'INSERT INTO price_snapshots (date, logged_at, has_tomorrow, prices_json) VALUES (?, ?, ?, ?)',
  );
  insSnap.run('2026-06-28', '2026-06-28T13:30:00.000Z', 1, JSON.stringify([
    { startTime: '2026-06-28T00:00:00', price: 10, priceIncludingTaxAndSurcharge: 50 },
    { startTime: '2026-06-29T00:00:00', price: 12, priceIncludingTaxAndSurcharge: 55 },
  ]));
  insSnap.run('2026-06-27', '2026-06-27T09:00:00.000Z', 0, JSON.stringify([
    { startTime: '2026-06-27T00:00:00', price: 8, priceIncludingTaxAndSurcharge: 45 },
  ]));

  db.close();
});

afterAll(() => {
  try {
    rmSync(DB_PATH, { force: true });
  } catch {
    // Windows keeps the module-level handle open; a stale temp file is harmless.
  }
});

describe('readOracleReadings', () => {
  it('returns the half-open range [since, before)', () => {
    const rows = telemetry.readOracleReadings('2026-06-28T00:00:00.000Z', '2026-06-29T00:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[0].timestamp).toBe('2026-06-28T00:00:00.000Z'); // lower bound included
    expect(rows[1].timestamp).toBe('2026-06-28T12:00:00.000Z'); // upper bound excluded
  });

  it('returns rows oldest first, as the bucketing depends on', () => {
    const rows = telemetry.readOracleReadings('2026-06-27T00:00:00.000Z', '2026-06-30T00:00:00.000Z');
    const stamps = rows.map((r) => r.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('carries the fields the oracle scores from', () => {
    const [row] = telemetry.readOracleReadings('2026-06-28T12:00:00.000Z', '2026-06-28T12:00:01.000Z');
    expect(row).toMatchObject({ pv_w: 6000, house_load_w: 800, soc_kwh: 20.0, grid_w: 5200 });
  });
});

describe('readArmedEvents', () => {
  it('returns the half-open range, oldest first', () => {
    const rows = telemetry.readArmedEvents('2026-06-28T00:00:00.000Z', '2026-06-29T00:00:00.000Z');
    expect(rows.map((r) => r.timestamp)).toEqual([
      '2026-06-28T06:00:00.000Z',
      '2026-06-28T18:00:00.000Z',
    ]);
  });

  it('preserves the armed flag as the 0/1 the coverage maths expects', () => {
    const rows = telemetry.readArmedEvents('2026-06-28T00:00:00.000Z', '2026-06-29T00:00:00.000Z');
    expect(rows.map((r) => r.armed)).toEqual([1, 0]);
  });
});

describe('readPriceSnapshot', () => {
  it('parses prices_json and maps has_tomorrow to a boolean', () => {
    const snap = telemetry.readPriceSnapshot('2026-06-28');
    expect(snap?.hasTomorrow).toBe(true);
    expect(snap?.prices).toHaveLength(2);
    expect(snap?.prices[0].startTime).toBe('2026-06-28T00:00:00');
  });

  it('maps has_tomorrow 0 to false', () => {
    expect(telemetry.readPriceSnapshot('2026-06-27')?.hasTomorrow).toBe(false);
  });

  it('returns null for a date with no snapshot', () => {
    expect(telemetry.readPriceSnapshot('2020-01-01')).toBeNull();
  });
});

describe('upsertOracleDaily / readOracleDates / readRecentOracleDays', () => {
  it('writes a row and reports success', () => {
    expect(telemetry.upsertOracleDaily(oracleRow('2026-06-28'))).toBe(true);
  });

  it('round-trips every scored figure through the column list', () => {
    // The whole point: a column-list/bind-order mismatch would land regret in the wrong column
    // and still "succeed". Reading it back is the only thing that catches that.
    telemetry.upsertOracleDaily(oracleRow('2026-06-20', { regretOre: 123, armedFraction: 0.5 }));
    const [row] = telemetry.readRecentOracleDays(50).filter((r) => r.date === '2026-06-20');
    expect(row).toMatchObject({
      date: '2026-06-20',
      status: 'ok',
      regretOre: 123,
      regretIntradayOre: 40,
      regretCarryOre: 47,
      achievedTotalOre: 913,
      oracleTotalOre: 1000,
      baselineNetOre: -200,
      armedFraction: 0.5,
    });
  });

  it('upserts on date — rescoring replaces rather than duplicating', () => {
    telemetry.upsertOracleDaily(oracleRow('2026-06-21', { regretOre: 1 }));
    telemetry.upsertOracleDaily(oracleRow('2026-06-21', { regretOre: 999, status: 'degraded' }));
    const matches = telemetry.readRecentOracleDays(50).filter((r) => r.date === '2026-06-21');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ regretOre: 999, status: 'degraded' });
  });

  it('readOracleDates returns the half-open range as date -> status', () => {
    telemetry.upsertOracleDaily(oracleRow('2026-06-22', { status: 'shadow' }));
    const dates = telemetry.readOracleDates('2026-06-20', '2026-06-22');
    expect(dates.get('2026-06-20')).toBe('ok');
    expect(dates.get('2026-06-21')).toBe('degraded');
    expect(dates.has('2026-06-22')).toBe(false); // upper bound excluded
  });

  it('readRecentOracleDays returns oldest first, so the card charts left to right', () => {
    const rows = telemetry.readRecentOracleDays(50);
    const dates = rows.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('readRecentOracleDays honours its limit, keeping the NEWEST days', () => {
    const rows = telemetry.readRecentOracleDays(2);
    expect(rows).toHaveLength(2);
    expect(rows[rows.length - 1].date).toBe('2026-06-28'); // newest present
  });
});

describe('missing tables degrade to the fallback (fresh install, poller never ran)', () => {
  it('every reader returns its empty value instead of throwing', async () => {
    const emptyPath = join(tmpdir(), `telemetry-empty-${process.pid}-${Date.now()}.db`);
    const prev = process.env.TELEMETRY_DB_PATH;
    process.env.TELEMETRY_DB_PATH = emptyPath;
    vi.resetModules();
    const fresh = await import('../telemetry');

    expect(fresh.readOracleReadings('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toEqual([]);
    expect(fresh.readArmedEvents('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toEqual([]);
    expect(fresh.readRecentOracleDays()).toEqual([]);
    expect(fresh.readOracleDates('2026-01-01', '2026-01-02')).toEqual(new Map());
    expect(fresh.readPriceSnapshot('2026-01-01')).toBeNull();

    process.env.TELEMETRY_DB_PATH = prev;
    vi.resetModules();
    try {
      rmSync(emptyPath, { force: true });
    } catch {
      // as above
    }
  });
});
