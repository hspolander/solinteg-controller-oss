import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SKATT_OVERFÖRING } from '../constants'; // no TELEMETRY_DB_PATH dependency — safe to import statically

// Unique temp DB, wired via env before importing the telemetry module (which reads the path once).
// pid alone is NOT unique enough: the module-level DatabaseSync handle stays open through
// afterAll, so on Windows rmSync fails (silently, by design) and the file leaks — and a later
// run with a recycled pid then inherits a DB whose tables already exist. The timestamp makes
// collisions impossible; leaked files are pennies of temp space.
const DB_PATH = join(tmpdir(), `telemetry-econ-test-${process.pid}-${Date.now()}.db`);
process.env.TELEMETRY_DB_PATH = DB_PATH;

// Imported dynamically in beforeAll so the env var is set first.
let telemetry: typeof import('../telemetry');
let economics: typeof import('../economics');

beforeAll(async () => {
  economics = await import('../economics');
  telemetry = await import('../telemetry');

  // Simulate the poller: create the readings table the web app never makes itself.
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE readings (
    id INTEGER PRIMARY KEY, timestamp TEXT, soc_pct REAL, soc_kwh REAL,
    pv_w INTEGER, grid_w INTEGER, battery_w INTEGER, inverter_ac_w INTEGER,
    house_load_w INTEGER, work_mode TEXT, work_mode_raw INTEGER)`);
  const ins = db.prepare(
    'INSERT INTO readings (timestamp, pv_w, grid_w, house_load_w) VALUES (?, ?, ?, ?)',
  );
  // Two readings 1 h apart on 2026-07-01, Stockholm 13:00 slot (UTC 11:00, CEST +2).
  // Importing 1 kW the whole time.
  ins.run('2026-07-01T11:00:00.000Z', 0, -1000, 1000);
  ins.run('2026-07-01T12:00:00.000Z', 0, -1000, 1000);
  db.close();

  // Log a price snapshot the normal way (web-app path) covering those slots.
  telemetry.logPriceSnapshot({
    today: '2026-07-01',
    tomorrow: '2026-07-02',
    hasTomorrow: false,
    maxForMonth: 0,
    minForMonth: 0,
    maxAge: 60,
    prices: [
      { startTime: '2026-07-01T13:00:00', endTime: '2026-07-01T13:15:00', price: 50, priceIncludingTaxAndSurcharge: 129 },
      { startTime: '2026-07-01T14:00:00', endTime: '2026-07-01T14:15:00', price: 50, priceIncludingTaxAndSurcharge: 129 },
    ],
  });
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

describe('telemetry → economics integration', () => {
  it('reads readings + prices from SQLite and computes bought/sold kWh and net cost', () => {
    const readings = telemetry.readReadings();
    expect(readings).toHaveLength(2);

    const priceAt = telemetry.buildPriceLookup();
    // buy = 129 + skatt = 200 öre/kWh; matched via Stockholm slot key (UTC 11:00 → 13:00).
    expect(priceAt('2026-07-01T11:00:00.000Z')).toEqual({ buy: 129 + SKATT_OVERFÖRING, sell: 50 });

    const daily = economics.computeDailyEconomics(readings, priceAt, {
      defaultIntervalMs: 0,
      maxGapMs: 7_200_000,
    });
    const day = daily.get('2026-07-01')!;
    // First reading bills 1 h at 1 kW import: 1 kWh × 2.00 kr = 2.00 kr.
    expect(day.boughtKwh).toBeCloseTo(1.0);
    expect(day.costKr).toBeCloseTo(2.0);
    expect(day.netKr).toBeCloseTo(-2.0);
  });

  it('readReadings filters by UTC timestamp range', () => {
    expect(telemetry.readReadings('2026-07-01T11:30:00.000Z')).toHaveLength(1);
    expect(telemetry.readReadings(undefined, '2026-07-01T11:30:00.000Z')).toHaveLength(1);
    expect(
      telemetry.readReadings('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
    ).toHaveLength(2);
  });

  it('readDailyEconomics folds cached elapsed days and live readings into one map', () => {
    // "now" is the day after the seeded readings, so both land in the frozen prefix
    // (boundary = Stockholm midnight 2026-07-02 = 2026-07-01T22:00Z) and the live pass is empty.
    const daily = telemetry.readDailyEconomics(new Date('2026-07-02T10:00:00Z'));
    const day = daily.get('2026-07-01')!;
    expect(day.readingCount).toBe(2);
    // Default poller-shaped options: first reading bills the 90 s gap cap, the last bills
    // the 30 s default interval → 120 s × 1 kW = 0.0333 kWh × 2.00 kr/kWh.
    expect(day.boughtKwh).toBeCloseTo(0.0333, 3);
    expect(day.costKr).toBeCloseTo(0.0667, 3);

    // Second call hits the per-day cache and must return the same totals.
    const again = telemetry.readDailyEconomics(new Date('2026-07-02T11:00:00Z'));
    expect(again.get('2026-07-01')!.costKr).toBeCloseTo(day.costKr);
  });
});
