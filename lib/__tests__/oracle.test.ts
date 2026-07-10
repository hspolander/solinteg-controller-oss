import { describe, it, expect } from 'vitest';
import {
  bucketActuals,
  socAtInstant,
  socSeries,
  armedStats,
  baselineCashOre,
  toOptimizerSlots,
  computeOracleDay,
} from '../oracle';
import type { OracleReadingRow, ArmedEventRow, OracleDayInputs } from '../oracle';
import { BATTERY_KWH, BATTERY_MIN_SOC_KWH, GRID_KW, BATTERY_MAX_KW } from '../optimizer';
import { BATTERY_RT_EFF, SKATT_OVERFÖRING } from '../constants';
import type { PriceSlot } from '../prices';

const SLOT_MS = 900_000;
const SLOT_MAX_KWH = Math.min(GRID_KW, BATTERY_MAX_KW) / 4;
const MIN_SOC = BATTERY_MIN_SOC_KWH;
const ONE_WAY_EFF = Math.sqrt(BATTERY_RT_EFF);

// Stockholm midnight of 2026-06-29 (CEST, UTC+2). The oracle's bucketing runs on elapsed ms
// from this instant — the naive startTime strings below are labels/day-filters only.
const DAY_MS = Date.UTC(2026, 5, 28, 22, 0, 0);

const iso = (ms: number) => new Date(ms).toISOString();

function priceDay(dateStr: string, slotCount: number, buy: number | ((i: number) => number), sell: number | ((i: number) => number)): PriceSlot[] {
  return Array.from({ length: slotCount }, (_, i) => {
    const h = String(Math.floor((i * 15) / 60) % 24).padStart(2, '0');
    const m = String((i * 15) % 60).padStart(2, '0');
    const buyV = typeof buy === 'function' ? buy(i) : buy;
    const sellV = typeof sell === 'function' ? sell(i) : sell;
    return {
      startTime: `${dateStr}T${h}:${m}:00`,
      endTime: `${dateStr}T${h}:${m}:00`,
      price: sellV, // sell price (spot + nätnytta), as prices.ts folds it
      priceIncludingTaxAndSurcharge: buyV - SKATT_OVERFÖRING, // so buyPrice comes out as exactly buyV
    };
  });
}

/** Readings every 5 min with constant values (enough samples for full slot coverage). */
function constantReadings(
  startMs: number,
  hours: number,
  v: { pv_w?: number; house_load_w?: number; soc_kwh?: number; grid_w?: number },
): OracleReadingRow[] {
  const out: OracleReadingRow[] = [];
  for (let t = startMs; t < startMs + hours * 3_600_000; t += 300_000) {
    out.push({
      timestamp: iso(t),
      pv_w: v.pv_w ?? 0,
      house_load_w: v.house_load_w ?? 0,
      soc_kwh: v.soc_kwh ?? 10,
      grid_w: v.grid_w ?? 0,
    });
  }
  return out;
}

function armedAllDay(dayStartMs: number, armed: 0 | 1): ArmedEventRow[] {
  return Array.from({ length: 288 }, (_, i) => ({
    timestamp: iso(dayStartMs + i * 300_000),
    armed,
    outcome: 'applied',
  }));
}

