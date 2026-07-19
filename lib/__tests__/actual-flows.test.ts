import { describe, it, expect } from 'vitest';
import {
  attributeReadingFlows,
  bucketActualFlows,
  actualFlowsByTime,
  buildActualFlowsByTime,
} from '../actual-flows';
import type { FlowReading } from '../actual-flows';
import type { PriceSlot } from '../prices';

function makePrice(startTime: string): PriceSlot {
  return { startTime, endTime: startTime, price: 50, priceIncludingTaxAndSurcharge: 120 };
}

function makeReading(timestamp: string, pv_w: number | null, house_load_w: number | null, battery_w: number | null): FlowReading {
  return { timestamp, pv_w, house_load_w, battery_w };
}

// ─── attributeReadingFlows ───────────────────────────────────────────────────

describe('attributeReadingFlows', () => {
  it('grid charge only: no solar, no load', () => {
    const f = attributeReadingFlows(0, 0, -2000);
    expect(f).toEqual({ gridToBatteryW: 2000, batteryToGridW: 0, batteryToLoadW: 0, loadFromGridW: 0 });
  });

  it('solar charge only: solar fully covers the charge, nothing from grid', () => {
    const f = attributeReadingFlows(3000, 0, -2000);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 0, batteryToLoadW: 0, loadFromGridW: 0 });
  });

  it('mixed funding: solar covers load, remaining solar partially funds the charge, grid tops up the rest', () => {
    const f = attributeReadingFlows(1000, 500, -2000);
    // solarToLoad=500 (covers load fully); remaining solar 500 → charge; grid covers 2000-500=1500
    expect(f).toEqual({ gridToBatteryW: 1500, batteryToGridW: 0, batteryToLoadW: 0, loadFromGridW: 0 });
  });

  it('discharge-to-load only: battery covers less than the full load, grid covers the rest', () => {
    const f = attributeReadingFlows(0, 1000, 800);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 0, batteryToLoadW: 800, loadFromGridW: 200 });
  });

  it('discharge sell+load: battery covers load fully and exports the surplus', () => {
    const f = attributeReadingFlows(0, 500, 2000);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 1500, batteryToLoadW: 500, loadFromGridW: 0 });
  });

  it('zero-load sell: pure export, nothing to cover', () => {
    const f = attributeReadingFlows(0, 0, 2000);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 2000, batteryToLoadW: 0, loadFromGridW: 0 });
  });

  it('clamps negative pv/load noise to zero', () => {
    const f = attributeReadingFlows(-50, -10, 500);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 500, batteryToLoadW: 0, loadFromGridW: 0 });
  });

  it('idle (battery_w exactly 0) is treated as charging with need=0', () => {
    const f = attributeReadingFlows(0, 500, 0);
    expect(f).toEqual({ gridToBatteryW: 0, batteryToGridW: 0, batteryToLoadW: 0, loadFromGridW: 500 });
  });
});

// ─── bucketActualFlows ───────────────────────────────────────────────────────

describe('bucketActualFlows', () => {
  const windowStartMs = Date.parse('2026-06-28T00:00:00.000Z');

  it('indexes readings into the correct slot by elapsed time since windowStartMs', () => {
    const rows = [
      makeReading('2026-06-28T00:20:00.000Z', 0, 0, -2000), // slot 1 (00:15-00:30)
    ];
    const flows = bucketActualFlows(rows, windowStartMs, 4);
    expect(flows[0]).toBeNull();
    expect(flows[1]).not.toBeNull();
    expect(flows[1]!.gridToBatteryKwh).toBeCloseTo(0.5); // 2000 W × 0.25 h / 1000
    expect(flows[2]).toBeNull();
  });

  it('averages multiple readings landing in the same slot (mean W × 0.25 h)', () => {
    const rows = [
      makeReading('2026-06-28T00:01:00.000Z', 0, 0, -1000),
      makeReading('2026-06-28T00:08:00.000Z', 0, 0, -3000),
    ];
    const flows = bucketActualFlows(rows, windowStartMs, 1);
    // mean 2000 W over the slot → 0.5 kWh
    expect(flows[0]!.gridToBatteryKwh).toBeCloseTo(0.5);
  });

  it('a slot with zero contributing readings is null, not zero-filled', () => {
    const flows = bucketActualFlows([], windowStartMs, 3);
    expect(flows).toEqual([null, null, null]);
  });

  it('skips readings outside the [0, slotCount) range', () => {
    const rows = [
      makeReading('2026-06-27T23:00:00.000Z', 0, 0, -2000), // before window
      makeReading('2026-06-28T02:00:00.000Z', 0, 0, -2000), // past a 4-slot window
    ];
    const flows = bucketActualFlows(rows, windowStartMs, 4);
    expect(flows.every((f) => f === null)).toBe(true);
  });

  it('skips readings missing any of the three physical fields', () => {
    const rows = [
      makeReading('2026-06-28T00:05:00.000Z', null, 0, -2000),
      makeReading('2026-06-28T00:06:00.000Z', 0, null, -2000),
      makeReading('2026-06-28T00:07:00.000Z', 0, 0, null),
    ];
    const flows = bucketActualFlows(rows, windowStartMs, 1);
    expect(flows[0]).toBeNull();
  });

  it('a sign flip within one slot accumulates both sides by construction', () => {
    const rows = [
      makeReading('2026-06-28T00:02:00.000Z', 0, 0, -2000), // charging
      makeReading('2026-06-28T00:10:00.000Z', 0, 500, 2000), // discharging + selling
    ];
    const flows = bucketActualFlows(rows, windowStartMs, 1);
    expect(flows[0]!.gridToBatteryKwh).toBeGreaterThan(0);
    expect(flows[0]!.batteryToGridKwh).toBeGreaterThan(0);
  });
});

