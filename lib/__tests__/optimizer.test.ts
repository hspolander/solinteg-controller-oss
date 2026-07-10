import { describe, it, expect } from 'vitest';
import {
  optimizeDispatch,
  evaluateDispatch,
  BATTERY_KWH,
  GRID_KW,
  BATTERY_MAX_KW,
  BATTERY_MIN_SOC_KWH,
} from '../optimizer';
import { BATTERY_RT_EFF, BATTERY_WEAR_COST_ORE_PER_KWH } from '../constants';
import type { OptimizerSlot } from '../optimizer';

const SLOT_MAX_KWH = Math.min(GRID_KW, BATTERY_MAX_KW) / 4; // 2.75 kWh/slot
const MIN_SOC = BATTERY_MIN_SOC_KWH; // operational floor (8% = 2.048 kWh)

function makeSlot(
  hour: number,
  quarter: number,
  overrides: Partial<Omit<OptimizerSlot, 'startTime'>> = {},
): OptimizerSlot {
  const h = String(hour).padStart(2, '0');
  const m = String(quarter * 15).padStart(2, '0');
  return {
    startTime: `2026-06-28T${h}:${m}:00`,
    buyPrice: 150,
    sellPrice: 80,
    solarKwh: 0,
    ...overrides,
  };
}

/** Build a 96-slot day with uniform prices and no solar */
function uniformDay(buyPrice: number, sellPrice: number): OptimizerSlot[] {
  return Array.from({ length: 96 }, (_, i) =>
    makeSlot(Math.floor(i / 4), i % 4, { buyPrice, sellPrice }),
  );
}

