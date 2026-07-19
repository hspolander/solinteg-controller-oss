import {
  BATTERY_KWH,
  BATTERY_MAX_KW,
  BATTERY_RT_EFF,
  BATTERY_MIN_SOC_KWH,
  BATTERY_WEAR_COST_ORE_PER_KWH,
  GRID_KW,
  MAX_DEFERRAL_SACRIFICE_ORE,
} from './constants';

export { BATTERY_KWH, BATTERY_MAX_KW, GRID_KW, BATTERY_MIN_SOC_KWH }; // re-export for tests and external callers

const SLOT_MAX_KW = Math.min(GRID_KW, BATTERY_MAX_KW); // 11 kW — grid is binding
const SLOT_MAX_KWH = SLOT_MAX_KW / 4; // 2.75 kWh per 15-min slot
const ONE_WAY_EFF = Math.sqrt(BATTERY_RT_EFF); // ≈0.9798 — applied on charge and on discharge
const MIN_SOC_KWH = BATTERY_MIN_SOC_KWH;

const SOC_LEVELS = 193; // SoC discretisation for the DP (≈0.12 kWh resolution over the usable range)

export type Action = 'charge' | 'discharge' | 'idle';

export interface OptimizerSlot {
  startTime: string;
  buyPrice: number; // öre/kWh — priceIncludingTaxAndSurcharge + 71 öre skatt/överföring
  sellPrice: number; // öre/kWh — price received per exported kWh: spot + EXPORT_BONUS_ORE (nätnytta), see DOMAIN.md
  solarKwh: number; // expected solar production for this 15-min slot
  consumptionKwh?: number; // expected household load for this 15-min slot (optional; defaults to 0)
  // Provenance tags, informational only — the DP never reads these, they exist purely so
  // logged telemetry (optimizer_runs.inputs_json) can tell a real forecast miss apart from a
  // climatology-fallback slot when validating solarKwh/consumptionKwh against actual readings
  // later. 'typical'/'baseline' means the live forecast wasn't available for that slot, so a
  // large error there reflects climatology, not Open-Meteo's forecast skill.
  // 'live' (added 2026-07-18) means consumptionKwh came from the trailing per-hour profile
  // measured from the house's own readings (lib/load.ts slotConsumptionFromLive) — the best
  // available estimator, so errors there are genuine household unpredictability.
  solarSource?: 'forecast' | 'typical';
  loadSource?: 'modeled' | 'baseline' | 'live';
}

export interface DispatchSlot {
  startTime: string;
  action: Action;
  gridKwh: number; // net grid exchange: +ve = import (load + battery charge), -ve = export
  solarExportKwh: number; // solar surplus exported to grid this slot
  // Grid-flow attribution: which part of the slot's grid exchange the BATTERY is responsible
  // for, vs the house. Net gridKwh alone can't distinguish "buying for the battery" from "load
  // import during a solar-funded charge", and the chart's decision zones
  // (lib/chart-utils.ts classifyBand) need exactly that distinction. Like gridKwh and socAfter
  // these describe the margined plan (see opts.loadFactor below).
  batteryToGridKwh: number; // battery energy exported to grid — a deliberate sell
  gridToBatteryKwh: number; // grid energy charged into the battery — a deliberate buy
  batteryToLoadKwh: number; // battery energy covering house load — default self-use behaviour
  loadFromGridKwh: number; // house load left for the grid to cover
  socAfter: number; // battery SoC in kWh after slot completes
}

interface Flows {
  gridImport: number;
  gridExport: number;
  solarExport: number; // solar (not battery) exported to grid — for the chart
  batteryToGrid: number; // battery-attributed share of gridExport
  gridToBattery: number; // battery-attributed share of gridImport
  batteryToLoad: number; // battery energy delivered to house load
  loadFromGrid: number; // load-attributed share of gridImport
  feasible: boolean;
}

/**
 * Physical grid flows + feasibility for moving SoC from `soc` to `socNext` across one slot.
 * Solar serves the house first (free); then the battery charges/discharges; the grid makes up the
 * balance. Excess solar that neither fits the battery nor the export cap is curtailed. The battery
 * may discharge to cover load AND export surplus to the grid (up to the grid cap).
 */
