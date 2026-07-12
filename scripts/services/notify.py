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
"""
import json
import logging
import os
import urllib.request

log = logging.getLogger("solinteg.notify")

NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")

# ntfy priority scale: 1=min, 2=low, 3=default, 4=high, 5=urgent (or max).
PRIORITY_LOW = 2
PRIORITY_DEFAULT = 3
PRIORITY_HIGH = 4
PRIORITY_URGENT = 5


def send(title: str, message: str, priority: int = PRIORITY_DEFAULT, tags=None) -> bool:
    """POST a push notification to the configured ntfy topic. Never raises — a notification
    failure must not crash the caller; the whole point of alerting is to be more reliable
    than the thing it's watching. Returns True only on a confirmed successful publish."""
    if not NTFY_TOPIC:
        log.warning("NTFY_TOPIC not set — skipping notification: %s: %s", title, message)
        return False
    payload = {"topic": NTFY_TOPIC, "title": title, "message": message, "priority": priority}
    if tags:
        payload["tags"] = tags
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
