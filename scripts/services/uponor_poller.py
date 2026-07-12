#!/usr/bin/env python3
"""
Polls the Uponor Smatrix Pulse underfloor-heating controller (its R-208 communication
module's local JNAP HTTP API) and logs per-room climate to the shared telemetry.db
(`room_climate` table): room temperature, setpoint, relative humidity, the per-room
DEMAND state (actuator open = actively heating — a live call-for-heat signal the battery
optimizer's load model can't see from meter data), and — added 2026-07-12, for comparing
how hard each room's loop works relative to the others — each
room's valve-open percentage per head, PWM modulation duty, and a valve-fault flag.

Collect-only by design (the weather-station precedent: log first, wire into decisions
only once winter data shows the signal is worth it). STRICTLY
READ-ONLY: the JNAP API is write-capable and has NO authentication (anyone on the LAN
could change setpoints), so this script must only ever send GetAttributes — never add
SetAttributes here casually.

Protocol (reverse-engineered by the asev/homeassistant-uponor project): one
POST http://<host>/JNAP/ with header x-jnap-action .../GetAttributes and body {} returns
the ENTIRE system state as flat name/value string pairs. Temperatures are tenths of a
degree Fahrenheit: °C = (raw − 320) / 18; raw ≥ 4508 means no sensor/invalid. The
controller is known to dislike aggressive polling (Home Assistant uses 30 s; slab
heating moves on hour timescales, so the default here is far gentler).

Per-room loop-effort fields (confirmed present via a live raw GetAttributes dump
2026-07-12, but not yet observed under real heating load — the whole system was idle
mid-July, so every value below read as its "nothing happening" default; only cross-check
against the app once winter gives real variation):
  {room}_head1_valve_pos_percent / _head2_valve_pos_percent  0-100, actual valve opening.
    A room's loop may be split across two heads (larger rooms) or just use head1; head2
    reads 0 for a single-head room, indistinguishable from "closed" — see
    scripts/tools/analyze-room-heat-demand.py, which takes max(head1, head2) as the
    room's combined valve-open %, rather than baking that combination in here.
  {room}_ufh_pwm_output           0-100 modulation duty, independent of valve position.
  {room}_stat_valve_position_err  1 = the controller detected a valve/actuator fault —
    surfaces a stuck or failed loop, which would otherwise look identical to "this room
    just needs a lot of heat" in the duty-cycle numbers.
NOT captured: per-head/controller supply-water temperature and manifold pump-relay state
exist in the raw dump too, but their scale is unconfirmed (unlike room_temperature, never
observed as anything but their own idle/sentinel values) and they describe the shared
manifold, not a single room — out of scope for a per-room comparison. Reconsider only if
a future question needs system-level (not per-room) heating-loop diagnostics.

No extra dependencies — stdlib urllib, matching weather_poller.py.

Environment:
  UPONOR_HOST            controller IP on the LAN (required — give it a router DHCP
                         reservation; a changed IP silently breaks polling)
  TELEMETRY_DB_PATH      SQLite path (default /opt/solinteg/telemetry.db)
  UPONOR_POLL_INTERVAL   seconds between polls (default 300)

Usage: normally via deploy/solinteg-uponor.service; `--once` does a single fetch,
prints every present room, and exits (commissioning probe — compare against the
Smatrix Pulse app's numbers).
"""
import json
import logging
import os
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import common  # sibling module (scripts/services/) — script dir is sys.path[0]

