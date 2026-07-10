import type { EconSummary, EconTotals } from '@/lib/economics';

function kr(n: number, digits = 0): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function fmtKwh(n: number): string {
  return `${n.toFixed(1)} kWh`;
}

const UP_ARROW = 'M12 20 V7 M6.5 12.5 L12 7 L17.5 12.5';
const DOWN_ARROW = 'M12 4 V17 M6.5 11.5 L12 17 L17.5 11.5';

function Tile({ label, totals, digits }: { label: string; totals: EconTotals; digits: number }) {
  const net = totals.netKr;
  const fav = net > 0.005;
  const unfav = net < -0.005;
  const netColor = fav ? 'var(--econ-green)' : unfav ? 'var(--econ-red)' : 'var(--econ-gray)';
  const tint = fav
    ? 'color-mix(in srgb, var(--econ-green) 7%, transparent)'
    : unfav
      ? 'color-mix(in srgb, var(--econ-red) 7%, transparent)'
      : 'color-mix(in srgb, var(--econ-gray) 5%, transparent)';
  const caption = fav ? 'Nettoförsäljning' : unfav ? 'Nettoköp' : 'I balans';
  const sign = net > 0.005 ? '+' : net < -0.005 ? '−' : '';
  const total = totals.costKr + totals.incomeKr || 1;
  const spentW = (totals.costKr / total) * 100;
  const earnedW = (totals.incomeKr / total) * 100;

  return (
    <div
      className="flex flex-1 flex-col gap-1.5 rounded-2xl"
      style={{ background: tint, padding: '9px 12px 10px' }}
    >
      <span className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>

      {/* Net number + caption on one line (v5) — was stacked caption-above-number. */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[20px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)', color: netColor }}>
          {sign}
          {kr(Math.abs(net), digits)}
        </span>
        <span className="text-[9px] font-bold" style={{ color: netColor }}>
          {caption}
        </span>
      </div>

      <div className="flex h-1 overflow-hidden rounded-full" style={{ background: 'var(--track-bg)' }}>
        <div style={{ width: `${spentW}%`, background: 'var(--econ-spent)' }} />
        <div style={{ width: `${earnedW}%`, background: 'var(--econ-earned)' }} />
      </div>

      <div className="mt-0.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, color: 'var(--econ-spent)', flex: 'none' }}>
            <path d={DOWN_ARROW} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
            Köpt
          </span>
          <span className="ml-auto text-[10.5px] font-bold">{fmtKwh(totals.boughtKwh)}</span>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
            · {kr(totals.costKr, digits)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, color: 'var(--econ-earned)', flex: 'none' }}>
            <path d={UP_ARROW} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
            Sålt
          </span>
          <span className="ml-auto text-[10.5px] font-bold">{fmtKwh(totals.soldKwh)}</span>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
            · {kr(totals.incomeKr, digits)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function EarningsCard({ summary }: { summary: EconSummary | null }) {
  if (!summary || summary.allTime.readingCount === 0) {
    return (
      <div className="card-surface box-border min-w-0 p-5 order-4 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_2] min-[1600px]:[grid-row:2]">
        <h2 className="text-[15px] font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Elhandel
        </h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Inväntar växelriktardata.
        </p>
      </div>
    );
  }

  return (
    <div
      className="card-surface box-border flex min-w-0 flex-col order-4 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_2] min-[1600px]:[grid-row:2]"
      style={{ padding: '15px 20px 13px' }}
    >
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-bold tracking-wide"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)', fontFamily: 'var(--font-heading)' }}
          >
            kr
          </div>
          <div className="flex flex-col gap-px">
            <div className="text-[14px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
              Elhandel
            </div>
            <div className="text-[10.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Resultat &amp; netto
            </div>
          </div>
        </div>
        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          {summary.days} {summary.days === 1 ? 'dag' : 'dagar'} data
        </div>
      </div>

      <div className="flex items-stretch gap-3.5">
        <Tile label="Idag" totals={summary.today} digits={2} />
        <Tile label="Denna månad" totals={summary.month} digits={0} />
        <Tile label="Totalt" totals={summary.allTime} digits={0} />
      </div>

      {/* Legend chips removed (v5) — the arrows + net-number color already make the color
          coding self-evident once the card has more horizontal room to read clearly. */}
      <div
        className="mt-3.5 border-t pt-2.5 text-[10.5px] font-semibold"
        style={{ borderColor: 'var(--divider)', color: 'var(--text-muted)' }}
      >
        Netto = intäkt (sålt) − kostnad (köpt) till periodens priser.
      </div>
    </div>
  );
}
