'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PriceData } from '@/lib/prices';
import { BATTERY_KWH } from '@/lib/optimizer';
import type { DispatchSlot } from '@/lib/optimizer';
import {
  buildAreaPath,
  buildLinePath,
  computeNowSlotTime,
  indexToX,
  priceYScale,
  socYScale,
  solarYScale,
  timeToX,
} from '@/lib/chart-utils';
import type { BandKind, ChartGeometry, ChartPoint } from '@/lib/chart-utils';
import { useChartData } from './useChartData';

interface Props {
  data: PriceData;
  solarProfiles: Record<number, number[]>;
  solarForecast?: Record<string, number[]> | null;
  dispatchSchedule?: DispatchSlot[] | null;
  startSocKwh?: number; // SoC the optimizer planned from
  socIsLive?: boolean; // true = live inverter reading, false = 50% fallback
  actualSocByTime?: Record<string, number>; // real measured SoC %, keyed "YYYY-MM-DDTHH:MM"
}

const BAND_COLOR: Record<BandKind, string> = {
  buy: 'var(--color-charge-band)',
  sell: 'var(--color-sell-band)',
};
const BAND_LABEL: Record<BandKind, string> = { buy: 'Ladda', sell: 'Sälj' };

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

function priceTicks(max: number): number[] {
  return [0, max * 0.25, max * 0.5, max * 0.75, max];
}

function tag(key: string, x: number, y: number, text: string, color: string) {
  const w = text.length * 6.4 + 14;
  return (
    <g key={key}>
      <rect x={x + 7} y={y - 9} width={w} height={18} rx={6} fill={color} />
      <text x={x + 7 + w / 2} y={y + 3.5} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff" style={{ fontFamily: 'var(--font-heading)' }}>
        {text}
      </text>
    </g>
  );
}

