/**
 * Simple electricity economics from logged telemetry: kWh bought, kWh sold, and the net
 * cost/benefit for a period — computed directly from the poller's `readings` (grid_w) and the
 * logged `price_snapshots`. No counterfactual, no assumption about what a different system would
 * have done — just what actually crossed the meter, at the actual prices.
 *
 * Pure module — no I/O. The DB read + price-lookup wiring lives in lib/telemetry.ts.
 */
import { SKATT_OVERFÖRING } from './constants';

export interface EconReading {
  timestamp: string; // UTC ISO (as written by the poller)
  grid_w: number; // +ve = export, −ve = import (as reported by the inverter)
}

export interface SlotPrice {
  buy: number; // öre/kWh — priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING
  sell: number; // öre/kWh — raw spot price only
}

export type PriceLookup = (timestampUtc: string) => SlotPrice | null;

export interface EconTotals {
  boughtKwh: number;
  soldKwh: number;
  costKr: number; // paid for imports
  incomeKr: number; // received for exports
  netKr: number; // incomeKr − costKr; positive = net benefit, negative = net cost
  readingCount: number;
}

export interface EconSummary {
  today: EconTotals;
  month: EconTotals;
  allTime: EconTotals;
  days: number; // distinct Stockholm days with data
  latestDate: string | null;
}

export interface EconOptions {
  /** Time a final/lone reading stands in for (no successor to measure against). */
  defaultIntervalMs?: number;
  /** Cap on the interval a reading represents, so service downtime isn't billed. */
  maxGapMs?: number;
}

const DEFAULTS = { defaultIntervalMs: 30_000, maxGapMs: 90_000 };

// One formatter each; reused across calls (cheap, and avoids per-reading allocation).
const STHLM_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const STHLM_DATETIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Stockholm calendar date ("YYYY-MM-DD") for a UTC instant. */
export function stockholmDateOf(timestampUtc: string): string {
  return STHLM_DATE.format(new Date(timestampUtc));
}

/** Price-slot key ("YYYY-MM-DDTHH:MM", Stockholm, floored to 15 min) for a UTC instant. */
export function stockholmSlotKey(timestampUtc: string): string {
  const parts = STHLM_DATETIME.formatToParts(new Date(timestampUtc));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = g('hour') === '24' ? '00' : g('hour'); // some engines emit 24 at midnight
  const min = Math.floor(parseInt(g('minute'), 10) / 15) * 15;
  return `${g('year')}-${g('month')}-${g('day')}T${hour}:${String(min).padStart(2, '0')}`;
}

/** Build a SlotPrice map (key = slot startTime sliced to "YYYY-MM-DDTHH:MM") from price slots. */
export function priceSlotsToMap(
  slots: { startTime: string; price: number; priceIncludingTaxAndSurcharge: number }[],
): Map<string, SlotPrice> {
  const map = new Map<string, SlotPrice>();
  for (const s of slots) {
    map.set(s.startTime.slice(0, 16), {
      buy: s.priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING,
      sell: s.price,
    });
  }
  return map;
}

function blank(): EconTotals {
  return { boughtKwh: 0, soldKwh: 0, costKr: 0, incomeKr: 0, netKr: 0, readingCount: 0 };
}

function addInto(acc: EconTotals, t: EconTotals): void {
  acc.boughtKwh += t.boughtKwh;
  acc.soldKwh += t.soldKwh;
  acc.costKr += t.costKr;
  acc.incomeKr += t.incomeKr;
  acc.netKr += t.netKr;
  acc.readingCount += t.readingCount;
}

/**
 * Bucket readings into per-Stockholm-day economics. Each reading is valued over the interval
 * until the next reading (capped at maxGapMs so downtime isn't billed); a final reading uses
 * defaultIntervalMs. Readings with no matching price are skipped.
 */
export function computeDailyEconomics(
  readings: EconReading[],
  priceAt: PriceLookup,
  options: EconOptions = {},
): Map<string, EconTotals> {
  const { defaultIntervalMs, maxGapMs } = { ...DEFAULTS, ...options };
  const byDay = new Map<string, EconTotals>();

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const price = priceAt(r.timestamp);
    if (!price) continue;

    let intervalMs = defaultIntervalMs;
    if (i + 1 < readings.length) {
      const dt = Date.parse(readings[i + 1].timestamp) - Date.parse(r.timestamp);
      if (dt > 0) intervalMs = Math.min(dt, maxGapMs);
    }
    const hours = intervalMs / 3_600_000;
    const kwh = (Math.abs(r.grid_w) / 1000) * hours;

    const day = stockholmDateOf(r.timestamp);
    const acc = byDay.get(day) ?? blank();
    if (r.grid_w > 0) {
      acc.soldKwh += kwh;
      acc.incomeKr += kwh * (price.sell / 100);
    } else if (r.grid_w < 0) {
      acc.boughtKwh += kwh;
      acc.costKr += kwh * (price.buy / 100);
    }
    acc.netKr = acc.incomeKr - acc.costKr;
    acc.readingCount += 1;
    byDay.set(day, acc);
  }

  return byDay;
}

/**
 * Merge two per-day maps into a new one without mutating either — e.g. a cached map of
 * fully elapsed days plus a freshly computed map of today's readings. A date appearing in
 * both (a day split across the two source ranges) has its totals summed.
 */
export function mergeDailyEconomics(
  a: Map<string, EconTotals>,
  b: Map<string, EconTotals>,
): Map<string, EconTotals> {
  const out = new Map<string, EconTotals>();
  for (const src of [a, b]) {
    for (const [date, totals] of src) {
      const acc = out.get(date) ?? blank();
      addInto(acc, totals);
      out.set(date, acc);
    }
  }
  return out;
}

/** Roll the per-day map up into today / month-to-date / all-time totals. */
export function summarize(daily: Map<string, EconTotals>, todayStockholm: string): EconSummary {
  const monthPrefix = todayStockholm.slice(0, 7); // "YYYY-MM"
  const today = blank();
  const month = blank();
  const allTime = blank();
  let latestDate: string | null = null;

  for (const [date, totals] of daily) {
    addInto(allTime, totals);
    if (date.slice(0, 7) === monthPrefix) addInto(month, totals);
    if (date === todayStockholm) addInto(today, totals);
    if (latestDate === null || date > latestDate) latestDate = date;
  }

  return { today, month, allTime, days: daily.size, latestDate };
}
