import { describe, it, expect } from 'vitest';
import {
  buildActionBands,
  buildActualSocByTime,
  buildAreaPath,
  buildChartData,
  buildChartGeometry,
  buildLinePath,
  buildTimeIndex,
  buildXTicks,
  computeNowSlotTime,
  computePriceMax,
  computePriceMin,
  computeSolarMax,
  indexToX,
  priceYScale,
  socYScale,
  solarYScale,
  timeToX,
} from '../chart-utils';
import { SKATT_OVERFÖRING, BATTERY_KWH, BATTERY_MIN_SOC_KWH } from '../constants';
import type { ChartPoint } from '../chart-utils';
import type { DispatchSlot } from '../optimizer';
import type { PriceSlot } from '../prices';

function makePoint(time: string, overrides: Partial<ChartPoint> = {}): ChartPoint {
  return {
    time,
    buy: 100,
    sell: 60,
    socPct: null,
    actualSocPct: null,
    solarKwh: 0,
    solarSource: 'typical',
    action: 'idle',
    decision: null,
    ...overrides,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDispatch(
  startTime: string,
  action: DispatchSlot['action'],
  overrides: Partial<DispatchSlot> = {},
): DispatchSlot {
  return {
    startTime,
    action,
    gridKwh: 0,
    solarExportKwh: 0,
    batteryToGridKwh: 0,
    gridToBatteryKwh: 0,
    batteryToLoadKwh: 0,
    loadFromGridKwh: 0,
    socAfter: 12,
    ...overrides,
  };
}

function makePrice(startTime: string, price = 100, priceIncludingTaxAndSurcharge = 140): PriceSlot {
  return { startTime, endTime: startTime, price, priceIncludingTaxAndSurcharge };
}

// ─── buildActionBands ─────────────────────────────────────────────────────────

describe('buildActionBands', () => {
  const FLOOR = BATTERY_MIN_SOC_KWH;

  it('returns empty array for empty schedule', () => {
    expect(buildActionBands([], FLOOR)).toEqual([]);
  });

  it('returns empty array when all slots are default behaviour (idle, no grid-covered load)', () => {
    const schedule = [
      makeDispatch('2026-06-28T08:00:00', 'idle'),
      makeDispatch('2026-06-28T08:15:00', 'idle'),
    ];
    expect(buildActionBands(schedule, FLOOR)).toEqual([]);
  });

  it('grid-funded charge = buy; solar-funded charge is default behaviour, no band', () => {
    const buy = buildActionBands(
      [makeDispatch('2026-06-28T10:00:00', 'charge', { gridToBatteryKwh: 2.0, gridKwh: 2.0 })],
      FLOOR,
    );
    expect(buy[0]).toEqual({ x1: '2026-06-28T10:00:00', x2: '2026-06-28T10:00:00', kind: 'buy' });
    // solar-funded charge while the house imports a little for load is NOT a buy decision —
    // exactly the case net gridKwh misclassified before attribution existed
    expect(
      buildActionBands(
        [makeDispatch('2026-06-28T10:00:00', 'charge', { gridKwh: 0.2, loadFromGridKwh: 0.05 })],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it('battery export = sell; discharge covering load is default behaviour, no band', () => {
    const sell = buildActionBands(
      [makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToGridKwh: 2.0, gridKwh: -2.0 })],
      FLOOR,
    );
    expect(sell[0].kind).toBe('sell');
    expect(
      buildActionBands(
        [makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToLoadKwh: 0.4 })],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it('sub-threshold battery-grid flows are slot slop, not decisions (< 0.5 kWh/slot)', () => {
    expect(
      buildActionBands([makeDispatch('2026-06-28T10:00:00', 'charge', { gridToBatteryKwh: 0.4 })], FLOOR),
    ).toEqual([]);
    expect(
      buildActionBands([makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToGridKwh: 0.33 })], FLOOR),
    ).toEqual([]);
  });

  it('hold: grid covers load while the battery sits on usable charge', () => {
    const hold = buildActionBands(
      [makeDispatch('2026-06-28T05:00:00', 'idle', { loadFromGridKwh: 0.4, socAfter: FLOOR + 5 })],
      FLOOR,
    );
    expect(hold[0]).toEqual({ x1: '2026-06-28T05:00:00', x2: '2026-06-28T05:00:00', kind: 'hold' });
  });

  it('hold requires usable charge — a battery at/near the floor is not holding back', () => {
    expect(
      buildActionBands(
        [makeDispatch('2026-06-28T05:00:00', 'idle', { loadFromGridKwh: 0.4, socAfter: FLOOR + 0.5 })],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it('hold ignores discretisation slop (< one DP SoC step of grid-covered load)', () => {
    expect(
      buildActionBands(
        [
          makeDispatch('2026-06-28T21:00:00', 'discharge', {
            batteryToLoadKwh: 0.3,
            loadFromGridKwh: 0.12,
            socAfter: FLOOR + 5,
          }),
        ],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it('buy/sell decisions take priority over hold on the same slot', () => {
    const bands = buildActionBands(
      [makeDispatch('2026-06-28T03:00:00', 'charge', { gridToBatteryKwh: 2.0, loadFromGridKwh: 0.5 })],
      FLOOR,
    );
    expect(bands[0].kind).toBe('buy');
  });

  it('merges consecutive same-kind slots into one band', () => {
    const schedule = [
      makeDispatch('2026-06-28T10:00:00', 'charge', { gridToBatteryKwh: 2.0 }),
      makeDispatch('2026-06-28T10:15:00', 'charge', { gridToBatteryKwh: 2.0 }),
      makeDispatch('2026-06-28T10:30:00', 'charge', { gridToBatteryKwh: 2.0 }),
    ];
    const bands = buildActionBands(schedule, FLOOR);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toEqual({ x1: '2026-06-28T10:00:00', x2: '2026-06-28T10:30:00', kind: 'buy' });
  });

  it('a sub-threshold slot inside a sell run splits it — the pause is signal, never merged over', () => {
    const schedule = [
      makeDispatch('2026-06-28T20:30:00', 'discharge', { batteryToGridKwh: 2.5 }),
      makeDispatch('2026-06-28T20:45:00', 'discharge', { batteryToLoadKwh: 0.3 }), // price dip: covers load only
      makeDispatch('2026-06-28T21:00:00', 'discharge', { batteryToGridKwh: 2.4 }),
    ];
    const bands = buildActionBands(schedule, FLOOR);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({ x1: '2026-06-28T20:30:00', x2: '2026-06-28T20:30:00', kind: 'sell' });
    expect(bands[1]).toEqual({ x1: '2026-06-28T21:00:00', x2: '2026-06-28T21:00:00', kind: 'sell' });
  });

  it('creates separate bands for different kinds, skipping default slots', () => {
    const schedule = [
      makeDispatch('2026-06-28T08:00:00', 'charge', { gridToBatteryKwh: 2.0 }), // buy
      makeDispatch('2026-06-28T08:15:00', 'idle'),
      makeDispatch('2026-06-28T14:00:00', 'discharge', { batteryToGridKwh: 2.0 }), // sell
      makeDispatch('2026-06-28T14:15:00', 'discharge', { batteryToGridKwh: 2.0 }),
    ];
    const bands = buildActionBands(schedule, FLOOR);
    expect(bands).toHaveLength(2);
    expect(bands[0]).toEqual({ x1: '2026-06-28T08:00:00', x2: '2026-06-28T08:00:00', kind: 'buy' });
    expect(bands[1]).toEqual({ x1: '2026-06-28T14:00:00', x2: '2026-06-28T14:15:00', kind: 'sell' });
  });

  it('does not merge adjacent slots of different kinds (hold vs sell)', () => {
    const schedule = [
      makeDispatch('2026-06-28T19:45:00', 'idle', { loadFromGridKwh: 0.4, socAfter: FLOOR + 5 }), // hold
      makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToGridKwh: 2.0 }), // sell
    ];
    const bands = buildActionBands(schedule, FLOOR);
    expect(bands).toHaveLength(2);
    expect(bands.map((b) => b.kind)).toEqual(['hold', 'sell']);
  });
});

// ─── buildChartData ───────────────────────────────────────────────────────────

describe('buildChartData', () => {
  const profiles: Record<number, number[]> = {
    6: Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 16 ? 4.0 : 0)),
  };

  it('sell = price field (spot + export bonus, folded in upstream); buy = priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING (both shown)', () => {
    const prices = [makePrice('2026-06-28T12:00:00', 80, 120)];
    const [pt] = buildChartData(prices, null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.sell).toBe(80);
    expect(pt.buy).toBe(120 + SKATT_OVERFÖRING);
  });

  it('action comes from dispatchByTime lookup', () => {
    const prices = [makePrice('2026-06-28T10:00:00')];
    const dispatchByTime = { '2026-06-28T10:00:00': makeDispatch('2026-06-28T10:00:00', 'charge') };
    const [pt] = buildChartData(prices, null, profiles, dispatchByTime, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.action).toBe('charge');
    expect(pt.socPct).toBeCloseTo((12 / BATTERY_KWH) * 100, 1); // socAfter 12 kWh
  });

  it('socPct is null when the slot has no dispatch plan', () => {
    const [pt] = buildChartData([makePrice('2026-06-28T10:00:00')], null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.socPct).toBeNull();
  });

  it('action defaults to idle when slot is not in dispatchByTime', () => {
    const prices = [makePrice('2026-06-28T10:00:00')];
    const [pt] = buildChartData(prices, null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.action).toBe('idle');
  });

  it('decision is classified from the dispatch slot (null without a plan / for default behaviour)', () => {
    const prices = [makePrice('2026-06-28T20:00:00')];
    const selling = {
      '2026-06-28T20:00:00': makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToGridKwh: 2.4 }),
    };
    expect(buildChartData(prices, null, profiles, selling, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH)[0].decision).toBe(
      'sell',
    );
    const selfUse = {
      '2026-06-28T20:00:00': makeDispatch('2026-06-28T20:00:00', 'discharge', { batteryToLoadKwh: 0.4 }),
    };
    expect(
      buildChartData(prices, null, profiles, selfUse, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH)[0].decision,
    ).toBeNull();
    expect(
      buildChartData(prices, null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH)[0].decision,
    ).toBeNull();
  });

  it('uses forecast kWh when available', () => {
    const prices = [makePrice('2026-06-28T12:00:00')]; // slotIndex(12,0) = 48
    const forecast = { '2026-06-28': Array(96).fill(0).map((_, i) => (i === 48 ? 2.5 : 0)) };
    const [pt] = buildChartData(prices, forecast, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.solarKwh).toBeCloseTo(2.5);
    expect(pt.solarSource).toBe('forecast');
  });

  it('falls back to profile when forecast is null', () => {
    // June (month 6), local 14:00 = UTC 12:00, profiles[6][12] = 4.0 → /4 = 1.0 kWh/slot
    const prices = [makePrice('2026-06-28T14:00:00')];
    const [pt] = buildChartData(prices, null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.solarKwh).toBeCloseTo(1.0);
    expect(pt.solarSource).toBe('typical');
  });

  it('preserves time from the source slot', () => {
    const prices = [makePrice('2026-06-28T06:30:00')];
    const [pt] = buildChartData(prices, null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.time).toBe('2026-06-28T06:30:00');
  });

  it('actualSocPct is null when no actual reading was bucketed into this slot', () => {
    const [pt] = buildChartData([makePrice('2026-06-28T10:00:00')], null, profiles, {}, BATTERY_KWH, SKATT_OVERFÖRING, BATTERY_MIN_SOC_KWH);
    expect(pt.actualSocPct).toBeNull();
  });

  it('actualSocPct is looked up by 16-char slot key (no seconds)', () => {
    const prices = [makePrice('2026-06-28T10:00:00')];
    const actualSocByTime = { '2026-06-28T10:00': 42.5 };
    const [pt] = buildChartData(
      prices,
      null,
      profiles,
      {},
      BATTERY_KWH,
      SKATT_OVERFÖRING,
      BATTERY_MIN_SOC_KWH,
      actualSocByTime,
    );
    expect(pt.actualSocPct).toBe(42.5);
  });
});

// ─── buildActualSocByTime ───────────────────────────────────────────────────────

describe('buildActualSocByTime', () => {
  it('averages multiple readings landing in the same 15-min slot', () => {
    // 2026-06-28 10:00-10:15 CEST = 08:00-08:15 UTC
    const readings = [
      { timestamp: '2026-06-28T08:00:13Z', soc_pct: 40.0 },
      { timestamp: '2026-06-28T08:07:44Z', soc_pct: 41.0 },
      { timestamp: '2026-06-28T08:14:59Z', soc_pct: 42.0 },
    ];
    const out = buildActualSocByTime(readings);
    expect(out['2026-06-28T10:00']).toBeCloseTo(41.0);
  });

  it('keys landing in different slots stay separate', () => {
    const readings = [
      { timestamp: '2026-06-28T08:00:00Z', soc_pct: 40.0 }, // 10:00 CEST
      { timestamp: '2026-06-28T08:20:00Z', soc_pct: 45.0 }, // 10:15 CEST
    ];
    const out = buildActualSocByTime(readings);
    expect(out['2026-06-28T10:00']).toBe(40.0);
    expect(out['2026-06-28T10:15']).toBe(45.0);
  });

  it('ignores non-finite/missing soc_pct values', () => {
    const readings = [
      { timestamp: '2026-06-28T08:00:00Z', soc_pct: 40.0 },
      { timestamp: '2026-06-28T08:05:00Z', soc_pct: NaN },
    ];
    const out = buildActualSocByTime(readings);
    expect(out['2026-06-28T10:00']).toBe(40.0);
  });

  it('returns an empty object for no readings', () => {
    expect(buildActualSocByTime([])).toEqual({});
  });
});

// ─── buildXTicks ──────────────────────────────────────────────────────────────

describe('buildXTicks', () => {
  it('returns empty array for no prices', () => {
    expect(buildXTicks([])).toEqual([]);
  });

  it('includes even-hour :00 slots', () => {
    const prices = [
      makePrice('2026-06-28T00:00:00'),
      makePrice('2026-06-28T02:00:00'),
      makePrice('2026-06-28T04:00:00'),
    ];
    expect(buildXTicks(prices)).toEqual([
      '2026-06-28T00:00:00',
      '2026-06-28T02:00:00',
      '2026-06-28T04:00:00',
    ]);
  });

  it('excludes odd-hour :00 slots', () => {
    const prices = [
      makePrice('2026-06-28T01:00:00'),
      makePrice('2026-06-28T03:00:00'),
    ];
    expect(buildXTicks(prices)).toEqual([]);
  });

  it('excludes :15, :30, :45 slots even on even hours', () => {
    const prices = [
      makePrice('2026-06-28T02:00:00'),
      makePrice('2026-06-28T02:15:00'),
      makePrice('2026-06-28T02:30:00'),
      makePrice('2026-06-28T02:45:00'),
    ];
    expect(buildXTicks(prices)).toEqual(['2026-06-28T02:00:00']);
  });
});

// ─── computeNowSlotTime ────────────────────────────────────────────────────────

describe('computeNowSlotTime', () => {
  it('floors to the 15-min slot in Stockholm local time (CEST, summer)', () => {
    // 2026-07-01T11:22:00Z = 13:22 Stockholm (CEST +2) → floors to 13:15
    const now = new Date('2026-07-01T11:22:00Z');
    const available = ['2026-07-01T13:00:00', '2026-07-01T13:15:00', '2026-07-01T13:30:00'];
    expect(computeNowSlotTime(now, available)).toBe('2026-07-01T13:15:00');
  });

  it('applies CET offset in winter', () => {
    // 2026-01-01T11:07:00Z = 12:07 Stockholm (CET +1) → floors to 12:00
    const now = new Date('2026-01-01T11:07:00Z');
    const available = ['2026-01-01T12:00:00', '2026-01-01T12:15:00'];
    expect(computeNowSlotTime(now, available)).toBe('2026-01-01T12:00:00');
  });

  it('stays on an exact slot boundary (does not floor an extra step)', () => {
    // 2026-07-01T11:15:00Z = 13:15 Stockholm exactly
    const now = new Date('2026-07-01T11:15:00Z');
    expect(computeNowSlotTime(now, ['2026-07-01T13:15:00'])).toBe('2026-07-01T13:15:00');
  });

  it('returns null when the current slot is not among the available times', () => {
    const now = new Date('2026-07-01T11:22:00Z'); // → 13:15 Stockholm
    expect(computeNowSlotTime(now, ['2026-07-01T09:00:00'])).toBeNull();
  });

  it('returns null for an empty availableTimes list', () => {
    expect(computeNowSlotTime(new Date('2026-07-01T11:22:00Z'), [])).toBeNull();
  });
});

// ─── chart geometry / scales ───────────────────────────────────────────────────

describe('buildChartGeometry', () => {
  it('derives plot dimensions from the mockup padding at the default size', () => {
    const g = buildChartGeometry();
    expect(g).toEqual({
      width: 1040,
      height: 388,
      padL: 42,
      padR: 46,
      padT: 30,
      padB: 26,
      plotW: 1040 - 42 - 46,
      plotH: 388 - 30 - 26,
      baseY: 30 + (388 - 30 - 26),
    });
  });

  it('scales with a custom width/height', () => {
    const g = buildChartGeometry(500, 200);
    expect(g.plotW).toBe(500 - 42 - 46);
    expect(g.plotH).toBe(200 - 30 - 26);
  });
});

describe('indexToX / timeToX / buildTimeIndex', () => {
  it('places index 0 at padL and the last index at padL + plotW', () => {
    const g = buildChartGeometry();
    expect(indexToX(0, 4, g)).toBe(g.padL);
    expect(indexToX(3, 4, g)).toBeCloseTo(g.padL + g.plotW);
  });

  it('falls back to padL for a single-point series (avoids divide-by-zero)', () => {
    const g = buildChartGeometry();
    expect(indexToX(0, 1, g)).toBe(g.padL);
  });

  it('timeToX resolves a known time via a prebuilt index', () => {
    const g = buildChartGeometry();
    const data = [makePoint('a'), makePoint('b'), makePoint('c')];
    const idx = buildTimeIndex(data);
    expect(timeToX('b', data, g, idx)).toBeCloseTo(indexToX(1, 3, g));
  });

  it('timeToX works without a prebuilt index (linear scan)', () => {
    const g = buildChartGeometry();
    const data = [makePoint('a'), makePoint('b')];
    expect(timeToX('b', data, g)).toBeCloseTo(indexToX(1, 2, g));
  });

  it('timeToX returns null when the time is outside the loaded horizon', () => {
    const g = buildChartGeometry();
    const data = [makePoint('a'), makePoint('b')];
    expect(timeToX('z', data, g)).toBeNull();
  });
});

describe('computePriceMax', () => {
  it('floors at 100 for a low-price / empty series', () => {
    expect(computePriceMax([])).toBe(100);
    expect(computePriceMax([makePoint('a', { buy: 20, sell: 10 })])).toBe(100);
  });

  it('rounds up to the next 20 above the highest buy/sell value plus headroom', () => {
    // max = 244 (buy) → +10 = 254 → ceil to next 20 = 260
    const data = [makePoint('a', { buy: 244, sell: 60 })];
    expect(computePriceMax(data)).toBe(260);
  });

  it('considers sell as well as buy', () => {
    const data = [makePoint('a', { buy: 50, sell: 190 })];
    expect(computePriceMax(data)).toBe(Math.ceil((190 + 10) / 20) * 20);
  });
});

describe('computePriceMin', () => {
  it('is 0 for an empty or all-positive series (the everyday case)', () => {
    expect(computePriceMin([])).toBe(0);
    expect(computePriceMin([makePoint('a', { buy: 244, sell: 60 })])).toBe(0);
  });

  it('rounds down to the next 20 below the lowest value minus headroom', () => {
    // min = -12 (sell) → -10 headroom = -22 → floor to next 20 = -40
    expect(computePriceMin([makePoint('a', { buy: 50, sell: -12 })])).toBe(-40);
  });

  it('considers buy as well as sell', () => {
    const data = [makePoint('a', { buy: -5, sell: 10 })];
    expect(computePriceMin(data)).toBe(Math.floor((-5 - 10) / 20) * 20);
  });
});

describe('computeSolarMax', () => {
  it('floors at 0.5 for a zero-solar series', () => {
    expect(computeSolarMax([])).toBe(0.5);
    expect(computeSolarMax([makePoint('a', { solarKwh: 0 })])).toBe(0.5);
  });

  it('adds headroom above the peak slot', () => {
    const data = [makePoint('a', { solarKwh: 2.0 }), makePoint('b', { solarKwh: 1.0 })];
    expect(computeSolarMax(data)).toBeCloseTo(2.3);
  });
});

describe('priceYScale / socYScale / solarYScale', () => {
  it('priceYScale maps 0 to the plot baseline and max to the top', () => {
    const g = buildChartGeometry();
    expect(priceYScale(0, 200, g)).toBeCloseTo(g.baseY);
    expect(priceYScale(200, 200, g)).toBeCloseTo(g.padT);
  });

  it('priceYScale with a negative min keeps negative prices inside the plot', () => {
    const g = buildChartGeometry();
    expect(priceYScale(-40, 200, g, -40)).toBeCloseTo(g.baseY); // the axis min sits on the baseline
    expect(priceYScale(200, 200, g, -40)).toBeCloseTo(g.padT);
    const yNeg = priceYScale(-10, 200, g, -40); // a negative price: below the 0-line, inside the plot
    expect(yNeg).toBeLessThan(g.baseY);
    expect(yNeg).toBeGreaterThan(priceYScale(0, 200, g, -40));
  });

  it('socYScale uses a fixed 0-100 domain regardless of a price max', () => {
    const g = buildChartGeometry();
    expect(socYScale(0, g)).toBeCloseTo(g.baseY);
    expect(socYScale(100, g)).toBeCloseTo(g.padT);
    expect(socYScale(50, g)).toBeCloseTo((g.padT + g.baseY) / 2);
  });

  it('solarYScale stays within the near-baseline band, never reaching padT', () => {
    const g = buildChartGeometry();
    const yAtMax = solarYScale(2.5, 2.5, g);
    expect(yAtMax).toBeCloseTo(g.baseY - g.plotH * 0.44);
    expect(yAtMax).toBeGreaterThan(g.padT);
    expect(solarYScale(0, 2.5, g)).toBeCloseTo(g.baseY);
  });
});

describe('buildLinePath / buildAreaPath', () => {
  it('buildLinePath joins points with M ... L ... L ...', () => {
    expect(buildLinePath([[0, 0], [10, 5], [20, 0]])).toBe('M 0.0 0.0 L 10.0 5.0 L 20.0 0.0');
  });

  it('buildLinePath returns empty string for no points', () => {
    expect(buildLinePath([])).toBe('');
  });

  it('buildAreaPath closes the path down to baseY at both ends', () => {
    const d = buildAreaPath([[0, 10], [10, 5], [20, 10]], 40);
    expect(d).toBe('M 0.0 40.0 L 0.0 10.0 L 10.0 5.0 L 20.0 10.0 L 20.0 40.0 Z');
  });

  it('buildAreaPath returns empty string for no points', () => {
    expect(buildAreaPath([], 40)).toBe('');
  });
});
