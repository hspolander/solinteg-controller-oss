'use client';

import { useEffect, useState } from 'react';
import type { DispatchCardData, DispatchTone, GaugeTone, DecisionOutcome } from '@/lib/dispatch-card';
import { gaugeFillPct, gaugeTone } from '@/lib/dispatch-card';

// Matches LiveInverterPanel's polling cadence for the rest of the live dashboard data.
const POLL_MS = 10_000;

const BADGE_TONE_STYLE: Record<DispatchTone, { bg: string; color: string }> = {
  AKTIV: { bg: 'color-mix(in srgb, var(--color-buy) 16%, transparent)', color: 'var(--color-buy)' },
  AVVAKTAR: { bg: 'color-mix(in srgb, var(--color-warning) 16%, transparent)', color: 'var(--color-warning)' },
  PLANERAT: { bg: 'var(--badge-bg)', color: 'var(--text-muted)' },
};

const GAUGE_TONE_COLOR: Record<GaugeTone, string> = {
  green: 'var(--color-buy)',
  amber: 'var(--color-warning)',
  red: 'var(--econ-red)',
};

const OUTCOME_BAR_COLOR: Record<DecisionOutcome, string> = {
  ok: 'var(--color-buy)',
  skip: 'var(--color-warning)',
  error: 'var(--econ-red)',
};

