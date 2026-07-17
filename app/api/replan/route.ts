/**
 * On-demand plan recompute — lets something other than a dashboard render ask for a fresh
 * optimizer_runs row right now, instead of waiting for the next real page view, the 5-min
 * AutoRefresh tick, or solinteg-telemetry.timer's hourly curl (see deploy/solinteg-telemetry.timer). The one caller today is dispatch_loop.py's maybe_request_replan, fired when the
 * loop notices the live plan has drifted from reality (SoC divergence, a guard skip, no plan
 * covering now, or tomorrow's prices still missing after 13:05) — see that module's docstring.
 *
 * POST-only, deliberately: this route grants NO authority a GET already has. producePlan() is
 * exactly what every dashboard render already does (app/page.tsx calls the same function) —
 * hitting this endpoint just makes that happen on demand instead of on a schedule. There is no
 * separate "apply to the inverter" step here; dispatch_loop.py still only ever reads back
 * whatever the newest optimizer_runs row says on its own next tick, unchanged by this route's
 * existence. POST (rather than GET) is simply the conventional verb for "do a side-effecting
 * computation now" — nothing about GET vs POST changes what this is allowed to do.
 *
 * The socIsLive publish gate inside logOptimizerRun (see lib/telemetry.ts) still applies here
 * exactly as it does on a normal render: if the poller's live.json is missing/stale when this
 * fires, producePlan() still computes and returns a plan (anchored to socKwhOrDefault's
 * fallback SoC), but that plan is NOT written to optimizer_runs — the dispatch loop keeps acting
 * on the last live-anchored row. So a replan triggered during a poller outage is display-only;
 * it can never hand the dispatch loop a plan built from a guessed starting SoC. `ok` below
 * reflects only whether a dispatch schedule was computed at all, not whether it was published —
 * check `socIsLive` in the response (or the optimizer_runs table itself) for that.
 */
import { producePlan } from '@/lib/plan';

export async function POST() {
  try {
    const { data, dispatchSchedule, startSoc, socIsLive } = await producePlan();
    return Response.json({
      ok: dispatchSchedule != null,
      socIsLive,
      startSoc,
      hasTomorrow: data?.hasTomorrow ?? false,
      slotCount: dispatchSchedule?.length ?? 0,
    });
  } catch (err) {
    console.error('POST /api/replan failed:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
