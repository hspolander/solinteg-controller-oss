#!/usr/bin/env python3
"""
Solinteg system healthcheck: periodic sweep of telemetry.db for signs the pipeline has
degraded, with push alerts via notify.py.

Distinct from watchdog.py (which ONLY guards against a stuck armed setpoint and is kept
deliberately minimal): this covers the rest of "is the system actually working" — poller/
weather staleness, a missing daily price/battery plan, and dispatch errors. None of these
need an inverter-safety response, just your attention; see watchdog.py for the one that does.

Run as a one-shot systemd timer (deploy/solinteg-healthcheck.timer), a few minutes' interval.

Alerts are de-duplicated via a small state file. An issue alerts when it is new, when its
CLASSIFICATION changes (a check's optional 5th tuple element, defaulting to its severity — see
should_alert()), or when HEALTHCHECK_ALERT_COOLDOWN_S has passed and it is still unresolved.
It is declared resolved, with a ✅ notice, only after HEALTHCHECK_RESOLVE_QUIET_S with no
recurrence. One-shot notices (state keys prefixed "oneshot:") are different: sent exactly once
ever, never repeated, never "resolved" — for milestones rather than problems.

These rules were rewritten after the simpler ones behaved badly on an INTERMITTENT fault, which
is worth knowing if you are tempted to simplify them back. Resolving after a single clean run
deleted the state entry, so the next occurrence took the "new" path and pushed again: a flapping
hardware fault (a degrading Modbus link, recurring every few hours) cost an alert plus a
"resolved" notice every single time, and the multi-hour cooldown never engaged at all. The two
fixes are symmetric — hold the entry through a quiet period so a recurrence is recognised as the
same standing issue, and compare classification rather than mere presence so an alert still fires
the moment the KIND of failure changes.

Environment (beyond notify.py's own NTFY_*):
  TELEMETRY_DB_PATH             SQLite path (default /opt/solinteg/telemetry.db)
  HEALTHCHECK_STATE_PATH        dedup state (default /opt/solinteg/healthcheck-state.json)
  HEALTHCHECK_ALERT_COOLDOWN_S  minimum time between repeat alerts for the same issue
                                (default 14400 = 4 h)
  HEALTHCHECK_RESOLVE_QUIET_S   how long an issue must be absent before it is declared resolved
                                (default 10800 = 3 h) — set well above the recurrence gap of a
                                flapping fault, else each blip reads as a brand-new issue
  PLAN_GRACE_AFTER_MIDNIGHT_S   suppress the "no prices/plan today" checks this long after
                                Stockholm midnight (default 1800) — the rows only exist once
                                the first post-midnight render lands (solinteg-telemetry.timer
                                runs a few minutes past midnight for exactly this)
  ORACLE_REVIEW_MIN_DAYS        one-shot: send a single "oracle-review data is ready" notice
                                once this many status='ok' oracle_daily rows exist
                                (default 16; 0 disables)
  PROBE_READY_MIN_PV_W          daily notice: live conditions suit
                                scripts/tools/probe_50209_pv_only.py right now. The value is
                                the PV floor in W. **Default 0 = OFF** — this is opt-in,
                                since it is a "go run this probe" nag and most installs never
                                need to. Set e.g. 3000 to enable. See probe_conditions_ready()
                                for what the other thresholds mean and when it is worth it.
  PROBE_READY_WINDOW_S          how far back the conditions window looks (default 600)
  PROBE_READY_MAX_PV_SWING      max (pv_max-pv_min)/pv_max across the window (default 0.25)
  PROBE_READY_MIN_SURPLUS_W     min avg(pv) - avg(house_load) (default 2000)
  PROBE_READY_MAX_SOC_PCT       max current SoC, so the charge has headroom (default 85)
  PROBE_READY_MIN_SAMPLES       min readings in the window to trust min/max (default 30)
  POLLER_STALE_S                readings table max age before flagging (default 300 — 10x
                                the poller's 30 s interval)
  WEATHER_STALE_S               weather table max age before flagging (default 1800 — the
                                station's own upload cadence varies more than the poll
                                interval, so this needs more slack than the poller's)
  CONTROL_ERROR_WINDOW_S        how far back to look for error_reverted/error_revert_failed
                                rows (default 900)
  DISK_FREE_MIN_PCT            minimum free space on / before alerting (default 10) - a full
                                disk breaks telemetry writes and the nightly backup alike
"""
import logging
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Sibling modules (scripts/services/) — script dir is sys.path[0].
import common
import notify

