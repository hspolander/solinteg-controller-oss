'use client';

import type { InverterLiveData } from '@/lib/inverter';

// Ignore sub-threshold dribbles so a line/node doesn't flicker state near 0 W.
const FLOW_THRESHOLD_W = 20;

// The flow diagram is designed at this fixed pixel size; FlowNode converts its left/top/size
// props (still given in this coordinate space by every call site below) to percentages of it,
// so the whole diagram scales down uniformly with the SVG's own viewBox scaling instead of
// overflowing the card on narrow viewports (this card can render well under 360px wide).
const DESIGN_W = 360;
const DESIGN_H = 284;
const NODE_W = 80;
const NODE_H = 66;

function kw(w: number): string {
  return `${(Math.abs(w) / 1000).toFixed(2)} kW`;
}

type Pt = [number, number];

function arrowPolygon(from: Pt, to: Pt): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const al = 9;
  const aw = 6;
  const b1: Pt = [to[0] - ux * al + px * aw, to[1] - uy * al + py * aw];
  const b2: Pt = [to[0] - ux * al - px * aw, to[1] - uy * al - py * aw];
  return `${to[0]},${to[1]} ${b1[0]},${b1[1]} ${b2[0]},${b2[1]}`;
}

function FlowConnector({
  id,
  from,
  to,
  color,
  active,
}: {
  id: string;
  from: Pt;
  to: Pt;
  color: string;
  active: boolean;
}) {
  if (!active) {
    return (
      <line
        x1={from[0]}
        y1={from[1]}
        x2={to[0]}
        y2={to[1]}
        stroke="var(--node-idle-stroke)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray="2 7"
        opacity={0.7}
      />
    );
  }
  return (
    <g>
      <line
        x1={from[0]}
        y1={from[1]}
        x2={to[0]}
        y2={to[1]}
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        opacity={0.16}
      />
      <line
        x1={from[0]}
        y1={from[1]}
        x2={to[0]}
        y2={to[1]}
        stroke={color}
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeDasharray="5 7"
        className="animate-flow-dash"
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
      <polygon points={arrowPolygon(from, to)} fill={color} />
    </g>
  );
}

function FlowNode({
  left,
  top,
  icon,
  label,
  value,
  active,
  color,
}: {
  left: number;
  top: number;
  icon: React.ReactNode;
  label: string;
  value: string;
  active: boolean;
  color: string;
}) {
  return (
    <div
      className="absolute flex flex-col items-center justify-center gap-0.5 rounded-2xl"
      style={{
        left: `${(left / DESIGN_W) * 100}%`,
        top: `${(top / DESIGN_H) * 100}%`,
        width: `${(NODE_W / DESIGN_W) * 100}%`,
        height: `${(NODE_H / DESIGN_H) * 100}%`,
        background: 'var(--node-bg)',
        border: `1px solid ${active ? `color-mix(in srgb, ${color} 45%, transparent)` : 'var(--node-idle-border)'}`,
        boxShadow: active
          ? `0 0 0 1px color-mix(in srgb, ${color} 22%, transparent), 0 8px 22px -8px color-mix(in srgb, ${color} 45%, transparent)`
          : '0 6px 16px -10px rgba(0,0,0,.35)',
      }}
    >
      <div style={{ width: 22, height: 22, color: active ? color : 'var(--node-idle-text)' }}>{icon}</div>
      <div className="text-[9px] font-semibold" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div
        className="text-[13px] font-bold tracking-tight"
        style={{ color: active ? color : 'var(--node-idle-text)' }}
      >
        {value}
      </div>
    </div>
  );
}

const SolarIcon = (
  <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
    <g stroke="currentColor" strokeWidth={7} strokeLinecap="round">
      <line x1="50" y1="7" x2="50" y2="19" />
      <line x1="50" y1="81" x2="50" y2="93" />
      <line x1="7" y1="50" x2="19" y2="50" />
      <line x1="81" y1="50" x2="93" y2="50" />
      <line x1="19" y1="19" x2="28" y2="28" />
      <line x1="72" y1="72" x2="81" y2="81" />
      <line x1="19" y1="81" x2="28" y2="72" />
      <line x1="72" y1="28" x2="81" y2="19" />
    </g>
    <circle cx="50" cy="50" r="19" fill="currentColor" />
  </svg>
);

