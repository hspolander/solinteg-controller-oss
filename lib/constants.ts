// ---- Networking ----

/** Abort an upstream fetch (elprisetjustnu, Open-Meteo) that hangs instead of erroring quickly,
 *  so a slow/unresponsive API can't stall a page render indefinitely. */
export const FETCH_TIMEOUT_MS = 10_000;

// ---- Env-var overrides ----
// Every constant below that varies by contract/site/bidding-zone (not by hardware model) can be
// overridden via the same env file the Python side reads (deploy/solinteg.env.example) — read
// once at module load, same pattern as TELEMETRY_DB_PATH/INVERTER_DATA_PATH elsewhere in the app.
// Falls back to the owner's own measured values, which stay the effective defaults either way.

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---- Pricing ----

/** Flat buy-side charge: skatt & överföringsavgift (öre/kWh). Never applied to sell prices.
 *  Env: SKATT_OVERFORING_ORE (a national tax + a DSO-specific grid fee, lumped together for
 *  simplicity — see the value's own history if re-measuring for a different grid area). */
export const SKATT_OVERFÖRING = numEnv('SKATT_OVERFORING_ORE', 71);

/** Swedish VAT (moms) on the energy price. Env: VAT_RATE. */
export const VAT_RATE = numEnv('VAT_RATE', 0.25);

/**
 * Supplier surcharge added to the raw spot BEFORE VAT (öre/kWh) — Mölndal's påslag + elcertifikat.
 * Measured 2026-07-01 by fitting Mölndal's priceIncludingTaxAndSurcharge against Nord Pool SE3 spot:
 * `priceInclTax = (spot + 11.5) × 1.25`, exact to 0.00 öre across all 96 slots. The app fetches raw
 * spot from elprisetjustnu.se rather than Mölndal's own (unreliable) API, but this doesn't affect
 * the calibration: spot is a standardized Nord Pool SE3 value, identical regardless of which API
 * relays it, and the owner's actual supplier contract is still Mölndal Energi (confirmed 2026-07-02
 * — only the price-fetch source changed, not the contract). Re-measure only if the Mölndal contract
 * itself changes (different surcharge/elcertifikat terms), or set SUPPLIER_SURCHARGE_ORE for a
 * different supplier's own påslag+elcertifikat.
 */
export const SUPPLIER_SURCHARGE_ORE = numEnv('SUPPLIER_SURCHARGE_ORE', 11.5);

/**
 * Per-kWh compensation received for exporting to the grid, ON TOP OF the raw spot price
 * (öre/kWh) — the grid-benefit / nätnytta payment. Folded into the sell price at fetch time, so
 * every consumer (optimizer, economics, chart) values an exported kWh at `spot + this`.
 * Measured by the owner at 5.10 öre/kWh net; env EXPORT_BONUS_ORE if the contract changes (some
 * grid companies pay 0 or a %-based bonus instead of a flat rate — this formula assumes flat).
 */
export const EXPORT_BONUS_ORE = numEnv('EXPORT_BONUS_ORE', 5.1);

/** Bidding zone for spot prices — Gothenburg is in SE3. Env: PRICE_ZONE, any of SE1-SE4 (the
 *  elprisetjustnu.se feed already serves all four the same way; nothing else needs to change to
 *  move zones). Falls back to SE3 on an unrecognised value rather than silently 404ing later. */
const VALID_PRICE_ZONES = ['SE1', 'SE2', 'SE3', 'SE4'] as const;
export type PriceZone = (typeof VALID_PRICE_ZONES)[number];
function isPriceZone(v: string): v is PriceZone {
  return (VALID_PRICE_ZONES as readonly string[]).includes(v);
}
const rawPriceZone = process.env.PRICE_ZONE;
export const PRICE_ZONE: PriceZone =
  rawPriceZone && isPriceZone(rawPriceZone) ? rawPriceZone : 'SE3';

// ---- Battery: Enershare Energy-Core 25.6 kWh ----

// One real source of truth per value, not per-language literals cross-checked after the fact:
// TS and the Python control scripts (dispatch_loop.py, modbus_poller.py, inverter_control.py)
// read the SAME env var names, with matching hardcoded fallback defaults so an install that
// never sets them (like this one) behaves identically to before this change. Two of these
// (BATTERY_MAX_KW, GRID_KW below) share their env var with values Python already reads in
// Watts (added 2026-07-10, day 2) rather than introducing a second, kW-named var for the same
// physical fact — that would just recreate the two-independently-settable-copies problem this
// is meant to close. lib/__tests__/constants-cross-language.test.ts still guards the one thing
// that genuinely can't be shared across languages: the two hardcoded fallback defaults
// themselves silently drifting apart.
export const BATTERY_KWH = numEnv('SOLINTEG_BATTERY_KWH', 25.6); // usable capacity (kWh)
export const BATTERY_MAX_KW = numEnv('SOLINTEG_BATTERY_MAX_W', 15360) / 1000; // max charge/discharge rate (kW) — env is in W, Python's native unit
export const BATTERY_RT_EFF = numEnv('SOLINTEG_BATTERY_RT_EFF', 0.96); // round-trip efficiency (datasheet: ≥96%)

