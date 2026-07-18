@AGENTS.md
@DOMAIN.md

## Architecture

### Data flow

```
elprisetjustnu.se SE3  Open Meteo (minutely_15)   Open Meteo (daily temp)
       │                        │                          │
 lib/prices.ts           lib/forecast.ts            lib/forecast.ts
 fetchPrices()           fetchSolarForecast()       fetchDailyMeanTemp()
 [today+tomorrow spot,   [cached 1 h / 8 h]         [cached 1 h / 8 h]
  cached to next release]       │                          │
       │                        │                          ▼
       │                        │                    lib/load.ts
       │                        │                    dailyLoadKwh / slotConsumptionKwh
       │                        │                    [baseline + slope·HDD; measured hourShareByMonth]
       │                        │                    [superseded per render by the live trailing
       │                        │                     per-hour profile when telemetry has ≥5 days:
       │                        │                     telemetry.ts readTrailingLoadProfile →
       │                        │                     slotConsumptionFromLive (HDD-ratio scaled),
       │                        │                     loadSource 'live'; static model = fallback]
       │                        │                          │
       └──────────┬─────────────┴──────────────────────────┘
                  ▼
           lib/pipeline.ts
           buildSolarProfiles()   ←─ lib/solar.ts       (GHI W/m² → kWh via array model, calibrated)
           buildOptimizerSlots()  ←─ lib/slot-utils.ts  (slotIndex, timezone offset)
                  │                   lib/load.ts        (per-slot consumptionKwh)
                  ▼
           lib/optimizer.ts
           optimizeDispatch()
           [net-load aware DP over discretised SoC (193 levels, backward
            cost-to-go pass, terminal value 0); RT_EFF from lib/constants.ts (√η per leg);
            grid cap from lib/constants.ts; wear cost on |ΔSoC|; plans against
            load × LOAD_FORECAST_MARGIN (1.15) so the trajectory keeps
            slack for load-forecast error — logged inputs stay honest,
            oracle calls without the factor (see constants.ts rationale)]
                  │
                  ▼
           app/page.tsx  (server component — fetches, assembles, passes props)
                  │                   └─→ lib/telemetry.ts  (best-effort: logs price curve
                  │                       + optimizer run to telemetry.db; no-op unless
                  ▼                       TELEMETRY_DB_PATH set — off in dev/build/tests)
     app/components/PriceChart.tsx   (rendering only)
     app/components/useChartData.ts  (React memos → lib/chart-utils.ts)
     lib/chart-utils.ts              (pure: buildActionBands, buildChartData, …)
```

### Fixed dependencies — not pluggable, by design

This is not a generic battery-dispatch framework. It's built for one electricity market and one
inverter family, on purpose — see README.md's "Scope" section for why, and what "adapting to
your own site" actually means (mostly: your own physical constants and historical data, not a
different market or vendor):

- **Electricity market:** Swedish day-ahead spot via elprisetjustnu.se (Nord Pool SE1–SE4). The
  Stockholm-timezone handling and the feed's 92/100-slot DST-transition quirk (see "Key
  invariants" below) are structural, not swappable constants — `lib/prices.ts` is the
  Sweden/Nord-Pool adapter to replace if you're in a different market.
- **Inverter:** Solinteg "Integ M Series" (MHT-10/12/15/20K-40) via Modbus TCP — see MODBUS.md
  for the register map. Supporting another model in the same family needs no code changes
  beyond your own `SOLINTEG_BATTERY_MAX_W`/`SOLINTEG_GRID_CAP_W` env values; a different vendor
  is a from-scratch field-verification project (new register map, on-device sign/persistence
  probes), not a config change.

### Key invariants

- **Sell price** = the `price` field only — spot + `EXPORT_BONUS_ORE` (nätnytta), folded in at
  fetch time (see DOMAIN.md). Never add tax, surcharge, or grid fees on top of it.
- **Buy price** = `priceIncludingTaxAndSurcharge` + `SKATT_OVERFÖRING`.
- elprisetjustnu timestamps are Stockholm local with an offset; `prices.ts` strips it to naive
  **Stockholm local time**. Open Meteo is also Stockholm (`timezone=Europe/Stockholm`). Your own
  historical GHI data source's timezone may differ — check before wiring it into
  `lib/irradiance-data.ts`.
- **Prices** come from elprisetjustnu.se (raw Nord Pool spot); the tax-inclusive buy price is
  reconstructed as `(spot + SUPPLIER_SURCHARGE_ORE) × (1 + VAT_RATE)`, and the sell price as
  `spot + EXPORT_BONUS_ORE` (see `lib/constants.ts` — all overridable via env, see README.md).