const HouseIcon = (
  <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
    <polygon points="50,13 87,45 13,45" fill="currentColor" />
    <rect x="20" y="43" width="60" height="45" rx="8" fill="currentColor" />
    <rect x="42" y="60" width="16" height="28" rx="3" fill="var(--node-bg)" />
  </svg>
);

const BatteryIcon = (
  <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
    <rect x="42" y="11" width="16" height="8" rx="3" fill="currentColor" />
    <rect x="30" y="19" width="40" height="71" rx="11" fill="none" stroke="currentColor" strokeWidth={7} />
    <rect x="38" y="64" width="24" height="19" rx="4" fill="currentColor" />
  </svg>
);

const GridIcon = (
  <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
    <g fill="none" stroke="currentColor" strokeWidth={6.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M50 8 L28 92" />
      <path d="M50 8 L72 92" />
      <path d="M38 20 H62" />
      <path d="M35 42 H65" />
      <path d="M31 66 H69" />
    </g>
  </svg>
);

function CardChrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="card-surface box-border flex w-full max-w-[380px] min-[1600px]:max-w-none min-[1600px]:flex-1 min-[1600px]:min-h-[380px] flex-col overflow-hidden order-2 min-[1600px]:order-none"
      style={{ borderRadius: 22, fontFamily: 'var(--font-heading)', gap: 8 }}
    >
      <div className="flex items-center justify-between px-5 pt-[12px]">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-lg"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
              <path
                d="M3 12 H7 L9.5 5 L14.5 19 L17 12 H21"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.1}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="flex flex-col gap-px">
            <div className="text-[15px] font-bold leading-tight tracking-tight">Systemstatus</div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Effektflöde nu
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          <span className="relative h-[7px] w-[7px]">
            <span className="absolute inset-0 rounded-full" style={{ background: 'var(--live-dot)' }} />
            <span className="absolute inset-0 animate-live-pulse rounded-full" style={{ background: 'var(--live-dot)' }} />
          </span>
          Live
        </div>
      </div>
      {/* No wrapping flex-1/centering div here anymore (v5) — header, diagram, divider, and
          the battery-health section are now sequential document-flow children. The diagram
          centers itself (margin:0 auto); the "no data" message centers itself via its own
          flex-1 wrapper below, since it's the only content when data is null. */}
      {children}
    </div>
  );
}