const SOC_FLOOR_PCT = numEnv('SOLINTEG_SOC_FLOOR_PCT', 8);
export const BATTERY_MIN_SOC_KWH = BATTERY_KWH * (SOC_FLOOR_PCT / 100); // operational floor (2.048 kWh at 8%)

/**
 * Robust-planning margin on the load forecast inside the DP (dimensionless factor ≥ 1;
 * 1 disables). The optimizer PLANS against consumptionKwh × this factor — the logged
 * telemetry inputs keep the honest, unmargined forecast (see lib/plan.ts).
 *
 * Why: the DP trusts its point forecasts completely, so its optimum routinely kisses the
 * SoC floor at exactly the moment committed load ends (e.g. sunrise) — zero slack. A load
 * forecast that runs even 10-20% hot then forces grid imports at exactly the hours the
 * plan judged most expensive (that's WHY the battery was scheduled to carry the night).
 * Measured 2026-07-18: a ~25%-low overnight load model turned a planned 0.15 kWh import
 * into 2.18 kWh bought at 170-220 öre. Planning against pessimistic load keeps the plan
 * feasible in the bad case; when load comes in at forecast, the unspent margin is simply
 * re-optimized away by the next replan (hourly + triggered), costing only öre-scale spread
 * timing and ~2 öre/kWh wear. The asymmetry that justifies it: holding 1 kWh too much
 * costs the small evening/next-day sell-price difference, running 1 kWh short costs the
 * full buy-sell spread at the night's worst prices. Price-certain arbitrage (sell high
 * evening, rebuy cheap night) is NOT distorted — prices carry no margin, the DP just
 * plans to rebuy the margin too. Env: SOLINTEG_LOAD_FORECAST_MARGIN.
 */
export const LOAD_FORECAST_MARGIN = numEnv('SOLINTEG_LOAD_FORECAST_MARGIN', 1.15);

/**
 * Trailing window (days) for the live per-hour load profile read from telemetry readings,
 * which replaces the static Ellevio-fitted hour shape whenever enough data exists (see
 * lib/telemetry.ts readTrailingLoadProfile / lib/load.ts slotConsumptionFromLive). 0 disables
 * the live profile entirely (static model only). Env: SOLINTEG_LIVE_LOAD_DAYS.
 */
export const LIVE_LOAD_PROFILE_DAYS = numEnv('SOLINTEG_LIVE_LOAD_DAYS', 14);

// SoC ceiling: enforced entirely inside inverter_control.py's force_charge (refuses to charge
// past it rather than silently capping) — the DP optimizer does NOT model this today, it plans
// as if the full BATTERY_KWH were reachable. Exported here for documentation/future use (e.g. a
// dashboard "distance to safety ceiling" indicator), not yet wired into optimizer.ts/oracle.ts.
// Making the DP itself ceiling-aware would be a real behavior change — out of scope for this
// config-consolidation pass, which only touches how values are SOURCED, not what they do.
const SOC_CEILING_PCT = numEnv('SOLINTEG_SOC_CEILING_PCT', 98);
export const BATTERY_MAX_SOC_KWH = BATTERY_KWH * (SOC_CEILING_PCT / 100);

/**
 * Marginal wear cost per kWh of battery throughput (öre), charged on both charge and
 * discharge in the optimizer's cost function. LFP cells rated ~6000 cycles before
 * ~10-15% capacity fade — that's NOT end of life, the pack keeps working well past it —
 * so this deliberately prices only the fractional pack value at risk over the rated life,
 * not a full replacement write-off, spread over total lifetime throughput (charge +
 * discharge, hence the ×2). Kept small on purpose: it should discourage only genuinely
 * marginal cycling (a slot barely worth doing after round-trip losses), never real
 * arbitrage — a typical daily price spread is tens of öre, an order of magnitude more
 * than this. REPLACEMENT_COST_SEK should be what you paid for inverter+battery combined —
 * using the whole system cost (a battery-only sub-price usually isn't itemized) is
 * intentionally conservative, slightly overstating the true battery-only value. The default
 * below is just an illustrative round number, not any particular real installation's price.
 * Env: BATTERY_REPLACEMENT_COST_SEK — set this to your own purchase price.
 */
