/**
 * Price curves + poller-reading telemetry: the `price_snapshots` and `readings` tables.
 *
 * Joining optimizer_runs (forecast, see ./dispatch.ts) against `readings` (actual) by
 * timestamp is the forecast-vs-actual feedback loop described in DESIGN-reserve.md.
 */
import { getDb } from './core';
import { stockholmParts, stockholmToUtc } from '../prices';
import type { PriceData } from '../prices';
import type { TrailingLoadProfile } from '../load';
import type { FlowReading } from '../actual-flows';
import {
  computeDailyEconomics,
  mergeDailyEconomics,
  priceSlotsToMap,
  stockholmDateOf,
  stockholmSlotKey,
  type EconReading,
  type EconTotals,
  type PriceLookup,
} from '../economics';
import type { PriceSlot } from '../prices';

/**
 * Record the price curve as the optimizer saw it. Upsert keyed on date: the last write
 * of the day wins, so the post-13:00 snapshot (today + tomorrow) supersedes the morning's
 * today-only one.
 */
export function logPriceSnapshot(data: PriceData): void {
  const handle = getDb();
  if (!handle) return;
  try {
    handle
      .prepare(
        `INSERT INTO price_snapshots (date, logged_at, has_tomorrow, prices_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           logged_at = excluded.logged_at,
           has_tomorrow = excluded.has_tomorrow,
           prices_json = excluded.prices_json`,
      )
      .run(
        data.today,
        new Date().toISOString(),
        data.hasTomorrow ? 1 : 0,
        JSON.stringify(data.prices),
      );
  } catch (err) {
    // Best-effort (a telemetry failure must never break the page), but silently swallowing
    // this previously hid a real bug: this write failed for ~7 hours overnight 2026-07-02/03
    // while logOptimizerRun kept succeeding every hour on the same data, and there was no way
    // to tell why. Logged now so a recurrence shows up in journalctl instead of vanishing.
    console.error('logPriceSnapshot failed:', err);
  }
}

/**
 * Poller readings, oldest first, optionally restricted to a UTC timestamp range
 * (sinceIso inclusive, beforeIso exclusive — both compared as ISO strings, which sort
 * chronologically for the poller's UTC timestamps). Returns [] if telemetry is off or the
 * `readings` table doesn't exist yet (the poller creates it on its first successful poll).
 */
