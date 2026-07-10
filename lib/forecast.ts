import { cacheLife } from 'next/cache';
import { ghiToKwh } from './solar';
import { slotIndex } from './slot-utils';
import { solarCalibrationByMonth } from './consumption-data';
import { FETCH_TIMEOUT_MS, SITE_LATITUDE, SITE_LONGITUDE } from './constants';

const FORECAST_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${SITE_LATITUDE}&longitude=${SITE_LONGITUDE}` +
  '&minutely_15=shortwave_radiation&forecast_days=2&timezone=Europe%2FStockholm';

const TEMP_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${SITE_LATITUDE}&longitude=${SITE_LONGITUDE}` +
  '&daily=temperature_2m_mean&forecast_days=2&timezone=Europe%2FStockholm';

// Returns date → 96-element array of kWh per 15-min slot, indexed by slotIndex = hour*4 + quarter (0-95).
// GHI from Open Meteo is W/m² instantaneous; dividing ghiToKwh by 4 converts from kWh/h to kWh/15min.
export async function fetchSolarForecast(): Promise<Record<string, number[]>> {
  'use cache';
  // Still try to refresh hourly, but keep serving a stale forecast for up to 8h if Open-Meteo
  // is unreachable — a several-hours-old forecast still encodes today-specific conditions (an
  // approaching front, expected cloud cover) that a climatological monthly average has no way
  // to know. slotSolarKwh's fallback (lib/slot-utils.ts) is already per-slot/per-date, so any
  // slot the stale snapshot doesn't cover (e.g. a date it never fetched) still falls back to the
  // seasonal average on its own — widening this window can only ever help, never hurt.
  cacheLife({ revalidate: 3600, expire: 8 * 3600 });

  const res = await fetch(FORECAST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open Meteo fetch failed: ${res.status}`);
  const data = await res.json();

  const times: string[] = data.minutely_15.time;
  const ghiValues: number[] = data.minutely_15.shortwave_radiation;

  const result: Record<string, number[]> = {};
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const month = parseInt(date.slice(5, 7), 10);
    const hour = parseInt(times[i].slice(11, 13), 10);
    const minute = parseInt(times[i].slice(14, 16), 10);
    const idx = slotIndex(hour, minute);
    const cal = solarCalibrationByMonth[month - 1];
    if (!result[date]) result[date] = new Array(96).fill(0);
    result[date][idx] = Math.round((ghiToKwh(ghiValues[i]) * cal / 4) * 100) / 100;
  }
  return result;
}

// Returns date → forecast daily mean outdoor temperature (°C), for today and tomorrow.
// Drives the weather-aware load model (see lib/load.ts). Same Open-Meteo endpoint,
// daily aggregation; cached on the same 1 h / 8 h schedule as the solar forecast.
export async function fetchDailyMeanTemp(): Promise<Record<string, number>> {
  'use cache';
  cacheLife({ revalidate: 3600, expire: 8 * 3600 });

  const res = await fetch(TEMP_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open Meteo temp fetch failed: ${res.status}`);
  const data = await res.json();

  const times: string[] = data.daily.time;
  const temps: number[] = data.daily.temperature_2m_mean;
  const result: Record<string, number> = {};
  times.forEach((date, i) => {
    if (temps[i] != null) result[date] = temps[i];
  });
  return result;
}
