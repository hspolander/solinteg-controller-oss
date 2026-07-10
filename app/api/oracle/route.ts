/**
 * Hindsight-oracle scoring endpoint.
 *
 * GET /api/oracle            → sweep the last 14 scorable days, compute any missing ones
 * GET /api/oracle?date=D     → compute exactly day D (YYYY-MM-DD, Stockholm)
 *        &force=1            → recompute even if a row exists (after code/config changes)
 *        &dry=1              → compute and return, but do not write oracle_daily
 *
 * Curled nightly by solinteg-oracle.timer (same localhost-render pattern as
 * solinteg-telemetry.timer). A day D is scorable only once D+1 has fully elapsed — the oracle
 * window needs the day-after's actuals to value carried SoC fairly (see lib/oracle.ts) — so
 * the newest scorable day is always Stockholm-today − 2, and regret numbers lag two nights.
 *
 * Days whose price curves are missing/incomplete are reported in the response but NOT written,
 * so a later backfill (e.g. a restored price snapshot) isn't blocked by a junk row.
 */
import { stockholmMidnightUtc } from '@/lib/prices';
import type { PriceSlot } from '@/lib/prices';
import { computeDailyEconomics, stockholmDateOf } from '@/lib/economics';
import {
  buildPriceLookup,
  readReadings,
  readOracleReadings,
  readArmedEvents,
  readPriceSnapshot,
  readOracleDates,
  upsertOracleDaily,
} from '@/lib/telemetry';
import { computeOracleDay, ARMED_SEGMENT_CAP_MS } from '@/lib/oracle';

const SLOT_MS = 900_000;
const SWEEP_DAYS = 14; // nightly self-healing window: recompute anything missing this far back
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function midnightMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return stockholmMidnightUtc(y, m - 1, d).getTime();
}

/** That day's slots out of a snapshot's prices (which may also hold the next day's). */
function slotsForDay(prices: PriceSlot[] | undefined, dateStr: string): PriceSlot[] {
  return (prices ?? []).filter((p) => p.startTime.startsWith(dateStr));
}

interface DaySummary {
  date: string;
  status: string;
  wrote: boolean;
  reason?: string;
  regretKr?: number | null;
  regretIntradayKr?: number | null;
  regretCarryKr?: number | null;
  oracleTotalKr?: number | null;
  achievedTotalKr?: number | null;
  achievedCashKr?: number | null;
  baselineNetKr?: number | null;
  armedFraction?: number | null;
  readingCoverage?: number | null;
  /** Day-D energy-balance residual (kWh) — systematic drift here means the model's physics
   *  disagree with the meter; surfaced in the nightly journal so it gets noticed. */
  balanceResidualKwh?: number | null;
}

const kr = (ore: number | null) => (ore === null ? null : Math.round(ore) / 100);

function scoreDay(date: string, dry: boolean): DaySummary {
  const d1 = addDays(date, 1);
  const dayStartMs = midnightMs(date);
  const dayEndMs = midnightMs(d1);
  const contEndMs = midnightMs(addDays(date, 2));

  // Day D's slots: its own snapshot, else yesterday's tomorrow-half (post-13:00 snapshots
  // hold today+tomorrow). Continuation slots symmetrically.
  const snapD = readPriceSnapshot(date);
  const snapPrev = snapD ? null : readPriceSnapshot(addDays(date, -1));
  const slotsD = slotsForDay(snapD?.prices ?? snapPrev?.prices, date);
  const snapD1 = readPriceSnapshot(d1);
  const slotsCont = snapD?.hasTomorrow
    ? slotsForDay(snapD.prices, d1)
    : slotsForDay(snapD1?.prices, d1);

  // Elapsed-time bucketing maps slot i to [midnight + 15i, midnight + 15(i+1)); that only
  // holds if the price list is complete and contiguous (92/96/100 slots depending on DST).
  const expectD = (dayEndMs - dayStartMs) / SLOT_MS;
  const expectCont = (contEndMs - dayEndMs) / SLOT_MS;
  if (slotsD.length !== expectD || slotsCont.length !== expectCont) {
    return {
      date,
      status: 'skipped_no_prices',
      wrote: false,
      reason: `price slots D=${slotsD.length}/${expectD}, D+1=${slotsCont.length}/${expectCont}`,
    };
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const readings = readOracleReadings(iso(dayStartMs), iso(contEndMs));
  // One cap-length of lead-in so a pre-midnight armed row covers the day's first minutes.
  const armedEvents = readArmedEvents(iso(dayStartMs - ARMED_SEGMENT_CAP_MS), iso(dayEndMs));
  const econ = computeDailyEconomics(
    readReadings(iso(dayStartMs), iso(dayEndMs)),
    buildPriceLookup(),
  ).get(date);
  const achievedCashOre = econ ? econ.netKr * 100 : null;

  const row = computeOracleDay({
    date,
    dayStartMs,
    priceSlotsD: slotsD,
    priceSlotsCont: slotsCont,
    readings,
    armedEvents,
    achievedCashOre,
  });

  const wrote = dry ? false : upsertOracleDaily(row);
  const balance = row.diagnostics.balance as { residualKwh: number } | undefined;
  return {
    date,
    status: row.status,
    wrote,
    regretKr: kr(row.regretOre),
    regretIntradayKr: kr(row.regretIntradayOre),
    regretCarryKr: kr(row.regretCarryOre),
    oracleTotalKr: kr(row.oracleTotalOre),
    achievedTotalKr: kr(row.achievedTotalOre),
    achievedCashKr: kr(row.achievedCashOre),
    baselineNetKr: kr(row.baselineNetOre),
    armedFraction: row.armedFraction,
    readingCoverage: row.readingCoverage,
    balanceResidualKwh: balance ? balance.residualKwh : null,
  };
}

export async function GET(request: Request) {
  if (!process.env.TELEMETRY_DB_PATH) {
    return Response.json({ error: 'telemetry disabled (TELEMETRY_DB_PATH unset)' }, { status: 503 });
  }
  const url = new URL(request.url);
  const dateParam = url.searchParams.get('date');
  const force = url.searchParams.get('force') === '1';
  const dry = url.searchParams.get('dry') === '1';
  const newestScorable = addDays(stockholmDateOf(new Date().toISOString()), -2);

  try {
    if (dateParam) {
      if (!DATE_RE.test(dateParam)) {
        return Response.json({ error: `bad date: ${dateParam}` }, { status: 400 });
      }
      if (dateParam > newestScorable) {
        return Response.json(
          { error: `day ${dateParam} not scorable before ${addDays(dateParam, 2)} (needs the day after's actuals)` },
          { status: 400 },
        );
      }
      const existing = readOracleDates(dateParam, addDays(dateParam, 1));
      if (existing.has(dateParam) && !force && !dry) {
        return Response.json({ days: [{ date: dateParam, status: existing.get(dateParam), wrote: false, reason: 'already scored (use force=1 to recompute)' }] });
      }
      return Response.json({ days: [scoreDay(dateParam, dry)] });
    }

    const from = addDays(newestScorable, -(SWEEP_DAYS - 1));
    const existing = readOracleDates(from, addDays(newestScorable, 1));
    const days: DaySummary[] = [];
    for (let d = from; d <= newestScorable; d = addDays(d, 1)) {
      if (existing.has(d) && !force) {
        days.push({ date: d, status: existing.get(d) ?? 'unknown', wrote: false, reason: 'already scored' });
      } else {
        days.push(scoreDay(d, dry));
      }
    }
    return Response.json({ days });
  } catch (err) {
    console.error('oracle scoring failed:', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
