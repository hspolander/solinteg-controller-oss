#!/usr/bin/env python3
"""
Shared ntfy.sh push-notification helper for watchdog.py / healthcheck.py.

Stdlib-only (urllib), matching weather_poller.py's no-extra-deps approach. Uses ntfy's JSON
publish API rather than header-based publishing so titles/messages can contain non-ASCII
(Swedish characters) without any header-encoding gymnastics.

Environment:
  NTFY_SERVER   base URL of the ntfy instance (default https://ntfy.sh — the free public one)
  NTFY_TOPIC    topic to publish to (required; pick a long random string — on the public
                instance, anyone who knows/guesses the topic name can read it)
  NTFY_QUIET_HOURS_START, NTFY_QUIET_HOURS_END
                Stockholm local hours (0-23, default 22 and 7 — 22:00-07:00) during which any
                push below NTFY_QUIET_HOURS_MIN_PRIORITY is held back rather than delivered
                immediately, via ntfy's own "delay" scheduling (the phone still gets it, just at
                NTFY_QUIET_HOURS_END instead of at 03:00). Setting START == END disables quiet
                hours entirely — every push goes out immediately.
                Added because most of what this file sends is informational-severity noise (a
                stale weather source, a slow-to-clear probe) that can trivially wait until
                morning, and there is no reason for that to vibrate a phone at 3am as insistently
                as a real fault — see watchdog.py/heating_watchdog.py's PRIORITY_URGENT sends for
                what SHOULD still wake someone.
  NTFY_QUIET_HOURS_MIN_PRIORITY
                priority (default 5 = PRIORITY_URGENT) at or above which quiet hours are
                bypassed — sent immediately regardless of the time. Defaults to ONLY urgent,
                because that priority is reserved (see healthcheck.py's check_control_errors) for
                the one case that can mean a write landed on the inverter and was not confirmed
                reverted — the same bar watchdog.py/heating_watchdog.py use for their own
                immediate sends. Everything below that — including PRIORITY_HIGH, which covers
                things like a dead poller or a full disk — is real but does not need a 3am
                response, so it waits.
"""
import json
import logging
import os
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

log = logging.getLogger("solinteg.notify")

NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")

# ntfy priority scale: 1=min, 2=low, 3=default, 4=high, 5=urgent (or max).
PRIORITY_LOW = 2
PRIORITY_DEFAULT = 3
PRIORITY_HIGH = 4
PRIORITY_URGENT = 5

STOCKHOLM = ZoneInfo("Europe/Stockholm")
NTFY_QUIET_HOURS_START = int(os.environ.get("NTFY_QUIET_HOURS_START", "22"))
NTFY_QUIET_HOURS_END = int(os.environ.get("NTFY_QUIET_HOURS_END", "7"))
NTFY_QUIET_HOURS_MIN_PRIORITY = int(os.environ.get("NTFY_QUIET_HOURS_MIN_PRIORITY", str(PRIORITY_URGENT)))


def _in_quiet_hours(hour: int, start: int, end: int) -> bool:
    """Whether local `hour` falls in [start, end) — handling the normal case where the window
    wraps past midnight (22 -> 7) as well as one that doesn't (e.g. testing with 1 -> 5).
    start == end means "disabled", not "all day", so a lazy/default config can never accidentally
    hold back every single notification forever."""
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _quiet_hours_delay(priority: int, now: datetime | None = None) -> int | None:
    """-> a unix timestamp to hand ntfy as `delay`, or None to send immediately.

    None whenever priority already clears NTFY_QUIET_HOURS_MIN_PRIORITY, so a genuinely critical
    push (see the module docstring on what that bar means) is never held back — quiet hours only
    ever delay, never drop."""
    if priority >= NTFY_QUIET_HOURS_MIN_PRIORITY:
        return None
    now = now.astimezone(STOCKHOLM) if now else datetime.now(STOCKHOLM)
    if not _in_quiet_hours(now.hour, NTFY_QUIET_HOURS_START, NTFY_QUIET_HOURS_END):
        return None
    end = now.replace(hour=NTFY_QUIET_HOURS_END, minute=0, second=0, microsecond=0)
    if end <= now:  # the window wraps past midnight — end is tomorrow, not today
        end += timedelta(days=1)
    return int(end.timestamp())


def send(title: str, message: str, priority: int = PRIORITY_DEFAULT, tags=None) -> bool:
    """POST a push notification to the configured ntfy topic. Never raises — a notification
    failure must not crash the caller; the whole point of alerting is to be more reliable
    than the thing it's watching. Returns True only on a confirmed successful publish (which,
    during quiet hours, means "ntfy accepted it for later delivery", not "it was delivered" —
    ntfy's own scheduler owns that half, same as a normal send racing the phone's network)."""
    if not NTFY_TOPIC:
        log.warning("NTFY_TOPIC not set — skipping notification: %s: %s", title, message)
        return False
    payload = {"topic": NTFY_TOPIC, "title": title, "message": message, "priority": priority}
    if tags:
        payload["tags"] = tags
    delay = _quiet_hours_delay(priority)
    if delay is not None:
        payload["delay"] = str(delay)
        log.info("ntfy: quiet hours — holding '%s' until %s", title,
                  datetime.fromtimestamp(delay, STOCKHOLM).isoformat())
    req = urllib.request.Request(
        NTFY_SERVER + "/",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        return True
    except Exception as exc:  # noqa: BLE001
        log.error("ntfy send failed: %s", exc)
        return False