describe('bucketActuals', () => {
  it('averages readings into elapsed-time slots', () => {
    const readings = constantReadings(DAY_MS, 24, { pv_w: 4000, house_load_w: 800, grid_w: 2000 });
    const a = bucketActuals(readings, DAY_MS, 96);
    expect(a.solarKwh).toHaveLength(96);
    expect(a.solarKwh[0]).toBeCloseTo(1.0, 6); // 4000 W × 0.25 h
    expect(a.loadKwh[50]).toBeCloseTo(0.2, 6);
    expect(a.exportKwh[10]).toBeCloseTo(0.5, 6); // grid_w +2000 = export
    expect(a.importKwh[10]).toBeCloseTo(0, 6);
    expect(a.coverage).toBe(1);
  });

  it('splits a slot that both imported and exported instead of netting it', () => {
    const readings: OracleReadingRow[] = [
      { timestamp: iso(DAY_MS + 0), pv_w: 0, house_load_w: 0, soc_kwh: 10, grid_w: 2000 },
      { timestamp: iso(DAY_MS + 450_000), pv_w: 0, house_load_w: 0, soc_kwh: 10, grid_w: -2000 },
    ];
    const a = bucketActuals(readings, DAY_MS, 1);
    expect(a.exportKwh[0]).toBeCloseTo(0.25, 6); // mean of (2000, 0) → 1000 W × 0.25 h
    expect(a.importKwh[0]).toBeCloseTo(0.25, 6);
  });

  it('interpolates short gaps, zero-fills long ones, and reports coverage', () => {
    let readings = constantReadings(DAY_MS, 24, { pv_w: 4000, house_load_w: 800 });
    const inGap = (t: string, fromSlot: number, toSlot: number) => {
      const ms = Date.parse(t) - DAY_MS;
      return ms >= fromSlot * SLOT_MS && ms < toSlot * SLOT_MS;
    };
    readings = readings.filter(
      (r) => !inGap(r.timestamp, 10, 12) && !inGap(r.timestamp, 40, 47), // 2-slot and 7-slot gaps
    );
    const a = bucketActuals(readings, DAY_MS, 96);
    expect(a.solarKwh[10]).toBeCloseTo(1.0, 6); // interpolated between equal neighbours
    expect(a.solarKwh[43]).toBe(0); // beyond MAX_INTERP_SLOTS → zero-filled
    expect(a.coverage).toBeCloseTo((96 - 9) / 96, 6);
    expect(a.interpolatedSlots).toBe(4); // 2 slots × (solar + load)
    expect(a.zeroFilledSlots).toBe(14); // 7 slots × (solar + load)
  });

  it('handles a 92-slot DST spring-forward day by elapsed time', () => {
    // 2026-03-29: Stockholm midnight is UTC+1; the day is 23 h long → 92 slots.
    const dstDay = Date.UTC(2026, 2, 28, 23, 0, 0);
    const readings = constantReadings(dstDay, 23, { pv_w: 4000 });
    const a = bucketActuals(readings, dstDay, 92);
    expect(a.coverage).toBe(1);
    expect(a.solarKwh.every((k) => Math.abs(k - 1.0) < 1e-6)).toBe(true);
  });
});

describe('socAtInstant', () => {
  const pts = [
    { t: DAY_MS, soc: 10 },
    { t: DAY_MS + 600_000, soc: 12 },
  ];
  it('interpolates between surrounding readings', () => {
    expect(socAtInstant(pts, DAY_MS + 300_000)).toEqual({ soc: 11, spanMs: 600_000 });
  });
  it('accepts a nearby reading off the ends but rejects a distant one', () => {
    expect(socAtInstant(pts, DAY_MS + 600_000 + 10 * 60_000)?.soc).toBe(12);
    expect(socAtInstant(pts, DAY_MS + 600_000 + 16 * 60_000)).toBeNull();
  });
  it('socSeries keeps only non-null soc readings', () => {
    const rows: OracleReadingRow[] = [
      { timestamp: iso(DAY_MS), pv_w: 0, house_load_w: 0, soc_kwh: 9, grid_w: 0 },
      { timestamp: iso(DAY_MS + 1000), pv_w: 0, house_load_w: 0, soc_kwh: null, grid_w: 0 },
    ];
    expect(socSeries(rows)).toEqual([{ t: DAY_MS, soc: 9 }]);
  });
});