function computeFlows(soc: number, socNext: number, solarRem: number, loadRem: number): Flows {
  const dE = socNext - soc;
  let gridImport: number;
  let gridExport: number;
  let solarExport: number;
  let batteryToGrid: number;
  let gridToBattery: number;
  let batteryToLoad: number;
  let loadFromGrid: number;

  if (dE >= 0) {
    // charge (or idle): store dE, needs dE / η at the battery input
    const need = dE / ONE_WAY_EFF;
    const fromSolar = Math.min(solarRem, need);
    gridToBattery = need - fromSolar;
    loadFromGrid = loadRem;
    batteryToGrid = 0;
    batteryToLoad = 0;
    gridImport = gridToBattery + loadRem;
    solarExport = solarRem - fromSolar;
    gridExport = solarExport;
    if (gridExport > SLOT_MAX_KWH) {
      // curtail solar we can neither store nor export within the grid cap
      solarExport = SLOT_MAX_KWH;
      gridExport = SLOT_MAX_KWH;
    }
  } else {
    // discharge: deliver (−dE)·η out of the battery — to load first, then export
    const out = -dE * ONE_WAY_EFF;
    const toLoad = Math.min(out, loadRem);
    batteryToLoad = toLoad;
    batteryToGrid = out - toLoad;
    gridToBattery = 0;
    loadFromGrid = loadRem - toLoad;
    gridImport = loadFromGrid;
    solarExport = solarRem;
    gridExport = solarRem + batteryToGrid;
  }

  const feasible = gridImport <= SLOT_MAX_KWH + 1e-9 && gridExport <= SLOT_MAX_KWH + 1e-9;
  return { gridImport, gridExport, solarExport, batteryToGrid, gridToBattery, batteryToLoad, loadFromGrid, feasible };
}

/**
 * Optimal battery dispatch via dynamic programming over a discretised state of charge.
 *
 * Unlike a greedy per-slot rule, this sees the whole horizon in order: it charges from the
 * cheapest hours (and free solar), holds energy only where it beats every alternative use, and
 * discharges — to cover load or export to the grid — where it is worth the most. Because it plans
 * the full SoC trajectory it never sells cheaply then rebuys dear, and never over-holds a full
 * battery it can't use. Terminal value is 0 (leftover energy above the floor is spent down by the
 * end of the known horizon), with the hard MIN_SOC floor enforced throughout.
 *
 * 'idle' does NOT mean "SoC holds steady" — it means "leave the inverter on auto/self-use,"
 * and a real hybrid inverter always charges the battery from surplus solar before exporting it
 * (see autoChargeInputKwh below). So an idle slot's socAfter still rises whenever there's solar
 * surplus beyond load; only a rise ABOVE that free/automatic amount gets labeled 'charge', since
 * only that portion requires actively forcing extra input (typically from the grid). Fixed
 * 2026-07-03 — the previous version assumed idle meant zero charge / 100% export, which
 * understated real SoC growth on sunny days and was the main driver of the SoC-divergence guard
 * (dispatch_loop.py) firing far more than genuine plan staleness ever would.
 *
 * @param slots     per-slot prices/solar/load
 * @param startSoc  current battery energy (kWh); defaults to half capacity
 * @param opts.endSoc  optional terminal constraint: the trajectory must END within one
 *   discretisation step of this SoC instead of enjoying the free terminal-value-0 drain.
 *   Exists for the hindsight-oracle comparison (lib/oracle.ts): constraining the oracle to the
 *   achieved end-of-day SoC isolates *within-day* dispatch quality from the *inter-day* choice
 *   of what SoC to hand the next morning — without it the oracle "wins" by spending energy the
 *   real system deliberately carried overnight, which is a horizon artifact, not real regret.
 *   Throws if the target is unreachable from startSoc (cannot happen for a target taken from a
 *   real trajectory obeying the same physics, but a caller-supplied fantasy target can).
 * @param opts.loadFactor  robust-planning margin: every slot's consumptionKwh is multiplied
 *   by this factor BEFORE the solar-first netting, so the plan stays feasible when real load
 *   runs hotter than forecast (see LOAD_FORECAST_MARGIN in lib/constants.ts for the full
 *   rationale — a point-forecast optimum has zero slack by construction, and the cost of
 *   running short is far larger than the cost of over-holding). Default 1 (no margin): the
 *   hindsight oracle re-dispatches ACTUAL load and must never carry a robustness margin, and
 *   existing tests pin the unmargined optimum. The emitted gridKwh/socAfter describe the
 *   margined plan — the honest forecast is what gets logged to telemetry (lib/plan.ts), so
 *   forecast-vs-actual validation is not polluted by the deliberate margin.
 * @param opts.deferralRateOrePerKwhHour  risk-aware planning (added 2026-07-19, see
 *   DEFERRAL_RATE_ORE_PER_KWH_HOUR in lib/constants.ts for the incident + full rationale):
 *   surcharge the battery's grid-facing actions (grid-funded charge, battery-to-grid sell) by
 *   `rate × hoursUntilHorizonEnd` öre/kWh in the backward pass, so among near-equal prices the
 *   action lands as late as possible and stays cancellable by the next replan. When set, the DP
 *   runs twice — with and without the bias — and the deferred plan is kept only if it gives up
 *   at most opts.maxDeferralSacrificeOre (default MAX_DEFERRAL_SACRIFICE_ORE) of TRUE-priced
 *   value vs the undeferred optimum, so a genuinely better early price is never deferred over.
 *   Load-covering discharges are deliberately NOT biased: their timing is dictated by when the
 *   load occurs, and biasing them would fight the reserve logic for no option-value gain.
 * @param opts.solarRiskPremiumOre  risk-aware planning (see SOLAR_RISK_PREMIUM_ORE_PER_KWH):
 *   surcharge grid-funded charging by `premium × min(1, futureRawForecastSolar /
 *   batteryHeadroom)` öre/kWh, so a buy that a plausible solar over-delivery would make
 *   redundant must clear a real risk margin, not any thin positive edge. Zero whenever no
 *   forecast solar remains (winter nights), so genuine arbitrage is untouched.
 *   Both knobs are planning-only and default OFF: the oracle re-dispatches actual data in
 *   hindsight, where deferral/uncertainty have no meaning — biasing it would poison the
 *   regret-≥0 invariant (lib/oracle.ts). Only lib/plan.ts sets them, for live plans.
 */
