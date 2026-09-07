// Does the oracle's 48 h scoring window actually contain day D's regret?
//
// Why this exists: `computeOracleDay` scores day D inside a window of D plus a CONTINUATION
// (normally exactly D+1), and values the SoC the real day handed over at what an optimal D+1
// would pay for it. That continuation length is a judgement call nobody had tested. If a third
// day changes day-D regret materially, then every regret number in `oracle_daily` is partly an
// artifact of where the window happens to stop, and the whole check #8 series would need
// re-reading. On the reference deployment this was measured over 20 late-summer days: day-D
// regret moved at most 0.026 kr (median 0.000), including on days where D+2's peak buy price
// was up to 2.41x D+1's, so the window holds. Re-run it on your own site and season before
// relying on that — a market with sustained multi-day price structure is exactly where a
// one-day continuation could start to matter.
//
// What it does: for each day, score it twice through the repo's own `computeOracleDay` —
// once with a 1-day continuation (exactly what the live route does) and once with 2 days —
// and report the movement. Nothing is reimplemented: same function, same constants, same
// telemetry readers, only `priceSlotsCont` and the readings window differ.
//
// Why the two runs should agree, and what it means if they don't: regret is
// `oracleTotal − (achievedDayValue + continuationValue)`, and BOTH sides play the continuation
// optimally from their own midnight SoC. Extending the horizon adds roughly the same value to
// each, so the difference should cancel to near zero. It cancels EXACTLY only if the extra day
// values a marginal kWh of carried SoC the same way the first one did — so a day where D+2 is
// much dearer than D+1 (or where D+1 alone cannot absorb the carried energy) is exactly where
// the window would show its seams. Those are the days to look at in the per-day table, not the
// mean.
//
// It prints three blocks:
//
//   1. FIDELITY — do the local 48 h re-scores reproduce the STORED oracle_daily rows? Everything
//      below is meaningless if they don't, so it comes first. A mismatch means the local rebuild
//      or the current constants differ from what the deployment scored with, NOT that the stored
//      rows are wrong. Tolerance is a few öre: re-scoring is deterministic, but a rebuilt DB can
//      hold a slightly different readings set at the window edges.
//   2. PER-DAY — regret, intraday and carry under both windows, plus where the oracle chose to
//      leave the battery at midnight. Sorted by |Δregret| so the worst case is the first row.
//   3. VERDICT — the max and median |Δregret| against a "a few öre" bar,
//      preceded by whether this sample could have failed at all. "Nothing moved" is only
//      evidence if the sample contained days where the third day was worth reaching for: if
//      every D+2 is priced like its D+1, agreement is arithmetic rather than a finding. The
//      POWER line counts days where D+2's peak buy price clears D+1's by a margin, which is
//      the shape that would pull carried energy across the old window's edge.
//
// Usage — point it at a copy of telemetry.db (a local copy of the deployment's, or the live
// file if you can read it):
//   TELEMETRY_DB_PATH=/path/to/telemetry.db npx tsx scripts/tools/oracle-continuation-sensitivity.ts \
//     --from YYYY-MM-DD --to YYYY-MM-DD [--json]
//
// Day D needs D+2 to have fully elapsed, so --to must be at least three days back. Days whose
// price curves or readings don't cover the longer window are reported and skipped, never
// silently scored short — a 72 h run quietly missing its third day would answer the question
// with a 48 h number and look like agreement.

import { stockholmMidnightUtc } from '../../lib/prices';
import type { PriceSlot } from '../../lib/prices';
import { computeDailyEconomics } from '../../lib/economics';
import {
  buildPriceLookup,
  readReadings,
  readOracleReadings,
  readArmedEvents,
  readPriceSnapshot,
} from '../../lib/telemetry';
import { computeOracleDay, ARMED_SEGMENT_CAP_MS } from '../../lib/oracle';
import type { OracleDayRow } from '../../lib/oracle';
import { readOrFallback } from '../../lib/telemetry/core';