HOST = os.environ.get("UPONOR_HOST", "")
DB_PATH = Path(os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db"))
POLL_INTERVAL = int(os.environ.get("UPONOR_POLL_INTERVAL", "300"))

GET_ACTION = "http://phyn.com/jnap/uponorsky/GetAttributes"
TOO_HIGH_TEMP_RAW = 4508  # controller's own "no sensor / invalid" sentinel (450.8 °F)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)


def init_db(path: Path):
    con = common.telemetry_connect(path)
    # Canonical schema for all telemetry.db tables: deploy/schema.sql — keep this in sync.
    con.execute("""
        CREATE TABLE IF NOT EXISTS room_climate (
            timestamp        TEXT NOT NULL,      -- poll time (UTC ISO) — instantaneous state, no device time exists
            thermostat       TEXT NOT NULL,      -- Uponor id 'C{controller}_T{thermostat}', e.g. 'C1_T1'
            room_temp_c      REAL,               -- NULL = sensor invalid (controller sentinel)
            setpoint_c       REAL,
            rh_pct           REAL,               -- NULL = no humidity sensor
            demand           INTEGER,            -- 1 = actuator open (room actively heating/cooling)
            eco              INTEGER,            -- 1 = thermostat in ECO setback
            sys_heat_cool    INTEGER,            -- system-wide: 0 = heating, 1 = cooling
            sys_away         INTEGER,            -- system-wide forced-ECO ("away") active
            head1_valve_pct  REAL,               -- 0-100, this loop's valve opening
            head2_valve_pct  REAL,               -- 0-100; reads 0 (not NULL) on a single-head room
            pwm_output_pct   REAL,               -- 0-100 modulation duty
            valve_error      INTEGER,            -- 1 = controller-detected valve/actuator fault
            PRIMARY KEY (timestamp, thermostat)
        )
    """)
    # Additive migration for the table created 2026-07-12 before these columns existed —
    # CREATE TABLE IF NOT EXISTS above is a no-op on an existing table, so old columns must
    # be added explicitly. Safe to run repeatedly: ignores "duplicate column" if already applied.
    for col in ("head1_valve_pct REAL", "head2_valve_pct REAL", "pwm_output_pct REAL",
                "valve_error INTEGER"):
        try:
            con.execute(f"ALTER TABLE room_climate ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass  # already applied
    con.commit()
    return con


def fetch_all(host: str) -> dict:
    """One GetAttributes POST — returns the whole system state as a {name: value} dict
    (every value a string). READ-ONLY: this is the only JNAP action this script sends."""
    req = urllib.request.Request(
        f"http://{host}/JNAP/",
        data=b"{}",
        headers={"x-jnap-action": GET_ACTION, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        payload = json.load(resp)
    out = payload.get("output") or {}
    if out.get("result") not in (None, "OK"):
        raise IOError(f"JNAP result {out.get('result')!r}")
    return {v["waspVarName"]: v["waspVarValue"] for v in out.get("vars", [])}


def temp_c(raw) -> float | None:
    """Deci-°F → °C, honouring the controller's invalid-sensor sentinel."""
    if raw is None:
        return None
    raw = int(raw)
    if raw >= TOO_HIGH_TEMP_RAW:
        return None
    return round((raw - 320) / 18, 1)


def _pct(raw) -> float | None:
    """A raw 0-100 percentage field — None only if the key is entirely missing."""
    return None if raw is None else float(raw)


def parse_rooms(d: dict) -> list[dict]:
    """One entry per present thermostat across all present controllers (C1..C4, T1..T12)."""
    sys_heat_cool = 1 if d.get("sys_heat_cool_mode") == "1" else 0
    sys_away = 1 if d.get("sys_forced_eco_mode") == "1" else 0
    rooms = []
    for c in range(1, 5):
        if d.get(f"sys_controller_{c}_presence") != "1":
            continue
        for t in range(1, 13):
            if d.get(f"C{c}_thermostat_{t}_presence") != "1":
                continue
            key = f"C{c}_T{t}"
            rh = d.get(f"{key}_rh")
            rh_val = float(rh) if rh not in (None, "0") else None  # 0 = the no-RH-sensor sentinel
            rooms.append({
                "thermostat": key,
                "room_temp_c": temp_c(d.get(f"{key}_room_temperature")),
                "setpoint_c": temp_c(d.get(f"{key}_setpoint")),
                "rh_pct": rh_val,
                "demand": 1 if d.get(f"{key}_stat_cb_actuator") == "1" else 0,
                "eco": 1 if d.get(f"{key}_stat_cb_comfort_eco_mode") == "1" else 0,
                "sys_heat_cool": sys_heat_cool,
                "sys_away": sys_away,
                "head1_valve_pct": _pct(d.get(f"{key}_head1_valve_pos_percent")),
                "head2_valve_pct": _pct(d.get(f"{key}_head2_valve_pos_percent")),
                "pwm_output_pct": _pct(d.get(f"{key}_ufh_pwm_output")),
                "valve_error": 1 if d.get(f"{key}_stat_valve_position_err") == "1" else 0,
            })
    return rooms


def log_rooms(con, rooms: list[dict]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    con.executemany(
        """INSERT OR IGNORE INTO room_climate
           (timestamp, thermostat, room_temp_c, setpoint_c, rh_pct, demand, eco, sys_heat_cool,
            sys_away, head1_valve_pct, head2_valve_pct, pwm_output_pct, valve_error)
           VALUES (:ts, :thermostat, :room_temp_c, :setpoint_c, :rh_pct, :demand, :eco,
                   :sys_heat_cool, :sys_away, :head1_valve_pct, :head2_valve_pct,
                   :pwm_output_pct, :valve_error)""",
        [{**r, "ts": now} for r in rooms],
    )
    con.commit()


def main() -> None:
    if not HOST:
        sys.exit("Set UPONOR_HOST (the Smatrix Pulse controller's LAN IP) before starting.")

    if "--once" in sys.argv:
        rooms = parse_rooms(fetch_all(HOST))
        for r in rooms:
            valve = max(r["head1_valve_pct"] or 0, r["head2_valve_pct"] or 0)
            print(f"{r['thermostat']}: temp={r['room_temp_c']} °C  set={r['setpoint_c']} °C  "
                  f"rh={r['rh_pct']}  demand={r['demand']}  eco={r['eco']}  "
                  f"valve={valve:.0f}%  pwm={r['pwm_output_pct']}%"
                  f"{'  VALVE ERROR' if r['valve_error'] else ''}")
        print(f"{len(rooms)} rooms; system mode={'cooling' if rooms and rooms[0]['sys_heat_cool'] else 'heating'}"
              f"{' AWAY' if rooms and rooms[0]['sys_away'] else ''}")
        return

    con = init_db(DB_PATH)
    log.info("Starting Uponor poller -> http://%s/JNAP/ every %ds -> %s", HOST, POLL_INTERVAL, DB_PATH)
    while True:
        try:
            rooms = parse_rooms(fetch_all(HOST))
            if rooms:
                log_rooms(con, rooms)
                temps = [r["room_temp_c"] for r in rooms if r["room_temp_c"] is not None]
                errors = [r["thermostat"] for r in rooms if r["valve_error"]]
                log.info("%d rooms, %d in demand, temp %.1f-%.1f °C%s",
                         len(rooms), sum(r["demand"] for r in rooms),
                         min(temps) if temps else float("nan"),
                         max(temps) if temps else float("nan"),
                         f", VALVE ERROR: {', '.join(errors)}" if errors else "")
            else:
                log.warning("controller answered but reported no present thermostats")
        except Exception as exc:  # noqa: BLE001 — keep the loop alive on any transient error
            log.error("Uponor poll failed: %s -- retry in %ds", exc, POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