export function optimizeDispatch(
  slots: OptimizerSlot[],
  startSoc: number = BATTERY_KWH / 2,
  opts?: {
    endSoc?: number;
    loadFactor?: number;
    deferralRateOrePerKwhHour?: number;
    maxDeferralSacrificeOre?: number;
    solarRiskPremiumOre?: number;
  },
): DispatchSlot[] {
  if ((opts?.deferralRateOrePerKwhHour ?? 0) > 0 && slots.length > 0) {
    // Two-pass sacrifice guard: the deferral ramp is a planning fiction, so measure what it
    // really costs — price both trajectories with the DP's own true-price arithmetic
    // (evaluateDispatch) and refuse the deferred plan beyond the cap. All-or-nothing on
    // purpose (see MAX_DEFERRAL_SACRIFICE_ORE's rationale).
    const undeferred = dpCore(slots, startSoc, { ...opts, deferralRateOrePerKwhHour: 0 });
    const deferred = dpCore(slots, startSoc, opts);
    const cap = opts?.maxDeferralSacrificeOre ?? MAX_DEFERRAL_SACRIFICE_ORE;
    const sacrifice =
      evaluateDispatch(slots, undeferred, startSoc).valueOre -
      evaluateDispatch(slots, deferred, startSoc).valueOre;
    return sacrifice <= cap ? deferred : undeferred;
  }
  return dpCore(slots, startSoc, opts);
}

