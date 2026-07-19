import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { OptimizerSlot, DispatchSlot } from '../optimizer';

// Same env-before-dynamic-import dance (and timestamped-filename reasoning) as
// telemetry-economics.integration.test.ts — see that file's header comment.
const DB_PATH = join(tmpdir(), `telemetry-optrun-test-${process.pid}-${Date.now()}.db`);
process.env.TELEMETRY_DB_PATH = DB_PATH;

let telemetry: typeof import('../telemetry');

beforeAll(async () => {
  telemetry = await import('../telemetry');
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

const inputs: OptimizerSlot[] = [
  { startTime: '2026-07-01T13:00:00', buyPrice: 200, sellPrice: 55, solarKwh: 0.2, consumptionKwh: 0.3 },
];
const dispatch: DispatchSlot[] = [
  {
    startTime: '2026-07-01T13:00:00',
    action: 'idle',
    gridKwh: 0.1,
    solarExportKwh: 0,
    batteryToGridKwh: 0,
    gridToBatteryKwh: 0,
    batteryToLoadKwh: 0,
    loadFromGridKwh: 0.1,
    socAfter: 10,
  },
];

function countRuns(): number {
  const db = new DatabaseSync(DB_PATH);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM optimizer_runs').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function newestInputsJson(): string {
  const db = new DatabaseSync(DB_PATH);
  try {
    return (
      db.prepare('SELECT inputs_json FROM optimizer_runs ORDER BY id DESC LIMIT 1').get() as {
        inputs_json: string;
      }
    ).inputs_json;
  } finally {
    db.close();
  }
}

describe('logOptimizerRun publish gate', () => {
  it('publishes a plan anchored to a live SoC reading', () => {
    telemetry.logOptimizerRun('2026-07-01', false, 10, inputs, dispatch, true);
    expect(countRuns()).toBe(1);
  });

  it('refuses to publish a plan anchored to the fallback SoC', () => {
    // The dispatch loop takes the newest optimizer_runs row as its authority, so a
    // fallback-anchored plan must never become a row (it would silently replace a
    // better plan computed from a real SoC reading) — display-only instead.
    telemetry.logOptimizerRun('2026-07-01', false, 12.8, inputs, dispatch, false);
    expect(countRuns()).toBe(1);
  });
});

describe('logOptimizerRun row slimming (rounding + dedup — companion to the 10-min timer)', () => {
  it('rounds logged floats to 3 decimals (Wh-scale, below every consumer precision)', () => {
    const noisyInputs: OptimizerSlot[] = [
      { ...inputs[0], startTime: '2026-07-01T13:15:00', consumptionKwh: 0.20746110774818402 },
    ];
    telemetry.logOptimizerRun('2026-07-01', false, 10, noisyInputs, dispatch, true);
    expect(newestInputsJson()).toContain('"consumptionKwh":0.207');
    expect(newestInputsJson()).not.toContain('0.20746110774818402');
  });

  it('skips the insert when the newest row already carries the identical plan', () => {
    const before = countRuns();
    telemetry.logOptimizerRun('2026-07-01', false, 10, [{ ...inputs[0], startTime: '2026-07-01T13:15:00', consumptionKwh: 0.20746110774818402 }], dispatch, true);
    expect(countRuns()).toBe(before); // byte-identical after rounding → deduped
  });

  it('dedups on the plan payload, not on start_soc_kwh (a few-Wh SoC wiggle is not a new plan)', () => {
    const before = countRuns();
    telemetry.logOptimizerRun('2026-07-01', false, 10.037, [{ ...inputs[0], startTime: '2026-07-01T13:15:00', consumptionKwh: 0.2074999 }], dispatch, true);
    expect(countRuns()).toBe(before); // same rounded payload, drifted SoC → still deduped
  });

  it('logs a new row the moment the plan actually differs', () => {
    const before = countRuns();
    const changed: DispatchSlot[] = [{ ...dispatch[0], gridKwh: 0.5, loadFromGridKwh: 0.5 }];
    telemetry.logOptimizerRun('2026-07-01', false, 10, [{ ...inputs[0], startTime: '2026-07-01T13:15:00', consumptionKwh: 0.207 }], changed, true);
    expect(countRuns()).toBe(before + 1);
  });

  it('a horizon change (tomorrow prices landed) is never deduped, even with equal slots', () => {
    const before = countRuns();
    const changed: DispatchSlot[] = [{ ...dispatch[0], gridKwh: 0.5, loadFromGridKwh: 0.5 }];
    telemetry.logOptimizerRun('2026-07-01', true, 10, [{ ...inputs[0], startTime: '2026-07-01T13:15:00', consumptionKwh: 0.207 }], changed, true);
    expect(countRuns()).toBe(before + 1);
  });
});
