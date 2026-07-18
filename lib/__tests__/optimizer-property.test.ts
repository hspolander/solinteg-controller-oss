/**
 * Property-based tests for optimizeDispatch (added by the 2026-07-13 optimizer review pass).
 *
 * Unlike optimizer.test.ts's hand-built behavioral pins, this file replicates the DP's
 * physics INDEPENDENTLY (grid geometry, SoC floor, natural auto-charge floor, grid caps)
 * and checks structural properties across seeded random scenarios — negative prices,
 * above-cap solar bursts, three horizon lengths, below-floor starts:
 *   1. OPTIMALITY: the DP's trajectory values ≥ thousands of random feasible on-grid
 *      trajectories priced by the same evaluateDispatch arithmetic.
 *   2. EMISSION VALIDITY: every emitted slot is on-grid, obeys floor/caps/natural-floor,
 *      carries the correct action label, and its gridKwh/solarExportKwh match
 *      independently recomputed flows.
 *   3. endSoc MODE: lands within half a grid step of any reachable target, never beats
 *      the unconstrained optimum, throws on an unreachable one.
 * Deterministic (seeded mulberry32) — a failure here is reproducible, not flaky. If a
 * deliberate physics change breaks these, update the replicated model here to match the
 * new physics, not the assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  optimizeDispatch,
  evaluateDispatch,
  BATTERY_KWH,
  BATTERY_MIN_SOC_KWH,
  BATTERY_MAX_KW,
  GRID_KW,
} from '../optimizer';
import type { OptimizerSlot, DispatchSlot } from '../optimizer';
import { BATTERY_RT_EFF, BATTERY_WEAR_COST_ORE_PER_KWH } from '../constants';

const SLOT_MAX_KWH = Math.min(GRID_KW, BATTERY_MAX_KW) / 4;
const ETA = Math.sqrt(BATTERY_RT_EFF);
const SOC_LEVELS = 193;
const EPS = 1e-6;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genSlots(rand: () => number, n: number): OptimizerSlot[] {
  // Realistic coupling: sell = spot + 5.1, buy = (spot + 11.5) × 1.25 + 71 (incl. negatives).
  const out: OptimizerSlot[] = [];
  for (let i = 0; i < n; i++) {
    const spot = -50 + rand() * 300;
    const solarPeak = rand() < 0.5 ? rand() * 2.8 : 0; // bursts, sometimes above the 2.75 cap
    out.push({
      startTime: `2026-07-01T${String(Math.floor((i * 15) / 60) % 24).padStart(2, '0')}:${String((i * 15) % 60).padStart(2, '0')}:00`,
      buyPrice: (spot + 11.5) * 1.25 + 71,
      sellPrice: spot + 5.1,
      solarKwh: solarPeak,
      consumptionKwh: rand() * 1.2,
    });
  }
  return out;
}

/** Replicated model geometry + admissibility (independent of optimizer.ts internals). */
function makeModel(slots: OptimizerSlot[], startSoc: number) {
  const floorSoc = Math.min(BATTERY_MIN_SOC_KWH, startSoc);
  const step = (BATTERY_KWH - floorSoc) / (SOC_LEVELS - 1);
  const socOf = (i: number) => floorSoc + i * step;
  const idxOf = (soc: number) =>
    Math.max(0, Math.min(SOC_LEVELS - 1, Math.round((soc - floorSoc) / step)));
  const minSocLevel = Math.ceil((BATTERY_MIN_SOC_KWH - floorSoc) / step - 1e-9);
  const maxDelta = Math.max(1, Math.floor(SLOT_MAX_KWH / step));
  const n = slots.length;
  const solarRem = new Float64Array(n);
  const loadRem = new Float64Array(n);
  const autoIn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const load = slots[i].consumptionKwh ?? 0;
    const s2l = Math.min(slots[i].solarKwh, load);
    solarRem[i] = slots[i].solarKwh - s2l;
    loadRem[i] = load - s2l;
    autoIn[i] = Math.min(solarRem[i], SLOT_MAX_KWH);
  }
  const flows = (soc: number, socNext: number, i: number) => {
    const dE = socNext - soc;
    let gImp: number, gExp: number, solarExport: number;
    if (dE >= 0) {
      const need = dE / ETA;
      const fromSolar = Math.min(solarRem[i], need);
      gImp = need - fromSolar + loadRem[i];
      solarExport = solarRem[i] - fromSolar;
      gExp = solarExport;
      if (gExp > SLOT_MAX_KWH) {
        solarExport = SLOT_MAX_KWH;
        gExp = SLOT_MAX_KWH;
      }
    } else {
      const out = -dE * ETA;
      const toLoad = Math.min(out, loadRem[i]);
      gImp = loadRem[i] - toLoad;
      solarExport = solarRem[i];
      gExp = solarRem[i] + (out - toLoad);
    }
    const feasible = gImp <= SLOT_MAX_KWH + 1e-9 && gExp <= SLOT_MAX_KWH + 1e-9;
    return { gImp, gExp, solarExport, feasible };
  };
  const admissibleJs = (s: number, i: number): number[] => {
    const lo = Math.max(0, s - maxDelta);
    const hi = Math.min(SOC_LEVELS - 1, s + maxDelta);
    const naturalFloor = idxOf(Math.min(socOf(s) + autoIn[i] * ETA, BATTERY_KWH));
    const js: number[] = [];
    for (let j = lo; j <= hi; j++) {
      if (j < s && j < minSocLevel) continue;
      if (j >= s && j < naturalFloor) continue;
      if (!flows(socOf(s), socOf(j), i).feasible) continue;
      js.push(j);
    }
    return js;
  };
  return { floorSoc, step, socOf, idxOf, minSocLevel, maxDelta, solarRem, loadRem, autoIn, flows, admissibleJs, n };
}