function dpCore(
  slots: OptimizerSlot[],
  startSoc: number,
  opts?: {
    endSoc?: number;
    loadFactor?: number;
    deferralRateOrePerKwhHour?: number;
    solarRiskPremiumOre?: number;
  },
): DispatchSlot[] {
  const n = slots.length;
  if (n === 0) return [];

  const floorSoc = Math.min(MIN_SOC_KWH, startSoc); // allow a start below the floor; never discharge below it
  const step = (BATTERY_KWH - floorSoc) / (SOC_LEVELS - 1);
  const socOf = (i: number) => floorSoc + i * step;
  const idxOf = (soc: number) =>
    Math.max(0, Math.min(SOC_LEVELS - 1, Math.round((soc - floorSoc) / step)));
  const minSocLevel = Math.ceil((MIN_SOC_KWH - floorSoc) / step - 1e-9); // lowest level that is ≥ MIN_SOC
  const maxDelta = Math.max(1, Math.floor(SLOT_MAX_KWH / step)); // reachable SoC levels per slot

  // Solar-first netting per slot, plus the energy input the battery gets for free from
  // solar surplus whenever the inverter is left on auto/self-use (i.e. NOT actively
  // forced into a discharge) — a real hybrid inverter always prioritizes charging the
  // battery from surplus over exporting it, so "idle" cannot mean "zero charge, export
  // everything" the way the DP used to assume. autoChargeInputKwh is capped the same way
  // any other charge/discharge flow is (SLOT_MAX_KWH) — the battery/inverter can't absorb
  // faster than its own throughput limit regardless of how much solar is available.
  const loadFactor = opts?.loadFactor ?? 1;
  const solarRem = new Float64Array(n);
  const loadRem = new Float64Array(n);
  const autoChargeInputKwh = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const load = (slots[i].consumptionKwh ?? 0) * loadFactor;
    const s2l = Math.min(slots[i].solarKwh, load);
    solarRem[i] = slots[i].solarKwh - s2l;
    loadRem[i] = load - s2l;
    autoChargeInputKwh[i] = Math.min(solarRem[i], SLOT_MAX_KWH);
  }

  // Risk-aware planning surcharges (see optimizeDispatch's opts docs; both default 0 = off,
  // and a 0 rate contributes exactly 0.0 öre to every transition, so the plain DP is
  // bit-identical to before these existed). deferOre[i] is the per-kWh earliness surcharge on
  // grid-facing battery actions at slot i; suffixSolarKwh[i] is the RAW forecast solar still
  // to come STRICTLY AFTER slot i (own-slot solar can't surprise a slot that grid-buys — a
  // buying slot has already consumed its surplus, need > sr). Raw, NOT load-netted surplus,
  // deliberately: the premium prices FORECAST ERROR, and error scales with how much solar the
  // forecast still has in play — a gloomy 6 kWh-day forecast can net to zero surplus and still
  // deliver 3-5× and fill the battery (the 2026-07-19 incident did exactly that); netted
  // surplus would price that day as risk-free, blind on precisely the highest-error days.
  const deferralRate = opts?.deferralRateOrePerKwhHour ?? 0;
  const solarRiskPremiumOre = opts?.solarRiskPremiumOre ?? 0;
  const deferOre = new Float64Array(n);
  const suffixSolarKwh = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i--) {
    deferOre[i] = deferralRate * 0.25 * (n - 1 - i); // 0.25 h per 15-min slot of earliness
    suffixSolarKwh[i] = suffixSolarKwh[i + 1] + slots[i].solarKwh;
  }

  // Backward pass: costToGo[level] = min öre cost from the next slot onward at that SoC level.
  let costToGo = new Float64Array(SOC_LEVELS); // terminal value 0
  if (opts?.endSoc !== undefined) {
    // Terminal constraint: only the target's own grid level may end the horizon (Infinity
    // elsewhere propagates backward and prunes every path that misses it). Exactly ONE level,
    // not a ±1 band: transitions land exactly on levels, so any single level is reachable, and
    // a band would hand the constrained run one grid step of free extra drain — ~a step×buyPrice
    // of phantom "intraday regret" on every scored day. The target snaps to the grid (≤ half a
    // step from the requested SoC) and clamps to the enforceable range: never below the
    // discharge floor, never above capacity.
    const target = Math.max(minSocLevel, Math.min(SOC_LEVELS - 1, idxOf(opts.endSoc)));
    costToGo.fill(Infinity);
    costToGo[target] = 0;
  }
  const choice: Int16Array[] = new Array(n);

  for (let i = n - 1; i >= 0; i--) {
    const cur = new Float64Array(SOC_LEVELS);
    const ch = new Int16Array(SOC_LEVELS);
    const buy = slots[i].buyPrice;
    const sell = slots[i].sellPrice;
    const sr = solarRem[i];
    const lr = loadRem[i];
    const autoInput = autoChargeInputKwh[i];

    for (let s = 0; s < SOC_LEVELS; s++) {
      const soc = socOf(s);
      const lo = Math.max(0, s - maxDelta);
      const hi = Math.min(SOC_LEVELS - 1, s + maxDelta);
      // The lowest reachable non-discharge level: the battery cannot end up BELOW what
      // free solar auto-charges it to unless something actively discharges it instead
      // (handled separately, j < s below) — see autoChargeInputKwh's definition above.
      const naturalFloor = idxOf(Math.min(soc + autoInput * ONE_WAY_EFF, BATTERY_KWH));
      // Solar-redundancy premium for grid-buying AT THIS state: scales with how much of the
      // remaining headroom the strictly-future raw forecast solar could fill on its own (see
      // suffixSolarKwh above for why raw, not netted). Headroom is this slot's proxy for
      // "what the buy competes with" — planned discharges between now and the solar's arrival
      // can open more room, so this slightly UNDER-counts the risk; acceptable for a heuristic
      // priced in öre. Denominator floored at one grid step to keep a near-full battery from
      // dividing by ~0 (ratio caps at 1 regardless).
      const solarRiskOre =
        solarRiskPremiumOre > 0
          ? solarRiskPremiumOre *
            Math.min(1, suffixSolarKwh[i + 1] / Math.max(BATTERY_KWH - soc, step))
          : 0;
      let best = Infinity;
      let bestJ = s;
      for (let j = lo; j <= hi; j++) {
        if (j < s && j < minSocLevel) continue; // never discharge below the floor
        if (j >= s && j < naturalFloor) continue; // can't charge less than auto-charging already provides
        const dE = socOf(j) - soc;
        let gImp: number;
        let gExp: number;
        let riskOre: number; // deferral + redundancy surcharge on the battery's grid-facing share
        if (dE >= 0) {
          const need = dE / ONE_WAY_EFF;
          const fromSolar = need < sr ? need : sr;
          const gridToBattery = need - fromSolar;
          gImp = gridToBattery + lr;
          gExp = sr - fromSolar;
          if (gExp > SLOT_MAX_KWH) gExp = SLOT_MAX_KWH;
          riskOre = gridToBattery * (deferOre[i] + solarRiskOre);
        } else {
          const out = -dE * ONE_WAY_EFF;
          const toLoad = out < lr ? out : lr;
          gImp = lr - toLoad;
          gExp = sr + (out - toLoad);
          if (gExp > SLOT_MAX_KWH + 1e-9) continue; // over-export infeasible
          // Only the battery-to-grid share is deferral-biased: covering load (toLoad) happens
          // when the load happens — there is no "later" to defer it to.
          riskOre = (out - toLoad) * deferOre[i];
        }
        if (gImp > SLOT_MAX_KWH + 1e-9) continue; // over-import infeasible
        // Wear cost on |dE| (battery throughput this slot) discourages cycling the
        // battery for a marginal gain smaller than what it costs in degradation —
        // see BATTERY_WEAR_COST_ORE_PER_KWH. Zero when j === s (idle, dE = 0).
        const wear = BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(dE);
        const cost = gImp * buy - gExp * sell + wear + riskOre + costToGo[j];
        if (cost < best) {
          best = cost;
          bestJ = j;
        }
      }
      cur[s] = best;
      ch[s] = bestJ;
    }
    choice[i] = ch;
    costToGo = cur;
  }

  // After the backward pass costToGo holds slot-0 values; an infinite cost at the start state
  // means no feasible path reaches the terminal constraint (only possible with opts.endSoc).
  if (opts?.endSoc !== undefined && !Number.isFinite(costToGo[idxOf(startSoc)])) {
    throw new Error(
      `optimizeDispatch: endSoc ${opts.endSoc} kWh is unreachable from startSoc ${startSoc} kWh in ${n} slots`,
    );
  }

  // Forward pass: walk the optimal SoC path from startSoc and emit dispatch.
  const result: DispatchSlot[] = new Array(n);
  let s = idxOf(startSoc);
  for (let i = 0; i < n; i++) {
    const j = choice[i][s];
    const soc = socOf(s);
    const socNext = socOf(j);
    const f = computeFlows(soc, socNext, solarRem[i], loadRem[i]);
    const dE = socNext - soc;
    // 'idle' means "leave the inverter on auto/self-use" — free, no grid-funded CHARGING,
    // whenever the chosen socNext is reachable from solar alone. Deliberately NOT based on
    // f.gridImport: that also counts grid power drawn purely to cover house load (lr), which
    // has nothing to do with whether the battery is being actively charged — a load-only
    // slot with dE = 0 must stay 'idle' even though gridImport > 0. gridForCharging isolates
    // just the charging-side grid draw (need beyond what solarRem covers).
    //
    // Also deliberately NOT a level-index comparison against the natural floor used for
    // feasibility above: SOC_LEVELS discretises the state space at ~0.12 kWh resolution, so
    // the search can land one grid point above the true continuous natural amount purely
    // from rounding, pulling in a sub-resolution sliver of "charging" that is not a real
    // decision — tolerate up to one discretization step before calling it an actively forced
    // charge, since a genuine arbitrage import is always much larger than the model's own
    // snap-to-grid noise.
    let action: Action;
    if (dE < -1e-6) {
      action = 'discharge';
    } else {
      const need = dE / ONE_WAY_EFF;
      const gridForCharging = Math.max(0, need - Math.min(solarRem[i], need));
      action = gridForCharging > step ? 'charge' : 'idle';
    }
    result[i] = {
      startTime: slots[i].startTime,
      action,
      gridKwh: f.gridImport - f.gridExport,
      solarExportKwh: f.solarExport,
      batteryToGridKwh: f.batteryToGrid,
      gridToBatteryKwh: f.gridToBattery,
      batteryToLoadKwh: f.batteryToLoad,
      loadFromGridKwh: f.loadFromGrid,
      socAfter: socNext,
    };
    s = j;
  }
  return result;
}

