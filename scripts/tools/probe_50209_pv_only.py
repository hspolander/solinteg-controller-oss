#!/usr/bin/env python3
"""
One-shot on-device probe: does `50209 = 0` really block the inverter's AC INPUT on THIS
unit+firmware — i.e. is a hardware-enforced PV-only charge actually available?

Answers the two questions MODBUS.md's "DO NOT enable live control" table lists for
50208/50209, both of which gate the `50209 = 0` PV-only charge idea:

  Q1  POLARITY / EFFECT.  We only ever write 50208/50209 to symmetric +-GRID_CAP today, so a
      swapped label would be invisible. `50209 = 0` is the first ASYMMETRIC value we would
      depend on. Does it block grid-funded charging (leaving PV-funded charging alone), or
      does it do nothing / restrict the wrong direction?

  Q2  WRITE ORDER.  The third-party doc (sixuniform/YOUEMS, 2026-08-02 revision) claims EMS
      limit writes are ignored unless the inverter is ALREADY in EMS BattCtrl (0x303).
      Production writes the caps BEFORE the mode (inverter_control.force_charge). If that
      claim holds, every restrictive cap we write in production order is silently dropped.

METHOD — force a charge at a power the sun CANNOT fund, so grid funding is required and
therefore visible, then take the cap away and watch what happens:

  Phase 0  baseline   observe self-use, no writes
  Phase A  control    caps unrestricted (50208=+1100, 50209=-1100), charge at PROBE_W
                      => grid-funded charge; this is exactly what production does today
  Phase B  in-mode    write 50209=0 while ALREADY in 0x303, change nothing else   -> Q1
  Phase C  pre-mode   back to auto, then write caps INCLUDING 50209=0 BEFORE entering
                      0x303 (production's own order)                              -> Q2
  restore             caps back to +-GRID_CAP *while still in 0x303*, 50207=0, original mode

Reading the result:
  B looks like A          -> 50209=0 has no effect in-mode; PV-only charge is NOT available
  B charge ~= PV surplus  -> cap enforced; PV-only charge IS available
  C looks like B          -> pre-mode cap writes stick; production's write order is fine
  C looks like A          -> pre-mode cap writes are dropped; write order MUST change before
                             anything ships an asymmetric cap

Register READBACKS are recorded alongside the power channels in every phase, because
"value did not stick" and "value stuck but is not enforced" are different bugs with
different fixes, and only the readback separates them.

WHAT THE REFERENCE DEPLOYMENT MEASURED (MHT-20K-40, 2026-08-07) — evidence for what to
expect on yours, NOT proof about your unit, which is the whole reason this script exists:
  - `50209 = 0` written IN-MODE blocked AC input as documented: inverter AC went from
    −1952 W (absorbing 2 kW from the grid) to +294 W. Polarity is as the Pinv sign rule says.
  - `50209 = 0` written PRE-MODE was **stored but never enforced** — it read back as `0`
    while a full 6 kW grid-funded charge ran. **The readback lies.** Treat any check that
    infers "the cap is applied" from a readback as unsound.
  - The result that matters most, and it is topology rather than firmware, so it very likely
    transfers to your install too: blocking AC input does NOT stop grid funding, it RELOCATES
    it. With input blocked the battery simply outbids the house for PV (measured: 3764 W to
    battery, 294 W to the house, so the house bought 454 W from the grid — while the same
    load minutes earlier in auto was fully PV-served). Economically that is identical to
    grid-charging the battery, and it is worst exactly when solar under-delivers, which is
    the case a "PV-only charge" would be wanted for. **So this register does not give you a
    hardware-enforced solar-only charge in any economically meaningful sense.** A software
    guard comparing planned vs live *funding* is the stronger check. See MODBUS.md.

Given that, the reason to still run this is the battery-freeze/hold case (50207/50208/50209
all zero), where blocking flow is the actual point — and there the write-order result above
is critical, because a freeze written pre-mode would read back as frozen and not be.

SAFE BY DESIGN:
  - never writes 50208=0 (this is not the battery-freeze/hold probe); export stays open
  - refuses unless there is real sun and real SoC headroom
  - restores caps BEFORE leaving 0x303, then verifies the readback and retries once
  - marks inverter_control._forced_active so the module's own atexit/SIGTERM fail-safe
    ALSO restores the caps if this process dies unexpectedly

  A stale restrictive 50209 is the one genuinely costly outcome (it would cripple
  self-consumption across every following idle slot), so the restore is verified, not
  assumed. Run --verify-only afterwards for an independent confirmation.

WHAT THIS PROBE CANNOT ANSWER: whether the inverter's own 52502/52503 SoC floor can still
grid-charge back up with AC input blocked. That needs a near-empty battery, which does not
coincide with the sunny afternoon this probe requires. See MODBUS.md.

Prerequisites:
  export SOLINTEG_HOST=<inverter ip>
  export SOLINTEG_SLAVE_ID=255
  export SOLINTEG_CONTROL_ARMED=1     # required — this script writes registers
  export SOLINTEG_50207_SIGN=neg_charge

The live dispatch loop and its watchdog must NOT be writing while this runs, or they will
fight the probe. The cleanest way is to set SOLINTEG_CONTROL_ARMED=0 in your env file and
restart solinteg-dispatch: every write in inverter_control.py then short-circuits, so both
the loop and the watchdog become no-ops without stopping any service. This probe sets ARMED
in its OWN process environment, so it still writes. Re-arm afterwards — and verify with
--verify-only BEFORE you re-arm (see the restore warning below).

Usage:
  probe_50209_pv_only.py [PROBE_W]     run the probe (default 6000 W)
  probe_50209_pv_only.py --verify-only read and print the control registers, write nothing
"""

