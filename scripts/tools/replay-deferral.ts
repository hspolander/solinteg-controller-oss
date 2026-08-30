// Deferral-guard DIAGNOSIS — the "why" layer under the risk-aware planning knobs, in the same
// spirit as oracle-diagnose.py is for check #8.
//
// Why this exists: `optimizeDispatch` runs the DP twice whenever deferral is on (with and
// without the earliness bias), prices both trajectories at TRUE prices, and keeps the deferred
// one only if it gives up at most MAX_DEFERRAL_SACRIFICE_ORE. **Nothing logs that decision.**
// `optimizer_runs` stores the winning plan and no trace of which pass produced it or what the
// runner-up cost — so "is the deferral bias actually in force right now?" was unanswerable from
// telemetry, and the "is a deferred buy ratcheting later every replan?" question had to be
// eyeballed from planned slot
// times. This script recovers the whole decision by replaying each logged run through the repo's
// own optimizer (imported, never reimplemented) and reporting what the guard did.
//
// It reports four things:
//
//   1. FIDELITY — does the replay reproduce the stored plans? Everything below is worthless if
//      it doesn't, so it is printed first and never suppressed. Compare socAfter at 3 decimals:
//      lib/telemetry/dispatch.ts's roundForLog rounds BOTH inputs_json and dispatch_json on the
//      way into the DB, so an exact-equality check reports ~0% and means nothing. Rounded inputs
//      also flip genuinely-tied DP states by one SoC level (~0.123 kWh), which is why the action
//      sequence is reported separately — that is the number that must be ~100%.
//   2. GUARD — how often the all-or-nothing cap rejects the deferred plan, split by horizon
//      length and has_tomorrow. The sacrifice is a whole-plan total in öre while deferOre[i] is
//      anchored to the horizon END (lib/optimizer.ts), so it scales with horizon × volume: the
//      flat cap therefore behaves as a horizon-length threshold, and the split is what makes
//      that visible instead of surprising. Also normalised per kWh bought, because that is the
//      form in which the cap's cost is comparable to the margin a buy banks.
//   3. WALK — the ratchet question. Two views: how much later the KEPT plan's first grid buy
//      sits than the same replan's undeferred optimum (the bias's own contribution, the only
//      part attributable to deferral), and how the first buy moves across successive replans
//      (the total walk, most of which is ordinary re-optimisation against fresher solar/SoC).
//      Conflating the two is what makes a ratchet look real when it isn't.
//   4. FRAGMENTATION — mode-transition counts per plan. PLANNED
//      transitions only: the DP has no mode-transition cost, but only the current slot is ever
//      executed and plans recompute every ~10 min, so planned scatter is an upper bound on
//      execution churn and NOT a substitute for it. Measure the churn that actually costs
//      Modbus writes from control_actions, with a LAG(planned_action) query over the applied
//      rows — planned scatter and executed churn have come out very differently in practice.
//
// Method / caveats (read before acting on a number):
// - The replay uses the CURRENT repo's constants and optimizer. Against a window whose live
//   deploy ran different code or env overrides, fidelity is what tells you — a low action-match
//   rate means "the deployed code differs", not "the plans were wrong".
// - Sacrifice is measured at the replan's own state and prices. Sacrifices from successive
//   replans of the SAME decision do NOT add up: each is re-measured against a fresh undeferred
//   baseline, and mostly re-prices the same future. Sum them and you will invent a ratchet.
// - A slightly NEGATIVE sacrifice is expected and not a bug: both passes carry the solar risk
//   premium, so the "undeferred" trajectory is not the true-price optimum either.
// - Slot startTime is Stockholm wall-clock, logged_at is UTC. This script never joins the two;
//   if you extend it to readings, convert properly (lib/prices.ts stockholmWallClockToUtc).
//   Applying "today's offset" to a future wall-clock time is wrong twice a year.
//
// Usage — dump the runs from the controller host (passwordless, read-only) and replay locally:
//   ssh <controller-host> "sudo solinteg-telemetry-ro sql \"SELECT id || '~|~' || logged_at || '~|~' || \
//     start_soc_kwh || '~|~' || has_tomorrow || '~|~' || inputs_json || '~|~' || dispatch_json \
//     FROM optimizer_runs WHERE logged_at >= '2026-08-29' ORDER BY id\" | tail -n +3 | gzip -9" \
//     > runs.gz
//   npx tsx scripts/tools/replay-deferral.ts runs.gz [--verbose]
//
// The '~|~' delimiter is deliberate: the wrapper's sqlite3 runs in -column mode, so a
// non-printable separator (char(31)) renders as a line break and splits every row across lines.
// `tail -n +3` drops the -header/-column banner. Plain (ungzipped) dumps are accepted too.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { optimizeDispatch, evaluateDispatch } from '../../lib/optimizer';
import type { OptimizerSlot, DispatchSlot } from '../../lib/optimizer';
import {
  LOAD_FORECAST_MARGIN,
  DEFERRAL_RATE_ORE_PER_KWH_HOUR,
  SOLAR_RISK_PREMIUM_ORE_PER_KWH,
  MAX_DEFERRAL_SACRIFICE_ORE,
} from '../../lib/constants';