export interface DispatchEconomics {
  cashOre: number; // öre — grid income minus grid cost over the horizon; positive = net income
  wearOre: number; // öre — BATTERY_WEAR_COST_ORE_PER_KWH × total |ΔSoC| (battery throughput)
  valueOre: number; // cashOre − wearOre — the exact quantity the DP maximises (negated cost)
}

/**
 * Price a dispatch trajectory with the DP's own arithmetic: the same solar-first netting and
 * computeFlows physics the backward pass costs transitions with, so
 * `evaluateDispatch(slots, optimizeDispatch(slots, s), s)` is the optimum's value and any other
 * feasible trajectory over the same slots evaluates ≤ it. Exists for the hindsight-oracle
 * comparison (lib/oracle.ts), where oracle/constrained/continuation trajectories must all be
 * valued on one identical basis — pricing them with separate ad-hoc arithmetic would make the
 * regret numbers reflect accounting drift, not dispatch quality.
 *
 * `dispatch` may be a prefix of a longer trajectory's slots (e.g. the first-day slice of a
 * 48 h oracle run); only `dispatch.length` slots are valued.
 */
export function evaluateDispatch(
  slots: OptimizerSlot[],
  dispatch: DispatchSlot[],
  startSoc: number,
): DispatchEconomics {
  let cashOre = 0;
  let wearOre = 0;
  let soc = startSoc;
  for (let i = 0; i < dispatch.length; i++) {
    const load = slots[i].consumptionKwh ?? 0;
    const s2l = Math.min(slots[i].solarKwh, load);
    const f = computeFlows(soc, dispatch[i].socAfter, slots[i].solarKwh - s2l, load - s2l);
    cashOre += f.gridExport * slots[i].sellPrice - f.gridImport * slots[i].buyPrice;
    wearOre += BATTERY_WEAR_COST_ORE_PER_KWH * Math.abs(dispatch[i].socAfter - soc);
    soc = dispatch[i].socAfter;
  }
  return { cashOre, wearOre, valueOre: cashOre - wearOre };
}
