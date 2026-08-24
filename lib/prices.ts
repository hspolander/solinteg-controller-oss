import { cacheLife } from 'next/cache';
import { VAT_RATE, SUPPLIER_SURCHARGE_ORE, PRICE_ZONE, EXPORT_BONUS_ORE, FETCH_TIMEOUT_MS } from './constants';

// Raw Nord Pool day-ahead spot prices per bidding zone (SE3), 15-min resolution, free & no key.
// Publishes tomorrow ~13:00 CET — reliably, unlike the Mölndal feed it replaced (which lagged by
// hours). Per-day URLs: /api/v1/prices/YYYY/MM-DD_<ZONE>.json. Prices are raw spot, excl VAT.
const PRICES_BASE_URL = 'https://www.elprisetjustnu.se/api/v1/prices';

export interface PriceSlot {
  startTime: string; // naive Stockholm local, e.g. "2026-07-01T00:00:00"
  endTime: string;
  price: number; // öre/kWh — the SELL price you actually receive: spot + EXPORT_BONUS_ORE
  priceIncludingTaxAndSurcharge: number; // öre/kWh — (spot + surcharge) × VAT (buy price, pre skatt/överföring)
}

export interface PriceData {
  today: string;
  tomorrow: string;
  hasTomorrow: boolean;
  maxForMonth: number; // öre — max/min sell price over the LOADED slots (today[+tomorrow]); unused downstream
  minForMonth: number;
  prices: PriceSlot[];
  maxAge: number;
}

interface ElprisSlot {
  SEK_per_kWh: number; // raw spot, excl VAT
  time_start: string; // ISO with offset, e.g. "2026-07-01T00:00:00+02:00"
  time_end: string;
}

/**
 * Convert an elprisetjustnu slot to our PriceSlot: the tax-inclusive buy price is reconstructed
 * from the raw spot; the sell price is the spot plus the flat grid-export compensation
 * (EXPORT_BONUS_ORE) that the owner actually receives per exported kWh.
 */
export function toSlot(p: ElprisSlot): PriceSlot {
  const spot = Math.round(p.SEK_per_kWh * 100 * 100) / 100; // SEK/kWh → öre/kWh (2 dp)
  const inclTax = Math.round((spot + SUPPLIER_SURCHARGE_ORE) * (1 + VAT_RATE) * 100) / 100;
  return {
    startTime: p.time_start.slice(0, 19), // drop the "+02:00" offset → naive local (matches app convention)
    endTime: p.time_end.slice(0, 19),
    price: Math.round((spot + EXPORT_BONUS_ORE) * 100) / 100, // sell = spot + export compensation
    priceIncludingTaxAndSurcharge: inclTax,
  };
}

