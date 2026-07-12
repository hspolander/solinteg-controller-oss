#!/usr/bin/env python3
"""
Solinteg inverter Modbus TCP poller.
Reads live data every 30 s and writes $INVERTER_DATA_PATH (default /opt/solinteg/live.json).
Each reading is also appended to a SQLite time-series at $TELEMETRY_DB_PATH
(default /opt/solinteg/telemetry.db) for analysis and adaptive-reserve backtesting.

Register map (holding registers). Source: plugin_solinteg.py @ commit 350266f
(wills106/homeassistant-solax-modbus), source-verified register-by-register.
See MODBUS.md for the full verified map and control registers.

  11000  S32  Meter (grid) power (W)   AS REPORTED: +ve = EXPORT, -ve = IMPORT
  11016  S32  Inverter AC output (W)   NOT house load — see below
  11028  U32  Total PV power (W)
  30258  S32  Battery power (W)        AS REPORTED: -ve = CHARGING, +ve = DISCHARGING
  33000  U16  Battery SoC              raw × 0.01 = %
  33001  U16  Battery SoH              raw × 0.01 = % (source-verified 2026-07-02, see MODBUS.md)
  33003  U16  Battery Temperature      raw × 0.1 = °C — plain U16, no signed/negative-temp handling;
                                       unconfirmed whether this pack can ever report sub-zero (a
                                       negative reading would wrap to a huge nonsensical positive
                                       number, e.g. ~6553°C at the U16 max, not a sane negative value)
  50000  U16  Working mode (readback)  0x101 General/auto, 0x303 EMS BattCtrl, ...

House load is NOT a single register. The plugin derives it as:
  house_load = inverter_ac_output(11016) - meter_power(11000)
(both raw, before any display-side sign inversion).

Requires: pip install "pymodbus>=3.13,<4"  (uses device_id= kwarg; renamed from slave= in 3.x)

Environment variables:
  SOLINTEG_HOST        Inverter IP or hostname (required — no default)
  SOLINTEG_PORT        Modbus TCP port (default 502)
  SOLINTEG_SLAVE_ID    Modbus unit/slave ID (default 1)
  INVERTER_DATA_PATH   Output JSON file path (default /opt/solinteg/live.json)
  TELEMETRY_DB_PATH    SQLite time-series path (default /opt/solinteg/telemetry.db)
  POLL_INTERVAL        Poll interval in seconds (default 30)
"""

import json
import logging
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import common  # sibling module (scripts/services/) — script dir is sys.path[0]

try:
    from pymodbus.client import ModbusTcpClient
except ImportError:
    sys.exit("pymodbus not installed — run: pip install 'pymodbus>=3.0'")

INVERTER_HOST = os.environ.get("SOLINTEG_HOST", "")
INVERTER_PORT = int(os.environ.get("SOLINTEG_PORT", "502"))
SLAVE_ID = int(os.environ.get("SOLINTEG_SLAVE_ID", "1"))
DATA_PATH = Path(os.environ.get("INVERTER_DATA_PATH", "/opt/solinteg/live.json"))
DB_PATH = Path(os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
# One real source of truth: same env var name lib/constants.ts reads, matching hardcoded
# fallback default (kept in sync by lib/__tests__/constants-cross-language.test.ts).
BATTERY_KWH = float(os.environ.get("SOLINTEG_BATTERY_KWH", "25.6"))  # Enershare Energy-Core usable capacity

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)


def s32(high: int, low: int) -> int:
    """Two U16 Modbus registers → signed S32 (big-endian, high word first)."""
    val = (high << 16) | low
    if val >= 0x80000000:
        val -= 0x100000000
    return val


def u32(high: int, low: int) -> int:
    return (high << 16) | low


# Working-mode enum readback (reg 50000). See MODBUS.md.
WORK_MODES = {
    0x101: "General",      # self-use / automatic
    0x102: "Economic",
    0x103: "UPS",
    0x104: "PeakShift",
    0x105: "Feed-In",
    0x200: "Off-Grid",
    0x301: "EMS ACCtrl",
    0x302: "EMS General",
    0x303: "EMS BattCtrl",  # the mode our controller uses to command battery power
    0x304: "EMS Off-Grid",
    0x400: "ToU",
}