describe('armedStats', () => {
  it('time-weights armed coverage and caps silent stretches', () => {
    const events: ArmedEventRow[] = [
      { timestamp: iso(DAY_MS), armed: 1, outcome: 'applied' },
      { timestamp: iso(DAY_MS + 300_000), armed: 1, outcome: 'applied' },
      // then silence: the second row's coverage is capped at 20 min, not "until midnight"
    ];
    const s = armedStats(events, DAY_MS, DAY_MS + 86_400_000);
    expect(s.fraction).toBeCloseTo((300_000 + 1_200_000) / 86_400_000, 9);
  });

  it('covers the whole gap of the loop\'s 15-min idle logging cadence', () => {
    // Idle stretches only log on slot change (~900 s apart, measured p90 903 s); the cap must
    // bridge those fully or an armed idle day scores ~0.85 instead of 1 (found on real data).
    const events: ArmedEventRow[] = Array.from({ length: 96 }, (_, i) => ({
      timestamp: iso(DAY_MS + i * 900_000),
      armed: 1,
      outcome: 'applied',
    }));
    const s = armedStats(events, DAY_MS, DAY_MS + 86_400_000);
    expect(s.fraction).toBeGreaterThan(0.999);
  });

  it('credits the day-start minutes from a pre-midnight row (route fetches one cap of lead-in)', () => {
    const events: ArmedEventRow[] = [
      { timestamp: iso(DAY_MS - 300_000), armed: 1, outcome: 'applied' }, // 23:55 the night before
      ...Array.from({ length: 96 }, (_, i) => ({
        timestamp: iso(DAY_MS + 600_000 + i * 900_000),
        armed: 1 as const,
        outcome: 'applied',
      })),
    ];
    const s = armedStats(events, DAY_MS, DAY_MS + 86_400_000);
    expect(s.fraction).toBeGreaterThan(0.999);
  });
  it('counts error_revert_failed and treats pre-first-row time as not armed', () => {
    const events: ArmedEventRow[] = [
      { timestamp: iso(DAY_MS + 43_200_000), armed: 0, outcome: 'error_revert_failed' },
    ];
    const s = armedStats(events, DAY_MS, DAY_MS + 86_400_000);
    expect(s.fraction).toBe(0);
    expect(s.revertFailedCount).toBe(1);
  });
  it('a fully-armed day of 5-min rows scores ~1', () => {
    const s = armedStats(armedAllDay(DAY_MS, 1), DAY_MS, DAY_MS + 86_400_000);
    expect(s.fraction).toBeGreaterThan(0.999);
  });
});

describe('baselineCashOre', () => {
  it('prices deficit at buy, surplus at sell, and curtails above the grid cap', () => {
    const slots = toOptimizerSlots(priceDay('2026-06-29', 3, 200, (i) => (i === 2 ? -10 : 50)), {
      solarKwh: [0, 3.5, 3.5],
      loadKwh: [0.4, 0.5, 0.5],
      importKwh: [],
      exportKwh: [],
      coverage: 1,
      interpolatedSlots: 0,
      zeroFilledSlots: 0,
    });
    // slot 0: deficit 0.4 × 200 = −80
    // slot 1: surplus 3.0 → capped at 2.75 × 50 = +137.5
    // slot 2: surplus capped 2.75 × −10 = −27.5 (negative price export is a real cost)
    expect(baselineCashOre(slots)).toBeCloseTo(-80 + 137.5 - 27.5, 6);
  });
});

// ── Full-day scoring ──────────────────────────────────────────────────────────────────────────

/**
 * Simulate a plain self-use ("auto mode") day at slot level and emit consistent readings:
 * solar serves load, surplus charges the battery (then exports), deficit discharges it (then
 * imports). This is a feasible trajectory under the DP's exact physics, so every regret the
 * oracle reports against it must be ≥ 0 up to SoC-grid snapping.
 */
