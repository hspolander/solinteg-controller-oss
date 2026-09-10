import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SHADOW_SCORE_VERSION } from '../oracle'; // pure constant — no TELEMETRY_DB_PATH dependency
import type { OracleDayRow } from '../oracle';

// The shadow-score blob rides inside oracle_daily.diagnostics_json, and its shadowVersion
// field is the nightly sweep's backfill sentinel (see app/api/oracle/route.ts). These tests
// pin the reader's side of that contract in readRecentOracleDays: exactly which stored shapes
// count as "already shadow-scored", and that nothing malformed can throw. Same temp-sqlite
// pattern as telemetry-economics.integration.test.ts.
const DB_PATH = join(tmpdir(), `telemetry-oracle-shadow-test-${process.pid}-${Date.now()}.db`);
process.env.TELEMETRY_DB_PATH = DB_PATH;

let telemetry: typeof import('../telemetry');

function makeRow(date: string, diagnostics: Record<string, unknown>): OracleDayRow {
  return {
    date,
    status: 'ok',
    armedFraction: 1,
    readingCoverage: 1,
    startSocKwh: 10,
    achievedEndSocKwh: 10,
    oracleEndSocKwh: 10,
    baselineNetOre: -100,
    achievedCashOre: -80,
    achievedWearOre: 0,
    achievedContinuationOre: 50,
    achievedTotalOre: -30,
    oracleDayCashOre: -60,
    oracleDayWearOre: 0,
    oracleTotalOre: -10,
    regretOre: 20,
    regretIntradayOre: 15,
    regretCarryOre: 5,
    params: {},
    oracleDispatchD: null,
    diagnostics,
  };
}

beforeAll(async () => {
  telemetry = await import('../telemetry');

  // Four stored shapes, one per date (readRecentOracleDays returns them oldest-first):
  // 01 — scored by the current sweep: blob with the matching shadowVersion
  telemetry.upsertOracleDaily(
    makeRow('2026-07-01', {
      shadow: {
        shadowVersion: SHADOW_SCORE_VERSION,
        dayAhead: { totalOre: -25, regretOre: 15, endSocKwh: 9.5 },
      },
    }),
  );
  // 02 — swept, but nothing to score (no day-ahead run existed): null score + skip reason
  telemetry.upsertOracleDaily(
    makeRow('2026-07-02', {
      shadow: { shadowVersion: SHADOW_SCORE_VERSION, dayAhead: null },
      shadowDayAheadSkip: 'no day-ahead run found before D midnight with D covered',
    }),
  );
  // 03 — predates the shadow sweep entirely: no shadow key
  telemetry.upsertOracleDaily(makeRow('2026-07-03', { balance: { residualKwh: 0 } }));
  // 04 — scored under a different (older/newer) arithmetic version
  telemetry.upsertOracleDaily(
    makeRow('2026-07-04', {
      shadow: {
        shadowVersion: SHADOW_SCORE_VERSION + 1,
        dayAhead: { totalOre: -99, regretOre: 99, endSocKwh: 5 },
      },
    }),
  );
  // 05 — a corrupted blob (hand-write: the upsert path can only produce valid JSON)
  telemetry.upsertOracleDaily(makeRow('2026-07-05', {}));
  const db = new DatabaseSync(DB_PATH);
  db.prepare(`UPDATE oracle_daily SET diagnostics_json = '{"shadow": {' WHERE date = ?`).run(
    '2026-07-05',
  );
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

describe('readRecentOracleDays — shadow blob parsing and the shadowVersion sentinel', () => {
  it('a matching shadowVersion reads as scored, with the score fields extracted', () => {
    const rows = telemetry.readRecentOracleDays(14);
    const r = rows.find((x) => x.date === '2026-07-01')!;
    expect(r.shadowScored).toBe(true);
    expect(r.shadowDayAheadRegretOre).toBe(15);
    expect(r.shadowDayAheadTotalOre).toBe(-25);
  });

  it('a swept-but-unscorable day still counts as scored (null score, no nightly recompute)', () => {
    const r = telemetry.readRecentOracleDays(14).find((x) => x.date === '2026-07-02')!;
    expect(r.shadowScored).toBe(true);
    expect(r.shadowDayAheadRegretOre).toBeNull();
    expect(r.shadowDayAheadTotalOre).toBeNull();
  });

  it('a pre-sweep row (no shadow key) reads as not scored → one-time backfill', () => {
    const r = telemetry.readRecentOracleDays(14).find((x) => x.date === '2026-07-03')!;
    expect(r.shadowScored).toBe(false);
    expect(r.shadowDayAheadRegretOre).toBeNull();
  });

  it('a version mismatch reads as not scored — bumping SHADOW_SCORE_VERSION re-backfills', () => {
    const r = telemetry.readRecentOracleDays(14).find((x) => x.date === '2026-07-04')!;
    expect(r.shadowScored).toBe(false);
    // The stale score is withheld too, not served: those numbers were computed under a
    // different arithmetic, and the next sweep replaces them within a night.
    expect(r.shadowDayAheadRegretOre).toBeNull();
    expect(r.shadowDayAheadTotalOre).toBeNull();
  });

  it('a malformed blob degrades to not-scored without throwing (self-heals on next sweep)', () => {
    const rows = telemetry.readRecentOracleDays(14); // must not throw
    const r = rows.find((x) => x.date === '2026-07-05')!;
    expect(r.shadowScored).toBe(false);
    expect(r.shadowDayAheadRegretOre).toBeNull();
    // …and the row's ordinary columns still come through untouched.
    expect(r.regretOre).toBe(20);
  });
});