// ─── actualFlowsByTime ───────────────────────────────────────────────────────

describe('actualFlowsByTime', () => {
  const windowStartMs = Date.parse('2026-06-28T00:00:00.000Z');
  const prices = [makePrice('2026-06-28T00:00:00'), makePrice('2026-06-28T00:15:00'), makePrice('2026-06-28T00:30:00')];

  it('keys bucketed flows by the price array own startTime strings, index-aligned', () => {
    const flows = [
      { gridToBatteryKwh: 1, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 },
      null,
      { gridToBatteryKwh: 2, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 },
    ];
    const nowMs = windowStartMs + 3 * 900_000; // all three slots fully elapsed
    const out = actualFlowsByTime(prices, flows, windowStartMs, nowMs);
    expect(out['2026-06-28T00:00:00']!.gridToBatteryKwh).toBe(1);
    expect(out['2026-06-28T00:15:00']).toBeUndefined(); // null flow — no data
    expect(out['2026-06-28T00:30:00']!.gridToBatteryKwh).toBe(2);
  });

  it('drops a slot still in progress (end instant after nowMs)', () => {
    const flows = [
      { gridToBatteryKwh: 1, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 },
      { gridToBatteryKwh: 1, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 },
      { gridToBatteryKwh: 1, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 },
    ];
    const nowMs = windowStartMs + 900_000 + 300_000; // 5 min into slot 1 — slot 1 not yet ended
    const out = actualFlowsByTime(prices, flows, windowStartMs, nowMs);
    expect(out['2026-06-28T00:00:00']).toBeDefined(); // slot 0 fully elapsed
    expect(out['2026-06-28T00:15:00']).toBeUndefined(); // slot 1 still in progress
    expect(out['2026-06-28T00:30:00']).toBeUndefined(); // slot 2 in the future
  });

  it('includes a slot exactly at its end instant (inclusive boundary)', () => {
    const flows = [{ gridToBatteryKwh: 1, batteryToGridKwh: 0, batteryToLoadKwh: 0, loadFromGridKwh: 0 }];
    const nowMs = windowStartMs + 900_000; // exactly slot 0's end instant
    const out = actualFlowsByTime([prices[0]], flows, windowStartMs, nowMs);
    expect(out['2026-06-28T00:00:00']).toBeDefined();
  });
});

// ─── buildActualFlowsByTime ──────────────────────────────────────────────────

describe('buildActualFlowsByTime', () => {
  it('filters to todayDate slots and derives the Stockholm-midnight window from the date string', () => {
    const prices = [
      makePrice('2026-06-28T00:00:00'),
      makePrice('2026-06-28T00:15:00'),
      makePrice('2026-06-29T00:00:00'), // tomorrow — must be excluded
    ];
    // 2026-06-28T00:00 Stockholm (CEST +2) = 2026-06-27T22:00:00Z
    const midnightUtcMs = Date.parse('2026-06-27T22:00:00.000Z');
    const rows: FlowReading[] = [
      { timestamp: '2026-06-27T22:05:00.000Z', pv_w: 0, house_load_w: 0, battery_w: -2000 }, // slot 0
    ];
    const nowMs = midnightUtcMs + 2 * 900_000; // both today slots fully elapsed
    const out = buildActualFlowsByTime(prices, '2026-06-28', rows, nowMs);
    expect(out['2026-06-28T00:00:00']!.gridToBatteryKwh).toBeCloseTo(0.5);
    expect(out['2026-06-28T00:15:00']).toBeUndefined(); // no readings that slot
    expect(out['2026-06-29T00:00:00']).toBeUndefined(); // excluded — not today
  });
});
