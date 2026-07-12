#!/usr/bin/env python3
"""
Solinteg inverter control library (standalone, no Home Assistant).

Implements force-charge / force-discharge / return-to-auto via verified Modbus
holding registers. See MODBUS.md for the register map and the on-device probes
that MUST pass before this is allowed to command power.

SAFETY MODEL — this module refuses to act unless two gates are explicitly set:

  SOLINTEG_CONTROL_ARMED=1        master arm; without it every write is a no-op
                                  (logged as "DISARMED").
  SOLINTEG_50207_SIGN=neg_charge  the verified sign convention for reg 50207.
                                  force_charge/force_discharge refuse to run until
                                  this is set to the value confirmed by
                                  scripts/probe_50207_sign.py ("neg_charge" if a
                                  NEGATIVE target charges, "pos_charge" otherwise).

On any unhandled error, SIGTERM/SIGINT, or interpreter exit, the inverter is
reverted to General (self-use) mode — never left parked in a forced setpoint.

Hardware limits (source of truth: lib/constants.ts; defaults below kept in sync by
lib/__tests__/constants-cross-language.test.ts, same pattern as SOLINTEG_SOC_FLOOR_PCT):
  battery 15.36 kW, grid ~11 kW (3x16A). Power is clamped to these before encoding.
  Override via SOLINTEG_BATTERY_MAX_W / SOLINTEG_GRID_CAP_W for a different install.

Requires: pip install "pymodbus>=3.13,<4"  (uses device_id= kwarg; renamed from slave= in 3.x)
"""

import atexit
import logging
import os
import signal
import sys
import time

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.exceptions import ModbusException
except ImportError:
    sys.exit("pymodbus not installed — run: pip install 'pymodbus>=3.13,<4'")

log = logging.getLogger("solinteg.control")

# ── Configuration ────────────────────────────────────────────────────────────
HOST = os.environ.get("SOLINTEG_HOST", "")
PORT = int(os.environ.get("SOLINTEG_PORT", "502"))
SLAVE_ID = int(os.environ.get("SOLINTEG_SLAVE_ID", "1"))
ARMED = os.environ.get("SOLINTEG_CONTROL_ARMED", "") == "1"
SIGN = os.environ.get("SOLINTEG_50207_SIGN", "")  # "neg_charge" | "pos_charge" | ""

# ── Hardware limits ──
# Defaults mirror BATTERY_MAX_KW/GRID_KW in lib/constants.ts (kept in sync by
# lib/__tests__/constants-cross-language.test.ts), same pattern as SOC_FLOOR_PCT below.
BATTERY_MAX_W = int(os.environ.get("SOLINTEG_BATTERY_MAX_W", "15360"))
GRID_CAP_W = int(os.environ.get("SOLINTEG_GRID_CAP_W", "11000"))
# Default mirrors BATTERY_MIN_SOC_KWH in lib/constants.ts (kept in sync by
# lib/__tests__/constants-cross-language.test.ts).
SOC_FLOOR_PCT = float(os.environ.get("SOLINTEG_SOC_FLOOR_PCT", "8"))
SOC_CEILING_PCT = float(os.environ.get("SOLINTEG_SOC_CEILING_PCT", "98"))

# ── Registers (verified — see MODBUS.md) ──
REG_WORK_MODE = 50000          # U16 enum
REG_BATT_POWER_TARGET = 50207  # S16, 0.01 kW (raw = W/10)
REG_MAX_EXPORT = 50208         # S16, 0.01 kW (>= 0)
REG_MAX_IMPORT = 50209         # S16, 0.01 kW (<= 0)
REG_PRIORITY = 50210           # U16 enum: 0=PV, 1=Battery
REG_BATTERY_POWER = 30258      # S32 W (read; -ve = charging)
REG_SOC = 33000                # U16 x0.01 %
REG_SOC_PROTECT_ENABLE = 52502 # U16 enum: 0=off, 1=on
REG_SOC_MIN = 52503            # U16, 0.1 %, 5..100 (raw = int(pct/0.1))

WORK_MODE_GENERAL = 0x101       # self-use / automatic
WORK_MODE_EMS_BATTCTRL = 0x303  # lets us command battery power via 50207

GRID_CAP_RAW = GRID_CAP_W // 10  # 1100

WRITE_MIN_INTERVAL_S = 2.0   # rate-limit: >=2 s between physical writes
SETTLE_S = 0.4               # delay before reading a written register back
POWER_TOL_RAW = 5            # readback tolerance in 0.01 kW units (=50 W)


def clamp_power_w(power_w: int) -> int:
    """Clamp a requested power magnitude to the binding hardware limit."""
    return max(0, min(int(power_w), BATTERY_MAX_W, GRID_CAP_W))