const SLOT_MS = 900_000;
/** Fidelity bar: the local 48 h re-score must land within this of the stored row. */
const FIDELITY_TOL_ORE = 5;
/** The bar for this check: "day-D regret moves < a few öre". */
const VERDICT_BAR_ORE = 10;

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function midnightMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return stockholmMidnightUtc(y, m - 1, d).getTime();
}

/** That day's own slots out of a snapshot (which may also hold the next day's). */
function slotsForDay(prices: PriceSlot[] | undefined, dateStr: string): PriceSlot[] {
  return (prices ?? []).filter((p) => p.startTime.startsWith(dateStr));
}

/** A day's price curve from whichever snapshot holds it: its own, the day before's
 *  tomorrow-half, or (for a day two ahead) neither. Mirrors the route's fallback chain. */
function priceSlotsFor(date: string): PriceSlot[] {
  const own = slotsForDay(readPriceSnapshot(date)?.prices, date);
  if (own.length) return own;
  return slotsForDay(readPriceSnapshot(addDays(date, -1))?.prices, date);
}

function expectedSlots(date: string): number {
  return (midnightMs(addDays(date, 1)) - midnightMs(date)) / SLOT_MS;
}

interface Scored {
  row: OracleDayRow;
  contDays: number;
}

/** Score day D with `contDays` days of continuation. Throws with a reason if the inputs for
 *  that window are incomplete — a short window must never be scored as if it were whole. */
