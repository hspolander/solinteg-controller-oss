'use client';

import { useRef, useState } from 'react';
import type { OracleCardData, OracleTrendDay } from '@/lib/oracle-card';

function kr(n: number, digits = 2): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

const DAY_LABEL = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "2026-07-09" → "9 juli" — dates are pure Stockholm days, formatted in UTC so no TZ can shift them. */
function dayLabel(date: string): string {
  return DAY_LABEL.format(new Date(`${date}T00:00:00Z`));
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'Fullt utvärderad',
  shadow: 'Ej skarp styrning hela dygnet',
  degraded: 'Ofullständig mätdata',
  skipped_no_readings: 'Ingen mätdata',
};

function Tile({ label, value, caption, sub }: { label: string; value: string; caption: string; sub?: string }) {
  return (
    <div
      className="flex flex-1 flex-col gap-1 rounded-2xl"
      style={{ background: 'color-mix(in srgb, var(--econ-gray) 5%, transparent)', padding: '9px 12px 10px' }}
    >
      <span className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[20px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
          {value}
        </span>
        <span className="text-[9px] font-bold" style={{ color: 'var(--text-muted)' }}>
          {caption}
        </span>
      </div>
      {sub && (
        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** Rounded top corners, square baseline — the bar spec (radius collapses on very short bars). */
function barPath(x: number, yTop: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const right = x + w;
  const bottom = yTop + h;
  return [
    `M ${x.toFixed(1)} ${bottom.toFixed(1)}`,
    `L ${x.toFixed(1)} ${(yTop + r).toFixed(1)}`,
    `Q ${x.toFixed(1)} ${yTop.toFixed(1)} ${(x + r).toFixed(1)} ${yTop.toFixed(1)}`,
    `L ${(right - r).toFixed(1)} ${yTop.toFixed(1)}`,
    `Q ${right.toFixed(1)} ${yTop.toFixed(1)} ${right.toFixed(1)} ${(yTop + r).toFixed(1)}`,
    `L ${right.toFixed(1)} ${bottom.toFixed(1)}`,
    'Z',
  ].join(' ');
}

interface HoverState {
  index: number;
  x: number; // container-relative px, for tooltip placement
  containerWidth: number;
}

const VIEW_W = 560;
const VIEW_H = 128;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 22; // room for the direct label above the tallest bar
const PAD_B = 18; // room for the date ticks
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const BASE_Y = VIEW_H - PAD_B;
const PLOT_H = BASE_Y - PAD_T;

function TrendRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="ml-auto pl-3 font-semibold">{value}</span>
    </div>
  );
}

export default function OracleCard({ data }: { data: OracleCardData | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  if (!data) {
    return (
      <div className="card-surface box-border min-w-0 p-5 order-5 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_3] min-[1600px]:[grid-row:3]">
        <h2 className="text-[15px] font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Facit
        </h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Facit beräknas varje natt när ett helt dygn plus dagen efter är kompletta — första
          utvärderingen dyker upp här när tillräckligt med data finns.
        </p>
      </div>
    );
  }

  const days = data.days;
  const slotW = PLOT_W / Math.max(1, days.length);
  const barW = Math.min(24, Math.max(6, slotW - 6));
  const maxKr = Math.max(1, ...days.map((d) => d.regretKr ?? 0));
  const xAt = (i: number) => PAD_L + i * slotW + (slotW - barW) / 2;
  const heightFor = (v: number) => Math.max(2, (Math.max(0, v) / maxKr) * PLOT_H);

  const latestIdx = days.findIndex((d) => d.date === data.latest.date);

  const updateHover = (clientX: number) => {
    const el = containerRef.current;
    if (!el || days.length === 0) return;
    const rect = el.getBoundingClientRect();
    const localX = clientX - rect.left;
    const fraction = Math.min(1, Math.max(0, localX / rect.width));
    const index = Math.min(days.length - 1, Math.max(0, Math.floor(((fraction * VIEW_W - PAD_L) / PLOT_W) * days.length)));
    setHover({ index, x: localX, containerWidth: rect.width });
  };

  const hoverDay: OracleTrendDay | null = hover ? days[hover.index] : null;

  const split =
    data.latestIntradayKr != null && data.latestCarryKr != null
      ? `intradag ${kr(data.latestIntradayKr)} · dygnsövergång ${kr(data.latestCarryKr)}`
      : undefined;

  return (
    <div
      className="card-surface box-border flex min-w-0 flex-col order-5 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_3] min-[1600px]:[grid-row:3]"
      style={{ padding: '15px 20px 13px', fontFamily: 'var(--font-body)' }}
    >
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-lg"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
              {/* target/bullseye: how close to optimal */}
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth={2} />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
          </div>
          <div className="flex flex-col gap-px">
            <div className="text-[14px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
              Facit
            </div>
            <div className="text-[10.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Batteristyrning jämförd med optimal styrning i efterhand
            </div>
          </div>
        </div>
        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          {data.okDays} {data.okDays === 1 ? 'dygn utvärderat' : 'dygn utvärderade'}
        </div>
      </div>

      <div className="flex flex-col gap-4 min-[900px]:flex-row min-[900px]:items-stretch">
        <div className="flex flex-1 items-stretch gap-3.5">
          <Tile
            label={`Senast · ${dayLabel(data.latest.date)}`}
            value={data.latest.regretKr == null ? '–' : kr(data.latest.regretKr)}
            caption="tappat vs facit"
            sub={split}
          />
          <Tile label={`Median · ${data.okDays} dygn`} value={kr(data.medianRegretKr)} caption="tappat per dygn" />
          <Tile
            label="Fångat värde"
            value={data.medianCapturedPct == null ? '–' : `${Math.round(data.medianCapturedPct)} %`}
            caption="av teoretiskt max"
          />
        </div>

        <div className="relative flex-1" ref={containerRef}>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width="100%"
            style={{ display: 'block', height: 'auto' }}
            onMouseMove={(e) => updateHover(e.clientX)}
            onMouseLeave={() => setHover(null)}
            onTouchMove={(e) => {
              if (e.touches[0]) updateHover(e.touches[0].clientX);
            }}
            onTouchEnd={() => setHover(null)}
          >
            <line x1={PAD_L} y1={BASE_Y} x2={PAD_L + PLOT_W} y2={BASE_Y} stroke="var(--divider)" strokeWidth={1} />
            {days.map((d, i) => {
              const ok = d.status === 'ok';
              const h = d.regretKr == null ? 3 : heightFor(d.regretKr);
              const x = xAt(i);
              return (
                <path
                  key={d.date}
                  d={barPath(x, BASE_Y - h, barW, h)}
                  fill={ok ? 'var(--color-sell)' : 'var(--econ-gray)'}
                  opacity={hover && hover.index === i ? 1 : ok ? 0.85 : 0.3}
                />
              );
            })}
            {/* direct label on the headline day only — the tooltip carries the rest */}
            {latestIdx >= 0 && days[latestIdx].regretKr != null && (
              <text
                x={xAt(latestIdx) + barW / 2}
                y={BASE_Y - heightFor(days[latestIdx].regretKr as number) - 6}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill="var(--text)"
              >
                {kr(days[latestIdx].regretKr as number)}
              </text>
            )}
            {days.length > 0 && (
              <>
                <text x={xAt(0) + barW / 2} y={BASE_Y + 13} textAnchor="middle" fontSize={9.5} fill="var(--axis-text)">
                  {dayLabel(days[0].date)}
                </text>
                {days.length > 1 && (
                  <text
                    x={xAt(days.length - 1) + barW / 2}
                    y={BASE_Y + 13}
                    textAnchor="middle"
                    fontSize={9.5}
                    fill="var(--axis-text)"
                  >
                    {dayLabel(days[days.length - 1].date)}
                  </text>
                )}
              </>
            )}
            <text x={PAD_L} y={PAD_T - 10} fontSize={9} fontWeight={700} fill="var(--axis-text)">
              Tappat värde per dygn, kr
            </text>
          </svg>

          {hover && hoverDay && (
            <div
              className="pointer-events-none absolute z-20 flex flex-col gap-1 rounded-lg p-2.5 text-xs"
              style={{
                ...(hover.x > hover.containerWidth * 0.6
                  ? { right: hover.containerWidth - hover.x + 12 }
                  : { left: hover.x + 12 }),
                top: 0,
                minWidth: 168,
                background: 'var(--card-bg-grad, var(--card-bg))',
                border: '1px solid var(--card-border)',
                boxShadow: 'var(--card-shadow)',
                color: 'var(--text)',
              }}
            >
              <div className="mb-0.5 font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
                {dayLabel(hoverDay.date)}
                <span className="ml-1.5 font-semibold" style={{ color: 'var(--text-muted)' }}>
                  {STATUS_LABEL[hoverDay.status] ?? hoverDay.status}
                </span>
              </div>
              {hoverDay.regretKr != null && (
                <TrendRow color="var(--color-sell)" label="Tappat vs facit" value={kr(hoverDay.regretKr)} />
              )}
              {hoverDay.achievedKr != null && <TrendRow label="Uppnått värde" value={kr(hoverDay.achievedKr, 0)} />}
              {hoverDay.oracleKr != null && <TrendRow label="Facit (optimalt)" value={kr(hoverDay.oracleKr, 0)} />}
              {hoverDay.capturedPct != null && (
                <TrendRow label="Fångat värde" value={`${Math.round(hoverDay.capturedPct)} %`} />
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="mt-3.5 border-t pt-2.5 text-[10.5px] font-semibold"
        style={{ borderColor: 'var(--divider)', color: 'var(--text-muted)' }}
      >
        Facit = bästa möjliga styrning beräknad i efterhand med facit i hand (verkliga priser, sol och
        förbrukning). Ett dygn utvärderas när nästa dygn är komplett, så siffrorna släpar ~2 dygn.
        Gråa staplar = dygn som inte kan jämföras rättvist (ej skarp styrning eller datalucka).
      </div>
    </div>
  );
}