import json
import logging
import os
import sys
import time

# inverter_control lives with the runtime services (scripts/services/); this file is a
# manual diagnostic tool, so it reaches over explicitly — same as probe_50207_sign.py.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

import inverter_control as ic  # noqa: E402  (module handle: we set _forced_active on it)
from inverter_control import (  # noqa: E402
    ARMED,
    GRID_CAP_RAW,
    Inverter,
    REG_BATT_POWER_TARGET,
    REG_MAX_AC_INPUT,
    REG_MAX_AC_OUTPUT,
    REG_PRIORITY,
    REG_WORK_MODE,
    WORK_MODE_EMS_BATTCTRL,
    WORK_MODE_GENERAL,
)

log = logging.getLogger("solinteg.probe50209")

DEFAULT_PROBE_W = 6000
SETTLE_S = 15          # let the inverter ramp before believing anything
SAMPLES = 12
SAMPLE_GAP_S = 3.0
BASELINE_SAMPLES = 6

SOC_MIN_PCT = 15.0     # headroom to charge for the whole probe, and clear of the floor
SOC_MAX_PCT = 85.0
PV_MIN_W = 1200        # below this, "charging from PV only" is indistinguishable from "not charging"


# ── raw decode helpers (the Inverter class only exposes single-register reads) ──
def _s32(hi: int, lo: int) -> int:
    u = (hi << 16) | lo
    return u - 0x100000000 if u & 0x80000000 else u


def read_power(inv: Inverter) -> dict:
    """PV / grid / battery / inverter-AC / SoC in one pass.

    Block 11000..11029 mirrors modbus_poller.py's own proven read, so the addresses and
    sign conventions here are the same ones the rest of the system already trusts.
    """
    inv._ensure()
    r1 = inv.client.read_holding_registers(11000, count=30, device_id=inv.unit)
    if r1.isError():
        raise IOError(f"block 11000 read failed: {r1}")
    regs = r1.registers
    r2 = inv.client.read_holding_registers(30258, count=2, device_id=inv.unit)
    if r2.isError():
        raise IOError(f"block 30258 read failed: {r2}")
    return {
        "grid_w": _s32(regs[0], regs[1]),            # +export / -import
        "inverter_ac_w": _s32(regs[16], regs[17]),   # the quantity 50208/50209 actually cap
        "pv_w": _s32(regs[28], regs[29]),
        "battery_w": _s32(r2.registers[0], r2.registers[1]),  # -charge / +discharge
        "soc_pct": inv.soc_pct(),
    }


def read_control(inv: Inverter) -> dict:
    """The five control registers, as stored. Single reads: all five are known-good on this
    dongle, and an unfamiliar block read is exactly what wedged it once before (MODBUS.md)."""
    return {
        "mode": inv.read_u16(REG_WORK_MODE),
        "r50207": inv.read_s16(REG_BATT_POWER_TARGET),
        "r50208": inv.read_s16(REG_MAX_AC_OUTPUT),
        "r50209": inv.read_s16(REG_MAX_AC_INPUT),
        "r50210": inv.read_u16(REG_PRIORITY),
    }


