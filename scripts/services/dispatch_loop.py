#!/usr/bin/env python3
"""
Dispatch loop: applies the web app's DP battery plan to the real inverter.

Reads the latest optimizer_runs row for today (dispatch_json: DispatchSlot[] — the same
plan shown on the dashboard) from telemetry.db, finds the entry for the current 15-min
Stockholm slot, and drives the inverter to match it via inverter_control.py's
force_charge/force_discharge/return_to_auto. Runs continuously, re-checking every
DISPATCH_LOOP_INTERVAL_S and re-asserting an unchanged CHARGE/DISCHARGE target at least
every DISPATCH_REASSERT_S (cheap insurance — see MODBUS.md's setpoint-persistence probe,
which confirmed a written setpoint holds for a full slot on its own, so this isn't
load-bearing, just a backstop). An unchanged IDLE target is never re-asserted on a timer,
only on an actual transition into it — General mode doesn't decay on its own, and
periodically re-writing it would blindly overwrite a mode the owner set by hand via the
inverter's own app. The very first decision after a (re)start is always applied
regardless (last_target starts as None), which is what self-heals a setpoint a crashed
prior instance left forced.

CONNECTION MODEL: this process does NOT hold a persistent Modbus connection — it opens
one only to apply/re-assert a target, then closes it immediately. It runs as a fully
separate process from modbus_poller.py (which does hold a persistent connection).
Empirically (2026-07-02) the poller's connection ran undisturbed through five separate
connect/write/close cycles from other scripts, including two that held a connection for
16+ minutes each — a second, brief, on-demand connection appears safe on this dongle.
Keeping this loop's connections brief and infrequent (at most once a minute) minimizes
overlap regardless, rather than relying on that finding being airtight.

SAFETY:
  - Disarmed by default (SOLINTEG_CONTROL_ARMED unset in solinteg.env) — every register
    write is a no-op (see inverter_control.write_u16), so this is safe to run
    continuously in shadow mode: it computes and logs every decision it WOULD make
    against the live plan, without ever touching a register. Note idle-slot decisions
    never even open a connection when disarmed (return_to_auto's writes short-circuit
    before connecting); charge/discharge decisions still open a connection to read the
    real SoC for the ceiling/floor check inside force_charge/force_discharge, but write
    nothing.
  - Every decision is logged to the control_actions table (timestamp, slot, planned
    action, power, armed, outcome) — see deploy/schema.sql.
  - No optimizer plan for today, or no matching slot, is treated as 'idle'
    (return_to_auto) — never silently left on a stale forced setpoint because data is
    missing.
  - A failed apply attempts return_to_auto as its own fail-safe rather than leaving a
    half-applied setpoint — reverted before the failure is logged, so a telemetry.db
    write error (shared WAL db, contention is realistic) can never skip the revert.
    If that fail-safe revert ALSO fails (outcome 'error_revert_failed', e.g. a Modbus
    outage spanning both calls), last_target is deliberately NOT recorded, so the next
    tick retries the apply/revert instead of treating the target as handled — otherwise
    an unchanged idle target would never be re-attempted and the previous slot's forced
    setpoint could keep running (added 2026-07-08).
  - A failure in decide() itself (e.g. a corrupt dispatch_json row) also triggers a
    best-effort revert, so a run of bad data can't leave a previous slot's forced setpoint
    running indefinitely just because a new one can't be computed. Only the FIRST failure of
    a streak reverts (decide_failure_reverted, in the main loop) — once armed, a persistent
    failure (the same bad row on every tick) must not re-write the register every 60s
    forever, which would repeatedly stomp any mode the owner set by hand via the inverter's
    own app. The flag clears the moment decide() succeeds again, so a fresh failure later
    still reverts.
  - Before forcing a charge/discharge, actual live SoC is checked against the plan's
    assumed starting SoC for this slot (DISPATCH_SOC_DIVERGENCE_KWH). The plan is only as fresh as
    the last optimizer_runs row — an unexpectedly sunny/cloudy stretch can leave actual
    SoC well off its trajectory for up to an hour — and slot_power_w's calculated power is
    only correct relative to the plan's assumed baseline, not the real one. Beyond the
    threshold we no longer trust that number and fall back to auto (logged as
    'skipped_divergence') instead of forcing a target computed from a stale starting point.
    The expected/actual/drift values are logged in `detail` on EVERY such check, not just
    ones that trip the threshold — query control_actions for that history if you want to
    tune the threshold itself against real data instead of a guess.
  - Before forcing (or continuing to force) a CHARGE, the plan's funding for it is
    checked against live solar (check_solar_funding) — on EVERY loop iteration while
    the charge is active, not just at the moment it starts. decide() re-reads live.json
    and re-runs the check every LOOP_INTERVAL_S, and that result is folded into the
    target used for the apply decision (see the main loop), so a cloud rolling in
    mid-slot triggers an immediate fallback to auto rather than waiting for the slot
    boundary or the next DISPATCH_REASSERT_S. The DP plans each charge against forecast
    solar; force_charge opens grid import at the full cap, so if that solar doesn't
    materialize the inverter would silently buy the difference at full price — the one
    place a forecast miss directly costs money. From the same optimizer_runs row's
    inputs_json we compute how much of the charge the plan meant to fund from solar
    surplus vs the grid, compare with the live surplus (pv_w − house_load_w from the
    poller's live.json), and if forcing it would buy more than
    DISPATCH_SOLAR_SHORTFALL_KWH beyond the plan we fall back to auto instead (logged
    as 'skipped_solar_shortfall'; if solar recovers mid-slot, the same per-iteration
    check flips back and forcing resumes at the plan's target). Auto (self-use) still
    charges from whatever surplus actually exists, so skipping wastes no real solar. If
    live.json is missing or stale the check can't see current solar, so slots the plan
    funds mostly from solar are skipped conservatively. Funding numbers are logged in
    `detail` on EVERY forced-charge decision (like the SoC-divergence numbers) so the
    threshold can be tuned from real control_actions data.
  - An idle decision only writes the auto/General register when the loop's own last
    confirmed write left something else set (loop_in_auto, main loop) — idle slot
    boundaries still log their control_actions row (armed-coverage measurement reads row
    cadence as "loop alive", see lib/oracle.ts's ARMED_SEGMENT_CAP_MS), but no longer
    re-poke General mode every 15 min, which would blindly overwrite a mode the owner set
    by hand via the inverter's own app.
  - SIGTERM/SIGINT and normal shutdown always revert to auto.
  - Every loop iteration — idle or not, successful or not — touches a heartbeat file
    (DISPATCH_HEARTBEAT_PATH). This is deliberately NOT the same signal as a fresh
    control_actions row: those are only written on an actual target change or the periodic
    reassert, so a long, healthy idle stretch can leave control_actions silent for hours by
    design (see the reassert comment above) — that silence must not look like a dead loop.
    scripts/services/watchdog.py, a separate process, watches this file: if it goes stale while
    armed, it forces the inverter back to auto itself, since a hard crash here (OOM kill,
    power loss) skips this script's own SIGTERM/SIGINT fail-safe entirely.

REPLAN TRIGGERS: beyond the timer-driven render cadence
  (at least hourly via solinteg-telemetry.timer, plus AutoRefresh every 5 min, plus any
  real page view), this loop can now ask the web app to compute a fresh plan the moment it
  notices the CURRENT one looks wrong, rather than only ever consuming whichever optimizer_runs
  row happens to be newest. maybe_request_replan() below is a small, debounced, fire-and-forget
  POST to DISPATCH_REPLAN_URL, called from five places: preemptive SoC drift past
  DISPATCH_REPLAN_DRIFT_KWH (deliberately tighter, and checked earlier, than
  DISPATCH_SOC_DIVERGENCE_KWH itself — the idea is that a fresh, live-anchored plan usually
  already exists by the time drift would otherwise cross that guard's own wider threshold), an
  actual skipped_divergence or skipped_solar_shortfall outcome, no plan row covering "now" at
  all, and today's plan still missing tomorrow's prices (has_tomorrow == 0) once it's past
  13:05 Stockholm — Nord Pool's day-ahead release window (see DOMAIN.md). This is a NUDGE, never
  a dependency: POST /api/replan runs the exact same producePlan() a normal dashboard render
  already calls (see lib/plan.ts), so every way this can end up doing nothing — the
  DISPATCH_REPLAN_TRIGGERS=0 kill switch, still being inside the DISPATCH_REPLAN_DEBOUNCE_S
  window, "shadow" mode (logs the decision, never calls out), or the HTTP request itself
  erroring or timing out — degrades to EXACTLY the behaviour from before this feature existed:
  the loop keeps acting on the newest optimizer_runs row and simply waits for the next
  timer-driven render to produce a fresher one. It never touches a register, a guard threshold,
  or a fail-safe path directly — it can only ever cause the WEB APP to compute (and, SoC
  permitting — see logOptimizerRun's publish gate — publish) a plan sooner than the timer
  schedule would have on its own.

Environment variables (beyond inverter_control.py's own SOLINTEG_* / SOLINTEG_CONTROL_ARMED):
  TELEMETRY_DB_PATH             SQLite path (default /opt/solinteg/telemetry.db)
  DISPATCH_LOOP_INTERVAL_S      how often to check for a slot change (default 60)
  DISPATCH_REASSERT_S           max time between re-writes of an unchanged target (default 300)
  DISPATCH_SOC_DIVERGENCE_KWH   max |plan-assumed − actual| starting SoC (kWh) before a
                                forced target is skipped as stale (default 3.0; logged as
                                'skipped_divergence')
  DISPATCH_SOLAR_SHORTFALL_KWH  extra grid kWh a forced charge may buy vs the plan before
                                falling back to auto (default 0.5)
  INVERTER_DATA_PATH            the poller's live.json (default /opt/solinteg/live.json)
  DISPATCH_HEARTBEAT_PATH       liveness file for scripts/services/watchdog.py (default
                                /opt/solinteg/dispatch-heartbeat.json)
  DISPATCH_REPLAN_TRIGGERS=0 kill switch, still being inside the DISPATCH_REPLAN_DEBOUNCE_S
  window, "shadow" mode (logs the decision, never calls out), or the HTTP request itself
  erroring or timing out — degrades to EXACTLY the behaviour from before this feature existed:
  the loop keeps acting on the newest optimizer_runs row and simply waits for the next
  timer-driven render to produce a fresher one. It never touches a register, a guard threshold,
  or a fail-safe path directly — it can only ever cause the WEB APP to compute (and, SoC
  permitting — see logOptimizerRun's publish gate — publish) a plan sooner than the timer
  schedule would have on its own.

Environment variables (beyond inverter_control.py's own SOLINTEG_* / SOLINTEG_CONTROL_ARMED):
  TELEMETRY_DB_PATH             SQLite path (default /opt/solinteg/telemetry.db)
  DISPATCH_LOOP_INTERVAL_S      how often to check for a slot change (default 60) — also the
                                dominant bound on how fast live_discharge_power_w can react to
                                a sudden load (e.g. a heat pump compressor starting): worst case
                                is roughly this value + POLL_INTERVAL (modbus_poller.py's own
                                sampling interval, live.json can't be fresher than that) + the
                                apply latency (~1 s now that inverter_control.py's fast path
                                skips redundant setup writes when already mid-discharge, ~8-9 s
                                on the first entry into a forced setpoint). Safe to lower well
                                below the 60 s default for this reason — the fast path means a
                                shorter interval mostly just means more (cheap, ~1 s) on-demand
                                Modbus connections rather than more long ones; still worth
                                watching journalctl for connection errors after lowering it a
                                lot, since the underlying dongle only tolerates one connection
                                at a time (see MODBUS.md) and this doesn't change that ceiling,
                                just how often it's approached.
  DISPATCH_REASSERT_S           max time between re-writes of an unchanged target (default 300)
  DISPATCH_SOC_DIVERGENCE_KWH   max |plan-assumed − actual| starting SoC (kWh) before a
                                forced target is skipped as stale (default 3.0; logged as
                                'skipped_divergence')
  DISPATCH_SOLAR_SHORTFALL_KWH  extra grid kWh a forced charge may buy vs the plan before
                                falling back to auto (default 0.5)
  DISPATCH_LIVE_LOAD_TRACKING   "0" disables live_discharge_power_w's correction, reverting
                                discharge slots to the plan's fixed forecast-based power
                                (default "1" — on). Kill switch, not a tuning knob: flip to
                                "0" and restart the service if this ever needs to be ruled
                                out while investigating something else.
  DISPATCH_LIVE_LOAD_ROUND_W    live-tracked discharge target is rounded to the nearest this
                                many watts (default 100) — precision of the written setpoint,
                                not the write-frequency control (that's the deadband below).
  DISPATCH_LIVE_LOAD_DEADBAND_W same-slot same-action retargets smaller than this (default
                                250) are deferred to the next REASSERT_S write instead of
                                being applied on their own tick — stops ordinary load noise
                                from writing the register every tick, without touching the
                                reaction to a genuinely large change (which clears the band
                                immediately). Must be > DISPATCH_LIVE_LOAD_ROUND_W to have
                                any effect.
  INVERTER_DATA_PATH            the poller's live.json (default /opt/solinteg/live.json) —
                                POLL_INTERVAL (modbus_poller.py, default 30) governs how fresh
                                this can ever be, independent of this loop's own interval.
  DISPATCH_HEARTBEAT_PATH       liveness file for scripts/services/watchdog.py (default
                                /opt/solinteg/dispatch-heartbeat.json)
  DISPATCH_REPLAN_TRIGGERS      "1" (default) POSTs to DISPATCH_REPLAN_URL on the five trigger
                                conditions in the REPLAN TRIGGERS section above; "0" disables
                                the feature entirely (kill switch — reverts to the pre-feature,
                                timer-only cadence); "shadow" computes the same decision and
                                logs it (INFO) but never calls out, for watching trigger
                                frequency before it's allowed to touch the web app
  DISPATCH_REPLAN_DRIFT_KWH     preemptive SoC-drift threshold in kWh for requesting a replan
                                (default 1.5 — HALF of DISPATCH_SOC_DIVERGENCE_KWH's own
                                default, so this fires before that guard would ever need to
                                skip a forced target)
  DISPATCH_REPLAN_DEBOUNCE_S    minimum seconds between replan requests, regardless of which
                                trigger(s) fired or how many times in that window (default 120)
  DISPATCH_REPLAN_URL           where to POST the replan request (default
                                http://localhost:3000/api/replan — the web app runs on the same
                                NUC, see solinteg-web.service)
"""

