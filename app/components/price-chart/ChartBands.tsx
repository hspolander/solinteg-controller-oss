'use client';

import { isBandDivergent, sumActualForBand } from '@/lib/chart-utils';
import type { ActionBand, BandKind } from '@/lib/chart-utils';
import type { ChartFrame } from './frame';

/**
 * The two backdrop layers, drawn before anything else so every series sits on top: the
 * today/tomorrow day tint, and the optimizer's decision zones.
 *
 * See classifyBand in lib/chart-utils.ts for what earns a zone at all — only DELIBERATE
 * decisions are drawn, never the inverter's default self-use behaviour.
 */

const BAND_COLOR: Record<BandKind, string> = {
  buy: 'var(--color-charge-band)',
  sell: 'var(--color-sell-band)',
  hold: 'var(--color-hold-band)',
};
export const BAND_LABEL: Record<BandKind, string> = { buy: 'Ladda', sell: 'Sälj', hold: 'Sparar' };
// Hold zones ("the plan is deliberately NOT using the battery") are context, not action —
// drawn fainter and without the leading edge bar so buy/sell decisions stay dominant.
const BAND_FILL_PCT: Record<BandKind, number> = { buy: 11, sell: 11, hold: 6 };

export function DayZones({
  frame,
  firstTime,
  lastTime,
  tomorrowTime,
  beforeTomorrowTime,
}: {
  frame: ChartFrame;
  firstTime: string | null;
  lastTime: string | null;
  tomorrowTime: string | null;
  beforeTomorrowTime: string | null;
}) {
  const { geo, tx } = frame;
  if (!tomorrowTime || !beforeTomorrowTime || !firstTime || !lastTime) return null;
  return (
    <>
      <rect
        x={tx(firstTime) ?? 0}
        y={geo.padT}
        width={(tx(beforeTomorrowTime) ?? 0) - (tx(firstTime) ?? 0)}
        height={geo.plotH}
        fill="var(--zone-today)"
      />
      <rect
        x={tx(tomorrowTime) ?? 0}
        y={geo.padT}
        width={(tx(lastTime) ?? 0) - (tx(tomorrowTime) ?? 0)}
        height={geo.plotH}
        fill="var(--zone-tomorrow)"
      />
    </>
  );
}

export function DecisionBands({ frame, bands }: { frame: ChartFrame; bands: ActionBand[] }) {
  const { geo, tx, stepX, chartData, timeIndex } = frame;
  return (
    <>
      {bands.map((band, i) => {
        const x1 = tx(band.x1);
        const x2 = tx(band.x2);
        if (x1 == null || x2 == null) return null;
        const bx = x1 - stepX / 2;
        const bw = x2 - x1 + stepX;
        const color = BAND_COLOR[band.kind];
        const isHold = band.kind === 'hold';
        // Divergence marker: buy/sell only (hold stays de-emphasized context, not a decision to
        // audit) and only once the WHOLE zone has elapsed with complete actual data — a poller
        // gap or a zone still partly in the future must never flag a false ⚠.
        const actualSummary = !isHold ? sumActualForBand(band, chartData, timeIndex) : null;
        const divergent = actualSummary != null && isBandDivergent(band.kwh, actualSummary);
        const label = divergent ? `${BAND_LABEL[band.kind]} ⚠` : BAND_LABEL[band.kind];
        const labelW = label.length * 6.4 + 14;
        return (
          <g key={i}>
            <rect
              x={bx}
              y={geo.padT}
              width={bw}
              height={geo.plotH}
              fill={`color-mix(in srgb, ${color} ${BAND_FILL_PCT[band.kind]}%, transparent)`}
            />
            {!isHold && (
              <rect x={bx} y={geo.padT} width={2} height={geo.plotH} fill={`color-mix(in srgb, ${color} 50%, transparent)`} />
            )}
            {bw >= labelW && (
              <>
                <rect
                  x={bx + bw / 2 - labelW / 2}
                  y={geo.padT + 4}
                  width={labelW}
                  height={15}
                  rx={5}
                  fill={isHold ? `color-mix(in srgb, ${color} 70%, transparent)` : color}
                />
                <text
                  x={bx + bw / 2}
                  y={geo.padT + 14.5}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={700}
                  fill="#fff"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {label}
                </text>
              </>
            )}
          </g>
        );
      })}
    </>
  );
}
