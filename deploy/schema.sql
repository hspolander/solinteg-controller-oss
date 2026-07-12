-- Canonical schema for telemetry.db (TELEMETRY_DB_PATH, default /opt/solinteg/telemetry.db).
--
-- This is the single source of truth for the shape of the shared telemetry database. Multiple
-- processes write it concurrently (WAL mode), each creating its own table(s) at startup with
-- CREATE TABLE IF NOT EXISTS. Keep those inline definitions in sync with THIS file:
--
--   readings         → scripts/services/modbus_poller.py   (inverter, every 30 s)
--   weather          → scripts/services/weather_poller.py  (Ecowitt cloud API, every 60 s)
--   room_climate     → scripts/services/uponor_poller.py   (Uponor Smatrix JNAP, every 300 s)
--   price_snapshots  → lib/telemetry.ts            (web app, per price fetch)
--   optimizer_runs   → lib/telemetry.ts            (web app, per optimizer run)
--   control_actions  → scripts/services/dispatch_loop.py    (dispatch decisions, on slot change / reassert)
--   oracle_daily     → lib/telemetry.ts            (web app, nightly via solinteg-oracle.timer)
--
-- WAL + a busy timeout are set by each writer so the concurrent access is safe.
-- This file documents the schema; it is not auto-applied (each writer creates its own tables).

PRAGMA journal_mode = WAL;

