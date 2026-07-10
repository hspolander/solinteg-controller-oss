/**
 * 0-based wall-clock index into a NOMINAL 96-slot day: hour*4 + quarter (0, 1, 2, 3).
 * Right for keying fixed 96-entry typical/forecast arrays, but NOT for positions in a
 * loaded prices array — DST-transition days really have 92/100 slots, so use the
 * elapsed-time-based currentSlotIndexInPrices (lib/prices.ts) for those.
 */
export function slotIndex(hour: number, minute: number): number {
  return hour * 4 + Math.floor(minute / 15);
}

/** Stockholm UTC offset in hours: CEST Apr–Oct = +2, CET Nov–Mar = +1 */
export function stockholmUtcOffset(month: number): number {
  return month >= 4 && month <= 10 ? 2 : 1;
}

/**
 * kWh produced in one 15-min slot, with forecast taking priority over static profile.
 * Returns both the value and the source so callers can label the data correctly.
 */
export function slotSolarKwh(
  startTime: string,
  forecast: Record<string, number[]> | null | undefined,
  profiles: Record<number, number[]>,
): { kwh: number; source: 'forecast' | 'typical' } {
  const date = startTime.slice(0, 10);
  const month = parseInt(startTime.slice(5, 7), 10);
  const hour = parseInt(startTime.slice(11, 13), 10);
  const minute = parseInt(startTime.slice(14, 16), 10);
  const idx = slotIndex(hour, minute);

  const forecastKwh = forecast?.[date]?.[idx];
  if (forecastKwh !== undefined) return { kwh: forecastKwh, source: 'forecast' };

  const utcHour = (hour - stockholmUtcOffset(month) + 24) % 24;
  return { kwh: (profiles[month]?.[utcHour] ?? 0) / 4, source: 'typical' };
}
