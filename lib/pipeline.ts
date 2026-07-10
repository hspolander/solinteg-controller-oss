import { getSolarProfileByMonth } from './solar';
import { slotSolarKwh } from './slot-utils';
import { slotConsumptionKwh } from './load';
import { SKATT_OVERFÖRING } from './constants';
import type { PriceData } from './prices';
import type { OptimizerSlot } from './optimizer';

/**
 * Builds the monthly irradiance profiles needed for solar fallback estimates.
 * Covers today and tomorrow (which may span a month boundary).
 */
export function buildSolarProfiles(
  data: Pick<PriceData, 'today' | 'tomorrow'>,
): Record<number, number[]> {
  const todayMonth = parseInt(data.today.slice(5, 7), 10);
  const tomorrowMonth = parseInt(data.tomorrow.slice(5, 7), 10);
  const profiles: Record<number, number[]> = {
    [todayMonth]: getSolarProfileByMonth(todayMonth),
  };
  if (tomorrowMonth !== todayMonth) {
    profiles[tomorrowMonth] = getSolarProfileByMonth(tomorrowMonth);
  }
  return profiles;
}

/**
 * Maps raw price slots + solar data into the shape the optimizer expects.
 * Pure function — no I/O, no Next.js dependencies, fully testable.
 */
export function buildOptimizerSlots(
  data: PriceData,
  forecast: Record<string, number[]> | null | undefined,
  profiles: Record<number, number[]>,
  tempByDate?: Record<string, number> | null,
): OptimizerSlot[] {
  return data.prices.map((slot) => {
    const { kwh: solarKwh, source: solarSource } = slotSolarKwh(slot.startTime, forecast, profiles);
    const date = slot.startTime.slice(0, 10);
    const loadSource = tempByDate?.[date] != null ? 'modeled' : 'baseline';
    return {
      startTime: slot.startTime,
      buyPrice: slot.priceIncludingTaxAndSurcharge + SKATT_OVERFÖRING,
      sellPrice: slot.price,
      solarKwh,
      solarSource,
      consumptionKwh: slotConsumptionKwh(slot.startTime, tempByDate),
      loadSource,
    };
  });
}
