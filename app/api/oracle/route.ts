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
  readRecentOracleDays,
  readDayAheadDispatch,
  readPlannedDecisions,
  upsertOracleDaily,
} from '@/lib/telemetry';
import type { OracleDaySummaryRow } from '@/lib/telemetry';
import type { DispatchSlot } from '@/lib/optimizer';
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
  // Shadow: what the Solinteg optimizer's own plan would have earned vs facit (see shadow=1).
  shadowDayAheadRegretKr?: number | null;
  shadowDayAheadTotalKr?: number | null;
  shadowReplannedRegretKr?: number | null;
  shadowReplannedTotalKr?: number | null;
  shadowReplannedCoverage?: number | null;
}

const kr = (ore: number | null) => (ore === null ? null : Math.round(ore) / 100);

/** A stored oracle_daily row → the API's kr-denominated day summary (no recompute). Used for
 *  already-scored days in the sweep and for the read-only ?stored=1 feed the publisher polls. */
function summaryRowToDay(r: OracleDaySummaryRow): DaySummary {
  return {
    date: r.date,
    status: r.status,
    wrote: false,
    regretKr: kr(r.regretOre),
    regretIntradayKr: kr(r.regretIntradayOre),
    regretCarryKr: kr(r.regretCarryOre),
    oracleTotalKr: kr(r.oracleTotalOre),
    achievedTotalKr: kr(r.achievedTotalOre),
    baselineNetKr: kr(r.baselineNetOre),
    armedFraction: r.armedFraction,
    shadowDayAheadRegretKr: kr(r.shadowDayAheadRegretOre ?? null),
    shadowDayAheadTotalKr: kr(r.shadowDayAheadTotalOre ?? null),
    shadowReplannedRegretKr: kr(r.shadowReplannedRegretOre ?? null),
    shadowReplannedTotalKr: kr(r.shadowReplannedTotalOre ?? null),
    shadowReplannedCoverage: r.shadowReplannedCoverage ?? null,
  };
}

function scoreDay(date: string, dry: boolean, shadow = false): DaySummary {
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

  // Shadow inputs (only when requested): the day-ahead committed plan (last run before D's
  // midnight that had D as its "tomorrow", sliced to D's slots) and the per-slot replanned
  // decisions logged during D.
  let planDayAheadD: DispatchSlot[] | null = null;
  let controlActionsD: { slotTime: string | null; action: string; powerW: number | null }[] | null = null;
  if (shadow) {
    const full = readDayAheadDispatch(iso(dayStartMs));
    planDayAheadD = full ? full.filter((d) => d.startTime.startsWith(date)) : null;
    controlActionsD = readPlannedDecisions(iso(dayStartMs), iso(dayEndMs));
  }

  const row = computeOracleDay({
    date,
    dayStartMs,
    priceSlotsD: slotsD,
    priceSlotsCont: slotsCont,
    readings,
    armedEvents,
    achievedCashOre,
    planDayAheadD,
    controlActionsD,
  });

  // Persist the shadow scores alongside the row so the Facit can show them without a live
  // recompute (control_armed=false makes regret_ore's achieved side the incumbent's, while
  // these say what the Solinteg optimizer's own plan would have earned). oracle_daily has no
  // shadow columns, so they ride inside diagnostics_json; the key's presence also tells the
  // nightly sweep this row was already shadow-scored (see readRecentOracleDays / GET).
  if (shadow) {
    (row.diagnostics as Record<string, unknown>).shadow = {
      dayAhead: row.shadowDayAhead ?? null,
      replanned: row.shadowReplanned ?? null,
    };
  }

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
    shadowDayAheadRegretKr: row.shadowDayAhead ? kr(row.shadowDayAhead.regretOre) : null,
    shadowDayAheadTotalKr: row.shadowDayAhead ? kr(row.shadowDayAhead.totalOre) : null,
    shadowReplannedRegretKr: row.shadowReplanned ? kr(row.shadowReplanned.regretOre) : null,
    shadowReplannedTotalKr: row.shadowReplanned ? kr(row.shadowReplanned.totalOre) : null,
    shadowReplannedCoverage: row.shadowReplanned ? row.shadowReplanned.coverageD : null,
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
  const shadow = url.searchParams.get('shadow') === '1';
  const stored = url.searchParams.get('stored') === '1';
  const newestScorable = addDays(stockholmDateOf(new Date().toISOString()), -2);

  try {
    // Read-only feed: the persisted scores as-is, no compute or write. This is what the MQTT
    // publisher polls (~every 30 min) — the nightly sweep (below) is the only writer/backfiller.
    if (stored) {
      return Response.json({ days: readRecentOracleDays(SWEEP_DAYS).map(summaryRowToDay) });
    }
    // Stored rows for the sweep window (+margin), keyed by date — lets both the single-date
    // path and the sweep return persisted numbers without recomputing.
    const storedRows = new Map(
      readRecentOracleDays(SWEEP_DAYS + 4).map((r) => [r.date, r] as const),
    );

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
        const row = storedRows.get(dateParam);
        return Response.json({
          days: [
            row
              ? summaryRowToDay(row)
              : { date: dateParam, status: existing.get(dateParam), wrote: false, reason: 'already scored (use force=1 to recompute)' },
          ],
        });
      }
      return Response.json({ days: [scoreDay(dateParam, dry, shadow)] });
    }

    const from = addDays(newestScorable, -(SWEEP_DAYS - 1));
    const days: DaySummary[] = [];
    for (let d = from; d <= newestScorable; d = addDays(d, 1)) {
      const row = storedRows.get(d);
      // Recompute when forced, never scored, or scored before the shadow backfill existed
      // (older rows lack the shadow key → shadowScored:false, recomputed once). The sweep
      // always scores shadow so the Solinteg optimizer's plan-vs-facit is persisted.
      if (row && !force && row.shadowScored) {
        days.push(summaryRowToDay(row));
      } else {
        days.push(scoreDay(d, dry, true));
      }
    }
    return Response.json({ days });
  } catch (err) {
    console.error('oracle scoring failed:', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
