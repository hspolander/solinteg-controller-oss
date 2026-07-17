import { fetchPrices, currentSlotIndexInPrices } from '@/lib/prices';
import PriceChart from '@/app/components/PriceChart';
import { fetchSolarForecast, fetchDailyMeanTemp } from '@/lib/forecast';
import { buildSolarProfiles, buildOptimizerSlots } from '@/lib/pipeline';
import { optimizeDispatch } from '@/lib/optimizer';
import { readLiveInverterData, socKwhOrDefault } from '@/lib/inverter';
import {
  logPriceSnapshot,
  logOptimizerRun,
  readDailyEconomics,
  readTodaySocHistory,
  readRecentControlActions,
  readRecentOracleDays,
} from '@/lib/telemetry';
import { buildDispatchCardData } from '@/lib/dispatch-card';
import { buildOracleCardData } from '@/lib/oracle-card';
import { buildActualSocByTime } from '@/lib/chart-utils';
import { summarize, stockholmDateOf } from '@/lib/economics';
import { BATTERY_KWH, SKATT_OVERFÖRING } from '@/lib/constants';
import AppShell from '@/app/components/AppShell';
import EarningsCard from '@/app/components/EarningsCard';
import LiveInverterPanel from '@/app/components/LiveInverterPanel';
import OracleCard from '@/app/components/OracleCard';
import type { DispatchSlot } from '@/lib/optimizer';
import type { EconSummary } from '@/lib/economics';