function TooltipRow({ color, label, value, bold }: { color: string; label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className={`ml-auto pl-3 ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</span>
    </div>
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
  startSocKwh,
  socIsLive,
  actualSocByTime,
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
    solarMax,
  } = useChartData(data, solarProfiles, solarForecast, dispatchSchedule, actualSocByTime);

  const hasActualSoc = chartData.some((d) => d.actualSocPct != null);
  const hasPlan = !!dispatchSchedule;

  const [layers, setLayers] = useState({ solar: true, soc: true, zones: true });

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

  const geo: ChartGeometry = geometry;
  const count = chartData.length;
  const stepX = count > 1 ? geo.plotW / (count - 1) : 0;

  const xAt = (i: number) => indexToX(i, count, geo);

  const buyPath = useMemo(
    () => buildLinePath(chartData.map((d, i): Point => [xAt(i), priceYScale(d.buy, priceMax, geo)])),
    [chartData, priceMax, geo],
  );
  const sellPath = useMemo(
    () => buildLinePath(chartData.map((d, i): Point => [xAt(i), priceYScale(d.sell, priceMax, geo)])),
    [chartData, priceMax, geo],
  );
  const solarTopPoints = useMemo(
    () => chartData.map((d, i): Point => [xAt(i), solarYScale(d.solarKwh, solarMax, geo)]),
    [chartData, solarMax, geo],
  );
  const solarAreaPath = useMemo(() => buildAreaPath(solarTopPoints, geo.baseY), [solarTopPoints, geo]);
  const solarLinePath = useMemo(() => buildLinePath(solarTopPoints), [solarTopPoints]);

  const socPlannedRuns = useMemo(
    () =>
      contiguousRuns(
        chartData.map((d, i): Point | null => (d.socPct == null ? null : [xAt(i), socYScale(d.socPct, geo)])),
      ),
    [chartData, geo],
  );
  const socActualRuns = useMemo(
    () =>
      contiguousRuns(
        chartData.map((d, i): Point | null =>
          d.actualSocPct == null ? null : [xAt(i), socYScale(d.actualSocPct, geo)],
        ),
      ),
    [chartData, geo],
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
          <div
            className="flex items-center gap-2 rounded-xl px-3 py-1.5"
            style={{ background: 'var(--badge-bg)' }}
          >
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

      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Pris
        </span>
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="inline-block h-[3px] w-[18px] rounded" style={{ background: 'var(--color-buy)' }} />
          Köp
        </span>
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="inline-block h-[3px] w-[18px] rounded" style={{ background: 'var(--color-sell)' }} />
          Sälj
        </span>
        <span className="mx-0.5 h-4 w-px" style={{ background: 'var(--divider)' }} />
        <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Lager
        </span>
        <button
          type="button"
          onClick={() => setLayers((s) => ({ ...s, solar: !s.solar }))}
          className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
          style={layers.solar ? { border: '1px solid var(--divider)' } : { color: 'var(--text-muted)', opacity: 0.6 }}
        >
          <span className="h-[11px] w-[13px] rounded-sm" style={{ background: 'color-mix(in srgb, var(--color-solar) 60%, transparent)' }} />
          Sol
        </button>
        {hasPlan && (
          <button
            type="button"
            onClick={() => setLayers((s) => ({ ...s, soc: !s.soc }))}
            className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={layers.soc ? { border: '1px solid var(--divider)' } : { color: 'var(--text-muted)', opacity: 0.6 }}
          >
            <span className="w-[18px] border-t-2" style={{ borderColor: 'var(--color-soc)', borderStyle: 'dashed' }} />
            Batteri-SoC
          </button>
        )}
        {hasPlan && (
          <button
            type="button"
            onClick={() => setLayers((s) => ({ ...s, zones: !s.zones }))}
            className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={layers.zones ? { border: '1px solid var(--divider)' } : { color: 'var(--text-muted)', opacity: 0.6 }}
          >
            <span className="h-[11px] w-[9px] rounded-sm" style={{ background: 'var(--color-charge-band)' }} />
            <span className="-ml-[3px] h-[11px] w-[9px] rounded-sm" style={{ background: 'var(--color-sell-band)' }} />
            Åtgärdszoner
          </button>
        )}
      </div>

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
          {/* today / tomorrow zones */}
        {tomorrowTime && beforeTomorrowTime && firstTime && lastTime && (
          <>
            <rect
              x={timeToX(firstTime, chartData, geo, timeIndex) ?? 0}
              y={geo.padT}
              width={(timeToX(beforeTomorrowTime, chartData, geo, timeIndex) ?? 0) - (timeToX(firstTime, chartData, geo, timeIndex) ?? 0)}
              height={geo.plotH}
              fill="var(--zone-today)"
            />
            <rect
              x={timeToX(tomorrowTime, chartData, geo, timeIndex) ?? 0}
              y={geo.padT}
              width={(timeToX(lastTime, chartData, geo, timeIndex) ?? 0) - (timeToX(tomorrowTime, chartData, geo, timeIndex) ?? 0)}
              height={geo.plotH}
              fill="var(--zone-tomorrow)"
            />
          </>
        )}

        {/* action bands */}
        {layers.zones &&
          actionBands.map((band, i) => {
            const x1 = timeToX(band.x1, chartData, geo, timeIndex);
            const x2 = timeToX(band.x2, chartData, geo, timeIndex);
            if (x1 == null || x2 == null) return null;
            const bx = x1 - stepX / 2;
            const bw = x2 - x1 + stepX;
            const color = BAND_COLOR[band.kind];
            return (
              <g key={i}>
                <rect x={bx} y={geo.padT} width={bw} height={geo.plotH} fill={`color-mix(in srgb, ${color} 11%, transparent)`} />
                <rect x={bx} y={geo.padT} width={2} height={geo.plotH} fill={`color-mix(in srgb, ${color} 50%, transparent)`} />
                {bw >= 30 && (
                  <>
                    <rect x={bx + bw / 2 - 20} y={geo.padT + 4} width={40} height={15} rx={5} fill={color} />
                    <text
                      x={bx + bw / 2}
                      y={geo.padT + 14.5}
                      textAnchor="middle"
                      fontSize={9}
                      fontWeight={700}
                      fill="#fff"
                      style={{ fontFamily: 'var(--font-body)' }}
                    >
                      {BAND_LABEL[band.kind]}
                    </text>
                  </>
                )}
              </g>
            );
          })}

        {/* gridlines + left price axis */}
        {priceTicks(priceMax).map((v, i) => (
          <g key={i}>
            <line x1={geo.padL} y1={priceYScale(v, priceMax, geo)} x2={geo.padL + geo.plotW} y2={priceYScale(v, priceMax, geo)} stroke="var(--grid-line)" strokeWidth={1} />
            <text x={geo.padL - 6} y={priceYScale(v, priceMax, geo) + 3.5} textAnchor="end" fontSize={10} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
              {Math.round(v)}
            </text>
          </g>
        ))}
        <text x={geo.padL - 6} y={geo.padT - 8} textAnchor="end" fontSize={9} fontWeight={700} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
          öre/kWh
        </text>

        {/* right SoC axis */}
        {hasPlan && layers.soc && (
          <>
            {[0, 25, 50, 75, 100].map((v, i) => (
              <text
                key={i}
                x={geo.padL + geo.plotW + 7}
                y={socYScale(v, geo) + 3.5}
                textAnchor="start"
                fontSize={10}
                fill="color-mix(in srgb, var(--color-soc) 80%, transparent)"
                style={{ fontFamily: 'var(--font-body)' }}
              >
                {v}%
              </text>
            ))}
            <text
              x={geo.padL + geo.plotW + 7}
              y={geo.padT - 8}
              textAnchor="start"
              fontSize={9}
              fontWeight={700}
              fill="color-mix(in srgb, var(--color-soc) 80%, transparent)"
              style={{ fontFamily: 'var(--font-body)' }}
            >
              SoC
            </text>
          </>
        )}

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

        {/* SoC lines */}
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
        <path d={sellPath} fill="none" stroke="var(--color-sell)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ filter: 'drop-shadow(0 1px 4px color-mix(in srgb, var(--color-sell) 35%, transparent))' }} />
        <path d={buyPath} fill="none" stroke="var(--color-buy)" strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" style={{ filter: 'drop-shadow(0 1px 5px color-mix(in srgb, var(--color-buy) 40%, transparent))' }} />

        {/* today/tomorrow divider + labels */}
        {tomorrowTime && (
          <line
            x1={timeToX(tomorrowTime, chartData, geo, timeIndex) ?? 0}
            y1={geo.padT}
            x2={timeToX(tomorrowTime, chartData, geo, timeIndex) ?? 0}
            y2={geo.baseY}
            stroke="var(--axis-text)"
            strokeWidth={1.2}
            strokeDasharray="4 5"
            opacity={0.7}
          />
        )}
        {firstTime && (
          <text x={(timeToX(firstTime, chartData, geo, timeIndex) ?? 0) + 4} y={geo.padT + 13} fontSize={10} fontWeight={700} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
            Idag
          </text>
        )}
        {tomorrowTime && (
          <text x={(timeToX(tomorrowTime, chartData, geo, timeIndex) ?? 0) + 4} y={geo.padT + 13} fontSize={10} fontWeight={700} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
            Imorgon
          </text>
        )}

        {/* now marker */}
        {nowTime &&
          nowPoint &&
          (() => {
            const xn = timeToX(nowTime, chartData, geo, timeIndex);
            if (xn == null) return null;
            const buyNowV = Math.round(nowPoint.buy);
            const sellNowV = Math.round(nowPoint.sell);
            let byY = priceYScale(nowPoint.buy, priceMax, geo);
            let syY = priceYScale(nowPoint.sell, priceMax, geo);
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

        {/* time axis */}
        {xTicks.map((t) => {
          const x = timeToX(t, chartData, geo, timeIndex);
          if (x == null) return null;
          return (
            <text key={t} x={x} y={geo.baseY + 15} textAnchor="middle" fontSize={9.5} fill="var(--axis-text)" style={{ fontFamily: 'var(--font-body)' }}>
              {t.slice(11, 13)}
            </text>
          );
        })}

        {/* hover guide + per-series dots */}
        {hover && hoverPoint && (
          <g pointerEvents="none">
            <line x1={xAt(hover.index)} y1={geo.padT} x2={xAt(hover.index)} y2={geo.baseY} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
            <circle cx={xAt(hover.index)} cy={priceYScale(hoverPoint.sell, priceMax, geo)} r={3.5} fill="var(--color-sell)" stroke="var(--card-bg)" strokeWidth={1.5} />
            <circle cx={xAt(hover.index)} cy={priceYScale(hoverPoint.buy, priceMax, geo)} r={3.5} fill="var(--color-buy)" stroke="var(--card-bg)" strokeWidth={1.5} />
            {hasPlan && layers.soc && hoverPoint.socPct != null && (
              <circle cx={xAt(hover.index)} cy={socYScale(hoverPoint.socPct, geo)} r={3.5} fill="var(--color-soc)" stroke="var(--card-bg)" strokeWidth={1.5} />
            )}
          </g>
        )}
      </svg>

      {hover && hoverPoint && (
        <div
          className="pointer-events-none absolute z-20 flex flex-col gap-1 rounded-lg p-2.5 text-xs"
          style={{
            ...(hover.x > hover.containerWidth * 0.6
              ? { right: hover.containerWidth - hover.x + 14 }
              : { left: hover.x + 14 }),
            top: Math.max(0, hover.y - 60),
            minWidth: 168,
            background: 'var(--card-bg-grad, var(--card-bg))',
            border: '1px solid var(--card-border)',
            boxShadow: 'var(--card-shadow)',
            color: 'var(--text)',
            fontFamily: 'var(--font-body)',
          }}
        >
          <div className="mb-0.5 font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            {hoverPoint.time.slice(0, 10)} {hoverPoint.time.slice(11, 16)}
            {hoverPoint.action === 'charge' && <span style={{ color: 'var(--color-charge-band)' }}> · Laddar batteri</span>}
            {hoverPoint.action === 'discharge' && <span style={{ color: 'var(--color-sell-band)' }}> · Urladdar</span>}
          </div>
          <TooltipRow color="var(--color-buy)" label="Köp" value={`${hoverPoint.buy.toFixed(1)} öre/kWh`} />
          <TooltipRow color="var(--color-sell)" label="Sälj" value={`${hoverPoint.sell.toFixed(1)} öre/kWh`} />
          <TooltipRow
            color="var(--color-solar)"
            label={hoverPoint.solarSource === 'forecast' ? 'Sol (prognos)' : 'Sol (typisk)'}
            value={`${hoverPoint.solarKwh.toFixed(2)} kWh`}
          />
          {hasPlan && hoverPoint.socPct != null && (
            <TooltipRow color="var(--color-soc)" label="Batteri-SoC (planerad)" value={`${hoverPoint.socPct.toFixed(0)} %`} />
          )}
          {hoverPoint.actualSocPct != null && (
            <TooltipRow color="var(--color-soc)" label="Batteri-SoC (verklig)" value={`${hoverPoint.actualSocPct.toFixed(0)} %`} bold />
          )}
        </div>
      )}
      </div>

      {hasPlan && (
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          {socIsLive && startSocKwh != null
            ? `Batteri-rekommendationer baserade på aktuell laddning ${Math.round(
                (startSocKwh / BATTERY_KWH) * 100,
              )} % (${startSocKwh.toFixed(1)} kWh).`
            : 'Batteri-rekommendationer baserade på antaget 50 % (växelriktardata saknas).'}
        </p>
      )}
    </div>
  );
}