- Prices are 15-min slots, nominally 96/day — but the two DST-transition days really arrive
  from the feed with **92 (spring) / 100 (fall) slots**, with the 02:xx hour absent or repeated.
  Positions in the loaded `prices` array must therefore be computed as *elapsed time* since the
  first slot (`currentSlotIndexInPrices` in `lib/prices.ts`, elapsed-15-min-slots since a real
  Stockholm-midnight UTC instant; `dispatch_loop.py`'s `slot_index_for_instant` is the Python
  half) — never as wall-clock `hour × 4 + floor(minute / 15)`, which drifts ±4 positions after
  the gap. The wall-clock formula (`slotIndex` in `lib/slot-utils.ts`, range 0–95) is still what
  keys the fixed 96-entry *typical-profile* arrays (forecast fallback), where a one-hour DST
  smear is noise; naive `startTime` strings also duplicate across the repeated fall-back hour,
  a known residual quirk in map-keyed lookups (economics/chart) worth ~öre once a year.
- **Optimizer = dynamic program, not per-slot rules.** `optimizeDispatch()` runs a DP over a
  discretised SoC trajectory (193 levels; backward cost-to-go pass with terminal value 0, then a
  forward walk from `startSoc`). There are no explicit look-ahead variables to grep for — the
  properties below are *emergent* from full-horizon optimality and are pinned as behaviour by
  `lib/__tests__/optimizer.test.ts`. Treat those tests as the spec when touching the optimizer.