// Baselines from the reference deployment's first review with real grid charging to look at
// (2026-08-30). Printed beside every run so a new number is read as a change, not in isolation.
// These are one installation's numbers under one price shape — replace them with your own once
// you have a couple of buying weeks, and update them when a later review supersedes them. A
// stale baseline is worse than none, because it invites a false comparison.
const BASELINE = {
  window: '2026-08-29..30 (buying days, 258 replans) / 2026-08-23..28 (solar-only, 856 replans)',
  fidelity:
    'buying days 258/258 action-exact (219 also SoC-exact); solar-only window 847/856 action-exact, ' +
    'the 9 others one-slot idle/discharge ties within a DP level',
  firedBuying: '89/258 overall — 0% when has_tomorrow=0, 72% when has_tomorrow=1',
  firedSolar: '56/856 overall (15% of long-horizon replans, median planned buy 0.2 kWh)',
  sacrificeByHorizon: '17.0 öre (40-60 slots) / 26.6 (60-80) / 64.5 (80+)',
  perKwh: 'median 1.99 öre/kWh on the buying days, p90 6.12 (3.70 median on the solar-only window)',
  walk: 'bias moved the first buy later on 61/258 replans, median 30 min; no cumulative ratchet found',
  fragmentation: 'median 13 transitions (max 26) on plans buying >5 kWh, vs 4 on the 08-06 summer plan',
};

type Run = {
  id: number;
  loggedAt: string;
  startSoc: number;
  hasTomorrow: number;
  slots: OptimizerSlot[];
  stored: DispatchSlot[];
};

function loadRuns(path: string): Run[] {
  const raw = readFileSync(path);
  // gzip magic — accept either form so the dump can be inspected by hand without re-pulling.
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  const runs: Run[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [id, loggedAt, startSoc, hasTomorrow, inputs, dispatch] = t.split('~|~');
    if (!dispatch) throw new Error(`malformed dump line (expected 6 '~|~' fields): ${t.slice(0, 120)}`);
    runs.push({
      id: Number(id),
      loggedAt,
      startSoc: Number(startSoc),
      hasTomorrow: Number(hasTomorrow),
      slots: JSON.parse(inputs),
      stored: JSON.parse(dispatch),
    });
  }
  return runs.sort((a, b) => a.id - b.id);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
// One step of the DP's SoC discretisation — (BATTERY_KWH − floor) / (SOC_LEVELS − 1). Kept as a
// literal rather than imported because SOC_LEVELS is private to lib/optimizer.ts; it is only used
// to classify mismatches as tie-noise, never in any reported number.
const SOC_LEVEL_KWH = 0.123;
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '—');
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

type Analysed = {
  run: Run;
  actionsMatch: boolean;
  socMatch: boolean;
  maxDsoc: number;
  sacrificeOre: number;
  diffSlots: number;
  maxDsocOnDiff: number;
  keptDeferred: boolean;
  buyKwh: number;
  firstBuyKept: { time: string; price: number } | null;
  firstBuyUndeferred: { time: string; price: number } | null;
  transitions: number;
};

