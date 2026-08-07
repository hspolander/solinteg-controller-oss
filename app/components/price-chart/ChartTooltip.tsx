'use client';

import { interventionLabel, isBandDivergent } from '@/lib/chart-utils';
import type { ActionBand, BandActualSummary, ChartPoint } from '@/lib/chart-utils';

/**
 * The hover detail panel — plain HTML positioned over the SVG, not SVG itself, so it can use
 * normal text flow and shadows. Restores what the old Recharts `<Tooltip>` gave for free.
 *
 * This is the one place the chart states plan-vs-actual side by side, which is most of why it
 * is the biggest single piece of the chart: for a deliberate buy/sell it shows the planned
 * quantity for the slot AND its whole zone, the measured actual for both, and a divergence row
 * when those disagree past the thresholds in isBandDivergent.
 */

// The tooltip renders an identical four-row block for a buy and for a sell — planned this slot,
// planned this zone, actual this slot, actual this zone — differing only in which ChartPoint
// flow field carries the quantity, which CSS colour marks it, and the Swedish noun. Kept as
// data rather than two parallel JSX branches so the two can't drift (they had already diverged
// once in wording). 'hold' has no quantity of its own: it is the ABSENCE of a battery flow, so
// it is deliberately absent here.
const DECISION_ROWS = {
  buy: { color: 'var(--color-charge-band)', noun: 'Laddning', field: 'gridToBatteryKwh' },
  sell: { color: 'var(--color-sell-band)', noun: 'Försäljning', field: 'batteryToGridKwh' },
} as const satisfies Record<'buy' | 'sell', { color: string; noun: string; field: 'gridToBatteryKwh' | 'batteryToGridKwh' }>;

function TooltipRow({ color, label, value, bold }: { color: string; label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className={`ml-auto pl-3 ${bold ? 'font-bold' : 'font-semibold'}`}>{value}</span>
    </div>
  );
}

export interface TooltipPlacement {
  /** Container-relative cursor position, for placing the panel. */
  x: number;
  y: number;
  containerWidth: number;
}

export default function ChartTooltip({
  point,
  band,
  bandActual,
  placement,
  hasPlan,
}: {
  point: ChartPoint;
  band: ActionBand | null;
  bandActual: BandActualSummary | null;
  placement: TooltipPlacement;
  hasPlan: boolean;
}) {
  // Resolves the hovered slot's decision to the one quantity block to show (see DECISION_ROWS).
  // Null for a hold, for a slot with no deliberate decision, and for a buy/sell zone whose own
  // flow field is missing — which would otherwise render "undefined kWh".
  const rows = (() => {
    const kind = point.decision;
    if (kind !== 'buy' && kind !== 'sell') return null;
    const spec = DECISION_ROWS[kind];
    const plannedSlotKwh = point[spec.field];
    return plannedSlotKwh == null ? null : { ...spec, plannedSlotKwh };
  })();

  return (
    <div
      className="pointer-events-none absolute z-20 flex flex-col gap-1 rounded-lg p-2.5 text-xs"
      style={{
        // Flip to the cursor's left once past 60% of the width, so the panel never runs off the
        // right edge of the card on a narrow viewport.
        ...(placement.x > placement.containerWidth * 0.6
          ? { right: placement.containerWidth - placement.x + 14 }
          : { left: placement.x + 14 }),
        top: Math.max(0, placement.y - 60),
        minWidth: 168,
        background: 'var(--card-bg-grad, var(--card-bg))',
        border: '1px solid var(--card-border)',
        boxShadow: 'var(--card-shadow)',
        color: 'var(--text)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div className="mb-0.5 font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
        {point.time.slice(0, 10)} {point.time.slice(11, 16)}
        {/* deliberate decisions (match the zones) in band colors; default self-use behaviour muted */}
        {point.decision === 'buy' && <span style={{ color: 'var(--color-charge-band)' }}> · Laddar från nätet</span>}
        {point.decision === 'sell' && <span style={{ color: 'var(--color-sell-band)' }}> · Säljer till nätet</span>}
        {point.decision === 'hold' && <span style={{ color: 'var(--color-hold-band)' }}> · Sparar batteriet</span>}
        {point.decision == null && point.action === 'discharge' && (
          <span style={{ color: 'var(--text-muted)' }}> · Urladdar (täcker last)</span>
        )}
        {point.decision == null && point.action === 'charge' && (
          <span style={{ color: 'var(--text-muted)' }}> · Laddar</span>
        )}
      </div>

      <TooltipRow color="var(--color-buy)" label="Köp" value={`${point.buy.toFixed(1)} öre/kWh`} />
      <TooltipRow color="var(--color-sell)" label="Sälj" value={`${point.sell.toFixed(1)} öre/kWh`} />
      <TooltipRow
        color="var(--color-solar)"
        label={point.solarSource === 'forecast' ? 'Sol (prognos)' : 'Sol (typisk)'}
        value={`${point.solarKwh.toFixed(2)} kWh`}
      />

      {/* planned dispatch quantities — only for deliberate buy/sell decisions, matching the
          zones; the amount shown is the flow the zone is classified from (grid→battery for a
          buy, battery→grid for a sell), plus the whole zone's total for context */}
      {rows && (
        <>
          <TooltipRow color={rows.color} label={`${rows.noun} (denna kvart)`} value={`${rows.plannedSlotKwh.toFixed(1)} kWh`} />
          {band && <TooltipRow color={rows.color} label={`${rows.noun} (hela zonen)`} value={`${band.kwh.toFixed(1)} kWh`} />}
          {point.actual && (
            <TooltipRow
              color={rows.color}
              label="Verkligt (denna kvart)"
              value={`${point.actual[rows.field].toFixed(1)} kWh`}
              bold
            />
          )}
          {bandActual && (
            <TooltipRow
              color={rows.color}
              label="Verkligt (hela zonen)"
              value={`${bandActual.complete ? '' : '≥ '}${bandActual.kwh.toFixed(1)} kWh`}
              bold
            />
          )}
        </>
      )}

      {(point.decision === 'buy' || point.decision === 'sell') && band && bandActual && isBandDivergent(band.kwh, bandActual) && (
        <TooltipRow
          color="var(--color-now)"
          label="Avvikelse"
          value={`plan ${band.kwh.toFixed(1)} / verkligt ${bandActual.complete ? '' : '≥ '}${bandActual.kwh.toFixed(1)} kWh`}
        />
      )}

      {point.interventions.length > 0 && (
        <TooltipRow
          color="var(--color-now)"
          label="Ingrepp"
          value={point.interventions.map(interventionLabel).join(', ')}
        />
      )}

      {point.decision == null && point.action === 'discharge' && point.batteryToLoadKwh != null && point.batteryToLoadKwh > 0 && (
        <TooltipRow color="var(--color-soc)" label="Batteri → hus" value={`${point.batteryToLoadKwh.toFixed(1)} kWh`} />
      )}

      {hasPlan && point.socPct != null && (
        <TooltipRow color="var(--color-soc)" label="Batteri-SoC (planerad)" value={`${point.socPct.toFixed(0)} %`} />
      )}
      {point.actualSocPct != null && (
        <TooltipRow color="var(--color-soc)" label="Batteri-SoC (verklig)" value={`${point.actualSocPct.toFixed(0)} %`} bold />
      )}
    </div>
  );
}