-- Inverter measurements. grid_w: +export/−import; battery_w: −charge/+discharge (as reported).
-- house_load_w is derived: inverter_ac_w − grid_w. soh_pct/battery_temp_c added 2026-07-02
-- (registers 33001/33003) — on a DB created before that date, modbus_poller.py adds these
-- columns via an additive ALTER TABLE migration at startup, since CREATE TABLE IF NOT EXISTS
-- is a no-op on an existing table.
CREATE TABLE IF NOT EXISTS readings (
    id             INTEGER PRIMARY KEY,
    timestamp      TEXT NOT NULL,   -- UTC ISO
    soc_pct        REAL,
    soc_kwh        REAL,
    soh_pct        REAL,            -- battery state of health, % — ground truth for the wear-cost
                                     -- model's assumed degradation curve (lib/constants.ts)
    battery_temp_c REAL,            -- plain U16 register, no negative-temp handling confirmed
    pv_w           INTEGER,
    grid_w         INTEGER,
    battery_w      INTEGER,
    inverter_ac_w  INTEGER,
    house_load_w   INTEGER,
    work_mode      TEXT,
    work_mode_raw  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ts ON readings(timestamp);

-- Local weather-station readings (Ecowitt GW1000). solar_wm2 is the value we care about most:
-- measured GHI, for calibrating the Open-Meteo solar forecast against site conditions.
CREATE TABLE IF NOT EXISTS weather (
    timestamp     TEXT PRIMARY KEY,  -- station observation time (UTC ISO), deduped
    fetched_at    TEXT NOT NULL,     -- when the cloud API was polled
    solar_wm2     REAL,
    uvi           REAL,
    temp_c        REAL,              -- outdoor
    humidity_pct  REAL,              -- outdoor
    wind_ms       REAL,
    wind_gust_ms  REAL,
    wind_dir_deg  REAL,
    pressure_hpa  REAL,              -- relative
    rain_rate_mmh REAL,
    rain_day_mm   REAL
);

-- Per-room climate from the Uponor Smatrix Pulse underfloor-heating controller (local JNAP
-- API, read-only). demand is the value that matters: actuator open = room actively calling
-- for heat — collected ahead of any optimizer use (evidence first, wiring second).
-- Temps arrive as deci-°F and are stored converted: °C = (raw − 320) / 18; the controller's
-- invalid-sensor sentinel (raw ≥ 4508) and no-RH-sensor sentinel (0) are stored as NULL.
-- head1/2_valve_pct, pwm_output_pct, valve_error added 2026-07-12 for comparing how hard
-- each room's loop works relative to the others (evidence first, wiring second) — a room's loop may be
-- split across two heads (larger rooms) or use only head1; head2 then reads 0, not NULL,
-- indistinguishable from "closed" (scripts/tools/analyze-room-heat-demand.py takes
-- max(head1, head2) as the room's combined valve-open %). Values not yet observed under
-- real heating load (added mid-July, system idle) — cross-check against the app in winter.
CREATE TABLE IF NOT EXISTS room_climate (
    timestamp       TEXT NOT NULL,      -- poll time (UTC ISO) — instantaneous state, no device time exists
    thermostat      TEXT NOT NULL,      -- Uponor id 'C{controller}_T{thermostat}', e.g. 'C1_T1'
    room_temp_c     REAL,               -- NULL = sensor invalid (controller sentinel)
    setpoint_c      REAL,
    rh_pct          REAL,               -- NULL = no humidity sensor
    demand          INTEGER,            -- 1 = actuator open (room actively heating/cooling)
    eco             INTEGER,            -- 1 = thermostat in ECO setback
    sys_heat_cool   INTEGER,            -- system-wide: 0 = heating, 1 = cooling
    sys_away        INTEGER,            -- system-wide forced-ECO ("away") active
    head1_valve_pct REAL,               -- 0-100, this loop's valve opening
    head2_valve_pct REAL,               -- 0-100; reads 0 (not NULL) on a single-head room
    pwm_output_pct  REAL,               -- 0-100 modulation duty, independent of valve position
    valve_error     INTEGER,            -- 1 = controller-detected valve/actuator fault
    PRIMARY KEY (timestamp, thermostat)
);

-- The daily price curve the optimizer planned against. Upserted on date: the last write of the
-- day wins, so the post-13:00 snapshot (today + tomorrow) supersedes the morning's today-only one.
CREATE TABLE IF NOT EXISTS price_snapshots (
    date         TEXT PRIMARY KEY,   -- Stockholm 'today'; row holds today+tomorrow slots
    logged_at    TEXT NOT NULL,
    has_tomorrow INTEGER NOT NULL,
    prices_json  TEXT NOT NULL       -- PriceData.prices: buy/sell per 15-min slot
);

-- One optimizer execution: inputs (per-slot forecast solar/load, start SoC) and dispatch output.
-- Join inputs_json (forecast) against readings (actual) by timestamp for forecast-vs-actual.
-- Each OptimizerSlot in inputs_json carries solarSource ('forecast'|'typical')
-- and loadSource ('modeled'|'baseline') (added 2026-07-02): filter to 'forecast'/'modeled' before
-- treating an error as a real forecast/model miss — a 'typical'/'baseline' slot means the live
-- forecast/temperature wasn't available for that slot, so its error reflects climatology's
-- limits, not the live pipeline's actual skill.
CREATE TABLE IF NOT EXISTS optimizer_runs (
    id            INTEGER PRIMARY KEY,
    logged_at     TEXT NOT NULL,
    price_date    TEXT NOT NULL,      -- links to price_snapshots.date
    has_tomorrow  INTEGER NOT NULL,
    start_soc_kwh REAL NOT NULL,
    inputs_json   TEXT NOT NULL,      -- OptimizerSlot[]: buy, sell, solarKwh, consumptionKwh
    dispatch_json TEXT NOT NULL       -- DispatchSlot[]: action, gridKwh, socAfter per slot
);
CREATE INDEX IF NOT EXISTS idx_runs_date ON optimizer_runs(price_date);

-- Audit trail for the dispatch loop: every decision it made against the live plan, whether
-- armed or not. planned_action/power_w are what the loop decided to apply — AFTER a guard
-- below may have demoted the plan's action to idle (the plan's original action is implied by
-- the skip outcome); when armed=0, every row still shows what WOULD have been written — lets
-- you validate the loop's decisions against the live plan before ever arming it. outcome:
--   'applied'             — planned_action/power_w were sent as-is (or no-op'd if disarmed). For
--                           charge/discharge rows, detail ALSO holds the expected/actual/drift
--                           SoC values checked against SOC_DIVERGENCE_KWH (dispatch_loop.py) —
--                           recorded on every such decision, not only ones that exceed the
--                           threshold, specifically so the threshold can eventually be tuned
--                           against the real everyday drift distribution.
--                           Charge rows additionally lead with the solar-funding numbers (below).
--   'skipped_divergence'  — that same drift exceeded SOC_DIVERGENCE_KWH; the loop distrusted the
--                           stale plan and reverted to auto instead of forcing a power target
--                           computed from the wrong starting point. detail holds the same
--                           expected/actual/drift values as above.
--   'skipped_solar_shortfall' — the plan funded this charge (mostly) from forecast solar, but
--                           live surplus (pv_w − house_load_w) implied forcing it would buy more
--                           than DISPATCH_SOLAR_SHORTFALL_KWH extra from the grid, so the loop
--                           fell back to auto — which still charges from any real surplus.
--                           detail holds planned vs projected grid kWh; the same numbers are on
--                           every charge decision (not only skips) for threshold tuning.
--   'error_reverted'      — applying planned_action failed, but the fall-back return_to_auto
--                           succeeded. detail holds the original error.
--   'error_revert_failed' — applying planned_action failed AND the fall-back revert also
--                           failed — the inverter's actual state is not confirmed by this row.
--                           detail holds both errors.
CREATE TABLE IF NOT EXISTS control_actions (
    id             INTEGER PRIMARY KEY,
    timestamp      TEXT NOT NULL,   -- UTC ISO
    slot_time      TEXT,            -- naive Stockholm local slot start, matches DispatchSlot.startTime
    planned_action TEXT NOT NULL,   -- 'charge' | 'discharge' | 'idle'
    power_w        INTEGER,
    armed          INTEGER NOT NULL,
    outcome        TEXT NOT NULL,   -- 'applied' | 'skipped_divergence' | 'skipped_solar_shortfall'
                                    --  | 'error_reverted' | 'error_revert_failed'
    detail         TEXT,            -- human-readable context: error message, divergence values, or
                                    -- why idle (missing plan/slot) — free text, for logs/journalctl
    detail_json    TEXT             -- added 2026-07-03: the SAME figures as `detail`, structured, for
                                    -- the dashboard's Dispatch card gauges. Keys (all optional — a
                                    -- missing key means that check didn't run this decision):
                                    --   buy_ore, sell_ore                             — this slot's price
                                    --   solar_shortfall_kwh, solar_shortfall_limit_kwh — charge actions only
                                    --   soc_drift_kwh, soc_drift_limit_kwh             — charge/discharge only
                                    --   grid_kwh                                       — discharge only: the plan's
                                    --                                                    net grid exchange for the
                                    --                                                    slot (+import/−export)
                                    -- Deliberately never parsed FROM `detail` (regex on a log sentence
                                    -- is fragile) — both are built independently from the same source
                                    -- numbers in dispatch_loop.py.
);
CREATE INDEX IF NOT EXISTS idx_control_ts ON control_actions(timestamp);

-- Hindsight-oracle scoring, one row per completed Stockholm day D — computed by lib/oracle.ts,
-- written via /api/oracle, triggered by solinteg-oracle.timer.
-- Day D is scored inside a 48 h window ending after D+1 so the oracle plans across midnight
-- exactly like production does; carried SoC is credited at its hindsight-true continuation
-- value on both sides (see lib/oracle.ts's header for the full fairness argument).
-- regret_ore = oracle_total_ore − achieved_total_ore ≥ 0 up to model-vs-reality mismatch;
-- regret_intraday_ore (same start AND end SoC as reality — pure within-day timing) +
-- regret_carry_ore (cost of handing D+1 the wrong SoC) = regret_ore.
-- Headline numbers are the status='ok' rows only: 'shadow' = armed < 90% of the day (the bar
-- is 90%, not ~100%: without solinteg-telemetry.timer's 00:03 Stockholm entry the dispatch
-- loop is structurally planless/silent for the first 1-2 h after every Stockholm midnight —
-- genuinely armed days then measure only 0.92-0.97; with it they score ~0.99), 'degraded' = reading coverage < 95% or a midnight SoC
-- anchor interpolated across > 30 min, 'skipped_no_readings' = unscorable.
-- All money in öre; kr = öre / 100.
CREATE TABLE IF NOT EXISTS oracle_daily (
    date                      TEXT PRIMARY KEY,  -- Stockholm day D being scored
    computed_at               TEXT NOT NULL,
    status                    TEXT NOT NULL,     -- 'ok'|'shadow'|'degraded'|'skipped_no_readings'
    armed_fraction            REAL,              -- time-weighted, from control_actions
    reading_coverage          REAL,              -- min(day D, day D+1) slot coverage, 0..1
    start_soc_kwh             REAL,              -- real SoC at D 00:00 (both oracle and reality start here)
    achieved_end_soc_kwh      REAL,              -- real SoC at D+1 00:00
    oracle_end_soc_kwh        REAL,              -- where the 48 h oracle crosses midnight
    baseline_net_ore          REAL,              -- no-battery counterfactual for day D
    achieved_cash_ore         REAL,              -- economics.ts meter cash for day D (netKr × 100)
    achieved_wear_ore         REAL,              -- Σ|ΔSoC| across day-D slots × wear cost
    achieved_continuation_ore REAL,              -- contV(achieved_end_soc): optimal D+1 value from there
    achieved_total_ore        REAL,              -- cash − wear + continuation
    oracle_day_cash_ore       REAL,              -- day-D slice of the oracle trajectory
    oracle_day_wear_ore       REAL,
    oracle_total_ore          REAL,              -- full 48 h oracle value (cash − wear)
    regret_ore                REAL,
    regret_intraday_ore       REAL,              -- NULL if the terminal-constrained DP was infeasible
    regret_carry_ore          REAL,
    params_json               TEXT NOT NULL,     -- battery/price constants used — config drift makes
                                                 -- old rows incomparable unless recomputed (force=1)
    oracle_dispatch_json      TEXT,              -- DispatchSlot[] for day D (future dashboard overlay)
    diagnostics_json          TEXT               -- coverage detail + day-D energy-balance residual
                                                 -- (pv + import − load − export − ΔSoC): systematically
                                                 -- nonzero ⇒ model physics drift from the real meter,
                                                 -- the one case where negative regrets mean something
);
