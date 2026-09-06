/**
 * Liveness probe for the SECOND solar/temperature tier.
 *
 * GET /api/weather-fallback-check → 200 {ok:true, run, hours} | 503 {ok:false, error}
 *
 * The forecast chain is Open-Meteo → MET Norway's Thredds server direct (lib/metno-thredds.ts,
 * only when SOLAR_FORECAST_MODEL is 'metno_nordic') → the persisted last-good forecast
 * (lib/solar-forecast-cache.ts) → seasonal climatology. Only the first tier is exercised on a
 * normal day, so tiers 2+ can rot silently: on the reference deployment the Thredds fetch was
 * returning 400 for weeks (raw brackets in the OPeNDAP query, since fixed) and nothing could
 * have noticed, because a fallback that only runs when the primary fails emits no signal of its
 * own. This endpoint is that signal — it runs the real tier-2 code path on demand, while the
 * primary is healthy.
 *
 * Polled once a day by healthcheck.py's check_weather_fallback_dead, which owns the rate
 * limiting — each call makes thredds.met.no subset a live multi-GB NetCDF file server-side (~8 s
 * measured), and the walk-back can repeat that up to RUN_LOOKBACK_ATTEMPTS times. Do not poll it
 * tightly, and do not wire it into a page render.
 *
 * Like every other route here it has no auth of its own (see CLAUDE.md on why the deployment
 * boundary is the network, not the app), and it grants no authority a GET already has: it writes
 * nothing, touches no register, and its only effect is one outbound request to met.no.
 */
import { connection } from 'next/server';
import { probeMetNordicDirect } from '@/lib/metno-thredds';

export async function GET() {
  // Request-time, never prerendered and never cached: a cached answer would be a lie about
  // liveness, which is the one thing this route exists to report.
  await connection();
  try {
    const { runIso, hours } = await probeMetNordicDirect();
    return Response.json({ ok: true, run: runIso, hours });
  } catch (err) {
    // 503, not 500: the tier being unavailable is this endpoint working correctly. The message
    // is the fetch's own (e.g. "met.no thredds fetch failed: 400"), and it names the OLDEST run
    // the walk-back tried — see fetchLatestRun.
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
