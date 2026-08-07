'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PriceData } from '@/lib/prices';
import type { DispatchSlot } from '@/lib/optimizer';
import {
  buildAreaPath,
  buildLinePath,
  computeNowSlotTime,
  priceYScale,
  socYScale,
  solarYScale,
  sumActualForBand,
} from '@/lib/chart-utils';
import type { ActualSlotFlows } from '@/lib/actual-flows';
import { useChartData } from './useChartData';
import { buildFrame } from './price-chart/frame';
import { DayZones, DecisionBands } from './price-chart/ChartBands';
import { PriceAxis, SocAxis, TimeAxis } from './price-chart/ChartAxes';
import ChartLegend from './price-chart/ChartLegend';
import type { ChartLayers } from './price-chart/ChartLegend';
import ChartTooltip from './price-chart/ChartTooltip';

/**
 * The Elpriser card: today's (and tomorrow's) prices with the optimizer's plan drawn over them.
 *
 * Hand-rolled SVG rather than a charting library (Recharts was removed early on — the chart
 * needs enough bespoke drawing that the library was mostly being fought).
 * This file owns the DATA WIRING and COMPOSITION only; each visual layer lives in
 * ./price-chart/ and is drawn here in z-order, back to front:
 *
 *   DayZones     today/tomorrow tint          ChartBands.tsx
 *   DecisionBands  optimizer decision zones     "
 *   PriceAxis    gridlines + öre/kWh labels   ChartAxes.tsx
 *   SocAxis      right-hand 0-100% scale        "
 *   (solar area, SoC lines, price lines)      below — short enough to read inline
 *   (now marker, hover guide)                 below
 *   TimeAxis     hour labels                  ChartAxes.tsx
 *   ChartTooltip hover detail (HTML, not SVG) ChartTooltip.tsx
 *
 * Split out of one ~600-line function on 2026-08-07. The series and overlay stay inline
 * deliberately: they are a handful of <path> elements each, and pushing them out too would
 * leave this file a list of imports that says nothing about what the chart looks like.
 */

interface Props {
  data: PriceData;
  solarProfiles: Record<number, number[]>;
  solarForecast?: Record<string, number[]> | null;
  dispatchSchedule?: DispatchSlot[] | null;
  pastDispatchSlots?: DispatchSlot[] | null; // reconstructed historical decision bands (see lib/telemetry readPastDispatchSlots)
  startSocKwh?: number; // SoC the optimizer planned from
  socIsLive?: boolean; // true = live inverter reading, false = 50% fallback
  actualSocByTime?: Record<string, number>; // real measured SoC %, keyed "YYYY-MM-DDTHH:MM"
  actualFlowsByTime?: Record<string, ActualSlotFlows>; // measured battery flows, keyed by slot startTime
  interventionsByTime?: Record<string, string[]>; // control_actions outcomes (non-'applied'), keyed by slot startTime
  // Resolved server-side (see app/page.tsx) and passed in rather than imported from
  // lib/constants directly: this component is 'use client', and Next.js never exposes
  // non-NEXT_PUBLIC_ env vars to the client bundle — a direct import would silently read the
  // hardcoded fallback instead of the deployment's real env-configured value.
  batteryKwh: number;
  skattOverforing: number;
  batteryFloorKwh: number;
}

type Point = [number, number];

