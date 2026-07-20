import { cacheLife } from 'next/cache';
import { ghiToKwh } from './solar';
import { slotIndex } from './slot-utils';
import { solarCalibrationByMonth } from './consumption-data';
import { FETCH_TIMEOUT_MS, SITE_LATITUDE, SITE_LONGITUDE, SOLAR_FORECAST_MODEL } from './constants';

// SOLAR_FORECAST_MODEL (see lib/constants.ts) picks a `models=` value or '' for the default
// best_match blend. Non-default models (verified for metno_nordic, 2026-07-18) don't expose
// a minutely_15 variant, so a model choice always fetches hourly here — see the slot-filling
// comment below for how that's spread across each hour's four 15-min slots.
const FORECAST_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${SITE_LATITUDE}&longitude=${SITE_LONGITUDE}` +
  (SOLAR_FORECAST_MODEL
    ? `&hourly=shortwave_radiation&models=${SOLAR_FORECAST_MODEL}`
    : '&minutely_15=shortwave_radiation') +
  '&forecast_days=2&timezone=Europe%2FStockholm';

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

  const result: Record<string, number[]> = {};

  if (SOLAR_FORECAST_MODEL) {
    // Hourly-only model: repeat each hour's value across its four 15-min slots rather than
    // interpolating — an Open-Meteo hourly value is itself an hour-average, not an instant
    // sample a real sub-hourly curve could be recovered from.
    //
    // Open-Meteo's hourly label is the average of the PRECEDING hour (confirmed against their
    // docs, a live MET Nordic Thredds cross-check, and compare-metno-solar.mjs's own
    // empirically-fit alignment offset), so shift back one hour to land on the slots the value
    // actually describes. Skip label hour 0: its target would be the previous day's 23:00,
    // already elapsed and outside the fetched window — slotSolarKwh's seasonal-average fallback
    // covers that one slot until the next hourly refetch's window reaches it.
    const times: string[] = data.hourly.time;
    const ghiValues: number[] = data.hourly.shortwave_radiation;
    for (let i = 0; i < times.length; i++) {
      const labelHour = parseInt(times[i].slice(11, 13), 10);
      if (labelHour === 0) continue;
      const date = times[i].slice(0, 10);
      const hour = labelHour - 1;
      const month = parseInt(date.slice(5, 7), 10);
      const cal = solarCalibrationByMonth[month - 1];
      const kwhPerSlot = Math.round((ghiToKwh(ghiValues[i]) * cal / 4) * 100) / 100;
      if (!result[date]) result[date] = new Array(96).fill(0);
      for (let minute = 0; minute < 60; minute += 15) {
        result[date][slotIndex(hour, minute)] = kwhPerSlot;
      }
    }
    return result;
  }

  // Same preceding-interval convention applies at 15-min granularity ("preceding 15 minutes
  // mean" per Open-Meteo's docs) — shift back one slot, skipping slot 0 for the same
  // already-elapsed-previous-day reason as above.
  const times: string[] = data.minutely_15.time;
  const ghiValues: number[] = data.minutely_15.shortwave_radiation;
  for (let i = 0; i < times.length; i++) {
    const date = times[i].slice(0, 10);
    const hour = parseInt(times[i].slice(11, 13), 10);
    const minute = parseInt(times[i].slice(14, 16), 10);
    const labelIdx = slotIndex(hour, minute);
    if (labelIdx === 0) continue;
    const idx = labelIdx - 1;
    const month = parseInt(date.slice(5, 7), 10);
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