class RateLimiter:
    def __init__(self, min_interval: float = WRITE_MIN_INTERVAL_S) -> None:
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self) -> None:
        dt = time.monotonic() - self._last
        if dt < self.min_interval:
            time.sleep(self.min_interval - dt)
        self._last = time.monotonic()


class Inverter:
    """Thin pymodbus wrapper: persistent connection, checked + verified writes."""

    def __init__(self, host: str = HOST, port: int = PORT, unit: int = SLAVE_ID):
        if not host:
            raise ValueError("SOLINTEG_HOST not set")
        self.unit = unit
        self.client = ModbusTcpClient(host, port=port, timeout=5)
        self._rl = RateLimiter()

    # — connection —
    def _ensure(self) -> None:
        if not self.client.connected:
            if not self.client.connect():
                raise ModbusException(f"connect failed {self.client}")

    def close(self) -> None:
        try:
            self.client.close()
        except Exception:
            pass

    # — reads —
    def read_u16(self, addr: int) -> int:
        self._ensure()
        rr = self.client.read_holding_registers(addr, count=1, device_id=self.unit)
        if rr.isError():
            raise ModbusException(f"read {addr} -> {rr}")
        return rr.registers[0]

    def read_s16(self, addr: int) -> int:
        v = self.read_u16(addr)
        return v - 0x10000 if v & 0x8000 else v

    def read_s32(self, addr: int) -> int:
        self._ensure()
        rr = self.client.read_holding_registers(addr, count=2, device_id=self.unit)
        if rr.isError():
            raise ModbusException(f"read {addr} -> {rr}")
        hi, lo = rr.registers
        u = (hi << 16) | lo
        return u - 0x100000000 if u & 0x80000000 else u

    def soc_pct(self) -> float:
        return round(self.read_u16(REG_SOC) * 0.01, 2)

    def battery_power_w(self) -> int:
        return self.read_s32(REG_BATTERY_POWER)

    def work_mode(self) -> int:
        return self.read_u16(REG_WORK_MODE)

    # — writes —
    def write_u16(self, addr: int, value: int, *, verify: bool = True) -> None:
        """FC06 write of a single holding register. value may be a signed S16
        (encoded two's-complement). Checks the Modbus result and reads back."""
        if not ARMED:
            log.warning("DISARMED: skipping write %d = %d (set SOLINTEG_CONTROL_ARMED=1)", addr, value)
            return
        raw = value & 0xFFFF
        self._ensure()
        self._rl.wait()
        rr = self.client.write_register(addr, raw, device_id=self.unit)
        if rr.isError():
            raise ModbusException(f"write {addr}={value} (raw {raw}) -> {rr}")
        if verify:
            time.sleep(SETTLE_S)
            got = self.read_u16(addr)
            if got != raw:
                # power registers may clamp; tolerate small differences there
                signed_got = got - 0x10000 if got & 0x8000 else got
                if addr == REG_BATT_POWER_TARGET and abs(signed_got - value) <= POWER_TOL_RAW:
                    return
                raise ValueError(f"write not applied: {addr} wrote {value} (raw {raw}), read {got}")


# ── Control sequences ──────────────────────────────────────────────────────────

def _charge_sign() -> int:
    """+1 or -1 for the charge direction of reg 50207, per the confirmed probe."""
    if SIGN == "neg_charge":
        return -1
    if SIGN == "pos_charge":
        return +1
    raise RuntimeError(
        "50207 sign convention not confirmed. Run scripts/probe_50207_sign.py and "
        "set SOLINTEG_50207_SIGN=neg_charge|pos_charge before forcing charge/discharge."
    )


def return_to_auto(inv: Inverter) -> None:
    """Hand dispatch back to the inverter's self-use logic. The fail-safe state."""
    global _forced_active
    log.info("return_to_auto: working mode -> General (0x101)")
    inv.write_u16(REG_WORK_MODE, WORK_MODE_GENERAL)
    inv.write_u16(REG_BATT_POWER_TARGET, 0, verify=False)
    _forced_active = False


def set_soc_floor(inv: Inverter, floor_pct: float = SOC_FLOOR_PCT) -> None:
    """Enable the inverter's native on-grid SoC protection at floor_pct.

    This is independent of EMS BattCtrl (50207/50000=0x303) — it constrains the
    inverter's own self-use logic, so it protects the battery even while our
    control loop is disarmed or not running. Does not require SOLINTEG_50207_SIGN.
    """
    if not (5.0 <= floor_pct <= 100.0):
        raise ValueError(f"floor_pct {floor_pct} outside valid range 5..100")
    raw = int(round(floor_pct / 0.1))
    log.info("set_soc_floor: enabling on-grid SoC protection at %.1f%% (raw %d)", floor_pct, raw)
    inv.write_u16(REG_SOC_MIN, raw)
    inv.write_u16(REG_SOC_PROTECT_ENABLE, 1)


