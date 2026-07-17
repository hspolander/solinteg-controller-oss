import { fetchPrices, currentSlotIndexInPrices } from './prices';
import type { PriceData } from './prices';
import { fetchSolarForecast, fetchDailyMeanTemp } from './forecast';
import { buildSolarProfiles, buildOptimizerSlots } from './pipeline';
import { optimizeDispatch } from './optimizer';
import type { DispatchSlot } from './optimizer';
import { readLiveInverterData, socKwhOrDefault } from './inverter';
import type { InverterLiveData } from './inverter';
import { logPriceSnapshot, logOptimizerRun } from './telemetry';

export interface PlanResult {
  data: PriceData | null;
  solarProfiles: Record<number, number[]>;
  // Raw Open-Meteo forecast (distinct from solarProfiles, the climatology fallback built from
  // it) — not one of the values the spec for this extraction enumerated, but app/page.tsx's
  // JSX passes it straight to <PriceChart solarForecast={...}> alongside solarProfiles, so it
  // has to ride along here too or a page render silently loses that prop (undefined instead of
  // the real forecast) instead of staying byte-for-byte identical to before this extraction.
  solarForecast: Record<string, number[]> | null;
  dispatchSchedule: DispatchSlot[] | null;
  startSoc: number;
  socIsLive: boolean;
  inverterData: InverterLiveData | null;
}

/**
 * Produces one full battery-dispatch plan: fetch today's (+tomorrow's, if released) prices,
 * the solar/temperature forecasts, and the live inverter reading, then run the DP optimizer
 * over whatever's left of today from right now.
 *
 * This is a verbatim extraction of what used to be the top of app/page.tsx's Home() — every
 * dashboard render has always produced a fresh plan this way (the hourly telemetry timer, AutoRefresh, and any page view); the only thing that changes with this function existing is that a plan can now
 * ALSO be produced from somewhere other than a page render — see app/api/replan/route.ts,
 * which POSTs here on request, and dispatch_loop.py's maybe_request_replan, which is what
 * calls that route when the loop notices the world has drifted from the last plan. A page
 * render and a triggered replan are therefore the exact same code path, not two implementations
 * that could quietly diverge.
 *
 * Deliberately does NOT carry a 'use cache' directive anywhere in this call graph: this app
 * runs with cacheComponents on (next.config.ts), and prices/solar/temp/live-SoC are exactly
 * the inputs that must be re-read at request time, never baked into a build-time or long-lived
 * cache entry. readLiveInverterData() already calls connection() internally, which is what
 * lets a Server Component caller (app/page.tsx) legally bail out of prerendering without this
 * module needing a dynamic marker of its own; a POST Route Handler caller (app/api/replan) is
 * never prerendered or cached regardless of what it touches (only GET handlers can opt into
 * caching — see the Next docs' Route Handlers page), so it doesn't need one either.
 *
 * Telemetry writes here (logPriceSnapshot, logOptimizerRun) are best-effort and a no-op unless
 * TELEMETRY_DB_PATH is set (see lib/telemetry.ts) — so a triggered replan from a NUC dev/test
 * environment without that var set computes the same plan but simply doesn't publish it,
 * exactly like a normal render would.
 */
export async function producePlan(): Promise<PlanResult> {
  const [data, solarForecast, tempByDate, inverterData] = await Promise.all([
    // A prices outage must not take down the whole page: live status and earnings don't
    // need spot prices. The chart/optimizer sections degrade to a notice instead.
    fetchPrices().catch((err) => {
      console.error('fetchPrices failed, rendering without price chart/optimizer:', err);
      return null;
    }),
    // Logged (not just silently swallowed) so we can tell from journalctl how often this
    // actually happens — Open-Meteo outages long enough to hit this are believed to be rare,
    // but that's currently a guess, not measured.
    fetchSolarForecast().catch((err) => {
      console.error('fetchSolarForecast failed, falling back to seasonal-average solar profile:', err);
      return null;
    }),
    fetchDailyMeanTemp().catch((err) => {
      console.error('fetchDailyMeanTemp failed, falling back to seasonal-average load model:', err);
      return null;
    }),
    readLiveInverterData(),
  ]);

  const startSoc = socKwhOrDefault(inverterData);
  const socIsLive = inverterData != null;
  let solarProfiles: Record<number, number[]> = {};
  let dispatchSchedule: DispatchSlot[] | null = null;

  if (data) {
    solarProfiles = buildSolarProfiles(data);
    const allSlots = buildOptimizerSlots(data, solarForecast, solarProfiles, tempByDate);

    // Telemetry (best-effort, no-op unless TELEMETRY_DB_PATH is set). readLiveInverterData()
    // calls connection() above, so this runs at request time, never during `next build`.
    logPriceSnapshot(data);

    try {
      // Slice off already-elapsed slots so the optimizer's own index 0 lines up with
      // `startSoc` (the live SoC read above, "right now") instead of always being
      // today's midnight. Without this, optimizeDispatch's forward pass anchors a
      // live mid-day SoC reading to a fictitious midnight and produces a full-day
      // trajectory that has nothing to do with reality by the time real wall-clock
      // catches up to any slot past the first — see lib/prices.ts's
      // currentSlotIndexInPrices docstring and dispatch_loop.py's matching fix.
      // Clamp defensively: a negative index (stale cache/clock skew) falls back to
      // the whole array (old behaviour, never worse); past the end (now is beyond
      // the last loaded day) yields an empty slice, which optimizeDispatch and the
      // dispatch loop both already treat as "no plan right now" safely.
      const nowSlotIdx = Math.max(0, currentSlotIndexInPrices(data.today, new Date()));
      const optimizerSlots = allSlots.slice(nowSlotIdx);

      dispatchSchedule = optimizeDispatch(optimizerSlots, startSoc);
      logOptimizerRun(data.today, data.hasTomorrow, startSoc, optimizerSlots, dispatchSchedule, socIsLive);
    } catch (err) {
      // non-fatal — chart renders without dispatch overlay — but logged so a failure here
      // (e.g. optimizeDispatch throwing) isn't as invisible as the price_snapshots gap was.
      console.error('optimizeDispatch/logOptimizerRun failed:', err);
    }
  }

  return { data, solarProfiles, solarForecast, dispatchSchedule, startSoc, socIsLive, inverterData };
}