log = logging.getLogger("solinteg.healthcheck")

DB_PATH = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")
STATE_PATH = os.environ.get("HEALTHCHECK_STATE_PATH", "/opt/solinteg/healthcheck-state.json")
ALERT_COOLDOWN_S = int(os.environ.get("HEALTHCHECK_ALERT_COOLDOWN_S", "14400"))
# How long an issue must stay ABSENT before it counts as resolved. Must be comfortably longer
# than the gap between recurrences of a flapping fault, or the state entry gets dropped between
# blips and every blip reads as a brand-new issue (see the resolve sweep in main()). The default
# is sized against a fault recurring every few hours; a fault quieter than this is genuinely
# worth an all-clear.
RESOLVE_QUIET_S = int(os.environ.get("HEALTHCHECK_RESOLVE_QUIET_S", "10800"))
POLLER_STALE_S = int(os.environ.get("POLLER_STALE_S", "300"))
WEATHER_STALE_S = int(os.environ.get("WEATHER_STALE_S", "1800"))
CONTROL_ERROR_WINDOW_S = int(os.environ.get("CONTROL_ERROR_WINDOW_S", "900"))
DISK_FREE_MIN_PCT = float(os.environ.get("DISK_FREE_MIN_PCT", "10"))
PLAN_GRACE_AFTER_MIDNIGHT_S = int(os.environ.get("PLAN_GRACE_AFTER_MIDNIGHT_S", "1800"))
ORACLE_REVIEW_MIN_DAYS = int(os.environ.get("ORACLE_REVIEW_MIN_DAYS", "16"))
# Default 0 = OFF, deliberately: this is a "go run this probe" nag, and the question it scouts
# for has already been answered once on the reference deployment (see MODBUS.md). Opt in by
# setting a PV floor in W if you want to verify the register behaviour on your OWN unit.
PROBE_READY_MIN_PV_W = float(os.environ.get("PROBE_READY_MIN_PV_W", "0"))
PROBE_READY_WINDOW_S = int(os.environ.get("PROBE_READY_WINDOW_S", "600"))
PROBE_READY_MAX_PV_SWING = float(os.environ.get("PROBE_READY_MAX_PV_SWING", "0.25"))
PROBE_READY_MIN_SURPLUS_W = float(os.environ.get("PROBE_READY_MIN_SURPLUS_W", "2000"))
PROBE_READY_MAX_SOC_PCT = float(os.environ.get("PROBE_READY_MAX_SOC_PCT", "85"))
# Enough samples in the window to trust min/max. A 10 s poller fills a 600 s window with 60 —
# require half, so a briefly degraded poller can't produce a confident verdict from four rows.
PROBE_READY_MIN_SAMPLES = int(os.environ.get("PROBE_READY_MIN_SAMPLES", "30"))

# State keys with this prefix are one-shot notices: sent once, then remembered forever —
# excluded from both the cooldown re-alert path and the "resolved" sweep in main().
ONESHOT_PREFIX = "oneshot:"

UTC = timezone.utc
STOCKHOLM = ZoneInfo("Europe/Stockholm")


def stockholm_date(now: datetime) -> str:
    return now.astimezone(STOCKHOLM).strftime("%Y-%m-%d")


def safe_scalar(con: sqlite3.Connection, sql: str, params=()):
    """First column of the first row, or None on no rows OR any query error — a table that
    doesn't exist yet (a service that has never started successfully never creates it) is
    treated the same as 'no data', not a healthcheck crash."""
    try:
        row = con.execute(sql, params).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None


