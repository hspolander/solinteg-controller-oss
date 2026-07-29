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
 *   pvKw  — that SAME irradiance run through the solar model the forecast uses (ghiToKwh),
 *           i.e. the production the model WOULD predict given the actual measured sky. On the
 *           dashboard this sits next to the forecast (model ⨉ forecast-GHI) and the actual PV,
 *           so the two gaps decompose cleanly: forecast↔pvKw = weather-forecast error,
 *           pvKw↔actual = PV-model error. Since ghiToKwh is linear this is exact, and it keeps
 *           everything on one kW axis (no need to expose raw forecast GHI).
 *
 * Best-effort like every getDb() consumer: any missing table / parse failure returns an empty
 * today[] rather than throwing — a telemetry hiccup must never break the publisher or a render.
 * Station timestamps are its own observation time (UTC ISO); today is bounded to the Stockholm
 * calendar day, same boundary pattern as lib/telemetry readTodaySocHistory.
 */
import { getDb } from '@/lib/telemetry/core';
import { stockholmParts, stockholmToUtc } from '@/lib/prices';
import { ghiToKwh } from '@/lib/solar';

// NB: NO `export const dynamic` here — the project runs Next 16 with cacheComponents enabled,
// which rejects route-segment config (`next build` fails, see the 0.7.2 build). Route handlers are
// dynamic per request anyway (like the other /api routes), so the DB read runs fresh every time.
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

type WeatherRow = {
  timestamp: string;
  solar_wm2: number | null;
  temp_c: number | null;
  uvi: number | null;
};

function epochMs(iso: string): number | null {
  let ms = Date.parse(iso);
  if (Number.isNaN(ms)) ms = Date.parse(`${iso}Z`); // tolerate an offset-less (naive) stamp
  return Number.isNaN(ms) ? null : ms;
}

export async function GET() {
  if (!process.env.TELEMETRY_DB_PATH) {
    return Response.json({ error: 'telemetry disabled (TELEMETRY_DB_PATH unset)' }, { status: 503 });
  }
  const handle = getDb();
  if (!handle) return Response.json({ source: 'weather', latest: null, today: [] });

  let rows: WeatherRow[] = [];
  try {
    const p = stockholmParts(new Date());
    const boundary = stockholmToUtc(p.year, p.month0, p.day, p.utcOffset, 0, 0).toISOString();
    rows = handle
      .prepare(
        'SELECT timestamp, solar_wm2, temp_c, uvi FROM weather WHERE timestamp >= ? ORDER BY timestamp',
      )
      .all(boundary) as unknown as WeatherRow[];
  } catch {
    return Response.json({ source: 'weather', latest: null, today: [] }); // table absent / unreadable
  }

  const today: [number, number, number][] = [];
  for (const r of rows) {
    if (r.solar_wm2 == null) continue;
    const t = epochMs(r.timestamp);
    if (t == null) continue;
    today.push([t, round1(r.solar_wm2), round2(ghiToKwh(r.solar_wm2))]);
  }

  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastT = lastRow ? epochMs(lastRow.timestamp) : null;
  const latest =
    lastRow && lastT != null
      ? {
          t: lastT,
          wm2: lastRow.solar_wm2 == null ? null : round1(lastRow.solar_wm2),
          tempC: lastRow.temp_c == null ? null : round1(lastRow.temp_c),
          uvi: lastRow.uvi == null ? null : round1(lastRow.uvi),
        }
      : null;

  return Response.json({ source: 'weather', latest, today });
}