function formatAgo(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s sedan`;
  return `${Math.round(seconds / 60)} min sedan`;
}

function PriceChip({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  return (
    <div
      className="flex flex-1 flex-col gap-1 rounded-[10px]"
      style={{ padding: '8px 10px', background: 'color-mix(in srgb, var(--text) 5%, transparent)' }}
    >
      <span className="text-[9.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-[14px] font-bold" style={{ fontFamily: 'var(--font-heading)', color }}>
        {value != null ? `${value.toFixed(1)} öre` : '—'}
      </span>
    </div>
  );
}

function Gauge({ name, value, limit, unit }: { name: string; value: number; limit: number; unit: string }) {
  const pct = gaugeFillPct(value, limit);
  const tone = gaugeTone(pct);
  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold">{name}</span>
        <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          {value.toFixed(1)} av {limit.toFixed(1)} {unit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--track-bg)' }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: GAUGE_TONE_COLOR[tone] }}
        />
      </div>
    </div>
  );
}

export default function DispatchCard({ initialData }: { initialData: DispatchCardData | null }) {
  const [data, setData] = useState(initialData);
  const [expanded, setExpanded] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [ageS, setAgeS] = useState<number | null>(
    initialData ? Math.round(initialData.current.secondsAgo) : null,
  );

  // Poll for fresh decisions — there's no push channel, and the underlying data changes
  // at most once per LOOP_INTERVAL_S (60s) server-side, but polling at the same 10s
  // cadence as the rest of the live panel keeps this card in step with everything else.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/dispatch', { cache: 'no-store' });
        const next = res.ok ? ((await res.json()) as DispatchCardData) : null;
        if (!cancelled && next) setData(next);
      } catch {
        // keep showing the last known data rather than blanking the card on a transient
        // fetch error — matches LiveInverterPanel's tolerance for one bad poll.
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Ticks the "Xs sedan" label between polls, extrapolating forward from the secondsAgo
  // captured at the last successful poll (same idea as the old DispatchStatus.tsx).
  useEffect(() => {
    if (!data) return;
    const base = data.current.secondsAgo;
    const startedAt = Date.now();
    const tick = () => setAgeS(Math.round(base + (Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [data]);

  if (!data) {
    return (
      <div
        className="card-surface box-border flex flex-col gap-2 order-4 min-[1600px]:order-none min-[1600px]:flex-none"
        style={{ padding: '18px 20px' }}
      >
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Ingen dispatch-data ännu.
        </p>
      </div>
    );
  }

  const { current, recentDecisions } = data;
  const activeIdx = selectedIdx ?? recentDecisions.length - 1;
  const selected = recentDecisions[activeIdx];
  const tone = BADGE_TONE_STYLE[current.badge];

  return (
    <div
      className="card-surface box-border flex flex-col order-4 min-[1600px]:order-none min-[1600px]:flex-none"
      style={{ padding: '18px 20px', gap: 8 }}
    >
      {/* header */}
      <div className="flex items-center gap-2">
        <div
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg"
          style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
        >
          <svg
            viewBox="0 0 24 24"
            style={{ width: 14, height: 14 }}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 15 L9 9 L13 12 L20 4" />
          </svg>
        </div>
        <span
          className="text-[15px] font-bold"
          style={{ fontFamily: 'var(--font-heading)', letterSpacing: '-0.2px' }}
        >
          Dispatch
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase"
          style={{ letterSpacing: '0.4px', background: tone.bg, color: tone.color }}
        >
          {current.badge}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {ageS != null ? formatAgo(ageS) : ''}
        </span>
      </div>

      {/* reasoning (Layer 1, always visible) */}
      <p className="text-[13.5px] leading-[1.45]" style={{ fontFamily: 'var(--font-body)' }}>
        {current.reason}
      </p>

      {/* warning (conditional) */}
      {current.warning && (
        <div
          className="flex items-start gap-1.5 text-[11.5px] font-semibold"
          style={{ color: 'var(--color-warning)' }}
        >
          <svg
            viewBox="0 0 24 24"
            style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinejoin="round"
          >
            <path d="M12 3.5 L21.5 20 H2.5 Z" />
            <line x1="12" y1="9.5" x2="12" y2="14" strokeLinecap="round" />
            <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
          </svg>
          <span>{current.warning}</span>
        </div>
      )}

      {/* expand toggle */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="chip flex items-center gap-1 self-start rounded text-[11.5px] font-bold"
        style={{ color: 'var(--color-soc)', background: 'none', border: 'none', padding: '2px 4px', margin: '-2px -4px' }}
      >
        {expanded ? 'Dölj detaljer' : 'Visa detaljer'}
        <svg
          viewBox="0 0 24 24"
          style={{ width: 11, height: 11, transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : 'none' }}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 9 L12 16 L19 9" />
        </svg>
      </button>

      {/* expanded detail (Layer 2) */}
      {expanded && (
        <div className="flex flex-col" style={{ gap: 12 }}>
          <div className="flex" style={{ gap: 8 }}>
            <PriceChip label="Köp" value={current.buyOre} color="var(--color-buy)" />
            <PriceChip label="Sälj" value={current.sellOre} color="var(--color-sell)" />
          </div>
          <Gauge
            name="Solunderskott"
            value={current.solarDeficitKwh}
            limit={current.solarDeficitLimitKwh}
            unit="kWh-gräns"
          />
          <Gauge
            name="SoC-avvikelse"
            value={current.socDeviationKwh}
            limit={current.socDeviationLimitKwh}
            unit="kWh"
          />
        </div>
      )}

      <div style={{ height: 1, background: 'var(--divider)', margin: '8px 0 2px' }} />

      {/* timeline header (Layer 3) */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Senaste besluten
        </span>
        <span className="text-[10.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
          Senaste ~4 h · tryck för detaljer
        </span>
      </div>

      {/* timeline strip — horizontally scrollable, not shrink-to-fit: up to 12 fixed
          22px bars (plus 7px gaps) need ~340px, more than this card is wide on a
          narrow viewport. Scrolling keeps every bar at its spec'd size instead of
          squeezing them to fit. The 4px inset (padding + matching negative margin,
          so the row still lines up with the rest of the card) is exactly the reach
          of the selected bar's ring (see boxShadow below) so it never gets clipped
          by the scroll container's own edge. */}
      <div
        className="flex items-end"
        style={{ gap: 7, height: 44, overflowX: 'auto', padding: '0 4px', margin: '0 -4px' }}
      >
        {recentDecisions.map((d, i) => {
          const isSelected = i === activeIdx;
          const height = Math.min(40, Math.max(10, 8 + d.powerKw * 5.5));
          const color = OUTCOME_BAR_COLOR[d.outcome];
          return (
            <button
              key={i}
              type="button"
              title={`${d.time} · ${d.action} · ${d.powerKw.toFixed(1)} kW`}
              onClick={() => setSelectedIdx(i)}
              style={{
                width: 22,
                height,
                borderRadius: 5,
                border: 'none',
                background: color,
                opacity: isSelected ? 1 : 0.55,
                boxShadow: isSelected ? `0 0 0 2px var(--card-bg), 0 0 0 4px ${color}` : 'none',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>

      {/* selected-item summary */}
      {selected && (
        <div style={{ borderTop: '1px solid var(--divider)', paddingTop: 9 }}>
          <span className="text-[11px] font-semibold">
            {selected.time} · {selected.action} · {selected.powerKw.toFixed(1)} kW
          </span>
        </div>
      )}
    </div>
  );
}