- It never discharges **to grid** unless selling now beats the worst-case cost of rebuying that
  energy later, after round-trip losses and wear (tests: "discharges to sell when the sell price
  beats the future rebuy cost"; "does not charge from grid when arbitrage is not viable").
- **Net load**: solar serves the house first, then charges the battery, then exports. The battery
  discharges **to load** on the priciest deficit slots and charges from cheap grid when that
  covers a pricier future deficit (test: "reserves energy to cover a dearer future load rather
  than selling it cheaply now"). `consumptionKwh` is optional on `OptimizerSlot` and defaults
  to 0, so zero-load callers keep the original arbitrage behaviour.
- **Net-consumer peak export**: in a net-consumer slot (evening, no solar), after covering load
  the battery can also export surplus to the grid, so stored energy can be sold into an evening
  price peak (test: "exports surplus at a high sell price while reserving only what a dear load
  needs").
- **Solar-aware charging**: the DP doesn't grid-charge when forecast solar still to come will
  refill the battery anyway — self-adjusting, no seasonal hardcoding (test: "does NOT grid-charge
  overnight when solar will refill for a load-only evening").
- **Cheapest-hours charging**: when a grid-buy is warranted it lands in the cheapest slots, not
  the earliest (test: "grid-charges in the cheapest hour, not the earliest, before a sell peak").
- **Battery wear cost**: every kWh of battery throughput (charge or discharge) carries a small
  cost (`BATTERY_WEAR_COST_ORE_PER_KWH` in `lib/constants.ts`) so the DP won't cycle the battery
  for a gain smaller than its degradation cost. Deliberately gentle — sized off the *fractional*
  pack value at risk over its rated cycle life (LFP cells lose ~10-15% capacity by ~6000 cycles,
  they don't die), not a full replacement write-off — so it filters only genuinely marginal
  cycling, never real arbitrage.
- **Load model** (`lib/load.ts`, constants in `lib/consumption-data.ts`): daily load =
  `avgDailyConsumptionByMonth[m] + LOAD_SLOPE_KWH_PER_HDD · (HDD − hddNormalByMonth[m])`,
  `HDD = max(0, HDD_T_BASE_C − dailyMeanTemp)`. The monthly average is the level (captures
  non-temperature seasonality); temperature only adds a within-month heating term that
  self-zeroes in summer. These are all fitted to one household's own history — see DOMAIN.md's
  "Adapting to a new site" for how to regenerate them for yours. Intraday distribution uses
  **measured `hourShareByMonth`** (per-month hourly shares from the reference household's meter
  history — see `lib/load.ts`; regenerate yours with `scripts/tools/build-intraday-profile.py`):
  it replaced a uniform 1/96 split, which under-allocated winter load ~30-40% at exactly the
  morning/evening price peaks. Since 2026-07-18 the whole static shape is itself superseded at
  runtime by a **live trailing per-hour profile** from the telemetry readings
  (`readTrailingLoadProfile` in `lib/telemetry.ts`, ≥5 days of data required, HDD-ratio scaled
  for weather; `loadSource: 'live'`) — fitted shapes go stale as the household changes (measured
  ~25% low overnight after 4 years on the reference install), so the fitted model is now the
  fallback and the cold-snap sensitivity term, not the steady-state forecast. The DP additionally
  plans against load × `LOAD_FORECAST_MARGIN` (1.15) — see DESIGN-reserve.md §9 for the incident
  that motivated both.

### Where constants live

All domain constants (hardware specs, pricing rules, solar arrays) are in **`lib/constants.ts`**,
each overridable via an env var with the reference deployment's own value as the default — see
README.md's "Configuration" section. Do not scatter magic numbers across other files.

### Test coverage

```
lib/__tests__/prices.test.ts      Stockholm time parsing, DST offsets, computeMaxAge branches,
                                  currentSlotIndexInPrices incl. the 92/100-slot DST-transition days
lib/__tests__/slot-utils.test.ts  slotIndex, utcOffset, slotSolarKwh fallback logic
lib/__tests__/solar.test.ts       ghiToKwh, getSolarProfileByMonth, estimateDailyKwh
lib/__tests__/pipeline.test.ts    buildSolarProfiles (month boundary), buildOptimizerSlots
lib/__tests__/optimizer.test.ts   dispatch logic, SoC bounds, round-trip cost guard, net-load shifting,
                                  evaluateDispatch (trajectory pricing) + endSoc terminal constraint
lib/__tests__/oracle.test.ts      hindsight-oracle scoring: elapsed-time bucketing (incl. 92-slot DST
                                  day), armed coverage, no-battery baseline, regret ≥ 0 invariants
lib/__tests__/load.test.ts        dailyLoadKwh (HDD adjust, summer self-zero, floor), slotConsumptionKwh
lib/__tests__/chart-utils.test.ts buildActionBands, buildChartData (price/dispatch/SoC mapping), xTicks, avg
lib/__tests__/economics.test.ts   value-added vs no-battery, gap-capping, DST slot matching, roll-ups
lib/__tests__/telemetry-economics.integration.test.ts  real SQLite read → price lookup → value-added
lib/__tests__/telemetry-optimizer-run.test.ts  logOptimizerRun's socIsLive publish gate (fallback-SoC plans stay display-only)
lib/__tests__/inverter.test.ts    isValidInverterLiveData rejects malformed/missing-field live.json
lib/__tests__/constants-cross-language.test.ts  hardware constants stay in sync with the Python copies
```

### Data-processing scripts (offline, not part of the app build)

Onboarding order for a new site (see DOMAIN.md's "Adapting to a new site" for the full walkthrough):
process-smhi-data.ts → build-load-model.mjs → process-inverter-data.ts → build-solar-calibration.ts
(each depends on the previous one's output; run in this order, not standalone).

```
scripts/tools/process-smhi-data.ts        station GHI CSV → lib/irradiance-data.ts's avgGhiByMonthHour
scripts/tools/process-inverter-data.ts   monthly production/consumption averages from a combined CSV
scripts/tools/build-load-model.mjs        reads solar-data/*.csv + Open-Meteo Archive temps → HDD load-model
                                    constants (parses CSV directly; needs network)
scripts/tools/build-solar-calibration.ts  measured production ÷ raw GHI-model estimate → solarCalibrationByMonth
```

## Deployment & operations

See `README.md` for the quick-start and `deploy/README.md` for the full NUC/systemd setup guide.
Summary: the app + Python Modbus poller/dispatch loop run as systemd services on a dedicated
Linux box (not Vercel — this needs a persistent local process with LAN access to the inverter).
Nine systemd units (plus their timers), all reading `/opt/solinteg/solinteg.env` (mode 600,
holds secrets — never commit it) — see `deploy/README.md` for what each one does.

**Hardware gotchas (see MODBUS.md for the full register-level detail):**
- Inverter Modbus **unit/device id is 255 (0xFF)** on this inverter family, not 1.
- The inverter dongle accepts **one Modbus TCP connection at a time** — `dispatch_loop.py`
  connects only briefly (apply/re-assert, then closes) rather than holding a persistent
  connection like the poller does; see the module docstring for why a second brief connection
  is safe despite that limit.
- pymodbus **3.13** API: `read_holding_registers(addr, count=N, device_id=ID)` (not `slave=`).

**Safety model:** every register write is gated behind `SOLINTEG_CONTROL_ARMED` — unset, it's a
no-op (shadow mode: the dispatch loop computes and logs real decisions but never touches the
inverter). Set it only after you've independently verified your own inverter's sign convention
and setpoint persistence — see `scripts/tools/probe_50207_sign.py` / `scripts/tools/probe_setpoint_persistence.py`
and MODBUS.md. **Always re-verify the current armed state before assuming either way** — check
via `journalctl -u solinteg-dispatch -n 5` (look for `ARMED=True/False` in the startup line) or
`sudo grep ARMED /opt/solinteg/solinteg.env` (must be `sudo` — a plain read fails
permission-denied, which looks identical to "unset" if you swallow stderr).

The loop refuses to grid-fund a solar-planned charge: before forcing a charge it compares the
plan's assumed funding against live solar surplus and falls back to auto when forcing would buy
more from the grid than planned (`DISPATCH_SOLAR_SHORTFALL_KWH`) — logged as
`skipped_solar_shortfall`. A persistent `decide()` failure reverts to auto only once per failure
streak, not every tick forever, so it can't repeatedly stomp a manually-set work mode.

See MODBUS.md / DESIGN-reserve.md for the underlying register-level detail behind the control
loop described above.