def check_poller_stale(con: sqlite3.Connection, now: datetime):
    latest = safe_scalar(con, "SELECT MAX(timestamp) FROM readings")
    if latest is None:
        return ("poller_no_data", notify.PRIORITY_HIGH, "Solinteg: no inverter readings yet",
                "The readings table is empty — has solinteg-poller ever run successfully?")
    age = (now - datetime.fromisoformat(latest)).total_seconds()
    if age > POLLER_STALE_S:
        return ("poller_stale", notify.PRIORITY_HIGH, "Solinteg: inverter poller looks dead",
                f"Last reading was {age:.0f}s ago (expected every 30s). "
                f"Check solinteg-poller on the NUC.")
    return None


def check_weather_stale(con: sqlite3.Connection, now: datetime):
    latest = safe_scalar(con, "SELECT MAX(timestamp) FROM weather")
    if latest is None:
        return ("weather_no_data", notify.PRIORITY_LOW, "Solinteg: no weather data yet",
                "The weather table is empty — has solinteg-weather ever run successfully?")
    age = (now - datetime.fromisoformat(latest)).total_seconds()
    if age > WEATHER_STALE_S:
        return ("weather_stale", notify.PRIORITY_LOW, "Solinteg: weather data is stale",
                f"Last weather reading was {age:.0f}s ago. Non-urgent — the solar forecast "
                f"just falls back to climatology until this recovers. Check solinteg-weather "
                f"and the Ecowitt station/cloud API.")
    return None


def check_todays_plan(con: sqlite3.Connection, today: str, now: datetime):
    # Both rows only exist once the FIRST dashboard render after Stockholm midnight has
    # logged the new day's snapshot + plan (solinteg-telemetry.timer runs a few minutes past
    # midnight for exactly this). Until then their absence is scheduling, not failure — this
    # alert used to false-fire around 00:05 depending on timer phase.
    local = now.astimezone(STOCKHOLM)
    seconds_into_day = local.hour * 3600 + local.minute * 60 + local.second
    if seconds_into_day < PLAN_GRACE_AFTER_MIDNIGHT_S:
        return None
    if safe_scalar(con, "SELECT 1 FROM price_snapshots WHERE date = ?", (today,)) is None:
        return ("no_price_snapshot_today", notify.PRIORITY_HIGH,
                "Solinteg: no prices logged today",
                f"No price_snapshots row for {today} — fetchPrices() has likely been failing "
                f"all day, or the dashboard/telemetry timer hasn't rendered since midnight. "
                f"Safe either way (the optimizer falls back to idle, not a stuck setpoint) "
                f"but the battery plan is empty until this recovers.")
    if safe_scalar(con, "SELECT 1 FROM optimizer_runs WHERE price_date = ? LIMIT 1", (today,)) is None:
        return ("no_optimizer_run_today", notify.PRIORITY_HIGH,
                "Solinteg: no battery plan today",
                f"No optimizer_runs row for {today} yet — check solinteg-web and the hourly "
                f"solinteg-telemetry timer.")
    return None


def wrote_nothing(detail: str | None) -> bool:
    """True when an error_revert_failed row provably left the inverter untouched.

    `detail` is built as f"{apply_exc} | revert also failed: {revert_exc}" (dispatch_loop.py).
    Only the FIRST half decides whether anything reached the inverter: force_charge/
    force_discharge open the Modbus connection on their first read (soc_pct()), and
    return_to_auto on its first write — so if the apply failed to CONNECT, no register was
    written and there was never a half-applied state to revert. "revert also failed" is then
    technically true and materially misleading.

    Anything else (notably "No response received after 3 retries") can have died mid-sequence
    with a write already in flight, which is the case that genuinely warrants waking someone.

    Deliberately classifies on the apply half alone: a write that timed out and whose REVERT
    then hit a connect failure is still unconfirmed, and matching "connect failed" anywhere in
    the string would wrongly downgrade exactly that case.

    On the reference install this split mattered a lot — over one 60-day window, 13 of 15
    error_revert_failed rows were connect failures and 12 of 15 self-healed within one loop
    tick, so every one of them had been raising an urgent alert for a transient that fixed
    itself. Check your own distribution before assuming the same ratio.
    """
    marker = "| revert also failed:"
    if not detail or marker not in detail:
        # dispatch_loop always writes both halves for this outcome. A row that isn't that
        # shape is one we cannot reason about, so it does NOT get the downgrade — without
        # this guard a detail containing "connect failed" anywhere would silently qualify.
        return False
    return "connect failed" in detail.split(marker, 1)[0]