export default async function Home() {
  const [data, solarForecast, tempByDate, inverterData] = await Promise.all([
    // A prices outage must not take down the whole page: live status and earnings don't
    // need spot prices. The chart/optimizer sections degrade to a notice instead.
    fetchPrices().catch((err) => {
      console.error('fetchPrices failed, rendering without price chart/optimizer:', err);
      return null;
    }),
    // Logged (not just silently swallowed) so we can tell from journalctl how often this
    // actually happens — Open-Meteo outages long enough to hit this are believed to be rare,
    // but that's currently a guess, not measured.
    fetchSolarForecast().catch((err) => {
      console.error('fetchSolarForecast failed, falling back to seasonal-average solar profile:', err);
      return null;
    }),
    fetchDailyMeanTemp().catch((err) => {
      console.error('fetchDailyMeanTemp failed, falling back to seasonal-average load model:', err);
      return null;
    }),
    readLiveInverterData(),
  ]);

  const startSoc = socKwhOrDefault(inverterData);
  const socIsLive = inverterData != null;
  let solarProfiles: Record<number, number[]> = {};
  let dispatchSchedule: DispatchSlot[] | null = null;

  if (data) {
    solarProfiles = buildSolarProfiles(data);
    const allSlots = buildOptimizerSlots(data, solarForecast, solarProfiles, tempByDate);

    // Telemetry (best-effort, no-op unless TELEMETRY_DB_PATH is set). readLiveInverterData()
    // calls connection() above, so this runs at request time, never during `next build`.
    logPriceSnapshot(data);

    try {
      // Slice off already-elapsed slots so the optimizer's own index 0 lines up with
      // `startSoc` (the live SoC read above, "right now") instead of always being
      // today's midnight. Without this, optimizeDispatch's forward pass anchors a
      // live mid-day SoC reading to a fictitious midnight and produces a full-day
      // trajectory that has nothing to do with reality by the time real wall-clock
      // catches up to any slot past the first — see lib/prices.ts's
      // currentSlotIndexInPrices docstring and dispatch_loop.py's matching fix.
      // Clamp defensively: a negative index (stale cache/clock skew) falls back to
      // the whole array (old behaviour, never worse); past the end (now is beyond
      // the last loaded day) yields an empty slice, which optimizeDispatch and the
      // dispatch loop both already treat as "no plan right now" safely.
      const nowSlotIdx = Math.max(0, currentSlotIndexInPrices(data.today, new Date()));
      const optimizerSlots = allSlots.slice(nowSlotIdx);

      dispatchSchedule = optimizeDispatch(optimizerSlots, startSoc);
      logOptimizerRun(data.today, data.hasTomorrow, startSoc, optimizerSlots, dispatchSchedule, socIsLive);
    } catch (err) {
      // non-fatal — chart renders without dispatch overlay — but logged so a failure here
      // (e.g. optimizeDispatch throwing) isn't as invisible as the price_snapshots gap was.
      console.error('optimizeDispatch/logOptimizerRun failed:', err);
    }
  }

  // Earnings, computed from logged telemetry (best-effort; empty until the poller has data).
  // readDailyEconomics caches fully elapsed days, so this only scans today's readings.
  let earnings: EconSummary | null = null;
  try {
    const daily = readDailyEconomics();
    if (daily.size > 0) {
      earnings = summarize(daily, stockholmDateOf(new Date().toISOString()));
    }
  } catch {
    // non-fatal — page renders without the earnings panel
  }

  // Actual SoC history, for the chart's plan-vs-actual overlay (best-effort).
  let actualSocByTime: Record<string, number> = {};
  try {
    actualSocByTime = buildActualSocByTime(readTodaySocHistory());
  } catch {
    // non-fatal — chart renders without the "actual" SoC line
  }

  // The dispatch loop's recent decisions, for the Dispatch card (best-effort; null
  // until it has logged at least one).
  const dispatchData = buildDispatchCardData(readRecentControlActions(), new Date());

  // Nightly hindsight-oracle scoring, for the Facit card (best-effort; null until the
  // first fully-armed day has been scored — see lib/oracle-card.ts).
  let oracleData = null;
  try {
    oracleData = buildOracleCardData(readRecentOracleDays());
  } catch (err) {
    console.error('buildOracleCardData failed, rendering without the Facit card data:', err);
  }

  return (
    <AppShell>
      {/* 2026-07-03 v5 layout: same 2 rows × 3 columns as v4. Batterihälsa no longer exists as
          its own card — merged into PowerFlowCard/Systemstatus (see that component) — so
          columns 1-2/row 2 now hold only Elhandel, alone, full width, as a plain direct grid
          child (no wrapper needed anymore). Elpriser (columns 1-2, row 1) and the
          Dispatch+Systemstatus wrapper (column 3, spanning both rows — see
          LiveInverterPanel) are unchanged from v4. items-start (only needed once ≥1600px)
          stops row 1/2 from stretching to match each other's height. gap-y is tightened at
          the ≥1600px breakpoint only — that's where row 1 (Elpriser) sits directly above row
          2 (Elhandel); the narrow single-column stack keeps the wider gap-5 since Dispatch/
          Systemstatus sit between them there instead. */}
      {/* Row 3 (added 2026-07-11): Facit spans all three columns under everything — column 3's
          LiveInverterPanel still spans only rows 1-2, so the full width is free there. */}
      <div className="grid grid-cols-1 gap-x-5 gap-y-5 min-[1600px]:grid-cols-[minmax(640px,1fr)_380px_minmax(640px,1fr)] min-[1600px]:grid-rows-[auto_auto_auto] min-[1600px]:items-start min-[1600px]:gap-y-2">
        {data ? (
          <PriceChart
            data={data}
            solarProfiles={solarProfiles}
            solarForecast={solarForecast}
            dispatchSchedule={dispatchSchedule}
            startSocKwh={startSoc}
            socIsLive={socIsLive}
            actualSocByTime={actualSocByTime}
            batteryKwh={BATTERY_KWH}
            skattOverforing={SKATT_OVERFÖRING}
          />
        ) : (
          <section className="card-surface box-border min-w-0 p-5 order-1 min-[1600px]:order-none min-[1600px]:[grid-column:1/span_2] min-[1600px]:[grid-row:1]">
            <h2 className="text-[15px] font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Elpriser
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Kunde inte hämta elpriser just nu — graf och batteriplan saknas tills källan svarar
              igen. Systemstatus och elhandel visas ändå.
            </p>
          </section>
        )}
        <LiveInverterPanel initialData={inverterData} initialDispatchData={dispatchData} />
        <EarningsCard summary={earnings} />
        <OracleCard data={oracleData} />
      </div>
    </AppShell>
  );
}