const REPLACEMENT_COST_SEK = numEnv('BATTERY_REPLACEMENT_COST_SEK', 60_000);
const ASSUMED_CAPACITY_LOSS_AT_RATED_CYCLES = 0.125; // 12.5%, midpoint of ~10-15%
const RATED_CYCLES = 6000;
export const BATTERY_WEAR_COST_ORE_PER_KWH =
  (REPLACEMENT_COST_SEK * 100 * ASSUMED_CAPACITY_LOSS_AT_RATED_CYCLES) /
  (2 * RATED_CYCLES * BATTERY_KWH); // ≈2.3 öre/kWh leg, ≈4.7 öre per full round-tripped kWh

// ---- Grid: 3×16A fuses ----

export const GRID_KW = numEnv('SOLINTEG_GRID_CAP_W', 11_000) / 1000; // ~11 kW cap — binding constraint over battery's 15.36 kW; env is in W, Python's native unit

// ---- Site location: Göteborg archipelago ----
// The one real exported source of truth for these coordinates — previously just a comment here
// (not an export), while lib/forecast.ts and two offline scripts each independently hardcoded the
// same literal, an unforced 4-way duplication/drift risk with no functional reason behind it.
// Env: SITE_LATITUDE / SITE_LONGITUDE (decimal degrees).
export const SITE_LATITUDE = numEnv('SITE_LATITUDE', 57.64);
export const SITE_LONGITUDE = numEnv('SITE_LONGITUDE', 11.78);

/**
 * Open-Meteo `models=` value for the solar forecast (lib/forecast.ts), or '' for the
 * default best_match blend. Reference install (57.6°N, Nordic) backtested `metno_nordic`
 * against 4.3 months of its own measured GHI (scripts/tools/compare-metno-solar.mjs) and
 * found it 14% better MAE than best_match, particularly fixing a systematic morning
 * over-forecast — but this is a REGIONAL result: metno_nordic only covers
 * Norway/Sweden/Denmark/Finland, and Open-Meteo's dedicated regional models differ by
 * territory (e.g. its default blend already leans on ICON-D2 for Central Europe, HRRR for
 * the US). If you're outside the Nordics, don't assume this default transfers — run the
 * backtest script against your own station history and your region's candidate models
 * (Open-Meteo's model list: open-meteo.com/en/docs) before trusting either choice. Also
 * note: unlike best_match, none of the regional models expose a `minutely_15` variant, so
 * picking one switches the forecast to hourly (see forecast.ts's slot-filling comment).
 * Env: SOLAR_FORECAST_MODEL.
 */
export const SOLAR_FORECAST_MODEL = process.env.SOLAR_FORECAST_MODEL ?? 'metno_nordic';

// ---- Solar installation ----
// tiltDeg/azimuthDeg are informational only (not read by any formula — lib/solar.ts's
// ghiToKwh() only uses kWp and performanceRatio) — they document how performanceRatio was
// estimated for this array, and help a new adopter sanity-check their own numbers against
// their install docs. performanceRatio accounts for tilt, orientation, inverter losses, and
// shading relative to GHI; it's a semi-empirical derating estimate, not computed from
// tilt/azimuth by any formula here — a new adopter without production history yet should
// start around 0.7-0.8 for an unshaded south-facing array and expect to refine it later
// against real production data (see solarCalibrationByMonth's generator script,
// scripts/process-inverter-data.ts, for the same kind of per-installation calibration).
//
// To adapt for a different site: replace this array with your own — kWp is nameplate power
// per string/array (from your panel spec sheet), tiltDeg/azimuthDeg from your install's own
// documentation (0° azimuth = north, 180° = south).
export interface SolarArray {
  label: string;
  kWp: number;
  tiltDeg: number;
  azimuthDeg: number;
  performanceRatio: number;
}

export const SOLAR_ARRAYS: SolarArray[] = [
  { label: 'A: SE, morning peak', kWp: 7.40, tiltDeg: 27, azimuthDeg: 123, performanceRatio: 0.77 },
  { label: 'B: NW, afternoon/evening (heavy azimuth penalty)', kWp: 5.55, tiltDeg: 18, azimuthDeg: 303, performanceRatio: 0.58 },
  { label: 'C: SW, afternoon contributor', kWp: 1.11, tiltDeg: 18, azimuthDeg: 214, performanceRatio: 0.72 },
];
