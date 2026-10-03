#!/usr/bin/env python3
"""
One-shot on-device probe: can THIS inverter hold the battery still while the grid carries
the house, i.e. is a `hold` / battery-freeze action executable?

Why it matters: the planner already plans "grid covers the house, battery holds" in no-solar
deficit slots, but `idle` maps to self-use, which drains the battery into them instead
(on the reference deployment, a few kWh a month in summer and tens of kWh by autumn). The
winter replay prices executing it at up to a few hundred kr per winter. Nothing can ship until
the mechanism is confirmed on the device, and `50208 = 0` has never been written to it.

THE QUESTIONS (run at night: no PV, real house load, so a hold is unambiguous):

  QA  SOFT HOLD.  EMS BattCtrl (0x303) with 50207 = 0 and the caps left OPEN. MODBUS.md says
      this "forces zero battery power". If that already freezes the battery with the grid
      covering the house, a no-solar hold needs no restrictive caps at all: the smallest and
      safest recipe, nothing that can be left behind.
  QB  FULL FREEZE.  The documented recipe: 0x303 + 50207 = 0 + 50209 = 0 + 50208 = 0, the caps
      written IN-MODE (an earlier probe proved pre-mode cap writes are silently dropped,
      while reading back as if they stuck). Does the battery stay at ~0 W, and does the GRID
      still serve the whole house on all three phases? The third-party doc warns behaviour
      with both AC limits at zero is firmware- and topology-dependent.
  QC  READBACKS. Do the in-mode cap writes read back as written? Recorded, never trusted as
      proof: the verdict comes from measured battery/grid power only.

  Phase 0  baseline   self-use, no writes: the battery should be covering the house
  Phase A  soft hold  50207 = 0, then mode 0x303; caps untouched (unrestricted)
  Phase B  freeze     still in 0x303: 50209 = 0, then 50208 = 0
  restore             caps back to +-GRID_CAP WHILE STILL IN 0x303, 50207 = 0, original mode;
                      read back, retry once

WHAT THIS PROBE CANNOT ANSWER: what the inverter's own SoC floor (52502/52503, 8 %) does with AC
input blocked. Answering it would mean freezing a near-empty battery on purpose. The planned
answer is a guard instead: never hold below ~15 % SoC (priced in winter-policy-replay.ts's
holdMinKwh). Nor does it test a hold with PV surplus: the freeze blocks PV export too.

SAFE BY DESIGN:
  - refuses outside 20-95 % SoC, with PV above 150 W, or with too little house load to see a
    hold (< 400 W baseline drain); refuses if something else is writing the control registers
  - holds for about a minute per phase; the battery cannot move meaningfully either way
  - marks inverter_control._forced_active, so the module's own atexit/SIGTERM fail-safe also
    restores (caps first, while still in 0x303) if this process dies; the watchdog does not
    interfere while dispatch is merely disarmed (its heartbeat stays fresh)
  - restore is verified by readback and retried; a failure prints DO NOT RE-ARM

RUNBOOK (one evening, ~10 min):
  1. Disarm dispatch: set SOLINTEG_CONTROL_ARMED=0 in solinteg.env and restart
     solinteg-dispatch (it hands back to self-use as it stops).
  2. sudo -u solinteg bash -c 'set -a; . /opt/solinteg/solinteg.env; set +a; \
       SOLINTEG_CONTROL_ARMED=1 /opt/solinteg/app/.venv/bin/python \
       /opt/solinteg/app/scripts/tools/probe_hold_freeze.py'
  3. same line with --verify-only at the end: must print "caps: UNRESTRICTED (healthy)"
  4. Re-arm: SOLINTEG_CONTROL_ARMED=1 in solinteg.env, restart solinteg-dispatch.
  The record lands in the solinteg user's home: ~solinteg/probe_hold_result.json.
  BEFORE STEP 2, confirm nothing is wired to the inverter's backup/EPS output: with
  50208 = 0 the inverter can deliver no AC, so a load on that port would lose power.

Usage:
  probe_hold_freeze.py                run the probe
  probe_hold_freeze.py --verify-only  read and print the control registers, write nothing
  probe_hold_freeze.py --restore      put the caps back to unrestricted and the mode back to
                                      General (self-use), then verify. The manual recovery if a
                                      run was cut off; safe to run any time
"""

import json
import logging
import os
import signal
import sys
import time

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

log = logging.getLogger("solinteg.probehold")

SETTLE_S = 15
SAMPLES = 12
SAMPLE_GAP_S = 3.0
BASELINE_SAMPLES = 8
QUIET_CHECK_S = 20      # watch the control registers this long: is anyone else writing?