// Groups a series with nulls into contiguous non-null runs — each run becomes its own path
// segment (mirrors Recharts' `connectNulls={false}`, which draws disconnected sub-lines
// rather than bridging gaps).
function contiguousRuns(points: (Point | null)[]): Point[][] {
  const runs: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    if (p) {
      current.push(p);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/** Rounded pill label for the now-marker's current buy/sell price. */
function tag(key: string, x: number, y: number, text: string, color: string) {
  const w = text.length * 6.4 + 14;
  return (
    <g key={key}>
      <rect x={x + 7} y={y - 9} width={w} height={18} rx={6} fill={color} />
      <text
        x={x + 7 + w / 2}
        y={y + 3.5}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill="#fff"
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {text}
      </text>
    </g>
  );
}

interface HoverState {
  index: number;
  x: number; // container-relative px, for tooltip placement
  y: number;
  containerWidth: number;
}

export default function PriceChart({
  data,
  solarProfiles,
  solarForecast,
  dispatchSchedule,
  pastDispatchSlots,
  startSocKwh,
  socIsLive,
  actualSocByTime,
  actualFlowsByTime,
  interventionsByTime,
  batteryKwh,
  skattOverforing,
  batteryFloorKwh,
}: Props) {
  const {
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
  } = useChartData(
    data,
    solarProfiles,
    solarForecast,
    dispatchSchedule,
    batteryKwh,
    skattOverforing,
    batteryFloorKwh,
    actualSocByTime,
    pastDispatchSlots,
    actualFlowsByTime,
    interventionsByTime,
  );

  const hasActualSoc = chartData.some((d) => d.actualSocPct != null);
  const hasPlan = !!dispatchSchedule;

  const [layers, setLayers] = useState<ChartLayers>({ solar: true, soc: true, zones: true });

  // "Now" marker: recomputed every minute so a dashboard left open stays accurate.
  const [nowTime, setNowTime] = useState<string | null>(null);
  useEffect(() => {
    const times = chartData.map((d) => d.time);
    const update = () => setNowTime(computeNowSlotTime(new Date(), times));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [chartData]);

  const nowPoint = nowTime ? chartData.find((d) => d.time === nowTime) : undefined;

  // Everything the layers draw against: data, box, scales (see price-chart/frame.ts).
  const frame = useMemo(
    () => buildFrame(chartData, geometry, timeIndex, priceMin, priceMax, solarMax),
    [chartData, geometry, timeIndex, priceMin, priceMax, solarMax],
  );
  const geo = geometry;
  const { xAt, tx } = frame;
  const count = chartData.length;

  const buyPath = useMemo(
    () => buildLinePath(chartData.map((d, i): Point => [xAt(i), priceYScale(d.buy, priceMax, geo, priceMin)])),
    [chartData, priceMax, priceMin, geo, xAt],
  );
  const sellPath = useMemo(
    () => buildLinePath(chartData.map((d, i): Point => [xAt(i), priceYScale(d.sell, priceMax, geo, priceMin)])),
    [chartData, priceMax, priceMin, geo, xAt],
  );
  const solarTopPoints = useMemo(
    () => chartData.map((d, i): Point => [xAt(i), solarYScale(d.solarKwh, solarMax, geo)]),
    [chartData, solarMax, geo, xAt],
  );
  const solarAreaPath = useMemo(() => buildAreaPath(solarTopPoints, geo.baseY), [solarTopPoints, geo]);
  const solarLinePath = useMemo(() => buildLinePath(solarTopPoints), [solarTopPoints]);

  const socPlannedRuns = useMemo(
    () =>
      contiguousRuns(
        chartData.map((d, i): Point | null => (d.socPct == null ? null : [xAt(i), socYScale(d.socPct, geo)])),
      ),
    [chartData, geo, xAt],
  );
  const socActualRuns = useMemo(
    () =>
      contiguousRuns(
        chartData.map((d, i): Point | null =>
          d.actualSocPct == null ? null : [xAt(i), socYScale(d.actualSocPct, geo)],
        ),
      ),
    [chartData, geo, xAt],
  );

  const peakSolarIdx = useMemo(() => {
    let best = -1;
    let bestVal = 0;
    chartData.forEach((d, i) => {
      if (d.solarKwh > bestVal) {
        bestVal = d.solarKwh;
        best = i;
      }
    });
    return best;
  }, [chartData]);

  // Hover detail (restores what the old Recharts <Tooltip> gave for free): a transparent
  // full-height hit area over the chart maps cursor x -> nearest slot index, independent of
  // the SVG's rendered size (it's scaled by viewBox, so we go through the container's actual
  // pixel width rather than SVG-space coordinates).
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const updateHover = (clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el || count === 0) return;
    const rect = el.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const fraction = Math.min(1, Math.max(0, localX / rect.width));
    const viewBoxX = fraction * geo.width;
    const idxFloat = ((viewBoxX - geo.padL) / geo.plotW) * (count - 1);
    const index = Math.min(count - 1, Math.max(0, Math.round(idxFloat)));
    setHover({ index, x: localX, y: localY, containerWidth: rect.width });
  };
  const clearHover = () => setHover(null);

  const hoverPoint = hover ? chartData[hover.index] : null;

  // The decision zone the hovered slot belongs to, for the tooltip's zone-total row. Bands are
  // few (a handful per day), so a linear scan per hover render is fine.
  const hoverBand =
    hoverPoint && hoverPoint.decision
      ? actionBands.find(
          (b) => b.kind === hoverPoint.decision && b.x1 <= hoverPoint.time && hoverPoint.time <= b.x2,
        ) ?? null
      : null;

  // Zone-level actual total for the hovered band (buy/sell only, matching the in-chart ⚠ marker
  // and the tooltip's "Verkligt (hela zonen)" row) — bands are few, a linear scan is fine.
  const hoverBandActual =
    hoverBand && hoverBand.kind !== 'hold' ? sumActualForBand(hoverBand, chartData, timeIndex) : null;

  return (
    <div
      className="card-surface box-border flex min-w-0 flex-col p-5 order-1 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_2] min-[1600px]:[grid-row:1]"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-lg"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
              <path
                d="M3 17 L9 11 L13 15 L21 6 M15.5 6 H21 V11.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="flex flex-col gap-px">
            <div className="text-[15px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
              Elpriser
            </div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              {data.today} · idag{data.hasTomorrow ? ' & imorgon' : ''}
              {!data.hasTomorrow && (
                <span className="ml-2" style={{ color: 'var(--color-now)' }}>
                  · Imorgons priser ej tillgängliga ännu
                </span>
              )}
            </div>
          </div>
        </div>
        {nowPoint && (
          <div className="flex items-center gap-2 rounded-xl px-3 py-1.5" style={{ background: 'var(--badge-bg)' }}>
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--color-now)' }} />
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              Nu
            </span>
            <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-heading)', color: 'var(--color-buy)' }}>
              {Math.round(nowPoint.buy)}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              /
            </span>
            <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-heading)', color: 'var(--color-sell)' }}>
              {Math.round(nowPoint.sell)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              öre
            </span>
          </div>
        )}
      </div>

      <ChartLegend layers={layers} setLayers={setLayers} hasPlan={hasPlan} />

      <div
        ref={containerRef}
        className="relative"
        onMouseMove={(e) => updateHover(e.clientX, e.clientY)}
        onMouseLeave={clearHover}
        onTouchMove={(e) => {
          if (e.touches[0]) updateHover(e.touches[0].clientX, e.touches[0].clientY);
        }}
        onTouchEnd={clearHover}
      >
        <svg viewBox={`0 0 ${geo.width} ${geo.height}`} width="100%" style={{ display: 'block', height: 'auto', overflow: 'visible' }}>
          <DayZones
            frame={frame}
            firstTime={firstTime}
            lastTime={lastTime}
            tomorrowTime={tomorrowTime}
            beforeTomorrowTime={beforeTomorrowTime}
          />

          {layers.zones && <DecisionBands frame={frame} bands={actionBands} />}

          <PriceAxis frame={frame} />
          {hasPlan && layers.soc && <SocAxis frame={frame} />}

          {/* solar area */}
          {layers.solar && (
            <>
              <path d={solarAreaPath} fill="color-mix(in srgb, var(--color-solar) 15%, transparent)" stroke="none" />
              <path d={solarLinePath} fill="none" stroke="color-mix(in srgb, var(--color-solar) 55%, transparent)" strokeWidth={1.2} />
              {peakSolarIdx >= 0 && (
                <text
                  x={xAt(peakSolarIdx)}
                  y={solarTopPoints[peakSolarIdx][1] - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={700}
                  fill="color-mix(in srgb, var(--color-solar) 80%, transparent)"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  Sol
                </text>
              )}
            </>
          )}

          {/* SoC lines — planned dashed, actual solid on top */}
          {hasPlan &&
            layers.soc &&
            socPlannedRuns.map((run, i) => (
              <path
                key={`planned-${i}`}
                d={buildLinePath(run)}
                fill="none"
                stroke="color-mix(in srgb, var(--color-soc) 75%, transparent)"
                strokeWidth={1.8}
                strokeDasharray="6 5"
                strokeLinecap="round"
              />
            ))}
          {hasPlan &&
            layers.soc &&
            hasActualSoc &&
            socActualRuns.map((run, i) => (
              <path key={`actual-${i}`} d={buildLinePath(run)} fill="none" stroke="var(--color-soc)" strokeWidth={2.4} strokeLinecap="round" />
            ))}

          {/* price lines — sell then buy, buy on top */}
          <path
            d={sellPath}
            fill="none"
            stroke="var(--color-sell)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 1px 4px color-mix(in srgb, var(--color-sell) 35%, transparent))' }}
          />
          <path
            d={buyPath}
            fill="none"
            stroke="var(--color-buy)"
            strokeWidth={2.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 1px 5px color-mix(in srgb, var(--color-buy) 40%, transparent))' }}
          />

          {/* today/tomorrow divider + labels */}
          {tomorrowTime && (
            <line
              x1={tx(tomorrowTime) ?? 0}
              y1={geo.padT}
              x2={tx(tomorrowTime) ?? 0}
              y2={geo.baseY}
              stroke="var(--axis-text)"
              strokeWidth={1.2}
              strokeDasharray="4 5"
              opacity={0.7}
            />
          )}
          {firstTime && (
            <text x={(tx(firstTime) ?? 0) + 4} y={geo.padT + 13} fontSize={10} fontWeight={700} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
              Idag
            </text>
          )}
          {tomorrowTime && (
            <text x={(tx(tomorrowTime) ?? 0) + 4} y={geo.padT + 13} fontSize={10} fontWeight={700} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
              Imorgon
            </text>
          )}

          {/* now marker */}
          {nowTime &&
            nowPoint &&
            (() => {
              const xn = tx(nowTime);
              if (xn == null) return null;
              const buyNowV = Math.round(nowPoint.buy);
              const sellNowV = Math.round(nowPoint.sell);
              const byY = priceYScale(nowPoint.buy, priceMax, geo, priceMin);
              let syY = priceYScale(nowPoint.sell, priceMax, geo, priceMin);
              if (Math.abs(byY - syY) < 20) syY = byY + 20;
              return (
                <g>
                  <line x1={xn} y1={geo.padT} x2={xn} y2={geo.baseY} stroke="var(--color-now)" strokeWidth={2} />
                  {tag('tagB', xn, byY, `Köp ${buyNowV}`, 'var(--color-buy)')}
                  {tag('tagS', xn, syY, `Sälj ${sellNowV}`, 'var(--color-sell)')}
                  <rect x={xn - 15} y={geo.padT - 22} width={30} height={16} rx={6} fill="var(--color-now)" />
                  <text x={xn} y={geo.padT - 10.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--color-now-text)" style={{ fontFamily: 'var(--font-heading)' }}>
                    Nu
                  </text>
                </g>
              );
            })()}

          <TimeAxis frame={frame} ticks={xTicks} />

          {/* hover guide + per-series dots */}
          {hover && hoverPoint && (
            <g pointerEvents="none">
              <line x1={xAt(hover.index)} y1={geo.padT} x2={xAt(hover.index)} y2={geo.baseY} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
              <circle cx={xAt(hover.index)} cy={priceYScale(hoverPoint.sell, priceMax, geo, priceMin)} r={3.5} fill="var(--color-sell)" stroke="var(--card-bg)" strokeWidth={1.5} />
              <circle cx={xAt(hover.index)} cy={priceYScale(hoverPoint.buy, priceMax, geo, priceMin)} r={3.5} fill="var(--color-buy)" stroke="var(--card-bg)" strokeWidth={1.5} />
              {hasPlan && layers.soc && hoverPoint.socPct != null && (
                <circle cx={xAt(hover.index)} cy={socYScale(hoverPoint.socPct, geo)} r={3.5} fill="var(--color-soc)" stroke="var(--card-bg)" strokeWidth={1.5} />
              )}
            </g>
          )}
        </svg>

        {hover && hoverPoint && (
          <ChartTooltip
            point={hoverPoint}
            band={hoverBand}
            bandActual={hoverBandActual}
            placement={{ x: hover.x, y: hover.y, containerWidth: hover.containerWidth }}
            hasPlan={hasPlan}
          />
        )}
      </div>

      {hasPlan && (
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          {socIsLive && startSocKwh != null
            ? `Batteri-rekommendationer baserade på aktuell laddning ${Math.round(
                (startSocKwh / batteryKwh) * 100,
              )} % (${startSocKwh.toFixed(1)} kWh).`
            : 'Batteri-rekommendationer baserade på antaget 50 % (växelriktardata saknas).'}
        </p>
      )}
    </div>
  );
}