def force_charge(inv: Inverter, power_w: int) -> None:
    global _forced_active
    sign = _charge_sign()
    power_w = clamp_power_w(power_w)
    soc = inv.soc_pct()
    if soc >= SOC_CEILING_PCT:
        log.info("force_charge: SoC %.1f%% >= ceiling %.1f%% — returning to auto instead", soc, SOC_CEILING_PCT)
        return_to_auto(inv)
        return
    raw = sign * (power_w // 10)
    log.info("force_charge: %d W (raw %d), SoC %.1f%%", power_w, raw, soc)
    inv.write_u16(REG_MAX_IMPORT, (-GRID_CAP_RAW) & 0xFFFF)  # allow grid import
    inv.write_u16(REG_MAX_EXPORT, GRID_CAP_RAW)
    inv.write_u16(REG_PRIORITY, 0)                           # PV priority
    inv.write_u16(REG_BATT_POWER_TARGET, raw)                # power before mode
    time.sleep(0.3)
    inv.write_u16(REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)
    _forced_active = True


def force_discharge(inv: Inverter, power_w: int) -> None:
    global _forced_active
    sign = _charge_sign()
    power_w = clamp_power_w(power_w)
    soc = inv.soc_pct()
    if soc <= SOC_FLOOR_PCT:
        log.info("force_discharge: SoC %.1f%% <= floor %.1f%% — returning to auto instead", soc, SOC_FLOOR_PCT)
        return_to_auto(inv)
        return
    raw = -sign * (power_w // 10)  # discharge = opposite of charge sign
    log.info("force_discharge: %d W (raw %d), SoC %.1f%%", power_w, raw, soc)
    inv.write_u16(REG_MAX_EXPORT, GRID_CAP_RAW)              # allow export
    inv.write_u16(REG_MAX_IMPORT, (-GRID_CAP_RAW) & 0xFFFF)
    inv.write_u16(REG_PRIORITY, 1)                           # battery priority
    inv.write_u16(REG_BATT_POWER_TARGET, raw)
    time.sleep(0.3)
    inv.write_u16(REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)
    _forced_active = True


# ── Fail-safe: revert to auto on exit/crash/signal ──────────────────────────────
# _forced_active tracks whether THIS process actually put the inverter into a forced
# EMS BattCtrl setpoint (via force_charge/force_discharge) that hasn't been reverted
# yet. Commands that never touch the setpoint (status, set-floor, a completed auto)
# leave it False, so exit/signal cleanup only closes the connection — it does not
# reconnect and rewrite a mode that was never changed (which previously produced a
# spurious "Connection refused" error on every clean exit, and would otherwise risk
# clobbering a mode set deliberately via the inverter's own app).
_active_inv: "Inverter | None" = None
_forced_active = False


def _install_failsafe(inv: Inverter) -> None:
    global _active_inv
    _active_inv = inv

    def _revert(*_args):
        if _active_inv is None:
            return
        if ARMED and _forced_active:
            try:
                return_to_auto(_active_inv)
            except Exception as exc:  # noqa: BLE001
                log.error("fail-safe revert_to_auto failed: %s", exc)
        _active_inv.close()

    atexit.register(_revert)
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, lambda *_a: (_revert(), sys.exit(0)))
        except ValueError:
            pass  # not in main thread


# ── Manual CLI for bench testing ────────────────────────────────────────────────
def _main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if len(argv) < 2:
        print("usage: inverter_control.py [status|auto|charge <W>|discharge <W>|set-floor [pct]]")
        return 2
    inv = Inverter()
    _install_failsafe(inv)
    cmd = argv[1]
    # No local close() here — the fail-safe installed above owns connection
    # teardown (and any needed revert) on exit, so it isn't closed twice.
    if cmd == "status":
        print(f"mode=0x{inv.work_mode():X}  SoC={inv.soc_pct()}%  battery={inv.battery_power_w()} W")
    elif cmd == "auto":
        return_to_auto(inv)
    elif cmd == "charge":
        force_charge(inv, int(argv[2]))
    elif cmd == "discharge":
        force_discharge(inv, int(argv[2]))
    elif cmd == "set-floor":
        set_soc_floor(inv, float(argv[2]) if len(argv) > 2 else SOC_FLOOR_PCT)
    else:
        print(f"unknown command: {cmd}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