def check_control_errors(con: sqlite3.Connection, now: datetime):
    since = (now - timedelta(seconds=CONTROL_ERROR_WINDOW_S)).isoformat()
    try:
        rows = con.execute(
            "SELECT outcome, detail FROM control_actions "
            "WHERE timestamp >= ? AND outcome IN ('error_reverted', 'error_revert_failed')",
            (since,),
        ).fetchall()
    except sqlite3.Error:
        return None
    if not rows:
        return None

    reverted = sum(1 for o, _ in rows if o == "error_reverted")
    failed = [d for o, d in rows if o == "error_revert_failed"]
    unconfirmed = [d for d in failed if not wrote_nothing(d)]
    benign = len(failed) - len(unconfirmed)

    parts = []
    if reverted:
        parts.append(f"error_reverted x{reverted}")
    if benign:
        parts.append(f"error_revert_failed x{benign} (connect failed — nothing written)")
    if unconfirmed:
        parts.append(f"error_revert_failed x{len(unconfirmed)} (state UNCONFIRMED)")

    # URGENT is reserved for a revert that failed after something may already have been
    # written. A failed connect cannot leave a half-applied setpoint, and those self-heal on
    # the next tick — alerting URGENT on them is what makes the one real case get ignored.
    # They still alert, just at the same level as error_reverted.
    if unconfirmed:
        severity = notify.PRIORITY_URGENT
        tail = ("The UNCONFIRMED rows mean a write may have landed and the revert did not — "
                "check the inverter's actual working mode directly.")
    else:
        # Must stay true for connect-failed rows, error_reverted rows, and a mix of both.
        # An earlier version said "no write reached the inverter", which is right for a failed
        # connect but FALSE for error_reverted — there the apply failed and the revert
        # succeeded, so a write may well have landed and then been cleanly undone.
        severity = notify.PRIORITY_HIGH
        tail = ("None of these left the inverter in an unconfirmed state — a failed connect "
                "writes nothing, and a successful revert restores auto. They normally clear on "
                "the next tick; persistent or lengthening runs point at the Modbus link/dongle, "
                "not at dispatch.")
    # Fingerprint = which SEVERITY CLASS this run found, never how many and never which of the
    # two equally-benign outcomes. `reverted` and `benign` are deliberately ONE token
    # ("benign_errors"): both leave the inverter in a known-good state (see `tail` above), and
    # only `unconfirmed` is the transition that must break through the cooldown. Treating them as
    # separate tokens re-classified on the ordinary mix of failure TYPES shifting run to run —
    # nothing about actual severity changing — which drowned the one transition that matters in
    # alert noise. Counts must still stay out of it for the same reason as always: with "x3" vs
    # "x4" in the fingerprint every blip would re-classify and the de-duplication would achieve
    # nothing.
    fingerprint = "+".join(
        k for k, present in (("benign_errors", reverted or benign),
                             ("unconfirmed", bool(unconfirmed))) if present
    )
    return ("control_errors", severity, "Solinteg: dispatch loop hit errors",
            f"In the last {CONTROL_ERROR_WINDOW_S // 60} min: {', '.join(parts)}. {tail} "
            f"See control_actions.detail.", fingerprint)