describe('optimizeDispatch', () => {
  // ── Shape & hard constraints ──────────────────────────────────────────────
  it('returns empty array for empty input', () => {
    expect(optimizeDispatch([])).toEqual([]);
  });

  it('returns same number of slots as input', () => {
    expect(optimizeDispatch(uniformDay(150, 80))).toHaveLength(96);
  });

  it('socAfter is always within [MIN_SOC, BATTERY_KWH]', () => {
    const result = optimizeDispatch(uniformDay(100, 120), BATTERY_KWH / 2);
    result.forEach(({ socAfter }) => {
      expect(socAfter).toBeGreaterThanOrEqual(MIN_SOC - 0.001);
      expect(socAfter).toBeLessThanOrEqual(BATTERY_KWH + 0.001);
    });
  });

  it('never drains SoC below MIN_SOC', () => {
    const result = optimizeDispatch(uniformDay(100, 200), MIN_SOC);
    result.forEach(({ socAfter }) => expect(socAfter).toBeGreaterThanOrEqual(MIN_SOC - 0.001));
  });

  it('|gridKwh| never exceeds SLOT_MAX_KWH per slot', () => {
    const result = optimizeDispatch(uniformDay(100, 150), BATTERY_KWH / 2);
    result.forEach(({ gridKwh }) => expect(Math.abs(gridKwh)).toBeLessThanOrEqual(SLOT_MAX_KWH + 0.001));
  });

  it('respects SoC and grid bounds with mixed solar + consumption', () => {
    const slots = [
      ...Array.from({ length: 48 }, (_, i) =>
        makeSlot(Math.floor(i / 4), i % 4, { buyPrice: 50, sellPrice: 80, consumptionKwh: 0.8, solarKwh: i % 8 === 0 ? 3 : 0 }),
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        makeSlot(Math.floor((i + 48) / 4), (i + 48) % 4, { buyPrice: 300, sellPrice: 120, consumptionKwh: 1.2 }),
      ),
    ];
    optimizeDispatch(slots, BATTERY_KWH / 2).forEach(({ socAfter, gridKwh }) => {
      expect(socAfter).toBeGreaterThanOrEqual(MIN_SOC - 0.001);
      expect(socAfter).toBeLessThanOrEqual(BATTERY_KWH + 0.001);
      expect(Math.abs(gridKwh)).toBeLessThanOrEqual(SLOT_MAX_KWH + 0.001);
    });
  });

  // ── Arbitrage (sell to grid) ──────────────────────────────────────────────
  it('discharges to sell when the sell price beats the future rebuy cost', () => {
    const slots = [
      makeSlot(6, 0, { sellPrice: 200, buyPrice: 300 }),
      makeSlot(6, 1, { sellPrice: 200, buyPrice: 300 }),
      makeSlot(12, 0, { sellPrice: 20, buyPrice: 100 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH);
    expect(result.slice(0, 2).some((s) => s.action === 'discharge')).toBe(true);
  });

  it('charges from grid when arbitrage is viable, in the cheapest hours', () => {
    const slots = [
      ...Array.from({ length: 24 }, (_, i) => makeSlot(Math.floor(i / 4), i % 4, { buyPrice: 50, sellPrice: 80 })),
      ...Array.from({ length: 72 }, (_, i) => makeSlot(Math.floor((i + 24) / 4), (i + 24) % 4, { buyPrice: 180, sellPrice: 200 })),
    ];
    const result = optimizeDispatch(slots, 0);
    expect(result.slice(0, 24).some((s) => s.action === 'charge')).toBe(true);
  });

  it('does not charge from grid when arbitrage is not viable (sell never beats buy)', () => {
    const result = optimizeDispatch(uniformDay(100, 50), 0);
    result.forEach(({ action }) => expect(action).not.toBe('charge'));
  });

  it('grid-charges in the cheapest hour, not the earliest, before a sell peak', () => {
    // Only ~one slot of energy is needed for the single sell peak, so it should pick the
    // cheapest night hour (50) and skip the pricier earlier ones (80/70/60).
    const night = [
      makeSlot(0, 0, { buyPrice: 80, sellPrice: 10 }),
      makeSlot(0, 1, { buyPrice: 70, sellPrice: 10 }),
      makeSlot(0, 2, { buyPrice: 60, sellPrice: 10 }),
      makeSlot(0, 3, { buyPrice: 50, sellPrice: 10 }),
    ];
    const peak = [makeSlot(1, 0, { buyPrice: 10, sellPrice: 300 })];
    const result = optimizeDispatch([...night, ...peak], MIN_SOC); // empty; must buy to sell at the peak
    expect(result[3].action).toBe('charge'); // buys the cheapest hour (50)
    expect(result[0].action).not.toBe('charge'); // skips the priciest hour (80)
  });

  // ── Order & quantity awareness (the bug this replaced the greedy for) ──────
  it('reserves energy to cover a dearer future load rather than selling it cheaply now', () => {
    // ~2 kWh usable. Could sell at 130 now, but slot 1 needs 2 kWh at buy 300. Selling now then
    // importing at 300 is a loss — hold it to cover the 300. (Fails on the old order-blind greedy.)
    const slots = [
      makeSlot(20, 0, { consumptionKwh: 0, buyPrice: 160, sellPrice: 130 }),
      makeSlot(21, 0, { consumptionKwh: 2.0, buyPrice: 300, sellPrice: 10 }),
      makeSlot(22, 0, { consumptionKwh: 0, buyPrice: 50, sellPrice: 10 }),
    ];
    const result = optimizeDispatch(slots, MIN_SOC + 2.0);
    expect(result[0].gridKwh).toBeGreaterThanOrEqual(-0.05); // does not sell/export at slot 0
    expect(result[1].gridKwh).toBeLessThan(1.5); // the 2 kWh load is largely covered from battery
  });

  it('exports surplus at a high sell price while reserving only what a dear load needs', () => {
    // Full battery, high sell now (200), a small dear deficit later. It should cover that load AND
    // export the surplus now — not hoard the whole battery for a 0.5 kWh future need.
    const slots = [
      makeSlot(18, 0, { consumptionKwh: 0.5, buyPrice: 120, sellPrice: 200 }),
      makeSlot(20, 0, { consumptionKwh: 0.5, buyPrice: 400, sellPrice: 10 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH);
    expect(result[0].gridKwh).toBeLessThan(-1); // exports surplus at the 200 sell price
    expect(result[1].gridKwh).toBeLessThanOrEqual(0.05); // still covers the 400 deficit from battery
  });

  // ── Net-load (self-consumption) ───────────────────────────────────────────
  it('load-shifts: charges during cheap hours, discharges to cover load during the expensive peak', () => {
    const cheap = Array.from({ length: 48 }, (_, i) =>
      makeSlot(Math.floor(i / 4), i % 4, { buyPrice: 50, sellPrice: 10, consumptionKwh: 1.0 }),
    );
    const dear = Array.from({ length: 48 }, (_, i) =>
      makeSlot(Math.floor((i + 48) / 4), (i + 48) % 4, { buyPrice: 300, sellPrice: 10, consumptionKwh: 1.0 }),
    );
    const result = optimizeDispatch([...cheap, ...dear], 0);
    expect(result.slice(0, 48).some((s) => s.action === 'charge')).toBe(true);
    expect(result.slice(48).some((s) => s.action === 'discharge')).toBe(true);
  });

  it('discharges at a meaningful rate — a full-power discharge slot moves SoC by ~SLOT_MAX', () => {
    // A single very expensive load slot the battery must fully serve: SoC should drop by close to
    // the slot's throughput cap (≈10.7% of capacity), not a tiny fraction. Guards the "super low
    // discharge rate" symptom.
    const slots = [
      makeSlot(20, 0, { consumptionKwh: 5.0, solarKwh: 0, buyPrice: 400, sellPrice: 10 }),
      makeSlot(21, 0, { consumptionKwh: 0, solarKwh: 0, buyPrice: 40, sellPrice: 10 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH);
    const drop = BATTERY_KWH - result[0].socAfter;
    expect(drop).toBeGreaterThan(SLOT_MAX_KWH * 0.9); // ~full-power discharge, several % of the pack
  });

  it('covers load from the battery on the priciest deficit slot instead of importing', () => {
    const slots = [
      makeSlot(18, 0, { buyPrice: 300, sellPrice: 10, consumptionKwh: 2.0 }),
      makeSlot(2, 0, { buyPrice: 50, sellPrice: 10, consumptionKwh: 0 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH);
    expect(result[0].action).toBe('discharge');
    expect(result[0].gridKwh).toBeLessThanOrEqual(0.05); // load met by battery, not imported at 300
  });

  it('serves load from solar before importing, and stores the surplus', () => {
    const slots = [
      makeSlot(12, 0, { solarKwh: 2.0, consumptionKwh: 0.5, sellPrice: 5, buyPrice: 300 }),
      makeSlot(13, 0, { solarKwh: 0, consumptionKwh: 0, sellPrice: 150, buyPrice: 300 }),
    ];
    const result = optimizeDispatch(slots, MIN_SOC);
    expect(result[0].gridKwh).toBeLessThanOrEqual(0.01); // solar covers the load → ~no import
    expect(result[0].socAfter).toBeGreaterThan(MIN_SOC + 1.0); // 1.5 kWh surplus stored
  });

  // ── Solar interaction ─────────────────────────────────────────────────────
  it('stores solar to sell later rather than dumping it at a low price now', () => {
    const slots = [
      makeSlot(6, 0, { solarKwh: 2.0, sellPrice: 5, buyPrice: 300 }),
      makeSlot(14, 0, { solarKwh: 0, sellPrice: 150, buyPrice: 300 }),
      makeSlot(15, 0, { solarKwh: 0, sellPrice: 150, buyPrice: 300 }),
    ];
    const result = optimizeDispatch(slots, MIN_SOC);
    expect(result[0].socAfter).toBeGreaterThan(MIN_SOC + 1.0); // stored, not dumped at sell 5
  });

  it('exports solar surplus when the battery is full', () => {
    const slots = [
      makeSlot(10, 0, { solarKwh: 2.0, sellPrice: 80, buyPrice: 300 }),
      makeSlot(14, 0, { solarKwh: 0, sellPrice: 100, buyPrice: 300 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH);
    expect(result[0].solarExportKwh).toBeCloseTo(2.0, 1); // can't store → solar exported
  });

  it('caps solar export at SLOT_MAX_KWH', () => {
    const result = optimizeDispatch([makeSlot(12, 0, { solarKwh: 5.0, sellPrice: 80, buyPrice: 200 })], BATTERY_KWH);
    expect(result[0].solarExportKwh).toBeLessThanOrEqual(SLOT_MAX_KWH + 0.001);
  });

  it('does NOT grid-charge overnight when solar will refill for a load-only evening', () => {
    // Cheap night, big solar by day, expensive-to-BUY but low-to-SELL evening (no sell arbitrage).
    // Free solar refills the battery to cover the evening load, so buying overnight is pointless.
    const night = Array.from({ length: 20 }, (_, i) =>
      makeSlot(Math.floor(i / 4), i % 4, { buyPrice: 50, sellPrice: 10, solarKwh: 0, consumptionKwh: 0.3 }),
    );
    const day = Array.from({ length: 40 }, (_, i) =>
      makeSlot(Math.floor((i + 20) / 4), (i + 20) % 4, { buyPrice: 80, sellPrice: 10, solarKwh: 3.0, consumptionKwh: 0.3 }),
    );
    const evening = Array.from({ length: 36 }, (_, i) =>
      makeSlot(Math.floor((i + 60) / 4), (i + 60) % 4, { buyPrice: 250, sellPrice: 10, solarKwh: 0, consumptionKwh: 0.5 }),
    );
    const result = optimizeDispatch([...night, ...day, ...evening], 5);
    expect(result.slice(0, 20).some((s) => s.action === 'charge')).toBe(false);
  });

  it('still grid-charges overnight on a low-solar day (solar cannot refill)', () => {
    const night = Array.from({ length: 20 }, (_, i) =>
      makeSlot(Math.floor(i / 4), i % 4, { buyPrice: 50, sellPrice: 40, solarKwh: 0, consumptionKwh: 0.5 }),
    );
    const evening = Array.from({ length: 76 }, (_, i) =>
      makeSlot(Math.floor((i + 20) / 4), (i + 20) % 4, { buyPrice: 250, sellPrice: 40, solarKwh: 0, consumptionKwh: 0.5 }),
    );
    const result = optimizeDispatch([...night, ...evening], 2);
    expect(result.slice(0, 20).some((s) => s.action === 'charge')).toBe(true);
  });

  // ── Negative prices ───────────────────────────────────────────────────────
  // Exporting at a negative sell price is a real cost (you pay to export), captured directly by
  // the DP's cost term `-gridExport * sellPrice` (which becomes positive when sellPrice < 0).
  // These lock in that the optimizer never treats a negative-price export as free or beneficial.

  it('stores solar surplus in the battery instead of exporting it at a negative price', () => {
    const slots = [
      makeSlot(12, 0, { solarKwh: 2.0, consumptionKwh: 0, sellPrice: -50, buyPrice: 200 }),
      makeSlot(13, 0, { solarKwh: 0, consumptionKwh: 0, sellPrice: 80, buyPrice: 200 }),
    ];
    const result = optimizeDispatch(slots, MIN_SOC); // plenty of room to store it
    expect(result[0].solarExportKwh).toBeCloseTo(0, 1); // not dumped to the grid at a loss
    expect(result[0].socAfter).toBeGreaterThan(MIN_SOC + 1.5); // stored instead
  });

  it('never discharges to export purely for arbitrage when the sell price is negative', () => {
    // Full battery, negative sell all day, no load: exporting would only cost money, never help.
    const result = optimizeDispatch(uniformDay(60, -50), BATTERY_KWH);
    result.forEach(({ gridKwh }) => expect(gridKwh).toBeGreaterThanOrEqual(-0.01)); // no net export
  });

  it('does not grid-charge when the sell price is negative (no arbitrage to capture)', () => {
    const result = optimizeDispatch(uniformDay(60, -50), MIN_SOC);
    result.forEach(({ action }) => expect(action).not.toBe('charge'));
  });

  it('curtailment gap: still forced to export at a loss if the battery is already full and cannot absorb more solar', () => {
    // Documents a real hardware/control limitation: the software has no lever to curtail PV
    // production, so once the battery has zero headroom, unstoppable solar surplus goes to the
    // grid regardless of price. Not a bug — there is no software-only alternative today.
    const result = optimizeDispatch(
      [makeSlot(12, 0, { solarKwh: 5.0, consumptionKwh: 0, sellPrice: -50, buyPrice: 200 })],
      BATTERY_KWH, // already full — no room to store any of the surplus
    );
    expect(result[0].solarExportKwh).toBeGreaterThan(0);
  });

  // ── Idle vs auto-charge (fixed 2026-07-03) ──────────────────────────────────
  // 'idle' used to be modeled as "SoC holds steady, 100% of solar surplus exported" — wrong,
  // because a real hybrid inverter left on auto/self-use always charges the battery from
  // surplus before exporting it. These lock in that an idle slot's socAfter now reflects that
  // free auto-charge, distinguishing it from an actively-forced 'charge' (which means MORE than
  // solar alone provides, e.g. grid-funded).

  it('an idle slot still charges the battery from solar surplus instead of exporting all of it', () => {
    // A later high-price slot gives a clear, unambiguous reason to hold what auto-charges in —
    // without it, flat pricing (or a battery already near-empty/-full) makes "top up now, sell
    // whenever" and "sell immediately" cost-equivalent, which tests two different behaviors at
    // once (auto-charging AND the separate, pre-existing "spend down by the terminal slot"
    // policy) instead of isolating just the auto-charge fix.
    //
    // Two things need to stay true for this to isolate ONLY the auto-charge behavior:
    //  - Net solar surplus stays well under SLOT_MAX_KWH (2.75) per slot AND in total, so the
    //    single high-price slot can actually sell everything accumulated — otherwise the model
    //    correctly (not a bug) dumps the un-sellable excess early rather than waste it at the
    //    terminal slot's zero leftover-SoC value, which is a real behavior but not this one.
    //  - buyPrice stays above the round-trip breakeven for the future sell price (~sellPrice ×
    //    0.96, minus wear — here 200 × 0.96 ≈ 192, so buyPrice must clear roughly 187) —
    //    otherwise grid-funded arbitrage charging becomes genuinely worth it on its own, which
    //    would correctly show up as an ACTIVE 'charge' rather than the free 'idle' this test
    //    means to isolate.
    const slots = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeSlot(12, i, { solarKwh: 1.0, consumptionKwh: 0.2, sellPrice: 25, buyPrice: 250 }),
      ),
      makeSlot(18, 0, { solarKwh: 0, consumptionKwh: 0, sellPrice: 200, buyPrice: 300 }),
    ];
    const result = optimizeDispatch(slots, MIN_SOC);
    expect(result[0].action).toBe('idle');
    expect(result[1].action).toBe('idle');
    expect(result[0].socAfter).toBeGreaterThan(MIN_SOC + 0.5); // real auto-charge, not flat
    expect(result[1].socAfter).toBeGreaterThan(result[0].socAfter + 0.5); // keeps climbing
  });

  it('an idle slot only exports the residual after auto-charging, not the full solar surplus', () => {
    const result = optimizeDispatch(
      [makeSlot(12, 0, { solarKwh: 2.0, consumptionKwh: 0.2, sellPrice: 25, buyPrice: 110 })],
      MIN_SOC,
    );
    expect(result[0].action).toBe('idle');
    // solarRem here is 1.8 kWh; auto-charging consumes most of it, so export should be far
    // below the full 1.8 kWh the old (buggy) model would have shown.
    expect(result[0].solarExportKwh).toBeLessThan(0.2);
  });

  it('idle auto-charge still respects the per-slot throughput cap when solar exceeds it', () => {
    const result = optimizeDispatch(
      [makeSlot(12, 0, { solarKwh: 10.0, consumptionKwh: 0, sellPrice: 25, buyPrice: 110 })],
      MIN_SOC, // plenty of headroom — the binding limit here is SLOT_MAX_KWH, not capacity
    );
    expect(result[0].action).toBe('idle');
    expect(result[0].socAfter - MIN_SOC).toBeLessThanOrEqual(SLOT_MAX_KWH + 0.01);
    expect(result[0].solarExportKwh).toBeGreaterThan(0); // the excess beyond the cap is exported
  });

  it('idle auto-charge stops at full capacity instead of overshooting it', () => {
    // Negative sell price (same trick as the existing "curtailment gap" test above) removes any
    // incentive to discharge — exporting would cost money — isolating just "does the free
    // auto-charge stop exactly at capacity" from the near-full battery's much larger unrelated
    // question of whether to liquidate its existing charge (which, started already near-full,
    // holds far more energy than any single slot could ever sell anyway; see SLOT_MAX_KWH).
    const result = optimizeDispatch(
      [makeSlot(12, 0, { solarKwh: 2.0, consumptionKwh: 0, sellPrice: -50, buyPrice: 200 })],
      BATTERY_KWH - 0.1, // almost full — headroom is the binding limit, not SLOT_MAX_KWH
    );
    expect(result[0].action).toBe('idle');
    expect(result[0].socAfter).toBeCloseTo(BATTERY_KWH, 2);
  });

  it('still labels it "charge" (not idle) when it is worth actively importing MORE than solar alone provides', () => {
    // A steep future price spike makes it worth grid-charging beyond what free solar gives —
    // this must still show up as an active 'charge' (dispatch_loop.py needs to know to force it).
    const slots = [
      makeSlot(6, 0, { solarKwh: 0.5, consumptionKwh: 0, sellPrice: 10, buyPrice: 20 }), // cheap grid too
      makeSlot(20, 0, { solarKwh: 0, consumptionKwh: 0, sellPrice: 300, buyPrice: 300 }), // huge spike
    ];
    const result = optimizeDispatch(slots, MIN_SOC);
    expect(result[0].action).toBe('charge');
    expect(result[0].gridKwh).toBeGreaterThan(0); // real grid import, beyond free solar
  });

  it('discharge still overrides auto-charging — forced discharge does not also soak up solar', () => {
    // High load, no better use for solar than covering it directly and exporting the rest — the
    // model should not simultaneously claim a 'discharge' AND a hidden auto-charge in the same slot.
    const slots = [
      makeSlot(18, 0, { solarKwh: 1.0, consumptionKwh: 4.0, sellPrice: 100, buyPrice: 300 }),
      makeSlot(19, 0, { solarKwh: 0, consumptionKwh: 0, sellPrice: 10, buyPrice: 300 }),
    ];
    const result = optimizeDispatch(slots, BATTERY_KWH * 0.9);
    expect(result[0].action).toBe('discharge');
    expect(result[0].socAfter).toBeLessThan(BATTERY_KWH * 0.9);
  });
});

// ── Oracle support: evaluateDispatch + terminal constraint (added for lib/oracle.ts) ─────────

/** A price/solar/load-varied two-day horizon rich enough that dispatch actually matters. */
function variedDay(dayOffset: number): OptimizerSlot[] {
  return Array.from({ length: 96 }, (_, i) => {
    const hour = Math.floor(i / 4);
    const solar = hour >= 8 && hour < 18 ? 1.5 * Math.sin((Math.PI * (hour - 8)) / 10) : 0;
    return makeSlot(hour, i % 4, {
      buyPrice: 100 + 80 * Math.sin((2 * Math.PI * (i + dayOffset * 17)) / 96) + (dayOffset ? 30 : 0),
      sellPrice: 30 + 60 * Math.sin((2 * Math.PI * (i + 30 + dayOffset * 17)) / 96) + (dayOffset ? 20 : 0),
      solarKwh: Math.max(0, solar),
      consumptionKwh: 0.3 + (hour >= 17 && hour < 22 ? 0.4 : 0),
    });
  });
}

describe('evaluateDispatch', () => {
  it('values a hand-checkable single discharge-to-load slot correctly', () => {
    // 2 kWh load, no solar, dear buy price, sell price BELOW the ~2.4 öre/kWh wear breakeven so
    // discharging beyond the load to export is a loss (with sell above breakeven the optimum
    // really is to keep discharging to the throughput cap — worth knowing, not what's tested
    // here). Optimal is then to cover (essentially) the whole load; the ~0.12 kWh SoC grid means
    // delivered energy can over/undershoot by up to one step, so assertions allow that quantum.
    const slots = [makeSlot(19, 0, { consumptionKwh: 2.0, solarKwh: 0, buyPrice: 300, sellPrice: 1 })];
    const dispatch = optimizeDispatch(slots, 10);
    const evald = evaluateDispatch(slots, dispatch, 10);
    const dSoc = 10 - dispatch[0].socAfter;
    const delivered = dSoc * Math.sqrt(BATTERY_RT_EFF);
    const step = (BATTERY_KWH - MIN_SOC) / 192;
    expect(Math.abs(delivered - 2.0)).toBeLessThanOrEqual(step + 1e-9); // covers the load ± one grid step
    // Cash is the priced residual of that quantisation: an import residual costs ×300, an
    // export residual earns ×1 — either way bounded by one step's worth of energy.
    expect(evald.cashOre).toBeGreaterThanOrEqual(-step * 300 - 1e-9);
    expect(evald.cashOre).toBeLessThanOrEqual(step * 1 + 1e-9);
    expect(evald.wearOre).toBeCloseTo(dSoc * BATTERY_WEAR_COST_ORE_PER_KWH, 1);
    expect(evald.valueOre).toBeCloseTo(evald.cashOre - evald.wearOre, 6);
  });

  it('the DP optimum evaluates ≥ any other feasible trajectory over the same slots', () => {
    // Feasible alternatives generated by optimizing against DIFFERENT prices but the same
    // solar/load — same physics, same natural auto-charge floor, so they are valid trajectories
    // for the real slots. None may beat the real optimum on the real slots.
    const slots = variedDay(0);
    const startSoc = 8;
    const optimal = evaluateDispatch(slots, optimizeDispatch(slots, startSoc), startSoc);
    const distortions: ((s: OptimizerSlot) => OptimizerSlot)[] = [
      (s) => ({ ...s, buyPrice: 100, sellPrice: 50 }), // flat prices
      (s) => ({ ...s, buyPrice: s.sellPrice + 60, sellPrice: Math.max(0, s.buyPrice - 100) }), // scrambled
      (s) => ({ ...s, buyPrice: 400 - s.buyPrice / 2, sellPrice: s.sellPrice / 2 }), // inverted
    ];
    for (const distort of distortions) {
      const alt = optimizeDispatch(slots.map(distort), startSoc);
      const altValue = evaluateDispatch(slots, alt, startSoc).valueOre;
      expect(altValue).toBeLessThanOrEqual(optimal.valueOre + 0.01);
    }
  });
});

describe('optimizeDispatch with endSoc (terminal constraint)', () => {
  it('ends within one discretisation step of the requested SoC', () => {
    const slots = variedDay(0);
    const step = (BATTERY_KWH - MIN_SOC) / 192;
    for (const target of [MIN_SOC + 1, 12, 20]) {
      const result = optimizeDispatch(slots, 10, { endSoc: target });
      expect(Math.abs(result[result.length - 1].socAfter - target)).toBeLessThanOrEqual(2 * step + 1e-9);
    }
  });

  it('constrained value never exceeds the unconstrained optimum', () => {
    const slots = variedDay(0);
    const startSoc = 10;
    const free = evaluateDispatch(slots, optimizeDispatch(slots, startSoc), startSoc).valueOre;
    for (const target of [MIN_SOC + 0.5, 8, 15, 22]) {
      const constrained = optimizeDispatch(slots, startSoc, { endSoc: target });
      const value = evaluateDispatch(slots, constrained, startSoc).valueOre;
      expect(value).toBeLessThanOrEqual(free + 0.01);
    }
  });

  it('holding the start SoC is always reachable and sacrifices little vs unconstrained', () => {
    // endSoc = startSoc is the trivially feasible "do nothing different at the boundary" case;
    // it must never throw regardless of prices.
    const slots = variedDay(1);
    expect(() => optimizeDispatch(slots, 14, { endSoc: 14 })).not.toThrow();
  });

  it('throws when the target is physically unreachable in the given slots', () => {
    // One slot can move SoC by at most SLOT_MAX_KWH/√η ≈ 2.8 kWh — full from the floor is fantasy.
    const slots = [makeSlot(12, 0, {})];
    expect(() => optimizeDispatch(slots, MIN_SOC, { endSoc: BATTERY_KWH })).toThrow(/unreachable/);
  });

  it('clamps a target below the discharge floor up to the floor instead of violating it', () => {
    const slots = variedDay(0).slice(0, 8);
    const result = optimizeDispatch(slots, MIN_SOC + 3, { endSoc: 0 });
    const last = result[result.length - 1].socAfter;
    expect(last).toBeGreaterThanOrEqual(MIN_SOC - 0.001);
    expect(last).toBeLessThanOrEqual(MIN_SOC + 0.3); // still drains as close to the floor as allowed
  });
});
