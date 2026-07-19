import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// See telemetry-economics.integration.test.ts for why the DB path must be unique per run
// (module-level DatabaseSync handle stays open through afterAll, so a recycled path can inherit
// stale tables on Windows where rmSync silently fails while the handle is open).
const DB_PATH = join(tmpdir(), `telemetry-actual-flows-test-${process.pid}-${Date.now()}.db`);
process.env.TELEMETRY_DB_PATH = DB_PATH;

let telemetry: typeof import('../telemetry');

beforeAll(async () => {
  telemetry = await import('../telemetry');

  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE readings (
    id INTEGER PRIMARY KEY, timestamp TEXT, soc_pct REAL, soc_kwh REAL,
    pv_w INTEGER, grid_w INTEGER, battery_w INTEGER, inverter_ac_w INTEGER,
    house_load_w INTEGER, work_mode TEXT, work_mode_raw INTEGER)`);
  const insReading = db.prepare(
    'INSERT INTO readings (timestamp, pv_w, house_load_w, battery_w) VALUES (?, ?, ?, ?)',
  );
  insReading.run('2026-06-28T10:00:00.000Z', 0, 500, -2000); // charging, some load
  insReading.run('2026-06-28T10:05:00.000Z', 0, 500, -2000);

  db.exec(`CREATE TABLE control_actions (
    id INTEGER PRIMARY KEY, timestamp TEXT, slot_time TEXT, planned_action TEXT,
    power_w INTEGER, armed INTEGER, outcome TEXT, detail TEXT, detail_json TEXT)`);
  const insAction = db.prepare(
    `INSERT INTO control_actions (timestamp, slot_time, planned_action, power_w, armed, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Same slot, multiple ticks: two skipped_solar_shortfall (dedupe to one), then applied
  // (excluded), plus a row for a DIFFERENT day (must not leak into '2026-06-28' results).
  insAction.run('2026-06-28T12:00:00.000Z', '2026-06-28T14:00:00', 'charge', 0, 1, 'skipped_solar_shortfall', 'x');
  insAction.run('2026-06-28T12:05:00.000Z', '2026-06-28T14:00:00', 'charge', 0, 1, 'skipped_solar_shortfall', 'x');
  insAction.run('2026-06-28T12:10:00.000Z', '2026-06-28T14:00:00', 'charge', 3000, 1, 'applied', 'x');
  insAction.run('2026-06-28T12:00:00.000Z', '2026-06-29T14:00:00', 'charge', 0, 1, 'skipped_divergence', 'x');
  db.close();
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_PATH + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe('readTodayFlowRows', () => {
  it('reads pv_w/house_load_w/battery_w since the given day boundary', () => {
    const rows = telemetry.readTodayFlowRows(new Date('2026-06-28T12:00:00Z'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      timestamp: '2026-06-28T10:00:00.000Z',
      pv_w: 0,
      house_load_w: 500,
      battery_w: -2000,
    });
  });

  it('excludes readings before the Stockholm-midnight boundary of "now"', () => {
    // now = 2026-06-29 → boundary = Stockholm midnight 06-29 = 2026-06-28T22:00:00Z, which is
    // AFTER both seeded readings (06-28T10:00/10:05Z) — they belong to the prior day.
    const rows = telemetry.readTodayFlowRows(new Date('2026-06-29T12:00:00Z'));
    expect(rows).toHaveLength(0);
  });
});

describe('readControlActionsForDay', () => {
  it('dedupes non-applied outcomes per slot_time and excludes applied rows', () => {
    const out = telemetry.readControlActionsForDay('2026-06-28');
    expect(out['2026-06-28T14:00:00']).toEqual(['skipped_solar_shortfall']);
  });

  it('does not leak rows from a different price date', () => {
    const out = telemetry.readControlActionsForDay('2026-06-28');
    expect(out['2026-06-29T14:00:00']).toBeUndefined();
  });

  it('returns {} for a date with no rows', () => {
    expect(telemetry.readControlActionsForDay('2026-01-01')).toEqual({});
  });
});