def check_disk_space(path: str = "/"):
    total, _used, free = shutil.disk_usage(path)
    free_pct = free / total * 100
    if free_pct < DISK_FREE_MIN_PCT:
        return ("disk_low", notify.PRIORITY_HIGH, "Solinteg: NUC disk space low",
                f"Only {free_pct:.1f}% free on {path} ({free / 1e9:.1f} GB) - telemetry.db "
                f"writes and the nightly backup will start failing at 0%. Check journal "
                f"growth (journalctl --disk-usage) and /opt/solinteg/backups.")
    return None


def oracle_review_ready(con: sqlite3.Connection):
    """One-shot notice: judging the oracle's regret numbers needs a body of scored days
    before medians mean anything — page once when that body exists, instead of relying on
    someone remembering to check. status='ok' only: shadow/degraded days don't measure
    live decision quality. Returns (key, title, message) or None."""
    if ORACLE_REVIEW_MIN_DAYS <= 0:
        return None
    n = safe_scalar(con, "SELECT COUNT(*) FROM oracle_daily WHERE status = 'ok'")
    if n is None or n < ORACLE_REVIEW_MIN_DAYS:
        return None
    return (ONESHOT_PREFIX + "oracle_review_ready",
            "Solinteg: oracle review data is ready",
            f"oracle_daily now has {n} fully-armed ('ok') days — enough to judge median "
            f"regret rather than single-day noise. Worth reviewing how dispatch is doing "
            f"against the hindsight oracle.")


def probe_conditions_ready(con: sqlite3.Connection, now: datetime):
    """Daily notice: live conditions suit `scripts/tools/probe_50209_pv_only.py` right now.

    OFF by default (PROBE_READY_MIN_PV_W=0) — opt in with a PV floor in W. Why you might: that
    probe writes an ASYMMETRIC cap, which nothing in normal operation ever does, and it is the
    only way to know whether YOUR unit enforces 50208/50209 the way the reference deployment's
    does. Worth enabling if you intend to build a battery-freeze/hold action. Not worth it
    otherwise — the PV-only-charge idea it originally scouted for turned out not to be worth
    building on any unit (MODBUS.md has the reasoning).

    The hard part isn't running the probe, it's catching a window: it needs steady sun, real
    surplus, and SoC headroom, all at once, and those come and go. Hence a notice rather than
    a checklist item. What it checks over the trailing PROBE_READY_WINDOW_S:

      pv floor      min(pv) over the window >= PROBE_READY_MIN_PV_W — MIN, not average: the
                    point is that the floor never dropped, which an average hides.
      stability     (max-min)/max <= PROBE_READY_MAX_PV_SWING across the window. Broken cloud
                    can hold a high MEAN while swinging wildly; only this catches that, and a
                    probe run through passing cloud produces a confidently wrong answer.
      surplus       avg(pv) - avg(house_load) >= PROBE_READY_MIN_SURPLUS_W, so the battery has
                    something to charge from and the blocked/unblocked contrast is visible.
      soc headroom  latest SoC <= PROBE_READY_MAX_SOC_PCT — force_charge bails at the SoC
                    ceiling, so the sunniest day is not automatically the best one.

    Plus two things that make the probe impossible rather than merely unclean: the dispatch
    loop actively forcing a charge/discharge (the probe would fight it, or interrupt a
    revenue-earning sell), and control being disarmed (writes short-circuit, so the probe
    would silently measure nothing). `armed` is read off the latest control_actions row since
    it is not stored anywhere else.

    Keyed per local date so it fires at most once a day and retries tomorrow if missed —
    deliberately NOT a true once-ever one-shot (conditions come and go, and a missed ping
    shouldn't burn the opportunity) and deliberately not an `issues`-style check either, since
    that path would emit a "resolved" notice every time a cloud passed.
    """
    if PROBE_READY_MIN_PV_W <= 0:
        return None

    row = con.execute(
        """
        SELECT COUNT(*), MIN(pv_w), MAX(pv_w), AVG(pv_w), AVG(house_load_w)
        FROM readings
        WHERE timestamp >= ? AND pv_w IS NOT NULL AND house_load_w IS NOT NULL
        """,
        ((now - timedelta(seconds=PROBE_READY_WINDOW_S)).isoformat(),),
    ).fetchone()
    if row is None:
        return None
    n, pv_min, pv_max, pv_avg, house_avg = row
    if not n or n < PROBE_READY_MIN_SAMPLES or pv_max is None or pv_max <= 0:
        return None

    if pv_min < PROBE_READY_MIN_PV_W:
        return None
    if (pv_max - pv_min) / pv_max > PROBE_READY_MAX_PV_SWING:
        return None
    surplus = pv_avg - house_avg
    if surplus < PROBE_READY_MIN_SURPLUS_W:
        return None

    soc = safe_scalar(con, "SELECT soc_pct FROM readings ORDER BY timestamp DESC LIMIT 1")
    if soc is None or soc > PROBE_READY_MAX_SOC_PCT:
        return None

    # Latest dispatch decision: skip while it is actively forcing, or while disarmed.
    last = con.execute(
        "SELECT planned_action, outcome, armed FROM control_actions ORDER BY timestamp DESC LIMIT 1"
    ).fetchone()
    if last is None:
        return None
    planned_action, outcome, armed = last
    if not armed:
        return None
    if planned_action in ("charge", "discharge") and outcome == "applied":
        return None

    return (ONESHOT_PREFIX + "probe_ready:" + stockholm_date(now),
            "Solinteg: good window for the PV-only-charge probe",
            f"Steady sun right now — PV {pv_min:.0f}-{pv_max:.0f} W over the last "
            f"{PROBE_READY_WINDOW_S // 60} min, {surplus:.0f} W surplus above house load, "
            f"SoC {soc:.0f}%, no forced charge/discharge running. Good conditions for "
            f"scripts/tools/probe_50209_pv_only.py (MODBUS.md: 50208/50209 polarity and the "
            f"write-order rule). Takes about 15 minutes and writes to the inverter — read the "
            f"script's docstring first.")