function simulateSelfUse(
  dayStartMs: number,
  solarKwh: number[],
  loadKwh: number[],
  startSoc: number,
): { readings: OracleReadingRow[]; cashOre: (buy: number[], sell: number[]) => number; socEnd: number } {
  const n = solarKwh.length;
  let soc = startSoc;
  const imp: number[] = [];
  const exp: number[] = [];
  const socAt: number[] = [soc];
  for (let i = 0; i < n; i++) {
    const surplus = solarKwh[i] - loadKwh[i];
    if (surplus >= 0) {
      const stored = Math.min(surplus, SLOT_MAX_KWH, (BATTERY_KWH - soc) / ONE_WAY_EFF);
      soc += stored * ONE_WAY_EFF;
      imp.push(0);
      exp.push(Math.min(surplus - stored, SLOT_MAX_KWH));
    } else {
      const need = -surplus;
      const delivered = Math.min(need, SLOT_MAX_KWH, (soc - MIN_SOC) * ONE_WAY_EFF);
      soc -= delivered / ONE_WAY_EFF;
      imp.push(need - delivered);
      exp.push(0);
    }
    socAt.push(soc);
  }
  const readings: OracleReadingRow[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const t = dayStartMs + i * SLOT_MS + k * 300_000;
      const frac = (k * 300_000 + 150_000) / SLOT_MS;
      readings.push({
        timestamp: iso(t),
        pv_w: (solarKwh[i] / 0.25) * 1000,
        house_load_w: (loadKwh[i] / 0.25) * 1000,
        soc_kwh: socAt[i] + (socAt[i + 1] - socAt[i]) * frac,
        grid_w: ((exp[i] - imp[i]) / 0.25) * 1000, // +export/−import
      });
    }
  }
  // Anchor the exact boundary SoC values so interpolation lands on the simulated states.
  readings.push({ timestamp: iso(dayStartMs), pv_w: null, house_load_w: null, soc_kwh: socAt[0], grid_w: null });
  readings.push({ timestamp: iso(dayStartMs + n * SLOT_MS - 1), pv_w: null, house_load_w: null, soc_kwh: soc, grid_w: null });
  readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    readings,
    cashOre: (buy, sell) => imp.reduce((acc, v, i) => acc + exp[i] * sell[i] - v * buy[i], 0),
    socEnd: soc,
  };
}

function makeInputs(overrides: Partial<OracleDayInputs> = {}): OracleDayInputs {
  const priceSlotsD = priceDay('2026-06-29', 96, 200, 1);
  const priceSlotsCont = priceDay('2026-06-30', 96, 200, 1);
  const readings = constantReadings(DAY_MS, 48, { house_load_w: 1600, grid_w: -1600, soc_kwh: 10 });
  return {
    date: '2026-06-29',
    dayStartMs: DAY_MS,
    priceSlotsD,
    priceSlotsCont,
    readings,
    armedEvents: armedAllDay(DAY_MS, 1),
    achievedCashOre: -(0.4 * 96 * 200), // imported the whole load at 200 öre
    ...overrides,
  };
}

