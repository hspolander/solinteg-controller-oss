import {
  avgDailyConsumptionByMonth,
  hddNormalByMonth,
  HDD_T_BASE_C,
  LOAD_SLOPE_KWH_PER_HDD,
} from './consumption-data';

const MIN_DAILY_LOAD_KWH = 3; // floor: never predict an implausibly low household day

/**
 * Expected total household consumption for a whole day (kWh).
 *
 * Uses the measured monthly average as the level and adds a within-month heating
 * adjustment driven by the day's mean temperature:
 *
 *   load = avgDailyConsumptionByMonth[m] + slope × (HDD − hddNormal[m]),
 *   HDD  = max(0, HDD_T_BASE_C − dailyMeanTemp).
 *
 * When `dailyMeanTemp` is null (no forecast), falls back to the plain monthly
 * average (adjustment = 0). The adjustment self-zeroes in summer because both
 * HDD and hddNormal are ≈0 there.
 *
 * @param month 1-based month (1 = January)
 */
export function dailyLoadKwh(month: number, dailyMeanTemp: number | null | undefined): number {
  const baseline = avgDailyConsumptionByMonth[month - 1] ?? 0;
  if (dailyMeanTemp == null) return Math.max(MIN_DAILY_LOAD_KWH, baseline);
  const hdd = Math.max(0, HDD_T_BASE_C - dailyMeanTemp);
  const adjusted = baseline + LOAD_SLOPE_KWH_PER_HDD * (hdd - hddNormalByMonth[month - 1]);
  return Math.max(MIN_DAILY_LOAD_KWH, adjusted);
}

/**
 * Expected household consumption for one 15-min slot (kWh).
 *
 * The daily total is spread uniformly across the 96 slots. We deliberately do
 * NOT impose an intraday shape: the only available hourly series is grid import,
 * whose shape is dominated by a night-tariff timer (hot-water / scheduled battery
 * charging) rather than genuine load — exactly the behaviour the optimizer is
 * meant to replace. A uniform split keeps the weather-aware daily energy honest
 * without baking in that artefact. Replace with a measured total-load profile if
 * one becomes available.
 *
 * @param startTime ISO-like local timestamp "YYYY-MM-DDTHH:MM:SS"
 * @param tempByDate date → forecast daily mean temperature (°C)
 */
export function slotConsumptionKwh(
  startTime: string,
  tempByDate: Record<string, number> | null | undefined,
): number {
  const date = startTime.slice(0, 10);
  const month = parseInt(startTime.slice(5, 7), 10);
  const temp = tempByDate?.[date] ?? null;
  return dailyLoadKwh(month, temp) / 96;
}
