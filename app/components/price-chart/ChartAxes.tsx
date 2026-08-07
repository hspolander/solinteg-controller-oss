'use client';

import { priceYScale, socYScale } from '@/lib/chart-utils';
import type { ChartFrame } from './frame';

/**
 * Everything that describes the coordinate space rather than the data: the price gridlines and
 * their öre/kWh labels, the emphasized zero line, the right-hand SoC scale, and the hour ticks
 * along the bottom.
 *
 * Three scales share one plot area — price on the left (öre/kWh), SoC on the right (%), and
 * solar as an unlabelled area whose height is relative to its own max. Only two get an axis:
 * the solar area is context for the shape of the day, and a third set of numbers would cost
 * more legibility than it buys.
 */

/** Five evenly spaced ticks spanning the real data range (see computePriceMin/Max). */
function priceTicks(min: number, max: number): number[] {
  const span = max - min;
  return [min, min + span * 0.25, min + span * 0.5, min + span * 0.75, max];
}

export function PriceAxis({ frame }: { frame: ChartFrame }) {
  const { geo, priceMax, priceMin } = frame;
  return (
    <>
      {priceTicks(priceMin, priceMax).map((v, i) => (
        <g key={i}>
          <line
            x1={geo.padL}
            y1={priceYScale(v, priceMax, geo, priceMin)}
            x2={geo.padL + geo.plotW}
            y2={priceYScale(v, priceMax, geo, priceMin)}
            stroke="var(--grid-line)"
            strokeWidth={1}
          />
          <text
            x={geo.padL - 6}
            y={priceYScale(v, priceMax, geo, priceMin) + 3.5}
            textAnchor="end"
            fontSize={10}
            fill="var(--axis-text)"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {Math.round(v)}
          </text>
        </g>
      ))}
      {/* zero line, emphasized only when the axis extends below it (negative-price day) */}
      {priceMin < 0 && (
        <line
          x1={geo.padL}
          y1={priceYScale(0, priceMax, geo, priceMin)}
          x2={geo.padL + geo.plotW}
          y2={priceYScale(0, priceMax, geo, priceMin)}
          stroke="var(--axis-text)"
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.7}
        />
      )}
      <text
        x={geo.padL - 6}
        y={geo.padT - 8}
        textAnchor="end"
        fontSize={9}
        fontWeight={700}
        fill="var(--axis-text)"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        öre/kWh
      </text>
    </>
  );
}

/** Right-hand 0-100% scale for the SoC lines. Only rendered when a plan exists AND the SoC
 *  layer is on — an axis for a hidden series is noise. */
export function SocAxis({ frame }: { frame: ChartFrame }) {
  const { geo } = frame;
  return (
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
  );
}

/** Hour labels along the bottom. The slice pulls the hour out of a naive Stockholm
 *  "YYYY-MM-DDTHH:MM:SS" — see buildXTicks for which slots become ticks. */
export function TimeAxis({ frame, ticks }: { frame: ChartFrame; ticks: string[] }) {
  const { geo, tx } = frame;
  return (
    <>
      {ticks.map((t) => {
        const x = tx(t);
        if (x == null) return null;
        return (
          <text
            key={t}
            x={x}
            y={geo.baseY + 15}
            textAnchor="middle"
            fontSize={9.5}
            fill="var(--axis-text)"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {t.slice(11, 13)}
          </text>
        );
      })}
    </>
  );
}