describe('computeOracleDay', () => {
  it('flat prices + idle battery ⇒ ~zero regret (the continuation credit at work)', () => {
    // With flat prices the oracle drains the battery over the 48 h window (terminal value 0)
    // and contV credits the achieved side for holding the same energy — a day-only comparison
    // without the credit would report a phantom regret of ≈ (10 − floor) × 200 öre ≈ 16 kr.
    const row = computeOracleDay(makeInputs());
    expect(row.status).toBe('ok');
    expect(row.regretOre).not.toBeNull();
    expect(Math.abs(row.regretOre as number)).toBeLessThan(30); // < 0.3 kr on a ~150 kr day
    expect(row.regretIntradayOre as number).toBeGreaterThanOrEqual(-25);
    expect(row.regretCarryOre as number).toBeGreaterThanOrEqual(-25);
    // Decomposition is exact by construction, up to each part's own 0.1 öre storage rounding.
    expect(
      Math.abs((row.regretIntradayOre as number) + (row.regretCarryOre as number) - (row.regretOre as number)),
    ).toBeLessThanOrEqual(0.25);
  });

  it('a varied real-shaped day scored against a feasible self-use trajectory: all regrets ≥ ~0', () => {
    const buy = Array.from({ length: 96 }, (_, i) => 120 + 100 * Math.sin((2 * Math.PI * (i - 20)) / 96));
    const sell = buy.map((b) => b - 90);
    const solar = Array.from({ length: 96 }, (_, i) => {
      const h = i / 4;
      return h >= 7 && h < 19 ? 2.2 * Math.sin((Math.PI * (h - 7)) / 12) : 0;
    });
    const load = Array.from({ length: 96 }, (_, i) => 0.25 + (i >= 68 && i < 88 ? 0.45 : 0));
    const simD = simulateSelfUse(DAY_MS, solar, load, 9);
    const simCont = simulateSelfUse(DAY_MS + 96 * SLOT_MS, solar, load, simD.socEnd);
    const inputs = makeInputs({
      priceSlotsD: priceDay('2026-06-29', 96, (i) => buy[i], (i) => sell[i]),
      priceSlotsCont: priceDay('2026-06-30', 96, (i) => buy[i], (i) => sell[i]),
      readings: [...simD.readings, ...simCont.readings],
      achievedCashOre: simD.cashOre(buy, sell),
    });
    const row = computeOracleDay(inputs);
    expect(row.status).toBe('ok');
    // ≥ 0 up to SoC-grid snapping of the boundary states (~half a step × price ≈ 20 öre).
    expect(row.regretOre as number).toBeGreaterThanOrEqual(-25);
    expect(row.regretIntradayOre as number).toBeGreaterThanOrEqual(-25);
    expect(row.regretCarryOre as number).toBeGreaterThanOrEqual(-25);
    expect(
      Math.abs((row.regretIntradayOre as number) + (row.regretCarryOre as number) - (row.regretOre as number)),
    ).toBeLessThanOrEqual(0.25);
    // Self-use leaves real money on the table on a price-spread day; the oracle must find it.
    expect(row.regretOre as number).toBeGreaterThan(100);
    // The simulation books η-losses inside the battery, so the residual reflects only those.
    const balance = (row.diagnostics as { balance: { residualKwh: number } }).balance;
    expect(Math.abs(balance.residualKwh)).toBeLessThan(1.5);
    expect(row.oracleDispatchD).toHaveLength(96);
  });

  it('flags a disarmed day as shadow, not ok', () => {
    const row = computeOracleDay(makeInputs({ armedEvents: armedAllDay(DAY_MS, 0) }));
    expect(row.status).toBe('shadow');
    expect(row.armedFraction).toBe(0);
    expect(row.regretOre).not.toBeNull(); // still scored — just not headline material
  });

  it('flags poor reading coverage as degraded', () => {
    const readings = constantReadings(DAY_MS, 48, { house_load_w: 1600, grid_w: -1600, soc_kwh: 10 }).filter(
      (r) => {
        const ms = Date.parse(r.timestamp) - DAY_MS;
        return ms < 20 * SLOT_MS || ms >= 40 * SLOT_MS; // 5-hour hole in day D
      },
    );
    const row = computeOracleDay(makeInputs({ readings }));
    expect(row.status).toBe('degraded');
    expect(row.readingCoverage as number).toBeLessThan(0.95);
  });

  it('records a day with no usable SoC anchor as skipped_no_readings', () => {
    const readings = constantReadings(DAY_MS + 4 * 3_600_000, 40, {
      house_load_w: 1600,
      grid_w: -1600,
      soc_kwh: 10,
    }); // nothing near day-D midnight
    const row = computeOracleDay(makeInputs({ readings }));
    expect(row.status).toBe('skipped_no_readings');
    expect(row.regretOre).toBeNull();
    expect(row.oracleTotalOre).toBeNull();
  });
});
