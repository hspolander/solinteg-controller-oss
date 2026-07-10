#!/usr/bin/env python3
"""
Ecowitt weather-station poller.

Pulls the Ecowitt cloud API real_time endpoint every $WEATHER_POLL_INTERVAL seconds and
appends readings to the `weather` table in $TELEMETRY_DB_PATH — the same SQLite file the
inverter poller and web app write. Primary value is solar irradiance (W/m²) for the
solar-forecast calibration; also logs temp, humidity, wind, pressure, rain.

The station is a GW1000 (WiFi gateway, USB-powered by the NUC). We read it via the Ecowitt
cloud API rather than locally because the gateway isn't reachable on the NUC's wired subnet.

Rows are keyed by the station's own observation time and deduped (INSERT OR IGNORE), so
polling faster than the station uploads to the cloud is harmless.

Uses only the Python standard library (urllib, sqlite3) — no extra dependencies.

Environment:
  ECOWITT_APPLICATION_KEY   Ecowitt application key (required)
  ECOWITT_API_KEY           Ecowitt API key (required)
  ECOWITT_MAC               station MAC, e.g. AA:BB:CC:DD:EE:FF (required)
  TELEMETRY_DB_PATH         SQLite path (default /opt/solinteg/telemetry.db)
  WEATHER_POLL_INTERVAL     seconds between polls (default 60)
"""

import json
import logging
import os
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

APP_KEY = os.environ.get("ECOWITT_APPLICATION_KEY", "")
API_KEY = os.environ.get("ECOWITT_API_KEY", "")
MAC = os.environ.get("ECOWITT_MAC", "")
DB_PATH = Path(os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db"))
POLL_INTERVAL = int(os.environ.get("WEATHER_POLL_INTERVAL", "60"))
API_URL = "https://api.ecowitt.net/api/v3/device/real_time"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)


def init_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")   # shared with inverter poller + web app
    con.execute("PRAGMA busy_timeout=5000")
    # Canonical schema for all telemetry.db tables: deploy/schema.sql — keep this in sync.
    con.execute("""
        CREATE TABLE IF NOT EXISTS weather (
            timestamp     TEXT PRIMARY KEY,   -- station observation time (UTC ISO), deduped
            fetched_at    TEXT NOT NULL,      -- when we polled the cloud API
            solar_wm2     REAL,
            uvi           REAL,
            temp_c        REAL,               -- outdoor
            humidity_pct  REAL,               -- outdoor
            wind_ms       REAL,
            wind_gust_ms  REAL,
            wind_dir_deg  REAL,
            pressure_hpa  REAL,               -- relative
            rain_rate_mmh REAL,
            rain_day_mm   REAL
        )
    """)
    con.commit()
    return con


def fetch() -> dict:
    params = urllib.parse.urlencode({
        "application_key": APP_KEY,
        "api_key": API_KEY,
        "mac": MAC,
        "call_back": "outdoor,solar_and_uvi,wind,pressure,rainfall",
        "temp_unitid": 1,               # ℃
        "solar_irradiance_unitid": 16,  # W/m²
        "wind_speed_unitid": 6,         # m/s
        "pressure_unitid": 3,           # hPa
        "rainfall_unitid": 12,          # mm
    })
    with urllib.request.urlopen(f"{API_URL}?{params}", timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _value(data: dict, *path: str):
    """Safely dig data[a][b]...['value'] -> float, or None if missing/non-numeric."""
    cur = data
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    if isinstance(cur, dict) and "value" in cur:
        try:
            return float(cur["value"])
        except (ValueError, TypeError):
            return None
    return None


def _obs_time(data: dict) -> str:
    """Station observation time (Unix) from any field → UTC ISO.

    Deliberately does NOT fall back to now() on failure: the `timestamp` column is the dedup
    key (INSERT OR IGNORE), so stamping a reading we couldn't actually date with wall-clock time
    would make every poll look "new" and silently defeat the dedup the moment the station stops
    reporting a usable time — exactly the case (station gone quiet) this needs to catch, not mask.
    Raises instead, so the poller logs a visible failure and retries next interval.
    """
    for category in data.values():
        if isinstance(category, dict):
            for field in category.values():
                if isinstance(field, dict) and "time" in field:
                    try:
                        return datetime.fromtimestamp(int(field["time"]), timezone.utc).isoformat()
                    except (ValueError, TypeError, OSError):
                        pass
    raise ValueError("no usable observation time in API response")


def log_reading(con: sqlite3.Connection, resp: dict):
    if resp.get("code") != 0:
        raise IOError(f"API error: code={resp.get('code')} msg={resp.get('msg')}")
    d = resp.get("data") or {}
    if not d:
        raise IOError("API returned empty data (station offline?)")
    row = (
        _obs_time(d),
        datetime.now(timezone.utc).isoformat(),
        _value(d, "solar_and_uvi", "solar"),
        _value(d, "solar_and_uvi", "uvi"),
        _value(d, "outdoor", "temperature"),
        _value(d, "outdoor", "humidity"),
        _value(d, "wind", "wind_speed"),
        _value(d, "wind", "wind_gust"),
        _value(d, "wind", "wind_direction"),
        _value(d, "pressure", "relative"),
        _value(d, "rainfall", "rain_rate"),
        _value(d, "rainfall", "daily"),
    )
    cur = con.execute(
        """INSERT OR IGNORE INTO weather
           (timestamp, fetched_at, solar_wm2, uvi, temp_c, humidity_pct,
            wind_ms, wind_gust_ms, wind_dir_deg, pressure_hpa, rain_rate_mmh, rain_day_mm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        row,
    )
    con.commit()
    return row, cur.rowcount


def main() -> None:
    if not (APP_KEY and API_KEY and MAC):
        sys.exit("Set ECOWITT_APPLICATION_KEY, ECOWITT_API_KEY and ECOWITT_MAC before starting.")
    con = init_db(DB_PATH)
    log.info("Starting weather poller -> Ecowitt %s every %ds -> %s", MAC, POLL_INTERVAL, DB_PATH)

    while True:
        try:
            row, inserted = log_reading(con, fetch())
            if inserted:
                def n(v):  # display helper: None -> nan so %.1f never crashes
                    return v if v is not None else float("nan")
                log.info("solar=%.1f W/m2  temp=%.1f C  hum=%.0f%%  wind=%.1f m/s @%s  (obs %s)",
                         n(row[2]), n(row[4]), n(row[5]), n(row[6]), row[8], row[0])
            else:
                log.debug("no new observation (station time unchanged)")
        except Exception as exc:  # noqa: BLE001 — keep the loop alive on any transient error
            log.error("Weather poll failed: %s -- retry in %ds", exc, POLL_INTERVAL)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
