"""Tests for scripts/tools/probe_hold_freeze.py, the on-device battery-freeze probe.

A probe is a one-shot tool, but this one writes `50208 = 0`, a value nothing has ever written
to this inverter, on the live system. The parts that can go wrong without the inverter ever
complaining are exactly the parts worth pinning before it runs once for real:

  - the WRITE ORDER: caps must land IN-MODE (an earlier probe proved pre-mode cap writes are
    silently dropped while reading back as stored), and the restore must put the caps back
    BEFORE leaving 0x303, for the same reason;
  - the restore must happen on every exit path, including an exception mid-probe;
  - the verdict must come from measured power, and "battery at 0 W" alone must not pass:
    a battery at 0 W with the house unpowered is the failure the third-party doc warns of;
  - the refusals, which are what keep it away from the SoC floor and from a still-armed
    dispatch loop.

Run: py -m unittest scripts.tests.test_probe_hold_freeze -v   (from the repo root)
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

from fakes import FakeModbusResult, install_pymodbus_stub  # noqa: E402

install_pymodbus_stub()

import inverter_control as ic  # noqa: E402

_TOOL = Path(__file__).resolve().parent.parent / "tools" / "probe_hold_freeze.py"
_spec = importlib.util.spec_from_file_location("probe_hold_freeze", _TOOL)
ph = importlib.util.module_from_spec(_spec)
sys.modules["probe_hold_freeze"] = ph
_spec.loader.exec_module(ph)

ORIGINAL_MODE = ic.WORK_MODE_GENERAL


def split32(v: int) -> tuple[int, int]:
    u = v & 0xFFFFFFFF
    return u >> 16, u & 0xFFFF


def set_power(inv, *, battery: int, grid: int, ac: int, pv: int = 0, soc_pct: float = 60.0):
    r = inv.client.regs
    third = grid // 3
    for addr, v in ((10994, third), (10996, third), (10998, grid - 2 * third), (11000, grid),
                    (11016, ac), (11028, pv), (30258, battery)):
        r[addr], r[addr + 1] = split32(v)
    r[ic.REG_SOC] = int(round(soc_pct * 100))


def night_inverter(physics: bool = True):
    """A night-time inverter: battery covering an 800 W house in self-use. With physics on,
    entering 0x303 with 50207 = 0 freezes the battery and the grid takes over the house."""
    inv = ic.Inverter(host="test-host")
    regs = inv.client.regs
    regs[ic.REG_WORK_MODE] = ORIGINAL_MODE
    regs[ic.REG_MAX_AC_OUTPUT] = ic.GRID_CAP_RAW
    regs[ic.REG_MAX_AC_INPUT] = (-ic.GRID_CAP_RAW) & 0xFFFF
    set_power(inv, battery=800, grid=0, ac=800)
    if physics:
        real_write = inv.client.write_register

        def write(addr, value, device_id=1):
            res = real_write(addr, value, device_id)
            frozen = regs.get(ic.REG_WORK_MODE) == ic.WORK_MODE_EMS_BATTCTRL and regs.get(ic.REG_BATT_POWER_TARGET, 0) == 0
            if frozen:
                set_power(inv, battery=0, grid=-800, ac=0)
            else:
                set_power(inv, battery=800, grid=0, ac=800)
            return res

        inv.client.write_register = write
    return inv


class ProbeTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        for target, attr, value in ((ic, "ARMED", True), (ph, "ARMED", True)):
            mock.patch.object(target, attr, value).start()
        mock.patch.object(ic.time, "sleep").start()
        mock.patch.object(ph.time, "sleep").start()
        mock.patch.object(ph.ic, "_install_failsafe").start()   # no atexit/signal hooks in tests
        mock.patch.object(ph.os.path, "expanduser", lambda _p: self.tmp.name).start()
        ic._forced_active = False

    def tearDown(self):
        mock.patch.stopall()
        ic._forced_active = False
        self.tmp.cleanup()

    def run_probe(self, inv):
        with mock.patch.object(ph, "Inverter", return_value=inv):
            return ph.main(["probe_hold_freeze.py"])


class RefusalTests(unittest.TestCase):
    def pre(self, **kw):
        return {"soc_pct": 60.0, "pv_w": 0, **kw}

    def test_runs_in_ordinary_night_conditions(self):
        self.assertIsNone(ph.refusal(self.pre(), {"battery_w": 800}))

    def test_refuses_near_the_floor(self):
        # The inverter's own floor behaviour with AC input blocked is the open question;
        # the probe must not be the thing that answers it by accident.
        self.assertIn("SoC", ph.refusal(self.pre(soc_pct=15.0)))

    def test_refuses_in_daylight(self):
        self.assertIn("PV", ph.refusal(self.pre(pv_w=900)))

    def test_refuses_when_the_house_draws_too_little_to_see_a_hold(self):
        self.assertIn("drain", ph.refusal(self.pre(), {"battery_w": 150}))


class HeldTests(unittest.TestCase):
    BASE = {"battery_w": 800, "grid_w": 0, "house_w": 800}

    def test_battery_still_and_grid_carrying_the_house_is_held(self):
        r = ph.held({"battery_w": 20, "grid_w": -790, "house_w": 790}, self.BASE)
        self.assertTrue(r["held"])

    def test_battery_at_zero_with_the_house_unpowered_is_not_held(self):
        # The failure the third-party doc warns of with both AC limits at zero.
        r = ph.held({"battery_w": 0, "grid_w": 0, "house_w": 0}, self.BASE)
        self.assertTrue(r["battery_held"])
        self.assertFalse(r["held"])

    def test_battery_still_discharging_is_not_held(self):
        self.assertFalse(ph.held({"battery_w": 780, "grid_w": 0, "house_w": 800}, self.BASE)["held"])


class ProbeRunTests(ProbeTestCase):
    def test_writes_caps_in_mode_and_restores_caps_before_leaving_it(self):
        inv = night_inverter()
        self.assertEqual(self.run_probe(inv), 0)
        writes = inv.client.write_calls()
        mode_on = writes.index((ic.REG_WORK_MODE, ic.WORK_MODE_EMS_BATTCTRL))
        cap_in = writes.index((ic.REG_MAX_AC_INPUT, 0))
        cap_out = writes.index((ic.REG_MAX_AC_OUTPUT, 0))
        self.assertLess(writes.index((ic.REG_BATT_POWER_TARGET, 0)), mode_on)
        self.assertLess(mode_on, cap_in)           # in-mode, never pre-mode
        self.assertLess(cap_in, cap_out)
        restore_out = writes.index((ic.REG_MAX_AC_OUTPUT, ic.GRID_CAP_RAW), cap_out)
        mode_off = writes.index((ic.REG_WORK_MODE, ORIGINAL_MODE), cap_out)
        self.assertLess(restore_out, mode_off)     # caps restored while still in 0x303
        regs = inv.client.regs
        self.assertEqual(regs[ic.REG_MAX_AC_OUTPUT], ic.GRID_CAP_RAW)
        self.assertEqual(regs[ic.REG_MAX_AC_INPUT], (-ic.GRID_CAP_RAW) & 0xFFFF)
        self.assertEqual(regs[ic.REG_WORK_MODE], ORIGINAL_MODE)
        self.assertFalse(ic._forced_active)

    def test_verdict_comes_from_measured_power(self):
        import json
        self.run_probe(night_inverter())
        rec = json.loads((Path(self.tmp.name) / "probe_hold_result.json").read_text())
        self.assertTrue(rec["verdict"]["soft_hold"])
        self.assertTrue(rec["restore_ok"])

    def test_no_physics_means_no_hold_even_though_every_write_read_back_fine(self):
        # Readbacks all say "stored"; the battery never stopped. Must report NOT held.
        import json
        self.run_probe(night_inverter(physics=False))
        rec = json.loads((Path(self.tmp.name) / "probe_hold_result.json").read_text())
        self.assertEqual(rec["verdict"], {"soft_hold": False, "freeze": False})

    def test_refuses_without_writing_if_someone_else_is_writing(self):
        inv = night_inverter()
        reads = {"n": 0}
        real_read = inv.client.read_holding_registers

        def read(addr, count=1, device_id=1):
            if addr == ic.REG_WORK_MODE:
                reads["n"] += 1
                if reads["n"] > 1:  # dispatch flipped the mode during the quiet check
                    return FakeModbusResult([ic.WORK_MODE_EMS_BATTCTRL])
            return real_read(addr, count=count, device_id=device_id)

        inv.client.read_holding_registers = read
        self.assertEqual(self.run_probe(inv), 2)
        self.assertEqual(inv.client.write_calls(), [])

    def test_a_failure_mid_probe_still_restores(self):
        inv = night_inverter()
        real_read = inv.client.read_holding_registers

        def read(addr, count=1, device_id=1):
            # Once the freeze caps are in, every power read dies: retries cannot save it.
            if addr == 10994 and inv.client.regs.get(ic.REG_MAX_AC_OUTPUT) == 0:
                return FakeModbusResult(error=True)
            return real_read(addr, count=count, device_id=device_id)

        inv.client.read_holding_registers = read
        with self.assertRaises(IOError):
            self.run_probe(inv)
        regs = inv.client.regs
        self.assertEqual(regs[ic.REG_MAX_AC_OUTPUT], ic.GRID_CAP_RAW)
        self.assertEqual(regs[ic.REG_MAX_AC_INPUT], (-ic.GRID_CAP_RAW) & 0xFFFF)
        self.assertEqual(regs[ic.REG_WORK_MODE], ORIGINAL_MODE)


    def test_one_garbled_reply_is_retried_not_fatal(self):
        # The first real run died in Phase 0 on a single truncated reply.
        import json
        inv = night_inverter()
        real_read = inv.client.read_holding_registers
        state = {"n": 0}

        def read(addr, count=1, device_id=1):
            if addr == 10994:
                state["n"] += 1
                if state["n"] == 3:
                    raise IOError("Unable to decode request")
            return real_read(addr, count=count, device_id=device_id)

        inv.client.read_holding_registers = read
        self.assertEqual(self.run_probe(inv), 0)
        rec = json.loads((Path(self.tmp.name) / "probe_hold_result.json").read_text())
        self.assertTrue(rec["verdict"]["soft_hold"])


class ManualRestoreTests(ProbeTestCase):
    def test_restore_from_a_left_behind_freeze_ends_in_self_use_with_open_caps(self):
        inv = night_inverter(physics=False)
        regs = inv.client.regs
        regs[ic.REG_WORK_MODE] = ic.WORK_MODE_EMS_BATTCTRL
        regs[ic.REG_MAX_AC_OUTPUT] = 0
        regs[ic.REG_MAX_AC_INPUT] = 0
        with mock.patch.object(ph, "Inverter", return_value=inv):
            self.assertEqual(ph.main(["probe_hold_freeze.py", "--restore"]), 0)
        writes = inv.client.write_calls()
        # caps reasserted while in 0x303, before the hand-back to General
        self.assertLess(writes.index((ic.REG_MAX_AC_OUTPUT, ic.GRID_CAP_RAW)),
                        writes.index((ic.REG_WORK_MODE, ic.WORK_MODE_GENERAL)))
        self.assertEqual(regs[ic.REG_MAX_AC_OUTPUT], ic.GRID_CAP_RAW)
        self.assertEqual(regs[ic.REG_MAX_AC_INPUT], (-ic.GRID_CAP_RAW) & 0xFFFF)
        self.assertEqual(regs[ic.REG_WORK_MODE], ic.WORK_MODE_GENERAL)

    def test_a_hangup_mid_freeze_still_restores(self):
        # Simulate the SSH session dropping during Phase B: the handler must turn SIGHUP into
        # an ordinary exit, so the finally-block restore runs.
        import signal as _signal
        if not hasattr(_signal, "SIGHUP"):
            self.skipTest("no SIGHUP on this platform")
        inv = night_inverter()
        handlers = {}
        mock.patch.object(ph.signal, "signal", lambda sig, h: handlers.__setitem__(sig, h)).start()
        real_read = inv.client.read_holding_registers

        def read(addr, count=1, device_id=1):
            if addr == 10994 and inv.client.regs.get(ic.REG_MAX_AC_OUTPUT) == 0:
                handlers[_signal.SIGHUP](_signal.SIGHUP, None)
            return real_read(addr, count=count, device_id=device_id)

        inv.client.read_holding_registers = read
        with self.assertRaises(SystemExit):
            self.run_probe(inv)
        self.assertEqual(inv.client.regs[ic.REG_MAX_AC_OUTPUT], ic.GRID_CAP_RAW)
        self.assertEqual(inv.client.regs[ic.REG_WORK_MODE], ORIGINAL_MODE)


if __name__ == "__main__":
    unittest.main()
