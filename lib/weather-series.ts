/**
 * Pure row → wire-form mapping for GET /api/weather: turns raw `weather` table rows
 * (scripts/services/weather_poller.py's WS90/Ecowitt appends) into the payload the MQTT
 * publisher pushes into an HA sensor. No React, no I/O — kept separate and pure so the
 * calibration arithmetic, the null-reading skip and the naive-timestamp fallback are
 * unit-testable (see lib/__tests__/weather-series.test.ts), matching lib/dispatch-card.ts's
 * pattern. app/api/weather/route.ts stays query + call.
 */
import { ghiToKwh } from './solar';
import { solarCalibrationByMonth } from './consumption-data';

export type WeatherRow = {
  timestamp: string;
  solar_wm2: number | null;
  temp_c: number | null;
  uvi: number | null;
};

/** [epochMs, measured GHI (W/m²), modelled production (kW)] */
export type WeatherSample = [number, number, number];

export interface WeatherLatest {
  t: number;
  wm2: number | null;
  tempC: number | null;
  uvi: number | null;
}

export interface WeatherPayload {
  source: 'weather';
  latest: WeatherLatest | null;
  today: WeatherSample[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The poller writes an offset-carrying UTC stamp (weather_poller.py's
 * `datetime.fromtimestamp(..., timezone.utc).isoformat()`), so the fallback here is defensive:
 * a naive stamp is read as UTC, matching the column's documented meaning. The designator has to
 * be checked syntactically rather than by letting a bare Date.parse fail first — it doesn't fail,
 * it succeeds with HOST-LOCAL semantics, which would silently shift the point by the host's
 * offset (two hours in Swedish summer).
 */
export function epochMs(iso: string): number | null {
  const ms = Date.parse(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Rows → the today[] series. `month0` is 0-based (stockholmParts' `month0`), which indexes
 * solarCalibrationByMonth directly — no `- 1`, unlike lib/forecast.ts and lib/metno-thredds.ts
 * which start from a 1-based month.
 *
 * The calibration factor is NOT optional: ghiToKwh() is the raw GHI × kWp × PR model, which runs
 * 13–43% low against measured production (see solarCalibrationByMonth), and every other caller
 * scales by it. Without it pvKw would sit systematically below the forecast series it exists to be
 * compared against — the forecast↔pvKw gap would be dominated by the missing correction rather
 * than isolating weather-forecast error, and the number lands in an HA sensor where it reads as a
 * measurement rather than as model output.
 *
 * The series is bounded to one Stockholm calendar day by the caller's query, so the month is
 * constant across it and the factor is looked up once.
 */
export function buildWeatherSeries(rows: WeatherRow[], month0: number): WeatherSample[] {
  const cal = solarCalibrationByMonth[month0];
  const today: WeatherSample[] = [];
  for (const r of rows) {
    if (r.solar_wm2 == null) continue;
    const t = epochMs(r.timestamp);
    if (t == null) continue;
    today.push([t, round1(r.solar_wm2), round2(ghiToKwh(r.solar_wm2) * cal)]);
  }
  return today;
}

/**
 * The station's most recent row — the last one chronologically, whether or not it carries an
 * irradiance reading (temp/UVI alone still make a valid "latest"; the individual fields go null).
 * Rows arrive ordered by timestamp from the query.
 */
export function latestReading(rows: WeatherRow[]): WeatherLatest | null {
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  if (!lastRow) return null;
  const t = epochMs(lastRow.timestamp);
  if (t == null) return null;
  return {
    t,
    wm2: lastRow.solar_wm2 == null ? null : round1(lastRow.solar_wm2),
    tempC: lastRow.temp_c == null ? null : round1(lastRow.temp_c),
    uvi: lastRow.uvi == null ? null : round1(lastRow.uvi),
  };
}

export function buildWeatherPayload(rows: WeatherRow[], month0: number): WeatherPayload {
  return { source: 'weather', latest: latestReading(rows), today: buildWeatherSeries(rows, month0) };
}