function randomWalk(model: ReturnType<typeof makeModel>, startSoc: number, rand: () => number, slots: OptimizerSlot[]): DispatchSlot[] {
  let s = model.idxOf(startSoc);
  const out: DispatchSlot[] = [];
  for (let i = 0; i < model.n; i++) {
    const js = model.admissibleJs(s, i);
    const j = js[Math.floor(rand() * js.length)];
    out.push({ startTime: slots[i].startTime, action: 'idle', gridKwh: 0, solarExportKwh: 0, socAfter: model.socOf(j) });
    s = j;
  }
  return out;
}

describe('optimizer property review harness', () => {
  it('DP dominates random feasible trajectories; emissions are valid; endSoc behaves', () => {
    let walksChecked = 0;
    let endSocChecked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed * 2654435761);
      const n = [8, 24, 96][seed % 3];
      const slots = genSlots(rand, n);
      const startSoc = BATTERY_MIN_SOC_KWH + rand() * (BATTERY_KWH - BATTERY_MIN_SOC_KWH);
      const model = makeModel(slots, startSoc);

      const optimal = optimizeDispatch(slots, startSoc);
      const optValue = evaluateDispatch(slots, optimal, startSoc).valueOre;

      // ── 2. emission validity ──
      let s = model.idxOf(startSoc);
      for (let i = 0; i < n; i++) {
        const soc = model.socOf(s);
        const socAfter = optimal[i].socAfter;
        const j = model.idxOf(socAfter);
        expect(Math.abs(model.socOf(j) - socAfter)).toBeLessThan(1e-9); // on-grid
        expect(Math.abs(j - s)).toBeLessThanOrEqual(model.maxDelta);
        if (j < s) expect(j).toBeGreaterThanOrEqual(model.minSocLevel); // floor
        if (j >= s) {
          const nf = model.idxOf(Math.min(soc + model.autoIn[i] * ETA, BATTERY_KWH));
          expect(j).toBeGreaterThanOrEqual(nf); // natural auto-charge floor
        }
        const f = model.flows(soc, socAfter, i);
        expect(f.feasible).toBe(true); // caps hold on the emitted path
        expect(Math.abs(optimal[i].gridKwh - (f.gImp - f.gExp))).toBeLessThan(1e-9);
        expect(Math.abs(optimal[i].solarExportKwh - f.solarExport)).toBeLessThan(1e-9);
        const dE = socAfter - soc;
        if (dE < -1e-6) expect(optimal[i].action).toBe('discharge');
        else {
          const need = dE / ETA;
          const gridForCharging = Math.max(0, need - Math.min(model.solarRem[i], need));
          expect(optimal[i].action).toBe(gridForCharging > model.step ? 'charge' : 'idle');
        }
        s = j;
      }

      // ── 1. optimality vs random feasible walks ──
      for (let w = 0; w < 60; w++) {
        const walk = randomWalk(model, startSoc, rand, slots);
        const walkValue = evaluateDispatch(slots, walk, startSoc).valueOre;
        expect(walkValue).toBeLessThanOrEqual(optValue + EPS);
        walksChecked++;
      }

      // ── 3. endSoc constraint from a reachable target ──
      const target = randomWalk(model, startSoc, rand, slots)[n - 1].socAfter;
      const constrained = optimizeDispatch(slots, startSoc, { endSoc: target });
      expect(Math.abs(constrained[n - 1].socAfter - target)).toBeLessThanOrEqual(model.step / 2 + 1e-9);
      const cValue = evaluateDispatch(slots, constrained, startSoc).valueOre;
      expect(cValue).toBeLessThanOrEqual(optValue + EPS);
      endSocChecked++;
    }
    expect(walksChecked).toBe(3600);
    expect(endSocChecked).toBe(60);
  });

  it('endSoc throws on an unreachable target', () => {
    const rand = mulberry32(42);
    const slots = genSlots(rand, 2).map((s) => ({ ...s, solarKwh: 0 })); // no solar: charging is grid-paced
    expect(() => optimizeDispatch(slots, BATTERY_MIN_SOC_KWH, { endSoc: BATTERY_KWH })).toThrow(/unreachable/);
  });

  it('start below the floor (2.048 kWh): never discharges further, floor holds after recovery', () => {
    for (let seed = 100; seed < 120; seed++) {
      const rand = mulberry32(seed);
      const slots = genSlots(rand, 24);
      const startSoc = 0.3 + rand() * 1.5; // genuinely below BATTERY_MIN_SOC_KWH (2.048)
      const d = optimizeDispatch(slots, startSoc);
      const floorSoc = Math.min(BATTERY_MIN_SOC_KWH, startSoc); // = startSoc here
      const step = (BATTERY_KWH - floorSoc) / (SOC_LEVELS - 1);
      for (const slot of d) {
        expect(slot.socAfter).toBeGreaterThanOrEqual(floorSoc - 1e-9); // never below where it started
        expect(slot.socAfter).toBeLessThanOrEqual(BATTERY_KWH + 1e-9);
      }
      // once recovered above the floor, never dip back under it (± one grid step of snap)
      let recovered = startSoc >= BATTERY_MIN_SOC_KWH;
      for (const slot of d) {
        if (recovered) expect(slot.socAfter).toBeGreaterThanOrEqual(BATTERY_MIN_SOC_KWH - step - 1e-9);
        if (slot.socAfter >= BATTERY_MIN_SOC_KWH - 1e-9) recovered = true;
      }
    }
  });

  it('degenerate horizons: empty and single-slot inputs', () => {
    expect(optimizeDispatch([], 12)).toEqual([]);
    const rand = mulberry32(9);
    const one = genSlots(rand, 1);
    const d = optimizeDispatch(one, 12);
    expect(d).toHaveLength(1);
    expect(d[0].socAfter).toBeGreaterThanOrEqual(BATTERY_MIN_SOC_KWH - 1e-9);
  });

  it('wear accounting matches |ΔSoC| on the emitted trajectory', () => {
    const rand = mulberry32(7);
    const slots = genSlots(rand, 24);
    const startSoc = 12;
    const d = optimizeDispatch(slots, startSoc);
    let expectedWear = 0;
    let soc = startSoc;
    for (const slot of d) {
      expectedWear += BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(slot.socAfter - soc);
      soc = slot.socAfter;
    }
    expect(evaluateDispatch(slots, d, startSoc).wearOre).toBeCloseTo(expectedWear, 9);
  });
});
