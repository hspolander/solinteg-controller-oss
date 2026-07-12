#!/usr/bin/env python3
"""
One-shot on-device probe: determine the SIGN CONVENTION of reg 50207
(EMS BattCtrl battery power target) on THIS inverter+firmware.

The HA source does not document whether a positive 50207 value charges or
discharges. This writes a gentle power target in each direction, watches the
battery power readback (reg 30258, where −ve = charging), and tells you which
value to set for SOLINTEG_50207_SIGN.

SAFE BY DESIGN:
  - low probe power (default 1500 W; override with arg 1)
  - refuses to run unless 25% <= SoC <= 90% (headroom for both directions)
  - short dwell per direction (~18 s)
  - ALWAYS restores the inverter's original working mode in a finally block

Prerequisites:
  export SOLINTEG_HOST=<inverter ip>
  export SOLINTEG_CONTROL_ARMED=1     # required — this script writes registers

Run once, on a quiet day, while you watch the inverter. Read the verdict, then
set SOLINTEG_50207_SIGN in /opt/solinteg/solinteg.env accordingly.
"""

import logging
import os
import sys
import time

# inverter_control lives with the runtime services (scripts/services/); this file is a
# manual diagnostic tool, so it reaches over explicitly.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from inverter_control import (
    ARMED,
    Inverter,
    REG_BATT_POWER_TARGET,
    REG_MAX_EXPORT,
    REG_MAX_IMPORT,
    REG_PRIORITY,
    REG_WORK_MODE,
    WORK_MODE_EMS_BATTCTRL,
    WORK_MODE_GENERAL,
    GRID_CAP_RAW,
)

log = logging.getLogger("solinteg.probe")

DWELL_S = 18
SAMPLES = 6
SAMPLE_GAP_S = 2.0


def _avg_battery_power(inv: Inverter) -> float:
    vals = []
    for _ in range(SAMPLES):
        vals.append(inv.battery_power_w())
        time.sleep(SAMPLE_GAP_S)
    return sum(vals) / len(vals)


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not ARMED:
        print("Refusing: set SOLINTEG_CONTROL_ARMED=1 (this script writes registers).")
        return 2

    probe_w = int(argv[1]) if len(argv) > 1 else 1500
    raw = probe_w // 10  # 0.01 kW units

    inv = Inverter()
    original_mode = None
    try:
        soc = inv.soc_pct()
        if not (25.0 <= soc <= 90.0):
            print(f"Refusing: SoC {soc}% outside safe probe window 25–90%.")
            return 2

        original_mode = inv.work_mode()
        log.info("SoC %.1f%%, original mode 0x%X. Probing at %d W (raw %d).", soc, original_mode, probe_w, raw)

        # Allow power to flow either way, modest caps, enter EMS BattCtrl.
        inv.write_u16(REG_MAX_EXPORT, GRID_CAP_RAW)
        inv.write_u16(REG_MAX_IMPORT, (-GRID_CAP_RAW) & 0xFFFF)
        inv.write_u16(REG_PRIORITY, 0)
        inv.write_u16(REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)

        # Phase A: POSITIVE target
        log.info("Phase A: 50207 = +%d (raw). Dwelling %ds…", raw, DWELL_S)
        inv.write_u16(REG_BATT_POWER_TARGET, +raw)
        time.sleep(DWELL_S)
        bp_pos = _avg_battery_power(inv)
        log.info("  avg battery power with POSITIVE target: %+.0f W", bp_pos)

        # Phase B: NEGATIVE target
        log.info("Phase B: 50207 = -%d (raw). Dwelling %ds…", raw, DWELL_S)
        inv.write_u16(REG_BATT_POWER_TARGET, (-raw) & 0xFFFF)
        time.sleep(DWELL_S)
        bp_neg = _avg_battery_power(inv)
        log.info("  avg battery power with NEGATIVE target: %+.0f W", bp_neg)

        # 30258: −ve = charging. Whichever target produced the more-negative
        # battery power is the charge direction.
        print("\n──────── VERDICT ────────")
        print(f"POSITIVE 50207 → battery power {bp_pos:+.0f} W")
        print(f"NEGATIVE 50207 → battery power {bp_neg:+.0f} W")
        if bp_pos < bp_neg:
            print("POSITIVE target charges (battery power more negative).")
            print("  => set SOLINTEG_50207_SIGN=pos_charge")
        else:
            print("NEGATIVE target charges (battery power more negative).")
            print("  => set SOLINTEG_50207_SIGN=neg_charge   (matches the PDF default)")
        print("─────────────────────────\n")
        return 0
    finally:
        # Restore: neutralize setpoint and go back to the original mode. Only if we
        # actually got past the SoC-refusal check and touched the inverter — original_mode
        # is None iff we refused to run, and refusing must mean zero writes, not a silent
        # forced-to-General fallback.
        if original_mode is not None:
            try:
                inv.write_u16(REG_BATT_POWER_TARGET, 0, verify=False)
                inv.write_u16(REG_WORK_MODE, original_mode)
                log.info("Restored working mode.")
            except Exception as exc:  # noqa: BLE001
                log.error("Restore failed — CHECK THE INVERTER: %s", exc)
        inv.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