SOC_MIN_PCT = 20.0      # well clear of the inverter's own 8 % floor (its behaviour frozen is unknown)
SOC_MAX_PCT = 95.0
PV_MAX_W = 150          # night probe: solar would muddle "who is covering the house"
LOAD_MIN_W = 400        # baseline battery drain must be visible, or a hold proves nothing

HELD_MAX_BATT_W = 150   # |battery| below this = held
GRID_COVERS_SHARE = 0.8 # grid import must cover at least this share of the baseline drain


RETRIES = 4
RETRY_GAP_S = 2.0


def _retry(inv: Inverter, what: str, fn):
    """Run one Modbus operation, retrying on a fresh connection.

    The dongle stalls or garbles a reply now and then (MODBUS.md: Solinteg's cloud contends
    for it ~1x/min). The first real run of this probe died in Phase 0 on exactly
    that: one 36-register reply arrived truncated ("byte_count 72 > length of packet 3") and
    pymodbus lost transaction-id sync. The poller shrugs that off by polling again; a one-shot
    probe has to retry instead. A fresh connection resets the transaction state. Re-sending a
    write is harmless: it writes the same value.
    """
    for attempt in range(1, RETRIES + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            if attempt == RETRIES:
                raise
            log.warning("%s failed (attempt %d/%d): %s; reconnecting", what, attempt, RETRIES, exc)
            inv.close()
            time.sleep(RETRY_GAP_S)


def write(inv: Inverter, addr: int, value: int, **kw) -> None:
    _retry(inv, f"write {addr}={value}", lambda: inv.write_u16(addr, value, **kw))


def _s32(hi: int, lo: int) -> int:
    u = (hi << 16) | lo
    return u - 0x100000000 if u & 0x80000000 else u


def read_power(inv: Inverter) -> dict:
    return _retry(inv, "power read", lambda: _read_power_once(inv))


def _read_power_once(inv: Inverter) -> dict:
    """Per-phase meter, meter total, inverter AC, PV and battery in two reads.

    10994..11029 is modbus_poller.py's own block (per-phase meter included), so
    these addresses and sign conventions are the ones the rest of the system trusts.
    """
    inv._ensure()
    r1 = inv.client.read_holding_registers(10994, count=36, device_id=inv.unit)
    if r1.isError():
        raise IOError(f"block 10994 read failed: {r1}")
    regs = r1.registers
    r2 = inv.client.read_holding_registers(30258, count=2, device_id=inv.unit)
    if r2.isError():
        raise IOError(f"block 30258 read failed: {r2}")
    grid = _s32(regs[6], regs[7])
    ac = _s32(regs[22], regs[23])
    return {
        "meter_l1_w": _s32(regs[0], regs[1]),
        "meter_l2_w": _s32(regs[2], regs[3]),
        "meter_l3_w": _s32(regs[4], regs[5]),
        "grid_w": grid,                       # +export / -import
        "inverter_ac_w": ac,
        "pv_w": _s32(regs[34], regs[35]),
        "battery_w": _s32(r2.registers[0], r2.registers[1]),  # -charge / +discharge
        "house_w": ac - grid,                 # the poller's house_load_w identity
        "soc_pct": inv.soc_pct(),
    }


def read_control(inv: Inverter) -> dict:
    return _retry(inv, "control read", lambda: _read_control_once(inv))


def _read_control_once(inv: Inverter) -> dict:
    """The five control registers, as stored. Single reads, all known-good on this dongle."""
    return {
        "mode": inv.read_u16(REG_WORK_MODE),
        "r50207": inv.read_s16(REG_BATT_POWER_TARGET),
        "r50208": inv.read_s16(REG_MAX_AC_OUTPUT),
        "r50209": inv.read_s16(REG_MAX_AC_INPUT),
        "r50210": inv.read_u16(REG_PRIORITY),
    }


KEYS = ("pv_w", "battery_w", "grid_w", "inverter_ac_w", "house_w",
        "meter_l1_w", "meter_l2_w", "meter_l3_w", "soc_pct")


def summarize(samples: list[dict]) -> dict:
    return {k: round(sum(x[k] for x in samples) / len(samples), 1) for k in KEYS}


def collect(inv: Inverter, n: int, gap: float) -> list[dict]:
    out = []
    for _ in range(n):
        out.append(read_power(inv))
        time.sleep(gap)
    return out


def refusal(pre: dict, baseline: dict | None = None) -> str | None:
    """Why the probe must not run in these conditions, or None. Pure, so it is testable."""
    if not (SOC_MIN_PCT <= pre["soc_pct"] <= SOC_MAX_PCT):
        return f"SoC {pre['soc_pct']}% outside {SOC_MIN_PCT}-{SOC_MAX_PCT}%"
    if pre["pv_w"] > PV_MAX_W:
        return f"PV {pre['pv_w']} W > {PV_MAX_W} W; run it after dark"
    if baseline is not None and baseline["battery_w"] < LOAD_MIN_W:
        return (f"baseline battery drain {baseline['battery_w']:.0f} W < {LOAD_MIN_W} W; "
                "with that little load a hold cannot be told apart from idle")
    return None


def held(phase: dict, baseline: dict) -> dict:
    """Did this phase hold? Judged on measured power only, never on register readbacks.

    Held = the battery stays near 0 W AND the grid import rose to cover what the battery was
    covering in the baseline. Both are needed: a battery at 0 W with the house unpowered would
    pass the first test alone.
    """
    batt_ok = abs(phase["battery_w"]) <= HELD_MAX_BATT_W
    need = baseline["battery_w"]                      # what self-use had the battery covering
    extra_import = -(phase["grid_w"] - baseline["grid_w"])
    grid_ok = extra_import >= GRID_COVERS_SHARE * need
    house_ok = phase["house_w"] >= 0.8 * baseline["house_w"]
    return {"battery_held": batt_ok, "grid_covers": grid_ok, "house_served": house_ok,
            "held": batt_ok and grid_ok and house_ok}


def show(label: str, ctrl: dict, s: dict) -> None:
    print(f"\n-- {label} --")
    print(f"   regs: mode=0x{ctrl['mode']:X} 50207={ctrl['r50207']} 50208={ctrl['r50208']} "
          f"50209={ctrl['r50209']} prio={ctrl['r50210']}")
    print(f"   battery {s['battery_w']:+7.0f} W   grid {s['grid_w']:+7.0f} W   house {s['house_w']:+7.0f} W"
          f"   inv_ac {s['inverter_ac_w']:+7.0f} W   pv {s['pv_w']:+5.0f} W   soc {s['soc_pct']:.1f}%")
    print(f"   meter per phase L1/L2/L3: {s['meter_l1_w']:+.0f} / {s['meter_l2_w']:+.0f} / {s['meter_l3_w']:+.0f} W")


def restore(inv: Inverter, original_mode: int) -> bool:
    """Caps back to unrestricted WHILE STILL IN 0x303, setpoint neutralized, original mode.

    Same order and verification as probe_50209_pv_only.restore: the caps only land in-mode, so
    they go first; then read back, and retry once in the restored mode if they did not stick.
    """
    ok = True
    try:
        _retry(inv, "restore caps", lambda: ic.restore_ac_limits(inv))
        write(inv, REG_BATT_POWER_TARGET, 0, verify=False)
        write(inv, REG_WORK_MODE, original_mode)
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
                write(inv, REG_MAX_AC_OUTPUT, GRID_CAP_RAW, verify=False)
                write(inv, REG_MAX_AC_INPUT, (-GRID_CAP_RAW) & 0xFFFF, verify=False)
                write(inv, REG_WORK_MODE, original_mode)
            except Exception as exc:  # noqa: BLE001
                log.error("restore: retry write failed: %s", exc)
    print("\n*** RESTORE FAILED: 50208/50209 may still be restrictive. DO NOT RE-ARM. ***")
    print("*** Fix 50208/50209 by hand (or rerun with --verify-only) before re-arming. ***")
    return False


def verify_only(inv: Inverter) -> int:
    c = read_control(inv)
    p = read_power(inv)
    print(f"mode=0x{c['mode']:X}  50207={c['r50207']}  50208={c['r50208']}  "
          f"50209={c['r50209']}  prio={c['r50210']}")
    print(f"pv={p['pv_w']} W  grid={p['grid_w']} W  battery={p['battery_w']} W  "
          f"house={p['house_w']} W  soc={p['soc_pct']}%")
    healthy = c["r50208"] == GRID_CAP_RAW and c["r50209"] == -GRID_CAP_RAW
    print("caps: UNRESTRICTED (healthy)" if healthy
          else f"caps: RESTRICTIVE: expected 50208={GRID_CAP_RAW}, 50209={-GRID_CAP_RAW}")
    return 0 if healthy else 1


def manual_restore(inv: Inverter) -> int:
    """Recovery for a cut-off run: re-enter 0x303 (caps only land in-mode), reassert the caps,
    then hand back to General. Ends in plain self-use regardless of where it started."""
    write(inv, REG_BATT_POWER_TARGET, 0, verify=False)
    write(inv, REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)
    ok = restore(inv, WORK_MODE_GENERAL)
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if "--restore" in argv:
        if not ARMED:
            print("Refusing: set SOLINTEG_CONTROL_ARMED=1 for this process (it writes registers).")
            return 2
        inv = Inverter()
        try:
            return manual_restore(inv)
        finally:
            inv.close()
    if "--verify-only" in argv:
        inv = Inverter()
        try:
            return verify_only(inv)
        finally:
            inv.close()
    if not ARMED:
        print("Refusing: set SOLINTEG_CONTROL_ARMED=1 for this process (it writes registers).")
        return 2

    inv = Inverter()
    ic._install_failsafe(inv)
    # A dropped SSH session sends SIGHUP, which the module's fail-safe does not catch (it hooks
    # SIGTERM/SIGINT), and Python's default SIGHUP kills the process WITHOUT running the
    # finally below or atexit: the freeze would be left in place. Turn it into a normal exit.
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, lambda *_a: sys.exit(1))
    original_mode = None
    record: dict = {"phases": {}}
    try:
        pre = read_power(inv)
        ctrl0 = read_control(inv)
        print(f"\nStart: pv={pre['pv_w']} W  grid={pre['grid_w']} W  battery={pre['battery_w']} W  "
              f"house={pre['house_w']} W  soc={pre['soc_pct']}%  mode=0x{ctrl0['mode']:X}")
        why = refusal(pre)
        if why:
            print(f"Refusing: {why}.")
            return 2

        # Nobody else may be writing (dispatch disarmed). Watch the control registers.
        time.sleep(QUIET_CHECK_S)
        ctrl1 = read_control(inv)
        if ctrl1 != ctrl0:
            print(f"Refusing: control registers changed while idle ({ctrl0} -> {ctrl1}). "
                  "Is dispatch still armed? Disarm it first (see the runbook in this file).")
            return 2

        original_mode = ctrl0["mode"]
        record["original_mode"] = original_mode
        record["start"] = pre

        log.info("Phase 0: baseline, %d samples, no writes", BASELINE_SAMPLES)
        s0 = summarize(collect(inv, BASELINE_SAMPLES, SAMPLE_GAP_S))
        show("Phase 0: BASELINE (self-use, no writes)", ctrl1, s0)
        record["phases"]["baseline"] = s0
        why = refusal(pre, s0)
        if why:
            print(f"Refusing: {why}.")
            original_mode = None  # nothing was written
            return 2

        log.info("Phase A: 50207 = 0, then mode 0x303; caps left unrestricted")
        write(inv, REG_BATT_POWER_TARGET, 0, verify=False)
        time.sleep(0.3)
        ic._forced_active = True               # arm the fail-safe BEFORE the mode can land
        write(inv, REG_WORK_MODE, WORK_MODE_EMS_BATTCTRL)
        time.sleep(SETTLE_S)
        sA = summarize(collect(inv, SAMPLES, SAMPLE_GAP_S))
        cA = read_control(inv)
        show("Phase A: SOFT HOLD (0x303, 50207 = 0, caps open)", cA, sA)
        record["phases"]["soft_hold"] = {**sA, "regs": cA, **held(sA, s0)}

        log.info("Phase B: in-mode 50209 = 0, then 50208 = 0")
        write(inv, REG_MAX_AC_INPUT, 0, verify=False)
        write(inv, REG_MAX_AC_OUTPUT, 0, verify=False)
        time.sleep(SETTLE_S)
        sB = summarize(collect(inv, SAMPLES, SAMPLE_GAP_S))
        cB = read_control(inv)
        show("Phase B: FULL FREEZE (+ 50209 = 0, 50208 = 0 in-mode)", cB, sB)
        record["phases"]["freeze"] = {**sB, "regs": cB, **held(sB, s0)}

        a, b = record["phases"]["soft_hold"], record["phases"]["freeze"]
        print("\n-------- VERDICT --------")
        for name, r in (("QA soft hold  ", a), ("QB full freeze", b)):
            print(f"{name}: {'HELD' if r['held'] else 'NOT held'}  "
                  f"(battery held {r['battery_held']}, grid covers {r['grid_covers']}, "
                  f"house served {r['house_served']})")
        print(f"QC readbacks  : freeze 50208={cB['r50208']} 50209={cB['r50209']} "
              "(0/0 = stored; recorded, not trusted)")
        if a["held"]:
            print("=> A no-solar hold needs NO restrictive caps: 0x303 + 50207=0 is enough.")
        elif b["held"]:
            print("=> The full freeze recipe is required, and it works on this unit.")
        else:
            print("=> Neither recipe held the battery. Hold is not executable this way.")
        print("-------------------------")
        record["verdict"] = {"soft_hold": a["held"], "freeze": b["held"]}
        return 0
    finally:
        if original_mode is not None:
            record["restore_ok"] = restore(inv, original_mode)
        out = os.path.join(os.path.expanduser("~"), "probe_hold_result.json")
        try:
            with open(out, "w", encoding="utf-8") as f:
                json.dump(record, f, indent=2)
            print(f"[record written to {out}]")
        except OSError as exc:
            log.error("could not write record: %s", exc)
        inv.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
