'use client';

/**
 * The key above the plot, and the three layer toggles.
 *
 * Price is a legend only — Köp and Sälj are the point of the chart and can't be turned off.
 * The other three are switchable because they compete for the same plot area: on a busy day
 * the solar area, the SoC lines and the decision zones together can bury the price curves the
 * user came to read. SoC and zones only appear at all when there is a plan to show.
 */
export interface ChartLayers {
  solar: boolean;
  soc: boolean;
  zones: boolean;
}

function ToggleChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="chip flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={on ? { border: '1px solid var(--divider)' } : { color: 'var(--text-muted)', opacity: 0.6 }}
    >
      {children}
    </button>
  );
}

export default function ChartLegend({
  layers,
  setLayers,
  hasPlan,
}: {
  layers: ChartLayers;
  setLayers: React.Dispatch<React.SetStateAction<ChartLayers>>;
  hasPlan: boolean;
}) {
  return (
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
      <ToggleChip on={layers.solar} onClick={() => setLayers((s) => ({ ...s, solar: !s.solar }))}>
        <span
          className="h-[11px] w-[13px] rounded-sm"
          style={{ background: 'color-mix(in srgb, var(--color-solar) 60%, transparent)' }}
        />
        Sol
      </ToggleChip>

      {hasPlan && (
        <ToggleChip on={layers.soc} onClick={() => setLayers((s) => ({ ...s, soc: !s.soc }))}>
          <span className="w-[18px] border-t-2" style={{ borderColor: 'var(--color-soc)', borderStyle: 'dashed' }} />
          Batteri-SoC
        </ToggleChip>
      )}

      {hasPlan && (
        <ToggleChip on={layers.zones} onClick={() => setLayers((s) => ({ ...s, zones: !s.zones }))}>
          {/* one swatch+label per zone kind, mirroring the in-chart band pills (BAND_LABEL) */}
          <span className="flex items-center gap-1">
            <span className="h-[11px] w-[9px] rounded-sm" style={{ background: 'var(--color-charge-band)' }} />
            Ladda
          </span>
          <span className="flex items-center gap-1">
            <span className="h-[11px] w-[9px] rounded-sm" style={{ background: 'var(--color-sell-band)' }} />
            Sälj
          </span>
          <span className="flex items-center gap-1">
            <span
              className="h-[11px] w-[9px] rounded-sm"
              style={{ background: 'color-mix(in srgb, var(--color-hold-band) 55%, transparent)' }}
            />
            Sparar
          </span>
        </ToggleChip>
      )}
    </div>
  );
}
