#!/usr/bin/env python3
"""
One-shot READ-ONLY probe: reads inverter register 10008 (model/firmware) plus a
few neighboring registers and the inverter-status register (10105), to confirm
the register map assumed throughout MODBUS.md actually applies to this exact
unit before arming control — the datasheet on file is for MHT-25-50, the
installed unit is a Solinteg MHT-20K-40 (see CLAUDE.md). This was the one
still-open precondition in MODBUS.md's table ("Never read in any script").

Pure read — no SOLINTEG_CONTROL_ARMED gate needed, no registers written.

Usage:
  SOLINTEG_HOST=192.168.1.50 python3 scripts/read_model_register.py
"""

import sys

from inverter_control import Inverter, REG_WORK_MODE

REG_MODEL = 10008
REG_STATUS = 10105
WINDOW_COUNT = 8  # in case the model is packed ASCII across multiple registers


def try_window(inv: Inverter, addr: int, count: int, label: str) -> bool:
    """Try FC03 (holding) then FC04 (input) — the 10xxx block may be a read-only
    input-register bank distinct from the 3xxxx/5xxxx holding registers everything
    else in this codebase reads, which would explain a clean timeout on FC03."""
    for fc_name, reader in (
        ("holding (FC03)", inv.client.read_holding_registers),
        ("input (FC04)", inv.client.read_input_registers),
    ):
        try:
            resp = reader(addr, count=count, device_id=inv.unit)
        except Exception as exc:  # noqa: BLE001
            print(f"{label} via {fc_name}: raised {exc!r}")
            continue
        if resp.isError():
            print(f"{label} via {fc_name}: error response {resp}")
            continue
        regs = resp.registers
        print(f"{label} via {fc_name}: raw = {regs}")
        chars = []
        for r in regs:
            chars.append(chr((r >> 8) & 0xFF))
            chars.append(chr(r & 0xFF))
        ascii_guess = "".join(c if 32 <= ord(c) < 127 else "." for c in chars)
        print(f"{label} via {fc_name}: as packed ASCII (best-effort guess): {ascii_guess!r}")
        return True
    return False


def main() -> int:
    inv = Inverter()
    try:
        model_ok = try_window(inv, REG_MODEL, WINDOW_COUNT, f"reg {REG_MODEL} (model)")
        status_ok = try_window(inv, REG_STATUS, 1, f"reg {REG_STATUS} (inverter status)")
        work_mode = inv.work_mode()
        print(f"reg {REG_WORK_MODE} (work mode, known-good FC03 register, sanity check): 0x{work_mode:X}")
        if not model_ok:
            print(f"\nCOULD NOT READ reg {REG_MODEL} via either function code.")
        if not status_ok:
            print(f"COULD NOT READ reg {REG_STATUS} via either function code.")
        return 0 if (model_ok or status_ok) else 1
    finally:
        inv.close()


if __name__ == "__main__":
    raise SystemExit(main())
