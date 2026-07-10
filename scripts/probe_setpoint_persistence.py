#!/usr/bin/env python3
"""
One-shot on-device probe: does a forced 50207 setpoint PERSIST for a full
15-minute slot, or does the firmware decay/clear it (requiring the dispatch
loop to re-assert mid-slot)?

Method: enter EMS BattCtrl with a gentle CHARGE target (charging chosen so the
probe is SoC-safe anywhere above the floor), write the setpoint ONCE, then only
observe for OBSERVE_MIN minutes — sampling battery power (30258), the 50207
readback, and the working mode (50000) every SAMPLE_GAP_S seconds. Any drift of
battery power away from the target, a changed 50207 readback, or a mode flip
counts as decay.

SAFE BY DESIGN:
  - low probe power (default 1500 W; override with arg 1)
  - refuses to run unless 12% <= SoC <= 92% (charge headroom + floor margin)
  - ALWAYS restores the inverter's original working mode in a finally block

Prerequisites (same as the sign probe):
  SOLINTEG_HOST / SOLINTEG_SLAVE_ID set (via /opt/solinteg/solinteg.env)
  SOLINTEG_CONTROL_ARMED=1        this script writes registers
  SOLINTEG_50207_SIGN=neg_charge  confirmed 2026-07-02 by probe_50207_sign.py
"""

import logging
import sys
import time

from inverter_control import (
    ARMED,
    SIGN,
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

log = logging.getLogger("solinteg.persistence-probe")

OBSERVE_MIN = 16          # one full 15-min slot plus margin
SAMPLE_GAP_S = 15
TOLERANCE_W = 300         # |battery power − target| beyond this = drift


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not ARMED:
        print("Refusing: set SOLINTEG_CONTROL_ARMED=1 (this script writes registers).")
        return 2
    if SIGN not in ("neg_charge", "pos_charge"):
        print("Refusing: SOLINTEG_50207_SIGN not set — run probe_50207_sign.py first.")
        return 2

    probe_w = int(argv[1]) if len(argv) > 1 else 1500
    charge_sign = -1 if SIGN == "neg_charge" else +1
    raw_target = charge_sign * (probe_w // 10)  # charge direction

    inv = Inverter()
    original_mode = None
    samples: list[tuple[float, int, int, int]] = []  # (t, battery_w, reg50207, mode)
    try:
        soc = inv.soc_pct()
        if not (12.0 <= soc <= 92.0):
            print(f"Refusing: SoC {soc}% outside safe probe window 12–92%.")
            return 2

        original_mode = inv.work_mode()
        log.info("SoC %.1f%%, original mode 0x%X. Forcing CHARGE %d W (raw %d), then observing %d min.",
                 soc, original_mode, probe_w, raw_target, OBSERVE_MIN)

        inv.write_u16(REG_MAX_EXPORT, GRID_CAP_RAW)
        inv.write_u16(REG_MAX_IMPORT, (-GRID_CAP_RAW) & 0xFFFF)
        inv.write_u16(REG_PRIORITY, 0)
        inv.write_u16(REG_BATT_POWER_TARGET, raw_target)
        time.sleep(0.3)
        inv.write_u16(REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)

        # From here on: OBSERVE ONLY. No further writes until restore.
        t0 = time.monotonic()
        target_w = charge_sign * probe_w  # signed, matches 30258 convention (−ve = charging)
        time.sleep(20)  # let the ramp settle before judging drift

        while (time.monotonic() - t0) < OBSERVE_MIN * 60:
            bp = inv.battery_power_w()
            sp = inv.read_s16(REG_BATT_POWER_TARGET)
            mode = inv.work_mode()
            t_min = (time.monotonic() - t0) / 60
            samples.append((t_min, bp, sp, mode))
            drift = abs(bp - target_w)
            flag = "" if drift <= TOLERANCE_W and sp == raw_target and mode == WORK_MODE_EMS_BATTCTRL else "  ← DEVIATION"
            log.info("t=%5.1f min  battery=%+6d W  50207=%+5d  mode=0x%X%s", t_min, bp, sp, mode, flag)
            time.sleep(SAMPLE_GAP_S)

        # Verdict
        deviations = [s for s in samples
                      if abs(s[1] - target_w) > TOLERANCE_W or s[2] != raw_target or s[3] != WORK_MODE_EMS_BATTCTRL]
        print("\n──────── VERDICT ────────")
        print(f"target {target_w:+d} W held for {OBSERVE_MIN} min, {len(samples)} samples, "
              f"{len(deviations)} deviation(s) (tolerance ±{TOLERANCE_W} W)")
        if not deviations:
            print("SETPOINT PERSISTS — no mid-slot re-assert needed (a periodic")
            print("re-assert is still cheap insurance for the dispatch loop).")
        else:
            first = deviations[0]
            print(f"SETPOINT DECAYS — first deviation at t={first[0]:.1f} min "
                  f"(battery {first[1]:+d} W, 50207={first[2]:+d}, mode=0x{first[3]:X}).")
            print("The dispatch loop MUST re-assert the setpoint more often than that.")
        print("─────────────────────────\n")
        return 0
    finally:
        # original_mode is None iff we refused to run (SoC out of window) — in that case
        # we never wrote anything, so restoring must be a no-op, not a forced-to-General write.
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