def collect(inv: Inverter, n: int, gap: float) -> list[dict]:
    out = []
    for _ in range(n):
        out.append(read_power(inv))
        time.sleep(gap)
    return out


def summarize(samples: list[dict]) -> dict:
    keys = ("pv_w", "grid_w", "battery_w", "inverter_ac_w", "soc_pct")
    s = {}
    for k in keys:
        vals = [x[k] for x in samples]
        s[k] = {
            "mean": round(sum(vals) / len(vals), 1),
            "min": min(vals),
            "max": max(vals),
        }
    return s


def show(label: str, ctrl_before: dict, samples: list[dict], ctrl_after: dict) -> dict:
    s = summarize(samples)
    print(f"\n── {label} ──")
    print(f"   regs before: mode=0x{ctrl_before['mode']:X} 50207={ctrl_before['r50207']} "
          f"50208={ctrl_before['r50208']} 50209={ctrl_before['r50209']} prio={ctrl_before['r50210']}")
    print(f"   regs after : mode=0x{ctrl_after['mode']:X} 50207={ctrl_after['r50207']} "
          f"50208={ctrl_after['r50208']} 50209={ctrl_after['r50209']} prio={ctrl_after['r50210']}")
    for k in ("pv_w", "battery_w", "grid_w", "inverter_ac_w"):
        v = s[k]
        print(f"   {k:>14}: mean {v['mean']:+9.1f}   min {v['min']:+7d}   max {v['max']:+7d}")
    print(f"   {'soc_pct':>14}: mean {s['soc_pct']['mean']:+9.1f}")
    return {"label": label, "ctrl_before": ctrl_before, "ctrl_after": ctrl_after,
            "summary": s, "samples": samples}


def enter_forced_charge(inv: Inverter, raw_target: int, *, cap_in_raw: int) -> None:
    """Production's own force_charge write order: caps -> priority -> power -> mode.

    cap_in_raw is what goes to 50209 (0 for the restrictive test, -GRID_CAP_RAW for the
    unrestricted control). verify=False on the caps deliberately: a REJECTED restrictive
    write is a result to record, not an exception that aborts the probe mid-flight.
    """
    inv.write_u16(REG_MAX_AC_INPUT, cap_in_raw & 0xFFFF, verify=False)
    inv.write_u16(REG_MAX_AC_OUTPUT, GRID_CAP_RAW, verify=False)
    inv.write_u16(REG_PRIORITY, 0)                       # PV priority, constant across phases
    inv.write_u16(REG_BATT_POWER_TARGET, raw_target)
    time.sleep(0.3)
    inv.write_u16(REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)
    ic._forced_active = True                             # arm the module's own fail-safe


def restore(inv: Inverter, original_mode: int) -> bool:
    """Caps back to unrestricted, setpoint neutralized, original mode. Verified.

    Caps are written BEFORE the mode write, while still in 0x303 — if the doc's write-order
    claim is right, that is the only window where they land. Then we read back, and if 50209
    is still restrictive we retry in the restored mode, which covers the opposite case too.
    """
    ok = True
    try:
        ic.restore_ac_limits(inv)
        inv.write_u16(REG_BATT_POWER_TARGET, 0, verify=False)
        inv.write_u16(REG_WORK_MODE, original_mode)
        ic._forced_active = False
    except Exception as exc:  # noqa: BLE001
        log.error("restore: first attempt raised: %s", exc)
        ok = False

    for attempt in (1, 2):
        try:
            c = read_control(inv)
        except Exception as exc:  # noqa: BLE001
            log.error("restore: verification read failed: %s", exc)
            return False
        if c["r50209"] == -GRID_CAP_RAW and c["r50208"] == GRID_CAP_RAW and c["mode"] == original_mode:
            print(f"\n[restore verified] mode=0x{c['mode']:X} 50207={c['r50207']} "
                  f"50208={c['r50208']} 50209={c['r50209']}")
            return ok
        log.error("restore: state still wrong (attempt %d): %s", attempt, c)
        if attempt == 1:
            try:
                inv.write_u16(REG_MAX_AC_OUTPUT, GRID_CAP_RAW, verify=False)
                inv.write_u16(REG_MAX_AC_INPUT, (-GRID_CAP_RAW) & 0xFFFF, verify=False)
                inv.write_u16(REG_WORK_MODE, original_mode)
            except Exception as exc:  # noqa: BLE001
                log.error("restore: retry write failed: %s", exc)
    print("\n*** RESTORE FAILED — 50209 may still be restrictive. DO NOT RE-ARM. ***")
    print("*** Check the inverter and fix 50208/50209 by hand before re-arming dispatch. ***")
    return False


