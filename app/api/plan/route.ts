/**
 * GET /api/plan — the Solinteg optimizer's CURRENT forward dispatch plan.
 *
 * Returns the latest optimizer_runs row (as fresh as the dispatch loop's last replan) in a
 * slim wire form the MQTT publisher can push straight into an HA sensor's attributes:
 *
 *   { loggedAt, batteryKwh, slots: [[epochSec, gridKw, socPct, solarKw], ...] }
 *
 *   gridKw  — planned net grid exchange for the 15-min slot, kW (+ = buy, − = sell)
 *   socPct  — planned battery SoC (%) after the slot completes
 *   solarKw — the solar forecast the plan was computed against (from the run's inputs,
 *             joined by startTime; null if the input slot is missing)
 *
 * NOTE: this is the plan of THIS optimizer. In shadow mode (control_armed=false) the battery
 * is driven by the incumbent, so planned SoC will diverge from measured SoC — the dashboard
 * labels the series "Plan:" for exactly that reason. Consumers must treat slots in the past
 * (plan computed a while ago) as stale and filter on epochSec >= now.
 */
import { BATTERY_KWH } from '@/lib/optimizer';
import { readLatestOptimizerRun } from '@/lib/telemetry';

const round2 = (n: number) => Math.round(n * 100) / 100;
const SLOTS_PER_HOUR = 4;

export async function GET() {
  if (!process.env.TELEMETRY_DB_PATH) {
    return Response.json({ error: 'telemetry disabled (TELEMETRY_DB_PATH unset)' }, { status: 503 });
  }
  const run = readLatestOptimizerRun();
  if (!run) return Response.json({ loggedAt: null, batteryKwh: BATTERY_KWH, slots: [] });
  const solarByStart = new Map(run.inputs.map((i) => [i.startTime, i.solarKwh]));
  const slots = run.dispatch.map((s) => {
    const solarKwh = solarByStart.get(s.startTime);
    return [
      Math.floor(new Date(s.startTime).getTime() / 1000),
      round2(s.gridKwh * SLOTS_PER_HOUR), // kWh per 15-min slot → kW
      round2((s.socAfter / BATTERY_KWH) * 100), // kWh → %
      solarKwh === undefined ? null : round2(solarKwh * SLOTS_PER_HOUR),
    ];
  });
  return Response.json({ loggedAt: run.loggedAt, batteryKwh: BATTERY_KWH, slots });
}
