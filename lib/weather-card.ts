/**
 * Pure presentation logic for the Väder (Weather) card: turns the latest weather-station
 * reading (lib/telemetry's LatestWeather) plus today's Open-Meteo forecast figures into the
 * shape app/components/WeatherCard.tsx renders. No React, no I/O — same pattern as
 * lib/dispatch-card.ts / lib/oracle-card.ts (see lib/__tests__/weather-card.test.ts).
 *
 * Display-only, and deliberately so: the optimizer's solar forecast comes from Open-Meteo
 * (lib/forecast.ts), never from the station. Showing the two side by side is useful — it makes
 * forecast error visible at a glance — but nothing here feeds planning, so a station that is
 * absent, offline or miscalibrated degrades this card and nothing else.
 *
 * The station is optional. `scripts/services/weather_poller.py` populates the `weather` table
 * if you run it; with no station the card renders its empty state and the rest of the dashboard
 * is unaffected.
 */
import type { LatestWeather } from './telemetry';

export interface WeatherCardData {
  secondsAgo: number;
  stale: boolean; // true once the station hasn't reported for a while (poller/API outage)
  tempC: number | null;
  solarWm2: number | null;
  humidityPct: number | null;
  windMs: number | null;
  rainDayMm: number | null;
  forecastGhiWm2: number | null; // today's forecast for the CURRENT hour, same W/m² units
  forecastMeanTempC: number | null; // today's forecast daily mean
}

// The weather poller runs every 60 s; a cloud-backed station API can lag a few minutes behind
// real time even when healthy (station → vendor cloud → our poll), so this is deliberately
// looser than the inverter's 2-minute staleness bar (PowerFlowCard) — same idea, different data
// source's normal lag, not a copy-paste of that constant.
const STALE_AFTER_S = 15 * 60;

export function buildWeatherCardData(
  latest: LatestWeather | null,
  forecastGhiWm2: number | null,
  forecastMeanTempC: number | null,
  now: Date,
): WeatherCardData | null {
  if (!latest) return null;
  const secondsAgo = Math.max(0, (now.getTime() - new Date(latest.timestamp).getTime()) / 1000);
  return {
    secondsAgo,
    stale: secondsAgo > STALE_AFTER_S,
    tempC: latest.temp_c,
    solarWm2: latest.solar_wm2,
    humidityPct: latest.humidity_pct,
    windMs: latest.wind_ms,
    rainDayMm: latest.rain_day_mm,
    forecastGhiWm2,
    forecastMeanTempC,
  };
}