def verify_only(inv: Inverter) -> int:
    c = read_control(inv)
    p = read_power(inv)
    print(f"mode=0x{c['mode']:X}  50207={c['r50207']}  50208={c['r50208']}  "
          f"50209={c['r50209']}  prio={c['r50210']}")
    print(f"pv={p['pv_w']} W  grid={p['grid_w']} W  battery={p['battery_w']} W  "
          f"inverter_ac={p['inverter_ac_w']} W  soc={p['soc_pct']}%")
    healthy = c["r50208"] == GRID_CAP_RAW and c["r50209"] == -GRID_CAP_RAW
    print("caps: UNRESTRICTED (healthy)" if healthy
          else f"caps: RESTRICTIVE — expected 50208={GRID_CAP_RAW}, 50209={-GRID_CAP_RAW}")
    return 0 if healthy else 1


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if "--verify-only" in argv:
        inv = Inverter()
        try:
            return verify_only(inv)
        finally:
            inv.close()

    if not ARMED:
        print("Refusing: set SOLINTEG_CONTROL_ARMED=1 (this script writes registers).")
        return 2

    probe_w = int(argv[1]) if len(argv) > 1 else DEFAULT_PROBE_W
    raw_target = -(probe_w // 10)  # neg_charge; asserted against the configured sign below
    if ic._charge_sign() != -1:
        print("Refusing: this probe assumes SOLINTEG_50207_SIGN=neg_charge.")
        return 2

    inv = Inverter()
    ic._install_failsafe(inv)
    original_mode = None
    record: dict = {"probe_w": probe_w, "phases": []}
    try:
        pre = read_power(inv)
        ctrl0 = read_control(inv)
        print(f"\nStart: pv={pre['pv_w']} W  grid={pre['grid_w']} W  battery={pre['battery_w']} W  "
              f"soc={pre['soc_pct']}%  mode=0x{ctrl0['mode']:X}")

        if not (SOC_MIN_PCT <= pre["soc_pct"] <= SOC_MAX_PCT):
            print(f"Refusing: SoC {pre['soc_pct']}% outside probe window "
                  f"{SOC_MIN_PCT}-{SOC_MAX_PCT}%.")
            return 2
        if pre["pv_w"] < PV_MIN_W:
            print(f"Refusing: PV {pre['pv_w']} W < {PV_MIN_W} W — with too little sun, "
                  "'charging from PV only' cannot be told apart from 'not charging'.")
            return 2
        if probe_w <= pre["pv_w"]:
            print(f"Refusing: probe power {probe_w} W <= PV {pre['pv_w']} W. The probe needs a "
                  "target the sun CANNOT fund, so grid funding is required and therefore visible.")
            return 2

        original_mode = ctrl0["mode"]
        record["original_mode"] = original_mode
        record["start"] = pre

        # ── Phase 0: baseline, no writes ──
        log.info("Phase 0: baseline (no writes), %d samples…", BASELINE_SAMPLES)
        s0 = collect(inv, BASELINE_SAMPLES, SAMPLE_GAP_S)
        record["phases"].append(show("Phase 0 — BASELINE (self-use, no writes)",
                                     ctrl0, s0, read_control(inv)))

        # ── Phase A: control — unrestricted caps, grid-funded charge ──
        log.info("Phase A: forced charge %d W, caps UNRESTRICTED (50209=-%d)…",
                 probe_w, GRID_CAP_RAW)
        enter_forced_charge(inv, raw_target, cap_in_raw=-GRID_CAP_RAW)
        time.sleep(SETTLE_S)
        cA0 = read_control(inv)
        sA = collect(inv, SAMPLES, SAMPLE_GAP_S)
        record["phases"].append(show("Phase A — CONTROL (50209 = -1100, unrestricted)",
                                     cA0, sA, read_control(inv)))

        # ── Phase B: the actual test — restrict AC input WHILE ALREADY in 0x303 ──
        log.info("Phase B: writing 50209 = 0 in-mode (nothing else changes)…")
        inv.write_u16(REG_MAX_AC_INPUT, 0, verify=False)
        time.sleep(SETTLE_S)
        cB0 = read_control(inv)
        sB = collect(inv, SAMPLES, SAMPLE_GAP_S)
        record["phases"].append(show("Phase B — 50209 = 0 written IN-MODE (already 0x303)",
                                     cB0, sB, read_control(inv)))

        # ── Phase C: production's write order — caps before mode entry ──
        log.info("Phase C: back to auto, then 50209=0 written BEFORE mode entry…")
        restore(inv, WORK_MODE_GENERAL)
        time.sleep(8)
        enter_forced_charge(inv, raw_target, cap_in_raw=0)
        time.sleep(SETTLE_S)
        cC0 = read_control(inv)
        sC = collect(inv, SAMPLES, SAMPLE_GAP_S)
        record["phases"].append(show("Phase C — 50209 = 0 written PRE-MODE (production order)",
                                     cC0, sC, read_control(inv)))

        # ── Verdict ──
        a, b, c = (record["phases"][i]["summary"] for i in (1, 2, 3))
        bat_a, bat_b, bat_c = (x["battery_w"]["mean"] for x in (a, b, c))
        imp_a, imp_b, imp_c = (min(0.0, x["grid_w"]["mean"]) for x in (a, b, c))
        pv_b = b["pv_w"]["mean"]

        print("\n──────── VERDICT ────────")
        print(f"target                 : {probe_w} W charge (raw {raw_target})")
        print(f"A unrestricted         : battery {bat_a:+.0f} W, grid {a['grid_w']['mean']:+.0f} W, "
              f"inv_ac {a['inverter_ac_w']['mean']:+.0f} W")
        print(f"B 50209=0 in-mode      : battery {bat_b:+.0f} W, grid {b['grid_w']['mean']:+.0f} W, "
              f"inv_ac {b['inverter_ac_w']['mean']:+.0f} W  (PV was {pv_b:.0f} W)")
        print(f"C 50209=0 pre-mode     : battery {bat_c:+.0f} W, grid {c['grid_w']['mean']:+.0f} W, "
              f"inv_ac {c['inverter_ac_w']['mean']:+.0f} W")

        # "Blocked" = the charge lost most of its grid-funded part. Compare against A, which
        # is the same commanded target with the cap open, so the sun is the only other source.
        blocked_b = abs(bat_b) < abs(bat_a) * 0.75 and abs(imp_b) < abs(imp_a) * 0.5
        blocked_c = abs(bat_c) < abs(bat_a) * 0.75 and abs(imp_c) < abs(imp_a) * 0.5

        print()
        if blocked_b:
            print("Q1 EFFECT   : 50209=0 BLOCKS inverter AC input — hardware PV-only charge WORKS.")
        else:
            print("Q1 EFFECT   : 50209=0 did NOT block grid-funded charging in-mode.")
            print("              A hardware-enforced PV-only charge is NOT available this way.")
        if blocked_c and blocked_b:
            print("Q2 ORDER    : pre-mode cap writes STICK — production's caps-before-mode order is OK.")
        elif blocked_b and not blocked_c:
            print("Q2 ORDER    : pre-mode cap writes are DROPPED — the doc's write-order rule HOLDS.")
            print("              inverter_control.force_charge must write caps AFTER mode entry")
            print("              before anything ships an asymmetric cap.")
        else:
            print("Q2 ORDER    : inconclusive (Q1 negative — nothing to order).")
        print(f"readbacks   : B 50209={record['phases'][2]['ctrl_before']['r50209']}, "
              f"C 50209={record['phases'][3]['ctrl_before']['r50209']} "
              f"(0 = value stored; -1100 = write did not stick)")
        print("─────────────────────────")
        record["verdict"] = {"blocked_in_mode": blocked_b, "blocked_pre_mode": blocked_c}
        return 0
    finally:
        if original_mode is not None:
            restore(inv, original_mode)
        out = os.path.join(os.path.expanduser("~"), "probe_50209_result.json")
        try:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2)
            print(f"[record written to {out}]")
        except OSError as exc:
            log.error("could not write record: %s", exc)
        inv.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