import json
import logging
import os
import signal
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

import common  # sibling module (scripts/services/) — script dir is sys.path[0]
from inverter_control import (
    ARMED,
    Inverter,
    force_charge,
    force_discharge,
    return_to_auto,
    clamp_power_w,
)

log = logging.getLogger("solinteg.dispatch")

DB_PATH = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")
LOOP_INTERVAL_S = int(os.environ.get("DISPATCH_LOOP_INTERVAL_S", "60"))
REASSERT_S = int(os.environ.get("DISPATCH_REASSERT_S", "300"))
STOCKHOLM = ZoneInfo("Europe/Stockholm")
UTC = ZoneInfo("UTC")
SLOT_HOURS = 0.25
# One real source of truth: same env var name lib/constants.ts reads, matching hardcoded
# fallback default (kept in sync by lib/__tests__/constants-cross-language.test.ts).
BATTERY_KWH = float(os.environ.get("SOLINTEG_BATTERY_KWH", "25.6"))  # usable capacity
# How far actual SoC may drift from the plan's assumed starting point for this slot before
# we stop trusting the plan's calculated power and fall back to auto instead. The plan is
# only as fresh as the last optimizer_runs row (recomputed on a dashboard view, or hourly
# via solinteg-telemetry.timer) — an unexpectedly sunny/cloudy stretch can leave actual SoC
# meaningfully off the plan's trajectory for up to that long. A stale plan's power target
# is calculated from the WRONG baseline (see slot_power_w), so beyond this threshold we no
# longer trust it enough to force it blindly.
SOC_DIVERGENCE_KWH = float(os.environ.get("DISPATCH_SOC_DIVERGENCE_KWH", "3.0"))
# Solar-funding guard (see check_solar_funding): how much MORE grid energy a forced charge may
# buy than the plan intended before we fall back to auto instead. 0.5 kWh/slot = a sustained
# 2 kW of missing solar — small enough to cap the cost of a forecast bust, large enough that
# ordinary forecast noise doesn't constantly veto planned charges.
SOLAR_SHORTFALL_KWH = float(os.environ.get("DISPATCH_SOLAR_SHORTFALL_KWH", "0.5"))
LIVE_JSON_PATH = os.environ.get("INVERTER_DATA_PATH", "/opt/solinteg/live.json")
LIVE_MAX_AGE_S = 120  # same staleness rule as lib/inverter.ts
# Same env var lib/constants.ts's BATTERY_RT_EFF reads (kept in sync by the cross-language test).
BATTERY_RT_EFF = float(os.environ.get("SOLINTEG_BATTERY_RT_EFF", "0.96"))
ONE_WAY_EFF = BATTERY_RT_EFF ** 0.5
HEARTBEAT_PATH = os.environ.get("DISPATCH_HEARTBEAT_PATH", "/opt/solinteg/dispatch-heartbeat.json")