/** Fetch one Stockholm day of 15-min slots, or null if not published yet (404 before release). */
export async function fetchDay(dateStr: string): Promise<PriceSlot[] | null> {
  const url = `${PRICES_BASE_URL}/${dateStr.slice(0, 4)}/${dateStr.slice(5)}_${PRICE_ZONE}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'solinteg-controller' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const raw = (await res.json()) as ElprisSlot[];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map(toSlot);
}

export function stockholmParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  const year = get('year');
  const month = get('month'); // 1–12
  const day = get('day');
  const hour = get('hour') % 24; // normalize: some engines return 24 for midnight
  const minute = get('minute');
  const utcOffset = (hour - date.getUTCHours() + 24) % 24;

  return {
    dateStr: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hour,
    minute,
    utcOffset,
    year,
    month0: month - 1,
    day,
  };
}

/**
 * Index into a today[+tomorrow] PriceSlot/OptimizerSlot array (PriceData.prices —
 * today's 96 slots, optionally followed by tomorrow's 96 once published) that
 * covers `now`. Used to slice that array down to "from now onward" before handing
 * it to the optimizer, so its own slot 0 lines up with the live SoC reading taken
 * at the same moment — optimizeDispatch's forward pass always treats its index 0
 * as the start of the optimization horizon, so feeding it the whole day (including
 * already-elapsed slots) makes it anchor "now's real SoC" to a fictitious midnight
 * instead of to now, which is what caused a mid-day SoC-divergence bug (fixed
 * 2026-07-03; see dispatch_loop.py's slot_index_for_instant for the other half).
 *
 * Can return a negative index (now is before todayDateStr — stale cache or clock
 * skew) or an index at/beyond the array length (now is past the last loaded day).
 * Callers must clamp before slicing; this only does the date-arithmetic + slot math.
 *
 * Computed as elapsed 15-min slots since todayDateStr's Stockholm midnight, NOT as
 * wall-clock `hour*4 + quarter`: the feed's DST-transition days really have 92
 * (spring) or 100 (fall) slots, so wall-clock arithmetic is off by ±4 array
 * positions for the rest of those days. Elapsed time matches the array layout on
 * every day, because the slots are contiguous 15-min intervals from midnight.
 */
export function currentSlotIndexInPrices(todayDateStr: string, now: Date): number {
  const [ty, tm, td] = todayDateStr.split('-').map(Number);
  const midnight = stockholmMidnightUtc(ty, tm - 1, td);
  return Math.floor((now.getTime() - midnight.getTime()) / 900_000);
}

/**
 * True UTC instant of Stockholm midnight on the given local date. Stockholm is
 * always UTC+1 (CET) or UTC+2 (CEST), and DST transitions happen at 02:00/03:00
 * local — never at midnight — so exactly one of the two candidate offsets
 * round-trips back to 00:00 on that date via stockholmParts.
 * Exported for lib/oracle.ts, whose day windows and elapsed-time slot bucketing
 * are all anchored to this instant (same anchor as currentSlotIndexInPrices).
 */
export function stockholmMidnightUtc(year: number, month0: number, day: number): Date {
  for (const offset of [1, 2]) {
    const candidate = new Date(Date.UTC(year, month0, day, -offset));
    const p = stockholmParts(candidate);
    if (p.year === year && p.month0 === month0 && p.day === day && p.hour === 0 && p.minute === 0) {
      return candidate;
    }
  }
  // Unreachable for real Stockholm dates; keep the CET guess rather than throwing.
  return new Date(Date.UTC(year, month0, day, -1));
}

// Convert a Stockholm clock time on a given Stockholm date to UTC.
// Date.UTC handles overflow (e.g. h=24 wraps to next day correctly).
export function stockholmToUtc(
  year: number,
  month0: number,
  day: number,
  utcOffset: number,
  h: number,
  min: number,
): Date {
  return new Date(Date.UTC(year, month0, day, h - utcOffset, min, 0));
}

/**
 * How long a "tomorrow isn't published yet" answer stays cached once past the 13:05 release
 * window. 20 min pins first sight of the day-ahead prices to a 13:05 + 20 min grid, well after
 * the feed actually has them, and starves any replan trigger that re-asks on a shorter cycle —
 * every re-ask lands in this same cache entry and gets the same pre-release answer back. 3 min
 * costs at most a couple of extra ~100 ms fetches per day against a free feed.
 */
const AWAITING_TOMORROW_RECHECK_S = 3 * 60;

export function computeMaxAge(
  hasTomorrow: boolean,
  now: Date,
  parts: ReturnType<typeof stockholmParts>,
): number {
  if (hasTomorrow) {
    const midnight = stockholmToUtc(parts.year, parts.month0, parts.day, parts.utcOffset, 24, 0);
    return Math.max(60, Math.floor((midnight.getTime() - now.getTime()) / 1000));
  }
  if (parts.hour < 13) {
    // No point fetching before 13:05 — prices for tomorrow are released around 13:00
    const release = stockholmToUtc(parts.year, parts.month0, parts.day, parts.utcOffset, 13, 5);
    return Math.max(60, Math.floor((release.getTime() - now.getTime()) / 1000));
  }
  return AWAITING_TOMORROW_RECHECK_S;
}

/**
 * The real fetch. **No 'use cache' here, deliberately** — this is what lib/plan.ts calls, and a
 * plan is a dispatch input: a stale price horizon is not a slightly-old number, it is the
 * optimizer solving yesterday's problem.
 *
 * On the reference deployment this cost two failed fix attempts before the cause was found. With
 * the price read behind 'use cache', a GET page render and a POST route handler resolved the same
 * argument-less entry differently, so the newest published plan alternated between horizon-aware
 * and today-only for the better part of an hour after each day-ahead release. Tuning cacheLife
 * does not fix it; taking the plan's price read out of the cache does.
 *
 * Cost of not caching: two ~100 ms fetches per plan against a free, unmetered feed, at whatever
 * cadence you render.
 */
export async function fetchPricesUncached(): Promise<PriceData> {

  const now = new Date();
  const parts = stockholmParts(now);

  const [y, m, d] = parts.dateStr.split('-').map(Number);
  const tomorrowStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  const todaySlots = await fetchDay(parts.dateStr);
  if (!todaySlots) throw new Error(`No spot prices for ${parts.dateStr} (${PRICE_ZONE})`);

  // Tomorrow returns null until Nord Pool releases it (~13:00 CET); hasTomorrow reflects that.
  const tomorrowSlots = await fetchDay(tomorrowStr);
  const hasTomorrow = tomorrowSlots !== null;

  const prices = tomorrowSlots ? [...todaySlots, ...tomorrowSlots] : todaySlots;
  const maxAge = computeMaxAge(hasTomorrow, now, parts);

  const sells = prices.map((p) => p.price);
  return {
    today: parts.dateStr,
    tomorrow: tomorrowStr,
    hasTomorrow,
    maxForMonth: Math.max(...sells),
    minForMonth: Math.min(...sells),
    prices,
    maxAge,
  };
}

/**
 * Cached wrapper, for display-only callers (app/api/prices/route.ts). **Never call this from
 * anything that feeds dispatch** — see fetchPricesUncached above for why.
 *
 * expire hugs revalidate rather than doubling it: maxAge means "seconds until this answer can be
 * wrong", so a stale-while-revalidate window past it serves an answer already known to be
 * outdated. The +1 is only because cacheLife validates "expire must be greater than revalidate".
 */
export async function fetchPrices(): Promise<PriceData> {
  'use cache';
  const data = await fetchPricesUncached();
  cacheLife({ revalidate: data.maxAge, expire: data.maxAge + 1 });
  return data;
}