function score(date: string, contDays: number): Scored {
  const dayStartMs = midnightMs(date);
  const contEndMs = midnightMs(addDays(date, 1 + contDays));

  const slotsD = priceSlotsFor(date);
  if (slotsD.length !== expectedSlots(date)) {
    throw new Error(`day ${date}: ${slotsD.length}/${expectedSlots(date)} price slots`);
  }

  const slotsCont: PriceSlot[] = [];
  for (let k = 1; k <= contDays; k++) {
    const d = addDays(date, k);
    const s = priceSlotsFor(d);
    if (s.length !== expectedSlots(d)) {
      throw new Error(`continuation ${d}: ${s.length}/${expectedSlots(d)} price slots`);
    }
    slotsCont.push(...s);
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const readings = readOracleReadings(iso(dayStartMs), iso(contEndMs));
  // Guard the readings window explicitly. bucketActuals would happily zero-fill a missing
  // third day, which is the silent way to get a 48 h answer out of a 72 h run.
  const last = readings.length ? Date.parse(readings[readings.length - 1].timestamp) : 0;
  const shortfallMin = (contEndMs - last) / 60_000;
  if (!readings.length || shortfallMin > 30) {
    throw new Error(
      `readings stop ${Math.round(shortfallMin)} min before the ${24 * (1 + contDays)} h window ends`,
    );
  }

  const armedEvents = readArmedEvents(
    iso(dayStartMs - ARMED_SEGMENT_CAP_MS),
    iso(midnightMs(addDays(date, 1))),
  );
  const econ = computeDailyEconomics(
    readReadings(iso(dayStartMs), iso(midnightMs(addDays(date, 1)))),
    buildPriceLookup(),
  ).get(date);

  return {
    contDays,
    row: computeOracleDay({
      date,
      dayStartMs,
      priceSlotsD: slotsD,
      priceSlotsCont: slotsCont,
      readings,
      armedEvents,
      achievedCashOre: econ ? econ.netKr * 100 : null,
    }),
  };
}

const kr = (ore: number | null | undefined) =>
  ore === null || ore === undefined ? '     —' : (ore / 100).toFixed(2).padStart(6);

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = opt('--from');
  const to = opt('--to');
  if (!from || !to) {
    console.error('usage: --from YYYY-MM-DD --to YYYY-MM-DD [--json]   (TELEMETRY_DB_PATH must be set)');
    process.exit(2);
  }
  if (!process.env.TELEMETRY_DB_PATH) {
    console.error('TELEMETRY_DB_PATH is unset — nothing to read.');
    process.exit(2);
  }

  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

  interface Result {
    date: string;
    r48: OracleDayRow;
    r72: OracleDayRow;
    /** Peak buy price of D+1 and D+2 (öre/kWh) — the sample's own ability to detect a problem. */
    peakD1: number;
    peakD2: number;
  }
  const peakBuy = (date: string) => {
    const slots = priceSlotsFor(date);
    return slots.length
      ? Math.max(...slots.map((p) => p.priceIncludingTaxAndSurcharge))
      : NaN;
  };
  const results: Result[] = [];
  const skipped: { date: string; why: string }[] = [];

  for (const date of days) {
    try {
      const a = score(date, 1);
      const b = score(date, 2);
      if (a.row.status !== 'ok' || b.row.status !== 'ok') {
        skipped.push({ date, why: `status ${a.row.status}/${b.row.status}` });
        continue;
      }
      results.push({
        date,
        r48: a.row,
        r72: b.row,
        peakD1: peakBuy(addDays(date, 1)),
        peakD2: peakBuy(addDays(date, 2)),
      });
    } catch (err) {
      skipped.push({ date, why: err instanceof Error ? err.message : String(err) });
    }
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ results, skipped }, null, 2));
    return;
  }

  // ── 1. FIDELITY ────────────────────────────────────────────────────────────────────────────
  console.log('\n=== FIDELITY: local 48 h re-score vs the stored oracle_daily rows ===');
  console.log('(a mismatch means this rebuild or these constants differ from the deployment —');
  console.log(' read nothing below until this block is clean)\n');
  // Straight out of oracle_daily in whatever DB this is pointed at — the deployment's own
  // scored rows if the local copy was rebuilt with that table, and simply absent otherwise.
  const stored = readOrFallback(new Map<string, number>(), (handle) => {
    const rows = handle
      .prepare("SELECT date, regret_ore FROM oracle_daily WHERE status = 'ok'")
      .all() as unknown as { date: string; regret_ore: number | null }[];
    return new Map(rows.filter((r) => r.regret_ore !== null).map((r) => [r.date, r.regret_ore!]));
  });
  if (!stored.size) {
    console.log('  no oracle_daily rows in this DB — fidelity cannot be checked, and every');
    console.log('  number below is therefore unverified against the live scoring.');
  } else {
    let worst = 0;
    for (const { date, r48 } of results) {
      const s = stored.get(date);
      if (s === undefined || r48.regretOre === null) continue;
      const d = Math.abs(r48.regretOre - s);
      worst = Math.max(worst, d);
      const flag = d > FIDELITY_TOL_ORE ? '  <-- MISMATCH' : '';
      console.log(`  ${date}  stored ${kr(s)} kr   local ${kr(r48.regretOre)} kr   Δ ${(d / 100).toFixed(3)}${flag}`);
    }
    console.log(`  worst |Δ| = ${(worst / 100).toFixed(3)} kr (tolerance ${FIDELITY_TOL_ORE / 100} kr)`);
  }

  // ── 2. PER-DAY ─────────────────────────────────────────────────────────────────────────────
  const rows = results
    .map(({ date, r48, r72, peakD1, peakD2 }) => ({
      date,
      peakD1,
      peakD2,
      /** >1 means the third day was the dearer one — the case where the 48 h window,
       *  which cannot see it, would have to mis-value carried energy if it were going to. */
      peakRatio: peakD2 / peakD1,
      regret48: r48.regretOre ?? NaN,
      regret72: r72.regretOre ?? NaN,
      dRegret: (r72.regretOre ?? NaN) - (r48.regretOre ?? NaN),
      dCarry: (r72.regretCarryOre ?? NaN) - (r48.regretCarryOre ?? NaN),
      dIntraday: (r72.regretIntradayOre ?? NaN) - (r48.regretIntradayOre ?? NaN),
      endSoc48: r48.oracleEndSocKwh,
      endSoc72: r72.oracleEndSocKwh,
      achievedEndSoc: r48.achievedEndSocKwh,
    }))
    .sort((a, b) => Math.abs(b.dRegret) - Math.abs(a.dRegret));

  console.log('\n=== PER-DAY: 48 h vs 72 h continuation (kr), worst movement first ===');
  console.log('                regret            Δ by component        oracle midnight SoC (kWh)');
  console.log('date         48h     72h      Δregret  Δcarry Δintra    48h    72h   achieved');
  for (const r of rows) {
    console.log(
      `${r.date} ${kr(r.regret48)} ${kr(r.regret72)}   ` +
        `${kr(r.dRegret)} ${kr(r.dCarry)} ${kr(r.dIntraday)}   ` +
        `${(r.endSoc48 ?? NaN).toFixed(1).padStart(5)} ${(r.endSoc72 ?? NaN).toFixed(1).padStart(6)} ` +
        `${(r.achievedEndSoc ?? NaN).toFixed(1).padStart(9)}`,
    );
  }
  for (const s of skipped) console.log(`${s.date} SKIPPED — ${s.why}`);

  // ── 3. VERDICT ─────────────────────────────────────────────────────────────────────────────
  const deltas = rows.map((r) => Math.abs(r.dRegret)).filter((x) => !Number.isNaN(x));
  const socMoves = rows.filter(
    (r) => r.endSoc48 !== null && r.endSoc72 !== null && Math.abs(r.endSoc72 - r.endSoc48) > 0.5,
  );
  console.log('\n=== VERDICT ===');
  console.log(`days scored under both windows: ${rows.length}   (skipped ${skipped.length})`);

  // Could this sample have failed? A third day only matters if it is worth carrying into.
  const dearer = rows.filter((r) => r.peakRatio > 1.2);
  const muchDearer = rows.filter((r) => r.peakRatio > 1.5);
  console.log(
    `POWER: D+2 peak buy vs D+1 peak — median ratio ${median(rows.map((r) => r.peakRatio)).toFixed(2)}, ` +
      `max ${Math.max(...rows.map((r) => r.peakRatio)).toFixed(2)}; ` +
      `${dearer.length}/${rows.length} days had D+2 dearer by >20% ` +
      `(${muchDearer.length} by >50%)`,
  );
  if (!dearer.length) {
    console.log('  ⚠ every D+2 was priced like its D+1, so agreement below is arithmetic, not');
    console.log('    evidence. Re-run over a window with real day-to-day price variation.');
  } else {
    const worstDear = [...dearer].sort((a, b) => Math.abs(b.dRegret) - Math.abs(a.dRegret))[0];
    console.log(
      `  worst |Δregret| among those days: ${(Math.abs(worstDear.dRegret) / 100).toFixed(3)} kr ` +
        `on ${worstDear.date} (D+2 peak ${worstDear.peakRatio.toFixed(2)}× D+1)`,
    );
  }
  if (deltas.length) {
    console.log(`|Δregret|: max ${(Math.max(...deltas) / 100).toFixed(3)} kr, ` +
      `median ${(median(deltas) / 100).toFixed(3)} kr, ` +
      `mean ${(deltas.reduce((a, b) => a + b, 0) / deltas.length / 100).toFixed(3)} kr`);
    console.log(`days over the ${VERDICT_BAR_ORE / 100} kr bar: ` +
      `${deltas.filter((d) => d > VERDICT_BAR_ORE).length}/${deltas.length}`);
    console.log(`days where the oracle's own midnight SoC moved > 0.5 kWh: ${socMoves.length}` +
      (socMoves.length ? ` (${socMoves.map((s) => s.date).join(', ')})` : ''));
    console.log(
      Math.max(...deltas) <= VERDICT_BAR_ORE
        ? '\n48 h window VALIDATED on this sample: a third day does not move day-D regret.'
        : '\n48 h window NOT validated on this sample — inspect the days above the bar before' +
            '\nquoting any regret number from oracle_daily as window-independent.',
    );
  }
}

main();
