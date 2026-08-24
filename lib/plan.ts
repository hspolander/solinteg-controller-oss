import { connection } from 'next/server';
import { fetchPricesUncached, currentSlotIndexInPrices } from './prices';
import type { PriceData } from './prices';
import { fetchSolarForecast, fetchDailyMeanTemp } from './forecast';
import { fetchSolarForecastDirect, fetchDailyMeanTempDirect } from './metno-thredds';
import { buildSolarProfiles, buildOptimizerSlots } from './pipeline';
import { optimizeDispatch } from './optimizer';
import type { DispatchSlot } from './optimizer';
import { readLiveInverterData, socKwhOrDefault } from './inverter';
import type { InverterLiveData } from './inverter';
import { logPriceSnapshot, logOptimizerRun, readTrailingLoadProfile } from './telemetry';
import {
  LIVE_LOAD_PROFILE_DAYS,
  LOAD_FORECAST_MARGIN,
  DEFERRAL_RATE_ORE_PER_KWH_HOUR,
  SOLAR_RISK_PREMIUM_ORE_PER_KWH,
  SOLAR_FORECAST_MODEL,
} from './constants';

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
 * **Caching in this call graph, and the one rule that matters.** This app runs with
 * cacheComponents on (next.config.ts). This docstring used to claim the call graph carried no
 * 'use cache' directive anywhere — it was not true, and the gap between the claim and the code
 * is where a real bug lived: fetchPrices() carried one, so the plan's price horizon came from a
 * cache entry that a page render and a POST route handler resolved differently, and the newest
 * published plan flip-flopped between horizon-aware and today-only after each day-ahead release.
 * The price read is now fetchPricesUncached() and genuinely request-time.
 *
 * The rule, stated properly: **staleness is only acceptable where a stale answer beats the
 * fallback.**
 *   - Prices: NEVER cached here. A stale horizon is not an old number, it is the optimizer
 *     solving yesterday's problem, and it reaches the inverter.
 *   - Solar/temp forecasts: DELIBERATELY still cached (lib/forecast.ts, 1 h revalidate / 8 h
 *     expire). A several-hours-old real forecast still encodes today-specific conditions — an
 *     approaching front, expected cloud cover — and strictly beats the alternative, which is the
 *     seasonal-average climatology this chain falls back to. Do not "fix" these to match prices;
 *     that trades a good input for a worse one.
 *   - Live SoC: readLiveInverterData() calls connection() internally, which is what lets a
 *     Server Component caller (app/page.tsx) legally bail out of prerendering.
 *
 * A POST Route Handler caller (app/api/replan) is never prerendered or cached regardless of what
 * it touches (only GET handlers can opt into caching — see the Next docs' Route Handlers page),
 * so it doesn't need a marker either.
 *
 * Telemetry writes here (logPriceSnapshot, logOptimizerRun) are best-effort and a no-op unless
 * TELEMETRY_DB_PATH is set (see lib/telemetry/core.ts) — so a triggered replan from a NUC dev/test
 * environment without that var set computes the same plan but simply doesn't publish it,
 * exactly like a normal render would.
 */
export async function producePlan(): Promise<PlanResult> {
  // Awaited FIRST, before anything in the Promise.all below starts. readLiveInverterData() also
  // calls connection(), but that is only sufficient while everything else in the group sits in a
  // 'use cache' scope. With a genuinely request-time price read, its `new Date()` and fetch()
  // run concurrently with that bail-out and the prerender aborts on whichever illegal access
  // lands first — a real build failure ("Error occurred prerendering page /"). Declaring the
  // dependency once, up front, is the honest statement anyway: a plan reads the clock, reads live
  // SoC and writes telemetry. It can never be part of a prerendered shell.
  await connection();

  const [data, solarForecast, tempByDate, inverterData] = await Promise.all([
    // A prices outage must not take down the whole page: live status and earnings don't
    // need spot prices. The chart/optimizer sections degrade to a notice instead.
    fetchPricesUncached().catch((err) => {
      console.error('fetchPricesUncached failed, rendering without price chart/optimizer:', err);
      return null;
    }),
    // Logged (not just silently swallowed) so we can tell from journalctl how often this
    // actually happens — Open-Meteo outages long enough to hit this are believed to be rare,
    // but that's currently a guess, not measured. When SOLAR_FORECAST_MODEL is 'metno_nordic'
    // (the default), a failure here tries MET Norway's own Thredds server directly
    // (lib/metno-thredds.ts) before giving up to seasonal-average climatology — that fallback
    // only mirrors metno_nordic specifically, so it's skipped for any other model choice.
    fetchSolarForecast()
      .catch((err) => {
        console.error('fetchSolarForecast failed:', err);
        if (SOLAR_FORECAST_MODEL !== 'metno_nordic') throw err;
        console.error('trying direct MET Norway fallback');
        return fetchSolarForecastDirect();
      })
      .catch((err) => {
        console.error('falling back to seasonal-average solar profile:', err);
        return null;
      }),
    fetchDailyMeanTemp()
      .catch((err) => {
        console.error('fetchDailyMeanTemp failed:', err);
        if (SOLAR_FORECAST_MODEL !== 'metno_nordic') throw err;
        console.error('trying direct MET Norway fallback');
        return fetchDailyMeanTempDirect();
      })
      .catch((err) => {
        console.error('falling back to seasonal-average load model:', err);
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
    // Live trailing load profile (null off-NUC or on thin data → static model fallback).
    // Read here, not inside buildOptimizerSlots, to keep that function pure/testable.
    const liveLoad = readTrailingLoadProfile(LIVE_LOAD_PROFILE_DAYS);
    const allSlots = buildOptimizerSlots(data, solarForecast, solarProfiles, tempByDate, liveLoad);

    // Telemetry (best-effort, no-op unless TELEMETRY_DB_PATH is set). producePlan() awaits
    // connection() at its top, so this runs at request time, never during `next build`.
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

      // loadFactor: plan against pessimistic load (LOAD_FORECAST_MARGIN) so the trajectory
      // keeps slack for forecast error — optimizerSlots themselves stay the honest forecast,
      // and that's what gets logged below, so forecast-vs-actual validation against readings
      // measures the model, not the deliberate margin.
      // deferral/solar-risk: risk-aware planning (added 2026-07-19 — see each constant's
      // rationale in lib/constants.ts). Live plans only; the hindsight oracle must never
      // carry these, same as loadFactor. Kill switches: set the corresponding env vars
      // (SOLINTEG_DEFERRAL_RATE_ORE / SOLINTEG_SOLAR_RISK_PREMIUM_ORE) to 0.
      dispatchSchedule = optimizeDispatch(optimizerSlots, startSoc, {
        loadFactor: LOAD_FORECAST_MARGIN,
        deferralRateOrePerKwhHour: DEFERRAL_RATE_ORE_PER_KWH_HOUR,
        solarRiskPremiumOre: SOLAR_RISK_PREMIUM_ORE_PER_KWH,
      });
      logOptimizerRun(data.today, data.hasTomorrow, startSoc, optimizerSlots, dispatchSchedule, socIsLive);
    } catch (err) {
      // non-fatal — chart renders without dispatch overlay — but logged so a failure here
      // (e.g. optimizeDispatch throwing) isn't as invisible as the price_snapshots gap was.
      console.error('optimizeDispatch/logOptimizerRun failed:', err);
    }
  }

  return { data, solarProfiles, solarForecast, dispatchSchedule, startSoc, socIsLive, inverterData };
}