def run_checks(con: sqlite3.Connection, now: datetime):
    today = stockholm_date(now)
    checks = [
        check_poller_stale(con, now),
        check_weather_stale(con, now),
        check_todays_plan(con, today, now),
        check_control_errors(con, now),
        check_disk_space(),
    ]
    return [c for c in checks if c is not None]


def load_state() -> dict:
    return common.read_json(STATE_PATH) or {}


def save_state(state: dict) -> None:
    common.write_json_atomic(STATE_PATH, state)


def should_alert(prior, fingerprint: str, now: datetime):
    """Does this occurrence of an already-known issue warrant another push? -> (bool, reason).

    Three ways through, in priority order:

    1. **Nothing on record** — the issue is new (or its quiet period fully elapsed and the
       resolve sweep dropped it). Always alert.
    2. **The classification changed.** `fingerprint` describes WHAT was found, not how much, so a
       benign-connect-failure run followed by a `state UNCONFIRMED` run alerts immediately even
       inside the cooldown. Without this, edge-triggering would let the one case that matters be
       swallowed by an ongoing benign condition — which is exactly what check_control_errors'
       severity split exists to prevent. A prior entry with NO recorded fingerprint (a state file
       written by an older version) is not treated as a change, so upgrading doesn't manufacture
       one spurious push per standing issue.
    3. **The cooldown elapsed** while the issue is still present. This is what stops a slow
       degradation from going silent after one push: a condition that never clears still reports
       every ALERT_COOLDOWN_S. Edge-triggering ALONE would announce a degrading link once and
       never mention that the rate had quadrupled over the following days.

    Otherwise: suppressed. Combined with the resolve hysteresis in main(), a condition that blips
    every few hours costs ONE push per cooldown window instead of a push plus a "resolved" notice
    per blip.
    """
    if not prior or not prior.get("last_alert"):
        return True, "new"
    was = prior.get("fingerprint")
    if was is not None and was != fingerprint:
        return True, f"reclassified {was} -> {fingerprint}"
    quiet = (now - datetime.fromisoformat(prior["last_alert"])).total_seconds()
    if quiet >= ALERT_COOLDOWN_S:
        return True, f"still unresolved after {quiet / 3600:.1f} h"
    return False, f"last alerted {prior['last_alert']}"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    now = datetime.now(UTC)

    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        con.execute("PRAGMA busy_timeout=5000")
    except sqlite3.Error as exc:
        log.error("cannot open telemetry.db read-only: %s", exc)
        return 1

    try:
        issues = run_checks(con, now)
        oneshots = [n for n in (oracle_review_ready(con),
                                probe_conditions_ready(con, now))
                    if n is not None]
    finally:
        con.close()

    state = load_state()
    seen_keys = set()
    for issue in issues:
        key, severity, title, message = issue[:4]
        # A check may declare a fingerprint: the CLASSIFICATION of what it found, as opposed to
        # how much of it there was. Defaults to the severity, so any check whose severity moves
        # breaks through the cooldown without having to opt in. See should_alert().
        fingerprint = issue[4] if len(issue) > 4 else str(severity)
        seen_keys.add(key)
        prior = state.get(key)
        alert, reason = should_alert(prior, fingerprint, now)
        if alert:
            notify.send(title, message, priority=severity)
            log.warning("%s (%s): %s", key, reason, message)
        else:
            log.info("%s still present (suppressed, %s)", key, reason)
        # last_seen advances either way — it is what the resolve sweep below measures quiet
        # time against, and a suppressed run is still an occurrence.
        state[key] = {
            "last_alert": now.isoformat() if alert else prior["last_alert"],
            "last_seen": now.isoformat(),
            "fingerprint": fingerprint,
        }

    # One-shot notices: sent at most once ever. Only recorded on a CONFIRMED publish, so a
    # failed send retries on the next run instead of silently marking itself done.
    for key, title, message in oneshots:
        if key not in state:
            if notify.send(title, message, priority=notify.PRIORITY_DEFAULT,
                           tags=["chart_with_upwards_trend"]):
                state[key] = {"sent": now.isoformat()}
                log.info("one-shot notice sent: %s", key)

    # Anything previously flagged but absent for a full quiet period has resolved. One-shot keys
    # are milestones, not issues — they never "resolve" and must survive here forever.
    #
    # The quiet period is the other half of the de-duplication (see should_alert()). Declaring
    # "resolved" after a single clean run is what made an INTERMITTENT fault behave like a stream
    # of unrelated new ones: the key was deleted, so the next occurrence hours later took the
    # "new" path and pushed again, and the cooldown never got to do its job. Keeping the entry
    # alive through the quiet window means a recurrence is recognised as the same standing issue.
    # Cost: a genuinely-fixed issue's ✅ arrives up to RESOLVE_QUIET_S late. Worth it — a
    # premature all-clear on a flapping fault is the more misleading of the two.
    for key, entry in list(state.items()):
        if key.startswith(ONESHOT_PREFIX) or key in seen_keys:
            continue
        last_seen = entry.get("last_seen") or entry.get("last_alert")
        if last_seen is None:  # malformed entry — don't wedge on it
            del state[key]
            continue
        quiet_s = (now - datetime.fromisoformat(last_seen)).total_seconds()
        if quiet_s >= RESOLVE_QUIET_S:
            notify.send(f"Solinteg: resolved — {key}",
                        f"This issue has not recurred for {quiet_s / 3600:.1f} h.",
                        priority=notify.PRIORITY_DEFAULT, tags=["white_check_mark"])
            del state[key]
        else:
            log.info("%s absent for %.0f min — holding before declaring it resolved",
                     key, quiet_s / 60)

    save_state(state)
    if issues:
        log.warning("%d issue(s) detected", len(issues))
    else:
        log.info("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
