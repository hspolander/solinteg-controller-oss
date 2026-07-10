#!/usr/bin/env python3
"""
Solinteg dispatch-loop watchdog: a small, INDEPENDENT safety net against a dead
dispatch_loop.py leaving the inverter stuck in a forced EMS BattCtrl setpoint.

WHY THIS EXISTS: inverter_control.py's own fail-safe (revert to auto on exit/signal) only
fires on a CLEAN exit — a hard crash (OOM kill, power loss, kernel panic) skips atexit and
signal handlers entirely. The setpoint-persistence probe (probe_setpoint_persistence.py)
only confirmed a written setpoint holds for 16 minutes without decaying; nothing confirms it
doesn't just hold indefinitely. Left forced for long enough while nobody's home to notice, a
stuck force-charge/discharge could be costly over days. This script runs as its OWN process,
deliberately separate from dispatch_loop.py — a bug in that loop must not also take down its
own safety net.

METHOD: dispatch_loop.py touches a heartbeat file every iteration, regardless of what it
decided (idle iterations count too — control_actions rows do NOT get written every
iteration, only on an actual target change or the periodic reassert, so control_actions
freshness alone cannot tell a healthy idle loop from a dead one; the heartbeat file can).
If that heartbeat goes stale beyond WATCHDOG_STALE_S, this script connects to the inverter
directly and calls return_to_auto — the exact fail-safe dispatch_loop would have applied
itself, just from an independent process. That call is always attempted regardless of
SOLINTEG_CONTROL_ARMED: write_u16 (inverter_control.py) already no-ops without ever opening
a connection when disarmed, so this needs no separate ARMED branch to stay safe — only the
alert wording below distinguishes "had to intervene" from "just a monitoring gap".

Run as a one-shot systemd timer (deploy/solinteg-watchdog.timer), short interval — this
script runs to completion and exits each time, unlike dispatch_loop.py's continuous loop.

Environment (beyond inverter_control.py's own SOLINTEG_* and notify.py's NTFY_*):
  DISPATCH_HEARTBEAT_PATH    heartbeat file dispatch_loop.py touches every iteration
                             (default /opt/solinteg/dispatch-heartbeat.json)
  WATCHDOG_STALE_S           heartbeat age beyond which the loop is considered dead
                             (default 240 — 4x dispatch_loop's default 60 s interval)
  WATCHDOG_STATE_PATH        small JSON tracking intervened/last-alert state, for
                             de-duplicating repeat alerts (default
                             /opt/solinteg/watchdog-state.json)
  WATCHDOG_ALERT_COOLDOWN_S  minimum time between repeat alerts while the condition
                             persists — the safety action itself is never rate-limited,
                             only the notification about it (default 1800)
"""
import json
import logging
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inverter_control import ARMED, Inverter, return_to_auto  # noqa: E402
import notify  # noqa: E402

log = logging.getLogger("solinteg.watchdog")

HEARTBEAT_PATH = os.environ.get("DISPATCH_HEARTBEAT_PATH", "/opt/solinteg/dispatch-heartbeat.json")
STALE_S = int(os.environ.get("WATCHDOG_STALE_S", "240"))
STATE_PATH = os.environ.get("WATCHDOG_STATE_PATH", "/opt/solinteg/watchdog-state.json")
ALERT_COOLDOWN_S = int(os.environ.get("WATCHDOG_ALERT_COOLDOWN_S", "1800"))

UTC = timezone.utc


def heartbeat_age_s(now: datetime):
    """Seconds since dispatch_loop's last heartbeat, or None if the file is missing/
    unreadable — e.g. dispatch_loop has never started even once, so there's nothing yet to
    compare against (not itself a fault worth alerting on; solinteg-healthcheck's own
    checks cover "has anything ever run")."""
    try:
        with open(HEARTBEAT_PATH, encoding="utf-8") as f:
            data = json.load(f)
        ts = datetime.fromisoformat(data["timestamp"])
        return (now - ts).total_seconds()
    except (OSError, ValueError, KeyError, TypeError):
        return None


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


def attempt_revert():
    """Always attempted, armed or not — see the module docstring. Returns None on success,
    the exception's string on failure."""
    try:
        inv = Inverter()
        try:
            return_to_auto(inv)
        finally:
            inv.close()
        return None
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    now = datetime.now(UTC)
    age = heartbeat_age_s(now)
    state = load_state()
    was_intervened = state.get("intervened", False)

    if age is None:
        log.info("no dispatch heartbeat found yet — nothing to check")
        return 0

    if age <= STALE_S:
        if was_intervened:
            notify.send(
                "Solinteg: dispatch loop recovered",
                f"Heartbeat is fresh again ({age:.0f}s old) — no longer intervening.",
                priority=notify.PRIORITY_DEFAULT, tags=["white_check_mark"],
            )
            log.info("dispatch loop recovered (heartbeat %.0fs old)", age)
        save_state({})
        return 0

    log.warning("dispatch heartbeat is %.0fs old (stale beyond %ds), armed=%s", age, STALE_S, ARMED)
    revert_error = attempt_revert()
    if revert_error:
        log.error("watchdog revert attempt failed: %s", revert_error)

    if ARMED and revert_error:
        # Always alert this one regardless of cooldown — armed + dead loop + failed
        # fail-safe is the one scenario this whole system exists to catch.
        notify.send(
            "Solinteg: watchdog fail-safe FAILED",
            f"Dispatch loop dead ({age:.0f}s, armed) AND the watchdog's own revert-to-auto "
            f"failed: {revert_error}. The inverter's state is not confirmed safe — check it "
            f"directly.",
            priority=notify.PRIORITY_URGENT, tags=["rotating_light"],
        )
        save_state({"intervened": True, "last_alert": now.isoformat()})
        return 1

    last_alert = state.get("last_alert")
    due = last_alert is None or (
        now - datetime.fromisoformat(last_alert)
    ).total_seconds() >= ALERT_COOLDOWN_S

    if due:
        if ARMED:
            notify.send(
                "Solinteg: dispatch loop dead — reverted to auto",
                f"No heartbeat for {age:.0f}s while control was armed. Forced the inverter "
                f"back to General/self-use as a precaution. Check solinteg-dispatch on the NUC.",
                priority=notify.PRIORITY_URGENT, tags=["rotating_light"],
            )
        else:
            notify.send(
                "Solinteg: dispatch loop looks dead",
                f"No heartbeat for {age:.0f}s. Control is disarmed, so the inverter's own "
                f"self-use logic runs untouched — this is a monitoring gap, not a safety "
                f"issue. Check solinteg-dispatch on the NUC when convenient.",
                priority=notify.PRIORITY_DEFAULT, tags=["warning"],
            )
        save_state({"intervened": ARMED, "last_alert": now.isoformat()})
    else:
        save_state({"intervened": ARMED, "last_alert": last_alert})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
