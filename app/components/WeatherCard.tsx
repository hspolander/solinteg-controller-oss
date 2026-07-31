import type { WeatherCardData } from '@/lib/weather-card';

function fmt(n: number | null, digits: number, unit: string): string {
  return n == null ? '–' : `${n.toFixed(digits)} ${unit}`;
}

// Live station reading vs. today's Open-Meteo forecast, same units, side by side — which makes
// forecast error visible at a glance. Purely informational: nothing here feeds the optimizer,
// whose solar forecast comes from Open-Meteo (see lib/weather-card.ts's header).
function Metric({
  label,
  liveValue,
  forecastValue,
}: {
  label: string;
  liveValue: string;
  forecastValue: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-2xl" style={{ padding: '9px 12px 10px', background: 'var(--badge-bg)' }}>
      <span className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-[20px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
        {liveValue}
      </span>
      {forecastValue && (
        <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          Prognos: {forecastValue}
        </span>
      )}
    </div>
  );
}

export default function WeatherCard({ data }: { data: WeatherCardData | null }) {
  if (!data) {
    return (
      <div className="card-surface box-border min-w-0 p-5 order-6 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_3] min-[1600px]:[grid-row:4]">
        <h2 className="text-[15px] font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Väder
        </h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Ingen väderdata ännu (väntar på solinteg-weather).
        </p>
      </div>
    );
  }

  return (
    <div
      className="card-surface box-border flex min-w-0 flex-col order-6 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_3] min-[1600px]:[grid-row:4]"
      style={{ padding: '15px 20px 13px' }}
    >
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-lg"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-color)' }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
              <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth={1.8} />
              <g stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                <line x1="12" y1="2.5" x2="12" y2="4.7" />
                <line x1="12" y1="19.3" x2="12" y2="21.5" />
                <line x1="2.5" y1="12" x2="4.7" y2="12" />
                <line x1="19.3" y1="12" x2="21.5" y2="12" />
              </g>
            </svg>
          </div>
          <div className="flex flex-col gap-px">
            <div className="text-[14px] font-bold leading-tight tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
              Väder
            </div>
            <div className="text-[10.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
              Egen station, live
            </div>
          </div>
        </div>
        {data.stale && (
          <div className="text-[11px] font-semibold" style={{ color: 'var(--flow-red, #e0554b)' }}>
            Ingen ny data på {Math.round(data.secondsAgo / 60)} min
          </div>
        )}
      </div>

      <div className="@container">
        <div className="flex flex-col gap-2.5 @min-[600px]:flex-row @min-[600px]:items-stretch @min-[600px]:gap-3.5">
          <Metric
            label="Utomhustemp"
            liveValue={fmt(data.tempC, 1, '°C')}
            forecastValue={data.forecastMeanTempC != null ? `${data.forecastMeanTempC.toFixed(1)} °C (dagsmedel)` : null}
          />
          <Metric
            label="Solinstrålning"
            liveValue={fmt(data.solarWm2, 0, 'W/m²')}
            forecastValue={data.forecastGhiWm2 != null ? `${data.forecastGhiWm2.toFixed(0)} W/m² (denna timme)` : null}
          />
          <Metric label="Luftfuktighet" liveValue={fmt(data.humidityPct, 0, '%')} forecastValue={null} />
          <Metric label="Vind" liveValue={fmt(data.windMs, 1, 'm/s')} forecastValue={null} />
        </div>
      </div>

      <div
        className="mt-3.5 border-t pt-2.5 text-[10.5px] font-semibold"
        style={{ borderColor: 'var(--divider)', color: 'var(--text-muted)' }}
      >
        Endast information — stationens mätvärden styr inte batteriets planering. Solprognosen
        kommer från Open-Meteo.
      </div>
    </div>
  );
}