def read_inverter(client: ModbusTcpClient) -> dict:
    # Block 1: 11000–11029 (meter power, inverter AC output, PV — 30 registers)
    r1 = client.read_holding_registers(11000, count=30, device_id=SLAVE_ID)
    if r1.isError():
        raise IOError(f"Block 11000 read failed: {r1}")

    # Block 2: 30258–30259 (battery power — separate due to large address gap)
    r2 = client.read_holding_registers(30258, count=2, device_id=SLAVE_ID)
    if r2.isError():
        raise IOError(f"Block 30258 read failed: {r2}")

    # Block 3: 33000-33003 (battery SoC, SoH, [33002 unused], temperature — 4 registers,
    # one round trip). SoH lets us track real capacity fade against the wear-cost model's
    # assumed degradation curve (lib/constants.ts); temperature is diagnostic.
    r3 = client.read_holding_registers(33000, count=4, device_id=SLAVE_ID)
    if r3.isError():
        raise IOError(f"Block 33000 read failed: {r3}")

    # Block 4: 50000 (working mode readback — single register)
    r4 = client.read_holding_registers(50000, count=1, device_id=SLAVE_ID)
    if r4.isError():
        raise IOError(f"Block 50000 read failed: {r4}")

    regs = r1.registers
    grid_w         = s32(regs[0],  regs[1])            # 11000  +ve = export, -ve = import
    inverter_ac_w  = s32(regs[16], regs[17])           # 11016  inverter AC output (NOT load)
    pv_w           = u32(regs[28], regs[29])           # 11028
    battery_w      = s32(r2.registers[0], r2.registers[1])  # 30258  -ve = charging
    soc_raw        = r3.registers[0]                   # 33000
    soh_raw        = r3.registers[1]                   # 33001
    battery_temp_raw = r3.registers[3]                 # 33003 (33002 unused/reserved)
    work_mode_raw  = r4.registers[0]                   # 50000

    # House load is derived, not a register: inverter AC output minus meter power
    # (plugin value_function_house_total_load). Both raw, before display inversion.
    house_load_w = inverter_ac_w - grid_w

    soc_pct = round(soc_raw * 0.01, 2)
    soc_kwh = round(soc_pct / 100 * BATTERY_KWH, 3)
    soh_pct = round(soh_raw * 0.01, 2)
    battery_temp_c = round(battery_temp_raw * 0.1, 1)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "soc_pct": soc_pct,
        "soc_kwh": soc_kwh,
        "soh_pct": soh_pct,
        "battery_temp_c": battery_temp_c,
        "pv_w": pv_w,
        "grid_w": grid_w,
        "battery_w": battery_w,
        "inverter_ac_w": inverter_ac_w,
        "house_load_w": house_load_w,
        "work_mode": WORK_MODES.get(work_mode_raw, f"Unknown(0x{work_mode_raw:X})"),
        "work_mode_raw": work_mode_raw,
    }


def write_atomic(path: Path, data: dict) -> None:
    """Write JSON to a temp file then rename — avoids partial reads."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def init_db(path: Path) -> sqlite3.Connection:
    con = common.telemetry_connect(path)
    # Canonical schema for all telemetry.db tables: deploy/schema.sql — keep this in sync.
    con.execute("""
        CREATE TABLE IF NOT EXISTS readings (
            id             INTEGER PRIMARY KEY,
            timestamp      TEXT NOT NULL,
            soc_pct        REAL,
            soc_kwh        REAL,
            soh_pct        REAL,
            battery_temp_c REAL,
            pv_w           INTEGER,
            grid_w         INTEGER,
            battery_w      INTEGER,
            inverter_ac_w  INTEGER,
            house_load_w   INTEGER,
            work_mode      TEXT,
            work_mode_raw  INTEGER
        )
    """)
    # Additive migration for DBs created before soh_pct/battery_temp_c existed (2026-07-02) —
    # CREATE TABLE IF NOT EXISTS above is a no-op on an existing table, so old columns must be
    # added explicitly. Safe to run repeatedly: ignores "duplicate column" if already applied.
    for col in ("soh_pct REAL", "battery_temp_c REAL"):
        try:
            con.execute(f"ALTER TABLE readings ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass  # already applied
    con.execute("CREATE INDEX IF NOT EXISTS idx_ts ON readings(timestamp)")
    con.commit()
    return con


def log_reading(con: sqlite3.Connection, data: dict) -> None:
    con.execute(
        """INSERT INTO readings
           (timestamp, soc_pct, soc_kwh, soh_pct, battery_temp_c, pv_w, grid_w, battery_w,
            inverter_ac_w, house_load_w, work_mode, work_mode_raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["timestamp"], data["soc_pct"], data["soc_kwh"],
            data["soh_pct"], data["battery_temp_c"],
            data["pv_w"], data["grid_w"], data["battery_w"],
            data["inverter_ac_w"], data["house_load_w"],
            data["work_mode"], data["work_mode_raw"],
        ),
    )
    con.commit()


def main() -> None:
    if not INVERTER_HOST:
        sys.exit("Set SOLINTEG_HOST to the inverter's IP address before starting.")

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = init_db(DB_PATH)
    log.info("Starting poller → %s:%d (slave %d) every %ds → %s  telemetry → %s",
             INVERTER_HOST, INVERTER_PORT, SLAVE_ID, POLL_INTERVAL, DATA_PATH, DB_PATH)

    client = ModbusTcpClient(INVERTER_HOST, port=INVERTER_PORT, timeout=10)

    while True:
        try:
            if not client.is_socket_open():
                client.connect()
            data = read_inverter(client)
            write_atomic(DATA_PATH, data)
            log_reading(db, data)
            log.info("SoC=%.1f%% (%.1f kWh)  SoH=%.1f%%  battTemp=%.1f°C  PV=%dW  grid=%+dW  "
                     "batt=%+dW  load=%dW  mode=%s",
                     data["soc_pct"], data["soc_kwh"], data["soh_pct"], data["battery_temp_c"],
                     data["pv_w"], data["grid_w"],
                     data["battery_w"], data["house_load_w"], data["work_mode"])
        except Exception as exc:
            log.error("Poll failed: %s — will retry in %ds", exc, POLL_INTERVAL)
            try:
                client.close()
            except Exception:
                pass

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
