'use client';

import { useMemo } from 'react';
import {
  buildActionBands,
  buildChartData,
  buildChartGeometry,
  buildTimeIndex,
  buildXTicks,
  computePriceMax,
  computePriceMin,
  computeSolarMax,
} from '@/lib/chart-utils';
import type { PriceData } from '@/lib/prices';
import type { DispatchSlot } from '@/lib/optimizer';

export function useChartData(
  data: PriceData,
  solarProfiles: Record<number, number[]>,
  solarForecast: Record<string, number[]> | null | undefined,
  dispatchSchedule: DispatchSlot[] | null | undefined,
  batteryKwh: number,
  skattOverforing: number,
  actualSocByTime: Record<string, number> = {},
) {
  const dispatchByTime = useMemo(() => {
    if (!dispatchSchedule) return {} as Record<string, DispatchSlot>;
    return Object.fromEntries(dispatchSchedule.map((d) => [d.startTime, d]));
  }, [dispatchSchedule]);

  const actionBands = useMemo(
    () => buildActionBands(dispatchSchedule ?? []),
    [dispatchSchedule],
  );

  const chartData = useMemo(
    () =>
      buildChartData(
        data.prices,
        solarForecast,
        solarProfiles,
        dispatchByTime,
        batteryKwh,
        skattOverforing,
        actualSocByTime,
      ),
    [data.prices, solarForecast, solarProfiles, dispatchByTime, batteryKwh, skattOverforing, actualSocByTime],
  );

  const xTicks = useMemo(() => buildXTicks(data.prices), [data.prices]);

  const tomorrowIdx = useMemo(
    () => data.prices.findIndex((p) => p.startTime.startsWith(data.tomorrow)),
    [data.prices, data.tomorrow],
  );

  const firstTime = chartData[0]?.time ?? null;
  const lastTime = chartData[chartData.length - 1]?.time ?? null;
  const tomorrowTime = tomorrowIdx > 0 ? (chartData[tomorrowIdx]?.time ?? null) : null;
  const beforeTomorrowTime = tomorrowIdx > 0 ? (chartData[tomorrowIdx - 1]?.time ?? null) : null;

  // SVG chart view-model: geometry is a fixed constant, but timeIndex/priceMax/solarMax depend
  // on the actual (variable-length, variable-range) chartData. Height is taller than the
  // mockup's own 388 default so the card has more visual weight next to PowerFlowCard.
  const geometry = useMemo(() => buildChartGeometry(1040, 410), []);
  const timeIndex = useMemo(() => buildTimeIndex(chartData), [chartData]);
  const priceMax = useMemo(() => computePriceMax(chartData), [chartData]);
  const priceMin = useMemo(() => computePriceMin(chartData), [chartData]);
  const solarMax = useMemo(() => computeSolarMax(chartData), [chartData]);

  return {
    actionBands,
    chartData,
    xTicks,
    firstTime,
    lastTime,
    tomorrowTime,
    beforeTomorrowTime,
    geometry,
    timeIndex,
    priceMax,
    priceMin,
    solarMax,
  };
}
