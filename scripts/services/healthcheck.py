#!/usr/bin/env python3
"""
Solinteg system healthcheck: periodic sweep of telemetry.db for signs the pipeline has
degraded, with push alerts via notify.py.

Distinct from watchdog.py (which ONLY guards against a stuck armed setpoint and is kept
deliberately minimal): this covers the rest of "is the system actually working" — poller/
weather staleness, a missing daily price/battery plan, and dispatch errors. None of these
need an inverter-safety response, just your attention; see watchdog.py for the one that does.

Run as a one-shot systemd timer (deploy/solinteg-healthcheck.timer), a few minutes' interval.

Alerts are de-duplicated via a small state file: each detected issue alerts once, then again
only after HEALTHCHECK_ALERT_COOLDOWN_S if still unresolved (a persistent problem gets a
periodic reminder, not a notification every run), plus a "resolved" notice once it clears.
One-shot notices (state keys prefixed "oneshot:") are different: sent exactly once ever,
never repeated, never "resolved" — for milestones rather than problems.

Environment (beyond notify.py's own NTFY_*):
  TELEMETRY_DB_PATH             SQLite path (default /opt/solinteg/telemetry.db)
  HEALTHCHECK_STATE_PATH        dedup state (default /opt/solinteg/healthcheck-state.json)
  HEALTHCHECK_ALERT_COOLDOWN_S  minimum time between repeat alerts for the same issue
                                (default 14400 = 4 h)
  PLAN_GRACE_AFTER_MIDNIGHT_S   suppress the "no prices/plan today" checks this long after
                                Stockholm midnight (default 1800) — the rows only exist once
                                the first post-midnight render lands (solinteg-telemetry.timer
                                runs a few minutes past midnight for exactly this)
  UPONOR_STALE_S                room_climate table max age before flagging (default 1800;
                                only relevant once solinteg-uponor is enabled — a never-
                                started poller reports as "no data", which is fine)
  ORACLE_REVIEW_MIN_DAYS        one-shot: send a single "oracle-review data is ready" notice
                                once this many status='ok' oracle_daily rows exist
                                (default 16; 0 disables)
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
import json
import logging
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify  # noqa: E402

log = logging.getLogger("solinteg.healthcheck")

DB_PATH = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")
STATE_PATH = os.environ.get("HEALTHCHECK_STATE_PATH", "/opt/solinteg/healthcheck-state.json")
ALERT_COOLDOWN_S = int(os.environ.get("HEALTHCHECK_ALERT_COOLDOWN_S", "14400"))
POLLER_STALE_S = int(os.environ.get("POLLER_STALE_S", "300"))
WEATHER_STALE_S = int(os.environ.get("WEATHER_STALE_S", "1800"))
CONTROL_ERROR_WINDOW_S = int(os.environ.get("CONTROL_ERROR_WINDOW_S", "900"))
DISK_FREE_MIN_PCT = float(os.environ.get("DISK_FREE_MIN_PCT", "10"))
PLAN_GRACE_AFTER_MIDNIGHT_S = int(os.environ.get("PLAN_GRACE_AFTER_MIDNIGHT_S", "1800"))
UPONOR_STALE_S = int(os.environ.get("UPONOR_STALE_S", "1800"))
ORACLE_REVIEW_MIN_DAYS = int(os.environ.get("ORACLE_REVIEW_MIN_DAYS", "16"))

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


def check_uponor_stale(con: sqlite3.Connection, now: datetime):
    latest = safe_scalar(con, "SELECT MAX(timestamp) FROM room_climate")
    if latest is None:
        return None  # poller not enabled yet (or never ran) — collection is optional, don't nag
    age = (now - datetime.fromisoformat(latest)).total_seconds()
    if age > UPONOR_STALE_S:
        return ("uponor_stale", notify.PRIORITY_LOW, "Solinteg: room-climate data is stale",
                f"Last room_climate row was {age:.0f}s ago. Non-urgent — this is data"
                f" collection only, nothing downstream consumes it yet. Check solinteg-uponor"
                f" and whether the Smatrix controller's IP changed (it needs a DHCP"
                f" reservation).")
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


def check_control_errors(con: sqlite3.Connection, now: datetime):
    since = (now - timedelta(seconds=CONTROL_ERROR_WINDOW_S)).isoformat()
    try:
        rows = con.execute(
            "SELECT outcome, COUNT(*) FROM control_actions "
            "WHERE timestamp >= ? AND outcome IN ('error_reverted', 'error_revert_failed') "
            "GROUP BY outcome",
            (since,),
        ).fetchall()
    except sqlite3.Error:
        return None
    if not rows:
        return None
    counts = ", ".join(f"{outcome} x{n}" for outcome, n in rows)
    severity = notify.PRIORITY_URGENT if any(o == "error_revert_failed" for o, _ in rows) \
        else notify.PRIORITY_HIGH
    return ("control_errors", severity, "Solinteg: dispatch loop hit errors",
            f"In the last {CONTROL_ERROR_WINDOW_S // 60} min: {counts}. "
            f"error_revert_failed means the inverter's actual state isn't confirmed — check "
            f"it directly. See control_actions.detail on the NUC.")


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


def run_checks(con: sqlite3.Connection, now: datetime):
    today = stockholm_date(now)
    checks = [
        check_poller_stale(con, now),
        check_weather_stale(con, now),
        check_uponor_stale(con, now),
        check_todays_plan(con, today, now),
        check_control_errors(con, now),
        check_disk_space(),
    ]
    return [c for c in checks if c is not None]


def load_state() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)


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
        oneshots = [n for n in (oracle_review_ready(con),) if n is not None]
    finally:
        con.close()

    state = load_state()
    seen_keys = set()
    for key, severity, title, message in issues:
        seen_keys.add(key)
        prior = state.get(key)
        due = prior is None or (
            now - datetime.fromisoformat(prior["last_alert"])
        ).total_seconds() >= ALERT_COOLDOWN_S
        if due:
            notify.send(title, message, priority=severity)
            state[key] = {"last_alert": now.isoformat()}
            log.warning("%s: %s", key, message)
        else:
            log.info("%s still present (suppressed, last alerted %s)", key, prior["last_alert"])

    # One-shot notices: sent at most once ever. Only recorded on a CONFIRMED publish, so a
    # failed send retries on the next run instead of silently marking itself done.
    for key, title, message in oneshots:
        if key not in state:
            if notify.send(title, message, priority=notify.PRIORITY_DEFAULT,
                           tags=["chart_with_upwards_trend"]):
                state[key] = {"sent": now.isoformat()}
                log.info("one-shot notice sent: %s", key)

    # Anything previously flagged but no longer present has resolved. One-shot keys are
    # milestones, not issues — they never "resolve" and must survive here forever.
    for key in list(state.keys()):
        if key.startswith(ONESHOT_PREFIX):
            continue
        if key not in seen_keys:
            notify.send(f"Solinteg: resolved — {key}", "This issue is no longer detected.",
                        priority=notify.PRIORITY_DEFAULT, tags=["white_check_mark"])
            del state[key]

    save_state(state)
    if issues:
        log.warning("%d issue(s) detected", len(issues))
    else:
        log.info("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