export function readReadings(sinceIso?: string, beforeIso?: string): EconReading[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (sinceIso) {
      where.push('timestamp >= ?');
      params.push(sinceIso);
    }
    if (beforeIso) {
      where.push('timestamp < ?');
      params.push(beforeIso);
    }
    const sql =
      'SELECT timestamp, grid_w FROM readings' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY timestamp';
    return handle.prepare(sql).all(...params) as unknown as EconReading[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

// buildPriceLookup parses every logged snapshot's JSON (one row per day, ~20 kB each), which
// grows without bound. A day's prices never change once published (day-ahead market), so the
// parsed map is cached and only rebuilt when the newest snapshot's identity changes: a new
// date (first render after midnight, or a late first snapshot after a prices outage) or its
// has_tomorrow flip (the ~13:00 release adding tomorrow's slots).
let priceLookupCache: PriceLookup | null = null;
let priceLookupKey: string | null = null;

/** A price lookup over all logged snapshots: UTC instant → that 15-min slot's buy/sell price. */
export function buildPriceLookup(): PriceLookup {
  const handle = getDb();
  if (!handle) return () => null;
  try {
    const newest = handle
      .prepare('SELECT date, has_tomorrow FROM price_snapshots ORDER BY date DESC LIMIT 1')
      .get() as { date: string; has_tomorrow: number } | undefined;
    const key = newest ? `${newest.date}:${newest.has_tomorrow}` : 'empty';
    if (priceLookupCache && key === priceLookupKey) return priceLookupCache;

    const rows = handle.prepare('SELECT prices_json FROM price_snapshots').all() as {
      prices_json: string;
    }[];
    const map = priceSlotsToMap(rows.flatMap((r) => JSON.parse(r.prices_json) as PriceSlot[]));
    priceLookupCache = (timestampUtc: string) => map.get(stockholmSlotKey(timestampUtc)) ?? null;
    priceLookupKey = key;
    return priceLookupCache;
  } catch {
    return () => null;
  }
}

// Per-day economics for fully elapsed Stockholm days, cached per process. Readings are
// append-only with now-timestamps and past days' prices are fixed, so days before today
// never change — recomputing them on every render made rendering O(all readings ever)
// (~1M rows/year at one reading per 30 s). The cache is rebuilt once per Stockholm day
// (and on process restart); per render only today's readings are read.
let frozenDaily: Map<string, EconTotals> | null = null;
let frozenBoundaryIso: string | null = null;
let frozenForDate: string | null = null;

/**
 * Daily buy/sell economics over all logged readings, split at (approximately) today's
 * Stockholm midnight: everything before it comes from the per-day cache above, only
 * readings after it are read and valued per call. The boundary uses the CURRENT UTC
 * offset, so on a DST transition day it can be an hour off real midnight — harmless,
 * because days are bucketed by true Stockholm date in both passes and a date landing in
 * both is summed by mergeDailyEconomics, never overwritten. The one reading straddling
 * the boundary is valued at defaultIntervalMs instead of its real successor gap (≤60 s
 * of one reading per day — noise).
 */
export function readDailyEconomics(now: Date = new Date()): Map<string, EconTotals> {
  const handle = getDb();
  if (!handle) return new Map();
  try {
    const today = stockholmDateOf(now.toISOString());
    if (frozenDaily === null || frozenForDate !== today) {
      const p = stockholmParts(now);
      const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
      frozenDaily = computeDailyEconomics(readReadings(undefined, boundary), buildPriceLookup());
      frozenBoundaryIso = boundary;
      frozenForDate = today;
    }
    const live = computeDailyEconomics(readReadings(frozenBoundaryIso!), buildPriceLookup());
    return mergeDailyEconomics(frozenDaily, live);
  } catch {
    return new Map();
  }
}

/**
 * Today's poller readings (Stockholm calendar day), timestamp + soc_pct only — the raw
 * material for the chart's "actual" SoC line. Bounded to today for the same reason
 * readDailyEconomics bounds its live pass: readings are append-only, so an unbounded scan
 * grows without limit as the deployment ages.
 */
export function readTodaySocHistory(now: Date = new Date()): { timestamp: string; soc_pct: number }[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const p = stockholmParts(now);
    const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
    return handle
      .prepare('SELECT timestamp, soc_pct FROM readings WHERE timestamp >= ? ORDER BY timestamp')
      .all(boundary) as unknown as { timestamp: string; soc_pct: number }[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

/**
 * Today's poller readings (Stockholm calendar day), the three fields the chart's plan-vs-actual
 * flow attribution needs (lib/actual-flows.ts) — timestamp, pv_w, house_load_w, battery_w. Same
 * day-boundary pattern as readTodaySocHistory above.
 */
export function readTodayFlowRows(now: Date = new Date()): FlowReading[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const p = stockholmParts(now);
    const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
    return handle
      .prepare(
        'SELECT timestamp, pv_w, house_load_w, battery_w FROM readings WHERE timestamp >= ? ORDER BY timestamp',
      )
      .all(boundary) as unknown as FlowReading[];
  } catch {
    return []; // table absent (poller never ran) or unreadable
  }
}

// The trailing load profile scans `days` worth of readings (~120k rows at the 10 s cadence),
// so it is cached per Stockholm day per process — the window boundary only moves daily and
// the profile is a multi-day mean, so intra-day staleness is noise. Same pattern (and reason)
// as readDailyEconomics' frozenDaily above.
let loadProfileCache: TrailingLoadProfile | null = null;
let loadProfileKey: string | null = null;

/**
 * Mean household consumption per local hour-of-day over the trailing `days` window, from the
 * poller's own readings — the live replacement for the static Ellevio-fitted hour shape (see
 * lib/load.ts slotConsumptionFromLive for why and how it's consumed). Aggregation happens in
 * SQL over UTC-hour buckets; each bucket is then mapped to its Stockholm local hour here, so
 * a DST transition inside the window lands every bucket in the right local bin instead of
 * being smeared by a fixed offset. Returns null — caller falls back to the static model —
 * when telemetry is off, or coverage is too thin to trust: fewer than `minDays` distinct
 * days, or any local hour entirely absent (a profile with holes would silently plan zero
 * load for that hour). trailingMeanTempC comes from the weather table over the same window
 * and is null-tolerant: without it the caller only loses winter cold-snap scaling, not the
 * profile itself.
 */
export function readTrailingLoadProfile(days = 14, minDays = 5): TrailingLoadProfile | null {
  const handle = getDb();
  if (!handle || days <= 0) return null;
  try {
    const now = new Date();
    const key = `${stockholmDateOf(now.toISOString())}:${days}`;
    if (loadProfileCache && key === loadProfileKey) return loadProfileCache;

    const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
    const buckets = handle
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H', timestamp) AS bucket,
                AVG(house_load_w) AS avg_w, COUNT(*) AS n
         FROM readings
         WHERE timestamp >= ? AND house_load_w IS NOT NULL
         GROUP BY bucket`,
      )
      .all(sinceIso) as { bucket: string; avg_w: number; n: number }[];

    const sumW = new Array<number>(24).fill(0);
    const count = new Array<number>(24).fill(0);
    const localDays = new Set<string>();
    for (const b of buckets) {
      const p = stockholmParts(new Date(`${b.bucket}:00:00Z`));
      sumW[p.hour] += b.avg_w * b.n;
      count[p.hour] += b.n;
      localDays.add(p.dateStr);
    }
    if (localDays.size < minDays || count.some((n) => n === 0)) return null;

    // Mean W over an hour ≈ kWh in that hour (the poller's cadence is uniform within it).
    const hourKwh = sumW.map((s, h) => s / count[h] / 1000);

    let trailingMeanTempC: number | null = null;
    try {
      const t = handle
        .prepare('SELECT AVG(temp_c) AS mean_c FROM weather WHERE timestamp >= ?')
        .get(sinceIso) as { mean_c: number | null } | undefined;
      trailingMeanTempC = t?.mean_c ?? null;
    } catch {
      trailingMeanTempC = null; // weather table absent — profile still usable without scaling
    }

    loadProfileCache = { hourKwh, trailingMeanTempC, days: localDays.size };
    loadProfileKey = key;
    return loadProfileCache;
  } catch {
    return null; // readings table absent (poller never ran) or unreadable
  }
}
