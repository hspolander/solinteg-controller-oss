import { describe, it, expect } from 'vitest';
import { optimizeDispatch, evaluateDispatch, BATTERY_MIN_SOC_KWH } from '../optimizer';
import type { OptimizerSlot } from '../optimizer';

// PV per 15-min slot: 2.0 kWh = 8 kW (> the 3 kW threshold 0.75 kWh/slot, under cap 2.75).
const PV = 2.0;

function slot(i: number, o: Partial<Omit<OptimizerSlot, 'startTime'>>): OptimizerSlot {
  const h = String(Math.floor(i / 4)).padStart(2, '0');
  const m = String((i % 4) * 15).padStart(2, '0');
  return { startTime: `2026-06-28T${h}:${m}:00`, buyPrice: 150, sellPrice: 80, solarKwh: 0, consumptionKwh: 0, ...o };
}

// Day favorable for hold: morning (h9-10) with high sell price + large solar surplus, abundant but
// very cheap afternoon (h11-18), evening peak (h19-21) that is the day's highest price. The battery
// starts nearly full → its charge is saved for the evening; the morning surplus is best to
// export now (high) and refill from the abundant afternoon solar. => the DP should choose hold.
function favorableDay(pv = PV, morningSell = 120): OptimizerSlot[] {
  return Array.from({ length: 96 }, (_, i) => {
    const h = Math.floor(i / 4);
    if (h === 9 || h === 10) return slot(i, { solarKwh: pv, buyPrice: 180, sellPrice: morningSell });
    if (h >= 11 && h <= 18) return slot(i, { solarKwh: pv, buyPrice: 40, sellPrice: 10 });
    if (h >= 19 && h <= 21) return slot(i, { solarKwh: 0, buyPrice: 200, sellPrice: 150 });
    return slot(i, { solarKwh: 0, buyPrice: 150, sellPrice: 80 });
  });
}
// Start at the floor: nothing to discharge in the morning, so the choice is purely between STORING
// the morning surplus or HOLDING (export now at 120 and fill the battery from the abundant
// afternoon solar ahead of the evening peak). With a nearly full start the DP instead chooses
// a double cycle (discharge in the morning + refill) — another, valid behavior.
const START = BATTERY_MIN_SOC_KWH;

describe('hold mode (gated)', () => {
  it('chooses hold when all three gates apply — freezes SoC and exports the solar surplus', () => {
    const day = favorableDay();
    const withHold = optimizeDispatch(day, START, { holdEnabled: true });
    const noHold = optimizeDispatch(day, START, { holdEnabled: false });

    const holds = withHold.filter((d) => d.action === 'hold');
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds) {
      expect(h.solarExportKwh).toBeGreaterThan(0); // exports solar
      expect(h.gridToBatteryKwh).toBeLessThan(1e-6); // does not charge from grid
    }
    // Without the flag there is never hold, and the same morning slot stores instead (higher SoC).
    expect(noHold.some((d) => d.action === 'hold')).toBe(false);
    const idx = withHold.findIndex((d) => d.action === 'hold');
    expect(withHold[idx].socAfter).toBeLessThan(noHold[idx].socAfter - 1e-6);
  });

  it('optimality: the hold plan is worth at least as much as the hold-free one', () => {
    const day = favorableDay();
    const vHold = evaluateDispatch(day, optimizeDispatch(day, START, { holdEnabled: true }), START).valueOre;
    const vNo = evaluateDispatch(day, optimizeDispatch(day, START, { holdEnabled: false }), START).valueOre;
    expect(vHold).toBeGreaterThanOrEqual(vNo - 1e-6);
  });

  it('default (no flag) is bit-identical to holdEnabled:false', () => {
    const day = favorableDay();
    expect(optimizeDispatch(day, START)).toEqual(optimizeDispatch(day, START, { holdEnabled: false }));
  });

  it('gate 2 required: PV at/below the 3 kW threshold → no hold', () => {
    const day = favorableDay(0.75); // exactly the threshold; the requirement is > 3 kW
    expect(optimizeDispatch(day, START, { holdEnabled: true }).some((d) => d.action === 'hold')).toBe(false);
  });

  it('gate 1 required: prices not heading down → no hold', () => {
    const day = favorableDay(PV, 20); // morning sell 20 < cheapest buy ahead (40) → no price drop
    expect(optimizeDispatch(day, START, { holdEnabled: true }).some((d) => d.action === 'hold')).toBe(false);
  });

  it('gate 3 required: 12 h of solar not enough to fill the battery → no hold', () => {
    // Empty battery (large headroom) + no afternoon solar → refill < 1.1 × headroom.
    const day = Array.from({ length: 96 }, (_, i) => {
      const h = Math.floor(i / 4);
      if (h === 9 || h === 10) return slot(i, { solarKwh: PV, buyPrice: 180, sellPrice: 120 });
      if (h >= 19 && h <= 21) return slot(i, { solarKwh: 0, buyPrice: 200, sellPrice: 150 });
      return slot(i, { solarKwh: 0, buyPrice: 150, sellPrice: 80 }); // no afternoon solar
    });
    expect(
      optimizeDispatch(day, BATTERY_MIN_SOC_KWH, { holdEnabled: true }).some((d) => d.action === 'hold'),
    ).toBe(false);
  });
});
