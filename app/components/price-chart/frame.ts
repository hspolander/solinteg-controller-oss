'use client';

import { indexToX, timeToX } from '@/lib/chart-utils';
import type { ChartGeometry, ChartPoint } from '@/lib/chart-utils';

/**
 * The projection every part of the chart draws against: the data, the box it's drawn in, and
 * the scales that map one onto the other.
 *
 * Bundled rather than passed as eight separate props because PriceChart.tsx was split into
 * layers (bands → axes → series → overlay) on 2026-08-07 and every layer needs most of these.
 * As individual props that split would have traded a 600-line function for four components with
 * eight-argument prop lists, which is not an improvement.
 *
 * `tx` is the reason this is a factory rather than a plain object literal: `timeToX(t,
 * chartData, geo, timeIndex)` was spelled out fourteen times in the old single-file version,
 * three of those arguments identical at every call. Curried once here, the call sites read
 * `frame.tx(time)`.
 */
export interface ChartFrame {
  chartData: ChartPoint[];
  geo: ChartGeometry;
  /** startTime → index. Carried as well as closed over by `tx` because sumActualForBand needs
   *  the map itself, not just the projection. */
  timeIndex: Map<string, number>;
  priceMin: number;
  priceMax: number;
  solarMax: number;
  /** Horizontal position of slot `i`. */
  xAt: (i: number) => number;
  /** Horizontal position of a slot's startTime, or null if it isn't in this chart's data. */
  tx: (time: string) => number | null;
  /** Width of one slot — bands widen by half of this at each end to cover their whole slot. */
  stepX: number;
}

export function buildFrame(
  chartData: ChartPoint[],
  geo: ChartGeometry,
  timeIndex: Map<string, number>,
  priceMin: number,
  priceMax: number,
  solarMax: number,
): ChartFrame {
  const count = chartData.length;
  return {
    chartData,
    geo,
    timeIndex,
    priceMin,
    priceMax,
    solarMax,
    xAt: (i: number) => indexToX(i, count, geo),
    tx: (time: string) => timeToX(time, chartData, geo, timeIndex),
    stepX: count > 1 ? geo.plotW / (count - 1) : 0,
  };
}