# See the module docstring's REPLAN TRIGGERS section for the full design. "0"/"1"/"shadow"
# (not a bare bool) so a rollout can watch the trigger rate in journalctl in shadow mode before
# it's allowed to actually reach the web app.
REPLAN_TRIGGERS = os.environ.get("DISPATCH_REPLAN_TRIGGERS", "1")
REPLAN_DRIFT_KWH = float(os.environ.get("DISPATCH_REPLAN_DRIFT_KWH", "1.5"))
REPLAN_DEBOUNCE_S = int(os.environ.get("DISPATCH_REPLAN_DEBOUNCE_S", "120"))
REPLAN_URL = os.environ.get("DISPATCH_REPLAN_URL", "http://localhost:3000/api/replan")

# Module-level: last time (time.monotonic(), immune to wall-clock jumps) a replan was actually
# requested — real POST or shadow-logged, either counts as "a request" for debounce purposes, so
# shadow mode's log line is itself rate-limited the same way the real call would be, rather than
# firing on every tick. 0.0 ("never") means the very first qualifying trigger always goes through.
_last_replan_request_monotonic = 0.0


def maybe_request_replan(reason: str) -> None:
    """Ask the web app to compute (and, live-SoC permitting, publish — see logOptimizerRun's
    publish gate) a fresh plan right now, instead of leaving this loop to act on a plan that's
    up to an hour stale until the next timer-driven render. See the module docstring's REPLAN
    TRIGGERS section for the full design and why every failure mode here is safe by construction.

    reason is one of "drift" / "divergence_skip" / "solar_shortfall" / "no_plan" /
    "awaiting_tomorrow" (see the five call sites) — carried only for the log line, so journalctl
    shows which condition is driving replan traffic.

    Never raises: disabled (DISPATCH_REPLAN_TRIGGERS=0) and still-debounced both return silently
    since neither is noteworthy; "shadow" logs at INFO and returns without calling out; a real
    request logs its outcome at INFO (success) or WARNING (any exception) but never propagates
    the exception — a dead/unreachable web app must degrade to the pre-feature timer cadence,
    not take down the tick that happened to notice the problem. Never retries on its own either;
    the debounce window is what stands in for a retry/backoff policy here. The only way this can
    delay the calling tick is the bounded 10 s request timeout below — an accepted cost, since
    the debounce keeps it to at most one attempt per DISPATCH_REPLAN_DEBOUNCE_S no matter how
    many ticks' worth of trigger conditions are true in that window.
    """
    global _last_replan_request_monotonic
    if REPLAN_TRIGGERS == "0":
        return
    if time.monotonic() - _last_replan_request_monotonic < REPLAN_DEBOUNCE_S:
        return
    _last_replan_request_monotonic = time.monotonic()

    if REPLAN_TRIGGERS == "shadow":
        log.info("replan trigger (shadow) reason=%s — DISPATCH_REPLAN_TRIGGERS=shadow, not calling %s", reason, REPLAN_URL)
        return

    try:
        req = urllib.request.Request(REPLAN_URL, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            log.info("replan trigger reason=%s -> POST %s HTTP %s", reason, REPLAN_URL, resp.status)
    except Exception as exc:  # noqa: BLE001 — a replan nudge must never affect the tick itself
        log.warning("replan trigger reason=%s failed (%s) — continuing on the existing plan", reason, exc)


def init_db(path: str) -> sqlite3.Connection:
    con = common.telemetry_connect(path)
    # Canonical schema for all telemetry.db tables: deploy/schema.sql — keep this in sync.
    con.execute("""
        CREATE TABLE IF NOT EXISTS control_actions (
            id             INTEGER PRIMARY KEY,
            timestamp      TEXT NOT NULL,
            slot_time      TEXT,
            planned_action TEXT NOT NULL,
            power_w        INTEGER,
            armed          INTEGER NOT NULL,
            outcome        TEXT NOT NULL,
            detail         TEXT,
            detail_json    TEXT
        )
    """)
    # Additive migration for DBs created before detail_json existed (2026-07-03) — same
    # pattern as modbus_poller.py's soh_pct/battery_temp_c migration: CREATE TABLE IF NOT
    # EXISTS is a no-op on an existing table, so old columns must be added explicitly.
    # Safe to run repeatedly: ignores "duplicate column" if already applied.
    try:
        con.execute("ALTER TABLE control_actions ADD COLUMN detail_json TEXT")
    except sqlite3.OperationalError:
        pass  # already applied
    con.execute("CREATE INDEX IF NOT EXISTS idx_control_ts ON control_actions(timestamp)")
    con.commit()
    return con


def log_action(con: sqlite3.Connection, slot_time, planned_action, power_w, outcome, detail="",
                detail_json: dict | None = None) -> None:
    """detail_json carries the exact figures behind this decision (buy/sell price,
    solar-shortfall, SoC-drift, each with its threshold) for the dashboard's Dispatch
    card gauges — see decide()'s docstring for where each field comes from. detail
    (free text) stays the human-readable log message; detail_json is never parsed
    from it, so future wording changes to `detail` can't silently break the UI."""
    con.execute(
        """INSERT INTO control_actions
           (timestamp, slot_time, planned_action, power_w, armed, outcome, detail, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (datetime.now(UTC).isoformat(), slot_time, planned_action, power_w,
         1 if ARMED else 0, outcome, detail,
         json.dumps(detail_json) if detail_json is not None else None),
    )
    con.commit()


def stockholm_date(now: datetime) -> str:
    return now.astimezone(STOCKHOLM).strftime("%Y-%m-%d")


def load_latest_plan(con: sqlite3.Connection, price_date: str):
    """The most recently logged optimizer run for this Stockholm date as
    (start_soc_kwh, dispatch slots, optimizer input slots, has_tomorrow), or
    (None, None, None, None). inputs_json rides along for the solar-funding check: it holds the
    per-slot forecast solarKwh/consumptionKwh the dispatch plan was computed from. has_tomorrow
    (added alongside the replan-trigger feature) is the plan's own record of whether tomorrow's
    day-ahead prices were released yet at the time it was computed — read here so the
    awaiting_tomorrow replan trigger in decide() doesn't need a second query."""
    row = con.execute(
        """SELECT start_soc_kwh, dispatch_json, inputs_json, has_tomorrow FROM optimizer_runs
           WHERE price_date = ? ORDER BY logged_at DESC LIMIT 1""",
        (price_date,),
    ).fetchone()
    if row is None:
        return None, None, None, None
    start_soc_kwh, dispatch_json, inputs_json, has_tomorrow = row
    return start_soc_kwh, json.loads(dispatch_json), json.loads(inputs_json), has_tomorrow


def slot_index_for_instant(dispatch: list, now: datetime):
    """Which array index in the plan covers `now`, found by REAL elapsed time since the
    plan's OWN FIRST SLOT rather than by matching DispatchSlot.startTime as a string.

    The web app slices the optimizer's input down to "from now onward" before solving
    (see lib/slot-utils.ts's currentSlotIndexInPrices) so optimizeDispatch's own index 0
    lines up with the live SoC reading it's given, instead of always being midnight —
    fixed 2026-07-03 after a mid-day SoC divergence bug traced to the old full-day
    version anchoring a live "right now" SoC reading to a fictitious midnight. That
    means dispatch[0] is whatever slot was current AT PLAN-COMPUTATION TIME, not
    today's midnight, so the elapsed-time anchor here has to be dispatch[0]'s own
    startTime, not price_date's midnight.

    DispatchSlot.startTime is a naive Stockholm local string (the UTC offset is stripped
    in lib/prices.ts) — on the autumn DST fall-back day, 02:00-03:00 local occurs twice,
    so two genuinely different array entries can share an identical string. Anchoring
    elapsed time off dispatch[0] (rather than matching each slot by string) sidesteps
    that the same way the old midnight-anchored version did, with one narrow residual
    edge case: if the plan itself was computed during that repeated hour, interpreting
    dispatch[0]'s own label is briefly ambiguous (Python's zoneinfo resolves to the
    first occurrence, fold=0) — at most one hour, one day a year, and self-correcting
    on the next replan (the web app recomputes on every page view and hourly via
    solinteg-telemetry.timer; this loop rechecks every LOOP_INTERVAL_S regardless).
    """
    if not dispatch:
        return None
    first_start = datetime.strptime(dispatch[0]["startTime"], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=STOCKHOLM)
    first_start_utc = first_start.astimezone(UTC)
    idx = int((now - first_start_utc).total_seconds() // (15 * 60))
    return idx if 0 <= idx < len(dispatch) else None


def expected_prev_soc_kwh(dispatch: list, idx: int, start_soc_kwh: float) -> float:
    """SoC the plan expected at the START of slot idx (its baseline for this slot's delta)."""
    return start_soc_kwh if idx == 0 else dispatch[idx - 1]["socAfter"]


def slot_power_w(dispatch: list, idx: int, prev_soc: float) -> int:
    """Battery power needed this slot to realize the planned socAfter transition."""
    delta_kwh = dispatch[idx]["socAfter"] - prev_soc
    return clamp_power_w(abs(delta_kwh) / SLOT_HOURS * 1000)


def read_live_solar_surplus_w(now: datetime):
    """Live PV surplus (pv_w − house_load_w, floored at 0) from the poller's live.json,
    or None if the file is missing, unreadable, or stale (> LIVE_MAX_AGE_S). The poller
    rewrites it every 30 s, so stale means the poller is down and we have no trustworthy
    picture of current solar."""
    try:
        with open(LIVE_JSON_PATH, encoding="utf-8") as f:
            data = json.load(f)
        age_s = (now - datetime.fromisoformat(data["timestamp"])).total_seconds()
        if age_s > LIVE_MAX_AGE_S:
            return None
        return max(0.0, float(data["pv_w"]) - float(data["house_load_w"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None


def check_solar_funding(inputs: list, idx: int, charge_kwh: float, surplus_w):
    """Should a forced charge fall back to auto because live solar can't fund it as planned?

    The DP prices each charge against the slot's forecast solar surplus; whatever that
    doesn't cover it accounts as a grid buy. force_charge opens grid import at the full
    cap and commands battery power, so if the forecast solar doesn't show up the inverter
    silently buys the difference at full price — the one place a forecast miss directly
    costs money. Compare the plan's intended grid share of this charge against what the
    live surplus implies, and skip when the extra buy would exceed SOLAR_SHORTFALL_KWH.
    Skipping wastes no real solar: auto (self-use) still charges from any actual surplus.

    surplus_w=None (no live data) skips conservatively when the plan funds more than the
    threshold from solar. Returns (skip, detail, numbers): detail always carries the
    numbers as human-readable text so the threshold can be tuned from telemetry; numbers
    carries the SAME figures structured (solar_shortfall_kwh/solar_shortfall_limit_kwh)
    for the dashboard's gauge — see log_action's detail_json. Empty dict when the check
    couldn't run at all (no optimizer inputs for this slot).
    """
    if not inputs or idx >= len(inputs):
        return False, "no optimizer inputs for slot — solar-funding check not possible", {}
    slot = inputs[idx]
    need_kwh = charge_kwh / ONE_WAY_EFF  # battery input energy incl. one-way losses
    planned_surplus_kwh = max(0.0, float(slot.get("solarKwh") or 0.0) - float(slot.get("consumptionKwh") or 0.0))
    planned_grid_kwh = need_kwh - min(planned_surplus_kwh, need_kwh)
    planned_solar_kwh = need_kwh - planned_grid_kwh

    if surplus_w is None:
        skip = planned_solar_kwh > SOLAR_SHORTFALL_KWH
        detail = (
            f"live solar unknown (live.json missing/stale); plan funds "
            f"{planned_solar_kwh:.2f} of {need_kwh:.2f} kWh from solar"
        )
        # No live surplus reading to compare against, so the "shortfall" here is the
        # whole plan-assumed solar share — the most conservative reading of the risk.
        numbers = {"solar_shortfall_kwh": round(planned_solar_kwh, 3), "solar_shortfall_limit_kwh": SOLAR_SHORTFALL_KWH}
        return skip, detail, numbers

    live_surplus_kwh = surplus_w / 1000.0 * SLOT_HOURS  # if the current surplus held all slot
    projected_grid_kwh = need_kwh - min(live_surplus_kwh, need_kwh)
    shortfall_kwh = projected_grid_kwh - planned_grid_kwh
    detail = (
        f"charge {need_kwh:.2f} kWh input: planned grid {planned_grid_kwh:.2f} kWh, "
        f"live surplus {surplus_w:.0f} W -> projected grid {projected_grid_kwh:.2f} kWh, "
        f"solar shortfall {shortfall_kwh:.2f} kWh (threshold {SOLAR_SHORTFALL_KWH})"
    )
    numbers = {"solar_shortfall_kwh": round(shortfall_kwh, 3), "solar_shortfall_limit_kwh": SOLAR_SHORTFALL_KWH}
    return shortfall_kwh > SOLAR_SHORTFALL_KWH, detail, numbers


def decide(con: sqlite3.Connection, now: datetime):
    """Returns (slot_time, action, power_w, expected_soc_kwh, solar_skip, detail, numbers).

    expected_soc_kwh is the plan's assumed starting SoC for this slot — None for idle/
    no-plan cases, where it's meaningless. The caller compares it against the actual live
    SoC before committing to a forced charge/discharge; see SOC_DIVERGENCE_KWH.

    solar_skip is True when a planned charge should fall back to auto because live solar
    can't fund it the way the plan assumed (see check_solar_funding); detail carries the
    funding numbers on every charge decision, tripped or not.

    numbers is a dict of the exact figures behind this decision — buy_ore/sell_ore for
    the current slot; solar_shortfall_kwh/solar_shortfall_limit_kwh for a charge action;
    grid_kwh (the plan's net grid exchange, +import/−export) for a discharge action, so
    the dashboard can tell a grid sale from covering the house load;
    next_action/next_action_time (the next non-idle slot's action + startTime) for an
    idle action, so the dashboard can say e.g. "next charge at 14:45" — for the
    dashboard's Dispatch card (see log_action's detail_json). Always a dict, never None;
    a key is simply absent when that particular check didn't run this iteration or there
    is no more non-idle activity left in the loaded plan. The caller (main()) adds
    soc_drift_kwh/soc_drift_limit_kwh to this SAME dict after the SoC-divergence check,
    since that needs a live inverter connection decide() doesn't hold.
    """
    price_date = stockholm_date(now)
    start_soc_kwh, dispatch, inputs, has_tomorrow = load_latest_plan(con, price_date)

    if dispatch is None:
        # No plan row at all for today — the loop is about to sit idle for lack of data, not
        # because that's what the plan calls for. Ask the web app to compute one now rather
        # than waiting for the next timer-driven render (see the module docstring's REPLAN
        # TRIGGERS section).
        maybe_request_replan("no_plan")
        return None, "idle", 0, None, False, f"no optimizer plan logged for {price_date}", {}

    idx = slot_index_for_instant(dispatch, now)
    if idx is None:
        # A plan exists but doesn't cover THIS instant (now is before its first slot or past
        # its last) — same "treated as idle for lack of a usable plan" situation as above.
        maybe_request_replan("no_plan")
        return None, "idle", 0, None, False, f"now falls outside the {len(dispatch)}-slot plan logged for {price_date}", {}

    # Once per tick (this is the only place in decide() reached once a valid plan+slot match is
    # found): if today's plan predates Nord Pool's day-ahead release and it's now past that
    # ~13:00 release window, ask for a replan so the DP can extend its horizon into tomorrow
    # instead of waiting for the 13:22/13:42 Stockholm timer entries
    # (see deploy/solinteg-telemetry.timer) to pick the new prices up on their own.
    now_stockholm = now.astimezone(STOCKHOLM)
    if has_tomorrow == 0 and (now_stockholm.hour, now_stockholm.minute) >= (13, 5):
        maybe_request_replan("awaiting_tomorrow")


    slot_time = dispatch[idx]["startTime"]  # the plan's own label, for logging only
    action = dispatch[idx]["action"]
    prev_soc = expected_prev_soc_kwh(dispatch, idx, start_soc_kwh)
    power_w = slot_power_w(dispatch, idx, prev_soc) if action != "idle" else 0

    numbers: dict = {}
    if inputs and idx < len(inputs):
        slot_inputs = inputs[idx]
        if slot_inputs.get("buyPrice") is not None:
            numbers["buy_ore"] = round(float(slot_inputs["buyPrice"]), 2)
        if slot_inputs.get("sellPrice") is not None:
            numbers["sell_ore"] = round(float(slot_inputs["sellPrice"]), 2)

    if action == "idle":
        # For the dashboard's "next action" framing on an idle slot — cheap to compute
        # since dispatch[] is already loaded; first non-idle slot at or after this one.
        for future in dispatch[idx + 1:]:
            if future["action"] != "idle":
                numbers["next_action"] = future["action"]
                numbers["next_action_time"] = future["startTime"]
                break

    if action == "discharge":
        # The plan's net grid exchange for this slot (+import/−export, DispatchSlot.gridKwh)
        # — lets the dashboard say whether this discharge sells to the grid or just covers
        # the house load, instead of labelling every discharge a grid sale.
        grid_kwh = dispatch[idx].get("gridKwh")
        if grid_kwh is not None:
            numbers["grid_kwh"] = round(float(grid_kwh), 3)

    solar_skip, detail = False, ""
    if action == "charge":
        # A bug in this advisory guard must degrade to "no check" (the old behaviour),
        # not throw — an exception here would put the outer loop into its
        # revert-every-iteration error path over what is only insurance.
        try:
            surplus_w = read_live_solar_surplus_w(now)
            charge_kwh = dispatch[idx]["socAfter"] - prev_soc
            solar_skip, detail, solar_numbers = check_solar_funding(inputs, idx, charge_kwh, surplus_w)
            numbers.update(solar_numbers)
        except Exception as exc:  # noqa: BLE001
            log.warning("solar-funding check failed (%s) — proceeding without it", exc)
            solar_skip, detail = False, f"solar-funding check failed: {exc}"
    return slot_time, action, power_w, prev_soc, solar_skip, detail, numbers


def apply_target(inv: Inverter, action: str, power_w: int) -> None:
    if action == "charge":
        force_charge(inv, power_w)
    elif action == "discharge":
        force_discharge(inv, power_w)
    else:
        return_to_auto(inv)


def write_heartbeat(now: datetime) -> None:
    """Touched every loop iteration regardless of outcome — see the module docstring's
    SAFETY note on why this, not control_actions freshness, is watchdog.py's liveness
    signal. Atomic write (temp file + rename) matching modbus_poller.py's live.json pattern."""
    tmp = HEARTBEAT_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"timestamp": now.isoformat()}, f)
        os.replace(tmp, HEARTBEAT_PATH)
    except OSError as exc:
        log.error("failed to write heartbeat: %s", exc)


def revert_best_effort() -> None:
    try:
        inv = Inverter()
        try:
            return_to_auto(inv)
        finally:
            inv.close()
    except Exception as exc:  # noqa: BLE001
        log.error("revert_best_effort failed: %s", exc)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    con = init_db(DB_PATH)
    log.info("Dispatch loop starting. ARMED=%s interval=%ds reassert=%ds",
              ARMED, LOOP_INTERVAL_S, REASSERT_S)
    if not ARMED:
        log.warning("Running DISARMED — decisions are computed and logged to "
                     "control_actions, but no register is actually written. "
                     "Safe for shadow-mode validation against the live plan.")

    last_target = None  # (slot_time, effective_action, effective_power) — post-guard, as applied
    # True when the loop's own last confirmed write/revert left the inverter in auto (or an
    # idle decision needed no write because of this flag). Gates idle register writes: an
    # idle decision while this is True logs its control_actions row but writes nothing, so
    # a mode the owner set by hand is never stomped by idle slot boundaries. Starts False
    # (inverter state unknown) so the first idle decision after a restart still writes auto
    # once — that's the self-heal for a setpoint a crashed prior instance left forced.
    loop_in_auto = False
    last_write_monotonic = 0.0
    # Set the moment decide() fails and we've reverted for it; cleared the moment decide()
    # succeeds again. Without this, a PERSISTENT decide() failure (e.g. a corrupt
    # dispatch_json row that never gets fixed) would call revert_best_effort() — and thus
    # write registers — on every single 60s tick forever, which once armed means repeatedly
    # stomping any mode the owner set by hand via the inverter's own app. One revert per
    # failure streak is enough; the fail-safe state doesn't need re-asserting on a timer any
    # more than a normal idle slot does (see the reassert comment below).
    decide_failure_reverted = False
    stop = {"flag": False}

    def _request_shutdown(*_args):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)

    while not stop["flag"]:
        iteration_now = datetime.now(UTC)
        try:
            slot_time, action, power_w, expected_soc_kwh, solar_skip, detail, numbers = decide(con, iteration_now)
            # decide() just succeeded — any prior failure streak is over. Reset last_target
            # to None too, matching the restart self-heal behaviour: the failure streak's
            # revert already forced auto, so whatever decide() computes now (even if it's the
            # exact same target as before the streak) must still be applied, not skipped
            # because it happens to equal a last_target from before the forced revert.
            if decide_failure_reverted:
                decide_failure_reverted = False
                last_target = None
            # Fold the solar-funding guard into the target itself (decide() re-checks
            # check_solar_funding against fresh live.json every call, i.e. every
            # LOOP_INTERVAL_S) so a mid-slot cloud pass — or solar recovering mid-slot —
            # is treated as a real target change and applied immediately, instead of
            # silently sitting on the previously-applied setpoint until the slot
            # boundary or the next REASSERT_S (up to 5 min of buying uncapped grid
            # power at full price during a forced charge the plan no longer funds).
            solar_skipped_now = action == "charge" and solar_skip
            effective_action = "idle" if solar_skipped_now else action
            effective_power = 0 if solar_skipped_now else power_w
            target = (slot_time, effective_action, effective_power)
            due_for_reassert = (time.monotonic() - last_write_monotonic) >= REASSERT_S
            # Idle reassertion is only insurance against a forced (charge/discharge)
            # setpoint drifting — General mode doesn't decay on its own, so re-poking it
            # on a timer would just blindly overwrite a mode the owner set by hand via the
            # inverter's own app. Still always apply on an actual target change (including
            # the very first decision after a restart, since last_target starts as None —
            # that's what self-heals a setpoint a crashed prior instance left forced).
            needs_apply = target != last_target or (due_for_reassert and effective_action != "idle")

            if needs_apply:
                inv = None  # opened lazily — an idle→idle slot boundary needs no connection
                applied_action, applied_power = action, power_w
                outcome = "applied"
                try:
                    if solar_skipped_now:
                        # Live solar can't fund this charge the way the plan assumed —
                        # forcing it would buy the difference from the grid at full price.
                        # Auto still charges from whatever surplus actually exists.
                        log.warning("slot=%s planned charge can't be solar-funded as "
                                    "planned (%s) — falling back to auto instead of "
                                    "buying the difference", slot_time, detail)
                        applied_action, applied_power = "idle", 0
                        outcome = "skipped_solar_shortfall"
                        maybe_request_replan("solar_shortfall")
                    elif action != "idle" and expected_soc_kwh is not None:
                        inv = Inverter()
                        actual_soc_kwh = inv.soc_pct() / 100 * BATTERY_KWH
                        drift = abs(actual_soc_kwh - expected_soc_kwh)
                        # Recorded on EVERY charge/discharge decision, not just ones that trip
                        # SOC_DIVERGENCE_KWH — this is what lets that threshold eventually be
                        # tuned from real data (the everyday drift distribution) rather than a
                        # guess. Appended to the funding detail (charge slots) rather than
                        # replacing it, so one row carries both guards.
                        soc_detail = (f"expected {expected_soc_kwh:.2f} kWh, actual "
                                      f"{actual_soc_kwh:.2f} kWh, drift {drift:.2f} kWh")
                        detail = f"{detail}; {soc_detail}" if detail else soc_detail
                        numbers["soc_drift_kwh"] = round(drift, 3)
                        numbers["soc_drift_limit_kwh"] = SOC_DIVERGENCE_KWH
                        if abs(drift) > REPLAN_DRIFT_KWH:
                            # Preemptive — a tighter, earlier threshold than SOC_DIVERGENCE_KWH
                            # below (see the module docstring's REPLAN TRIGGERS section): by the
                            # time drift would cross THAT guard's wider threshold, a fresh
                            # live-anchored plan is usually already in place from this nudge.
                            maybe_request_replan("drift")
                        if drift > SOC_DIVERGENCE_KWH:
                            log.warning(
                                "slot=%s action=%s planned from %.2f kWh but actual is %.2f kWh "
                                "(drift %.2f kWh > %.2f kWh) — plan is stale, falling back to "
                                "auto instead of forcing a power target computed from the wrong "
                                "starting point", slot_time, action, expected_soc_kwh,
                                actual_soc_kwh, drift, SOC_DIVERGENCE_KWH,
                            )
                            applied_action, applied_power = "idle", 0
                            outcome = "skipped_divergence"
                            maybe_request_replan("divergence_skip")
                    # Never stomp an owner-set mode: when the loop's own last write already
                    # left the inverter in auto, an idle decision (planned, or a guard demotion
                    # above) needs no register write — re-poking General mode at every idle
                    # slot boundary would blindly overwrite a mode set by hand via the
                    # inverter's app. The row below is STILL logged: it carries the skip
                    # outcomes, and armed-coverage measurement reads row cadence as "loop
                    # alive" (silence > ARMED_SEGMENT_CAP_MS counts as down — lib/oracle.ts).
                    if not (applied_action == "idle" and loop_in_auto):
                        if inv is None:
                            inv = Inverter()
                        apply_target(inv, applied_action, applied_power)
                    loop_in_auto = applied_action == "idle"
                    log_action(con, slot_time, applied_action, applied_power, outcome, detail, detail_json=numbers)
                    log.info("slot=%s action=%s power=%dW armed=%s -> %s%s",
                              slot_time, applied_action, applied_power, ARMED, outcome,
                              f" ({detail})" if detail else "")
                except Exception as exc:  # noqa: BLE001
                    log.error("apply failed for slot=%s action=%s power=%dW: %s — "
                              "falling back to auto", slot_time, applied_action, applied_power, exc)
                    # Revert first, log second — a DB error in log_action must never skip
                    # the fail-safe (telemetry.db is shared WAL, contention is realistic).
                    try:
                        if inv is None:
                            inv = Inverter()
                        return_to_auto(inv)
                        outcome, detail = "error_reverted", str(exc)
                        loop_in_auto = True
                    except Exception as exc2:  # noqa: BLE001
                        log.error("fail-safe return_to_auto also failed: %s", exc2)
                        outcome, detail = "error_revert_failed", f"{exc} | revert also failed: {exc2}"
                        loop_in_auto = False  # inverter state unconfirmed — next idle must write
                    try:
                        log_action(con, slot_time, applied_action, applied_power, outcome, detail, detail_json=numbers)
                    except Exception as exc3:  # noqa: BLE001
                        log.error("log_action failed after apply error: %s", exc3)
                finally:
                    if inv is not None:
                        inv.close()
                if outcome == "error_revert_failed":
                    # Both the apply AND the fail-safe revert failed — the inverter
                    # may still be running the PREVIOUS slot's forced setpoint.
                    # Recording last_target here would make an unchanged idle target
                    # never retry (needs_apply requires a target change or a non-idle
                    # reassert), leaving that stale setpoint running until the next
                    # slot boundary — or forever when slot_time is None. Leave it
                    # unset so the very next tick retries the apply/revert.
                    last_target = None
                else:
                    last_target = target
                last_write_monotonic = time.monotonic()
        except Exception as exc:  # noqa: BLE001
            # decide() itself failed (e.g. a corrupt dispatch_json row) — we don't know
            # the intended action, but we must not leave a previous slot's forced setpoint
            # running indefinitely just because this iteration couldn't compute a new one.
            # Only revert on the FIRST failure of a streak — see decide_failure_reverted's
            # definition above for why a persistent failure must not re-revert every tick.
            if not decide_failure_reverted:
                log.error("loop iteration failed: %s — falling back to auto", exc)
                revert_best_effort()
                decide_failure_reverted = True
            else:
                log.error("loop iteration still failing (%s) — already reverted, not re-writing", exc)

        # Always touched, success or failure — see write_heartbeat's docstring.
        write_heartbeat(datetime.now(UTC))

        for _ in range(LOOP_INTERVAL_S):
            if stop["flag"]:
                break
            time.sleep(1)

    log.info("Shutting down — reverting to auto.")
    revert_best_effort()


if __name__ == "__main__":
    main()