// A "grid buy" means a slot the dispatcher would actually execute as a charge. Both conditions
// matter: the DP leaves sub-threshold gridToBatteryKwh dribble (a few Wh of grid-covered load
// rounding) in slots it classifies as idle, and matching on that alone reports the CURRENT slot
// as the first buy on every replan — which reads as a buy walking forward with the clock while
// the dispatcher is in fact idling through it (seen on 2026-08-29 before this threshold existed).
const MIN_REAL_BUY_KWH = 0.05;
function firstGridBuy(slots: OptimizerSlot[], plan: DispatchSlot[]) {
  const i = plan.findIndex((s) => s.action === 'charge' && (s.gridToBatteryKwh ?? 0) >= MIN_REAL_BUY_KWH);
  return i < 0 ? null : { time: slots[i].startTime, price: slots[i].buyPrice };
}

function analyse(run: Run): Analysed {
  const opts = {
    loadFactor: LOAD_FORECAST_MARGIN,
    deferralRateOrePerKwhHour: DEFERRAL_RATE_ORE_PER_KWH_HOUR,
    solarRiskPremiumOre: SOLAR_RISK_PREMIUM_ORE_PER_KWH,
  };
  const kept = optimizeDispatch(run.slots, run.startSoc, opts);
  // The two candidates the guard chooses between. maxDeferralSacrificeOre=Infinity forces the
  // biased trajectory through so it can be priced even when the live guard rejected it.
  const undeferred = optimizeDispatch(run.slots, run.startSoc, { ...opts, deferralRateOrePerKwhHour: 0 });
  const deferred = optimizeDispatch(run.slots, run.startSoc, {
    ...opts,
    maxDeferralSacrificeOre: Number.POSITIVE_INFINITY,
  });
  const sacrificeOre =
    evaluateDispatch(run.slots, undeferred, run.startSoc).valueOre -
    evaluateDispatch(run.slots, deferred, run.startSoc).valueOre;

  const lenOk = kept.length === run.stored.length;
  const actionsMatch = lenOk && kept.every((s, i) => s.action === run.stored[i].action);
  const socMatch =
    lenOk && kept.every((s, i) => Math.abs(round3(s.socAfter) - run.stored[i].socAfter) < 5e-4);
  const maxDsoc = lenOk
    ? Math.max(...kept.map((s, i) => Math.abs(s.socAfter - run.stored[i].socAfter)))
    : NaN;
  const diffIdx = lenOk ? kept.map((s, i) => i).filter((i) => kept[i].action !== run.stored[i].action) : [];
  const maxDsocOnDiff = diffIdx.length
    ? Math.max(...diffIdx.map((i) => Math.abs(kept[i].socAfter - run.stored[i].socAfter)))
    : 0;

  let transitions = 0;
  for (let i = 1; i < run.stored.length; i++) {
    if (run.stored[i].action !== run.stored[i - 1].action) transitions++;
  }

  return {
    run,
    actionsMatch,
    socMatch,
    maxDsoc,
    diffSlots: diffIdx.length,
    maxDsocOnDiff,
    sacrificeOre,
    keptDeferred: sacrificeOre <= MAX_DEFERRAL_SACRIFICE_ORE,
    buyKwh: undeferred.reduce((a, s) => a + (s.action === 'charge' ? (s.gridToBatteryKwh ?? 0) : 0), 0),
    firstBuyKept: firstGridBuy(run.slots, kept),
    firstBuyUndeferred: firstGridBuy(run.slots, undeferred),
    transitions,
  };
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: npx tsx scripts/tools/replay-deferral.ts <runs-dump[.gz]> [--verbose]');
    console.error('(see the header comment for the solinteg-telemetry-ro dump command)');
    process.exit(2);
  }

  const runs = loadRuns(path);
  const rows = runs.map(analyse);
  console.log(
    `replayed ${rows.length} optimizer runs from ${runs[0]?.loggedAt.slice(0, 16)} to ` +
      `${runs[runs.length - 1]?.loggedAt.slice(0, 16)} (UTC)`,
  );
  console.log(
    `constants in force here: margin ${LOAD_FORECAST_MARGIN}, deferral ${DEFERRAL_RATE_ORE_PER_KWH_HOUR} ` +
      `öre/kWh/h, solar risk ${SOLAR_RISK_PREMIUM_ORE_PER_KWH} öre/kWh, cap ${MAX_DEFERRAL_SACRIFICE_ORE} öre`,
  );

  // ---- 1. FIDELITY ------------------------------------------------------------------------
  const bothMatch = rows.filter((r) => r.actionsMatch && r.socMatch).length;
  const actionsOnly = rows.filter((r) => r.actionsMatch && !r.socMatch);
  console.log('\n=== 1. FIDELITY (everything below depends on this) ===');
  console.log(`  action sequence reproduced: ${rows.filter((r) => r.actionsMatch).length}/${rows.length}`);
  console.log(`  action + socAfter (3 dp):   ${bothMatch}/${rows.length}`);
  if (actionsOnly.length) {
    const d = actionsOnly.map((r) => r.maxDsoc).sort((a, b) => a - b);
    console.log(
      `  ${actionsOnly.length} runs match on actions but differ on SoC by up to ` +
        `${quantile(d, 0.999).toFixed(3)} kWh (one DP level ≈ 0.123 kWh = rounded-input ties)`,
    );
  }
  // An action mismatch is only alarming if it is STRUCTURAL. A rounded-input tie that lands on
  // an action boundary (idle vs discharge over one DP level, ~0.123 kWh, in some far-future
  // slot) is the same harmless artifact as the SoC-only mismatches above — it just shows up in
  // the action column. Real code/env drift moves many slots, or moves them by more than a level.
  const broken = rows.filter((r) => !r.actionsMatch);
  const structural = broken.filter((r) => r.diffSlots > 2 || r.maxDsocOnDiff > 2 * SOC_LEVEL_KWH);
  const tieNoise = broken.length - structural.length;
  if (tieNoise) {
    console.log(
      `  ${tieNoise} runs differ in ONE-OFF actions, each within a DP level — same rounded-input ` +
        'tie as above, landing on an action boundary. Not drift.',
    );
  }
  if (structural.length) {
    console.log(
      `  !! ${structural.length} runs differ STRUCTURALLY in actions (ids ` +
        `${structural.slice(0, 8).map((r) => r.run.id).join(',')}${structural.length > 8 ? ', …' : ''}) — ` +
        'the deployed code or env differs from this checkout;',
    );
    console.log('     treat the sections below as describing THIS checkout, not what ran live.');
  }
  console.log(`  baseline: ${BASELINE.fidelity}`);

  // ---- 2. GUARD ---------------------------------------------------------------------------
  console.log('\n=== 2. GUARD — how often the all-or-nothing cap rejects the deferred plan ===');
  const fired = rows.filter((r) => !r.keptDeferred);
  console.log(`  cap fired (undeferred plan kept): ${fired.length}/${rows.length} (${pct(fired.length, rows.length)})`);
  for (const ht of [0, 1]) {
    const g = rows.filter((r) => r.run.hasTomorrow === ht);
    if (!g.length) continue;
    const s = g.map((r) => r.sacrificeOre).sort((a, b) => a - b);
    console.log(
      `    has_tomorrow=${ht}: ${g.length} runs, fired ${g.filter((r) => !r.keptDeferred).length} ` +
        `(${pct(g.filter((r) => !r.keptDeferred).length, g.length)}), median sacrifice ${quantile(s, 0.5).toFixed(1)} öre`,
    );
  }
  console.log('  by horizon length (the cap is flat per plan, so this is where it bites):');
  for (const [lo, hi] of [
    [0, 40],
    [40, 60],
    [60, 80],
    [80, Number.MAX_SAFE_INTEGER],
  ] as [number, number][]) {
    const g = rows.filter((r) => r.run.slots.length >= lo && r.run.slots.length < hi);
    if (!g.length) continue;
    const s = g.map((r) => r.sacrificeOre).sort((a, b) => a - b);
    const label = hi === Number.MAX_SAFE_INTEGER ? `${lo}+` : `${lo}-${hi}`;
    console.log(
      `    ${label.padEnd(7)} slots: n=${String(g.length).padStart(4)}  median ${quantile(s, 0.5).toFixed(1).padStart(6)} öre  ` +
        `p90 ${quantile(s, 0.9).toFixed(1).padStart(6)}  max ${s[s.length - 1].toFixed(1).padStart(7)}  ` +
        `fired ${g.filter((r) => !r.keptDeferred).length}`,
    );
  }
  const perKwh = rows.filter((r) => r.buyKwh > 1).map((r) => r.sacrificeOre / r.buyKwh).sort((a, b) => a - b);
  if (perKwh.length) {
    console.log(
      `  sacrifice per kWh bought: median ${quantile(perKwh, 0.5).toFixed(2)} öre/kWh, ` +
        `p90 ${quantile(perKwh, 0.9).toFixed(2)}, max ${perKwh[perKwh.length - 1].toFixed(2)} ` +
        `(compare against the margin a buy banks, not against the cap)`,
    );
  }
  console.log(`  baseline: fired ${BASELINE.firedBuying}; solar-only window ${BASELINE.firedSolar}`);
  console.log(`            sacrifice by horizon ${BASELINE.sacrificeByHorizon}; per kWh ${BASELINE.perKwh}`);

  // ---- 3. WALK ----------------------------------------------------------------------------
  console.log('\n=== 3. WALK — is the deferral bias ratcheting a buy later? ===');
  const withBoth = rows.filter((r) => r.firstBuyKept && r.firstBuyUndeferred);
  const deltas = withBoth
    .map((r) => (Date.parse(r.firstBuyKept!.time + 'Z') - Date.parse(r.firstBuyUndeferred!.time + 'Z')) / 60000)
    .sort((a, b) => a - b);
  const moved = deltas.filter((d) => d > 0);
  console.log(
    `  replans where the bias moved the first grid buy later: ${moved.length}/${withBoth.length}` +
      (moved.length ? `, by median ${quantile(moved, 0.5)} min, max ${moved[moved.length - 1]} min` : ''),
  );
  console.log('  first grid buy across successive replans (total walk — mostly re-optimisation):');
  let prev: string | null = null;
  for (const r of rows) {
    const t = r.firstBuyKept?.time ?? null;
    if (t === prev && !verbose) continue;
    prev = t;
    console.log(
      `    ${r.run.loggedAt.slice(5, 16)}Z  soc ${r.run.startSoc.toFixed(1).padStart(5)}  ` +
        `first buy ${t ? `${t.slice(5, 16)} @ ${r.firstBuyKept!.price.toFixed(0)} öre` : '—'}` +
        `  ${r.keptDeferred ? 'deferred' : 'CAP FIRED'}  sacrifice ${r.sacrificeOre.toFixed(1)} öre`,
    );
  }
  console.log(`  baseline: ${BASELINE.walk}`);

  // ---- 4. FRAGMENTATION -------------------------------------------------------------------
  console.log('\n=== 4. FRAGMENTATION — planned mode transitions (an upper bound on churn) ===');
  const buying = rows.filter((r) => r.buyKwh > 5);
  const t = buying.map((r) => r.transitions).sort((a, b) => a - b);
  if (t.length) {
    console.log(
      `  plans buying >5 kWh: ${buying.length}/${rows.length}, transitions median ${quantile(t, 0.5)}, ` +
        `p90 ${quantile(t, 0.9)}, max ${t[t.length - 1]}`,
    );
  } else {
    console.log('  no plan in this window buys >5 kWh — fragmentation is not measurable here.');
  }
  console.log('  executed churn is NOT this number — get it from control_actions (LAG over applied rows).');
  console.log(`  baseline: ${BASELINE.fragmentation}`);
  console.log(`\nbaseline window: ${BASELINE.window}`);
}

main();
