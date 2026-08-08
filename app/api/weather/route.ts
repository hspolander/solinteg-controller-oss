/**
 * GET /api/weather — the on-site weather station's readings for today (Stockholm day).
 *
 * Reads the `weather` table (scripts/services/weather_poller.py appends WS90/Ecowitt readings
 * there every WEATHER_POLL_INTERVAL) and returns a slim wire form the MQTT publisher pushes
 * straight into an HA sensor's state + attributes:
 *
 *   { source, latest: { t, wm2, tempC, uvi } | null, today: [[epochMs, wm2, pvKw], ...] }
 *
 *   wm2   — measured global horizontal irradiance (W/m²) at the station.
 *   pvKw  — that SAME irradiance run through the solar model the forecast uses (ghiToKwh ×
 *           solarCalibrationByMonth), i.e. the production the model WOULD predict given the
 *           actual measured sky. On the dashboard this sits next to the forecast (model ⨉
 *           forecast-GHI) and the actual PV, so the two gaps decompose cleanly:
 *           forecast↔pvKw = weather-forecast error, pvKw↔actual = PV-model error. Since the
 *           model is linear this is exact, and it keeps everything on one kW axis (no need to
 *           expose raw forecast GHI).
 *
 * The row → wire-form mapping lives in lib/weather-series.ts (pure, tested); this route is the
 * query plus the best-effort gates around it.
 *
 * Best-effort like every getDb() consumer: any missing table / parse failure returns an empty
 * today[] rather than throwing — a telemetry hiccup must never break the publisher or a render.
 * Station timestamps are its own observation time (UTC ISO); today is bounded to the Stockholm
 * calendar day, same boundary pattern as lib/telemetry readTodaySocHistory.
 */
import { getDb } from '@/lib/telemetry/core';
import { stockholmParts, stockholmToUtc } from '@/lib/prices';
import { buildWeatherPayload, type WeatherRow } from '@/lib/weather-series';

// NB: NO `export const dynamic` here — the project runs Next 16 with cacheComponents enabled,
// which rejects route-segment config (`next build` fails, see the 0.7.2 build). Route handlers are
// dynamic per request anyway (like the other /api routes), so the DB read runs fresh every time.

const EMPTY = { source: 'weather', latest: null, today: [] };

export async function GET() {
  if (!process.env.TELEMETRY_DB_PATH) {
    return Response.json({ error: 'telemetry disabled (TELEMETRY_DB_PATH unset)' }, { status: 503 });
  }
  const handle = getDb();
  if (!handle) return Response.json(EMPTY);

  const p = stockholmParts(new Date());
  let rows: WeatherRow[] = [];
  try {
    const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
    rows = handle
      .prepare(
        'SELECT timestamp, solar_wm2, temp_c, uvi FROM weather WHERE timestamp >= ? ORDER BY timestamp',
      )
      .all(boundary) as unknown as WeatherRow[];
  } catch {
    return Response.json(EMPTY); // table absent / unreadable
  }

  return Response.json(buildWeatherPayload(rows, p.month0));
}