export default function PowerFlowCard({ data }: { data: InverterLiveData | null }) {
  if (!data) {
    return (
      <CardChrome>
        <div
          className="flex flex-1 items-center justify-center px-8 pb-[18px] text-center text-sm"
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}
        >
          Ingen aktuell data från växelriktaren (offline eller mer än 2 min gammal).
        </div>
      </CardChrome>
    );
  }

  const solarActive = data.pv_w > FLOW_THRESHOLD_W;
  const houseActive = data.house_load_w > FLOW_THRESHOLD_W;
  const batteryCharging = data.battery_w < -FLOW_THRESHOLD_W;
  const batteryDischarging = data.battery_w > FLOW_THRESHOLD_W;
  const batteryActive = batteryCharging || batteryDischarging;
  const exporting = data.grid_w > FLOW_THRESHOLD_W;
  const importing = data.grid_w < -FLOW_THRESHOLD_W;
  const gridActive = exporting || importing;
  const gridColor = importing ? 'var(--flow-red)' : 'var(--flow-sky)';

  // Solar -> House always flows downward (a panel can't draw power); House <-> Battery and
  // House <-> Grid reverse direction on discharge/import.
  const solA: Pt = [180, 90];
  const solB: Pt = [180, 113];
  const husBat: Pt = [150, 183];
  const batPt: Pt = [108, 209];
  const husGrid: Pt = [210, 183];
  const gridPt: Pt = [252, 209];
  const [bFrom, bTo] = batteryDischarging ? [batPt, husBat] : [husBat, batPt];
  const [gFrom, gTo] = importing ? [gridPt, husGrid] : [husGrid, gridPt];

  return (
    <CardChrome>
      {/* Fixed 360x284 design, scaled down uniformly (via aspect-ratio + %-based FlowNode
          positions, both keyed off DESIGN_W/DESIGN_H) below that width instead of overflowing —
          this card can be well under 360px wide on a phone once the page's own padding is
          subtracted. Above 360px (desktop) it renders at the exact original pixel design,
          capped and centered by max-width/margin. */}
      <div
        className="relative"
        style={{ width: '100%', maxWidth: DESIGN_W, aspectRatio: `${DESIGN_W} / ${DESIGN_H}`, margin: '0 auto' }}
      >
        <svg
          viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`}
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ width: '100%', height: '100%' }}
        >
          <FlowConnector id="s" from={solA} to={solB} color="var(--flow-solar)" active={solarActive} />
          <FlowConnector id="b" from={bFrom} to={bTo} color="var(--flow-battery)" active={batteryActive} />
          <FlowConnector id="g" from={gFrom} to={gTo} color={gridColor} active={gridActive} />
        </svg>

        <FlowNode
          left={140}
          top={24}
          icon={SolarIcon}
          label="Sol"
          value={solarActive ? kw(data.pv_w) : 'Vilar'}
          active={solarActive}
          color="var(--flow-solar)"
        />
        <FlowNode
          left={140}
          top={116}
          icon={HouseIcon}
          label="Hus"
          value={houseActive ? kw(data.house_load_w) : 'Vilar'}
          active={houseActive}
          color="var(--flow-house-accent)"
        />
        <FlowNode
          left={32}
          top={208}
          icon={BatteryIcon}
          label={`Batteri ${data.soc_pct.toFixed(0)}%`}
          value={batteryActive ? kw(data.battery_w) : 'Vilar'}
          active={batteryActive}
          color="var(--flow-battery)"
        />
        <FlowNode
          left={248}
          top={208}
          icon={GridIcon}
          label="Nät"
          value={gridActive ? kw(data.grid_w) : 'Vilar'}
          active={gridActive}
          color={gridColor}
        />
      </div>

      <div style={{ height: 1, background: 'var(--divider)' }} />

      {/* Battery health — merged from the old standalone BatteryHealthCard (v5). Same data
          (data.soc_pct/soc_kwh/soh_pct/battery_temp_c) PowerFlowCard already receives; same
          visual treatment as before, just relocated. If this section's natural height is
          shorter than the card's flex-filled total (varies with Dispatch's height next
          door), the leftover space just becomes bottom padding — not force-stretched. */}
      <div className="flex flex-col gap-2.5 px-5 pb-[12px]">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-lg"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
              <rect x="9" y="3" width="6" height="2.4" rx="1" fill="currentColor" />
              <rect x="6.5" y="5.4" width="11" height="15.6" rx="3.2" fill="none" stroke="currentColor" strokeWidth={2} />
              <rect x="9" y="13.5" width="6" height="5" rx="1.4" fill="currentColor" />
            </svg>
          </div>
          <div className="flex flex-1 flex-col gap-px">
            <div className="text-[15px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
              Batterihälsa
            </div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Tillstånd &amp; laddning
            </div>
          </div>
          <span className="text-[15px] font-bold" style={{ fontFamily: 'var(--font-heading)', color: 'var(--flow-battery)' }}>
            {data.soc_pct.toFixed(0)}%
          </span>
        </div>

        <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--track-bg)' }}>
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max(0, Math.min(100, data.soc_pct))}%`, background: 'var(--flow-battery)' }}
          />
        </div>

        <div className="flex items-center justify-between text-center" style={{ fontFamily: 'var(--font-heading)' }}>
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-bold">
              {data.soc_kwh.toFixed(1)}
              <span className="ml-0.5 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                kWh
              </span>
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>
              lagrat
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-bold">
              {data.soh_pct.toFixed(0)}
              <span className="ml-0.5 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                %
              </span>
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>
              SoH
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-bold">
              {data.battery_temp_c.toFixed(0)}
              <span className="ml-0.5 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                °C
              </span>
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>
              temp
            </span>
          </div>
        </div>
      </div>
    </CardChrome>
  );
}
