"""Tests for scripts/services/inverter_control.py — the module that actually writes to
the inverter's Modbus registers. Uses fakes.FakeModbusClient (no real hardware/network).

Run: python3 -m unittest scripts.tests.test_inverter_control -v   (from the repo root)
     or: python3 -m unittest discover -s scripts/tests
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

from fakes import install_pymodbus_stub  # noqa: E402

install_pymodbus_stub()

import inverter_control as ic  # noqa: E402


def make_inverter(soc_pct: float = 50.0) -> ic.Inverter:
    inv = ic.Inverter(host="test-host")
    inv.client.regs[ic.REG_SOC] = int(round(soc_pct * 100))
    return inv


def set_already_in_ems_mode(inv: ic.Inverter, priority: int) -> None:
    """Pre-populate registers so _already_set_for(priority) reads True — simulates the
    inverter already being mid-charge/discharge from a prior tick (the fast-path case)."""
    inv.client.regs[ic.REG_MAX_EXPORT] = ic.GRID_CAP_RAW
    inv.client.regs[ic.REG_MAX_IMPORT] = (-ic.GRID_CAP_RAW) & 0xFFFF
    inv.client.regs[ic.REG_PRIORITY] = priority
    inv.client.regs[ic.REG_WORK_MODE] = ic.WORK_MODE_EMS_BATTCTRL


class InverterControlTestCase(unittest.TestCase):
    def setUp(self):
        self._armed_patch = mock.patch.object(ic, "ARMED", True)
        self._sign_patch = mock.patch.object(ic, "SIGN", "neg_charge")
        self._sleep_patch = mock.patch.object(ic.time, "sleep")  # skip real rate-limit/settle delays
        self._armed_patch.start()
        self._sign_patch.start()
        self._sleep_patch.start()
        ic._forced_active = False

    def tearDown(self):
        mock.patch.stopall()
        ic._forced_active = False


class ForceChargeTests(InverterControlTestCase):
    def test_full_setup_sequence_when_not_already_set(self):
        inv = make_inverter(soc_pct=50.0)
        ic.force_charge(inv, 3000)

        writes = inv.client.write_calls()
        written_addrs = [addr for addr, _ in writes]
        # caps + priority must land before the power target; power before the mode switch
        self.assertLess(written_addrs.index(ic.REG_MAX_IMPORT), written_addrs.index(ic.REG_BATT_POWER_TARGET))
        self.assertLess(written_addrs.index(ic.REG_MAX_EXPORT), written_addrs.index(ic.REG_BATT_POWER_TARGET))
        self.assertLess(written_addrs.index(ic.REG_PRIORITY), written_addrs.index(ic.REG_BATT_POWER_TARGET))
        self.assertLess(written_addrs.index(ic.REG_BATT_POWER_TARGET), written_addrs.index(ic.REG_WORK_MODE))

        self.assertEqual(dict(writes)[ic.REG_PRIORITY], 0)  # PV priority for charging
        self.assertEqual(dict(writes)[ic.REG_WORK_MODE], ic.WORK_MODE_EMS_BATTCTRL)
        # neg_charge sign: charging encodes as a NEGATIVE raw target
        self.assertEqual(inv.client.regs[ic.REG_BATT_POWER_TARGET], (-300) & 0xFFFF)
        self.assertTrue(ic._forced_active)

    def test_fast_path_skips_setup_writes_when_already_set(self):
        inv = make_inverter(soc_pct=50.0)
        set_already_in_ems_mode(inv, priority=0)

        ic.force_charge(inv, 3000)

        writes = inv.client.write_calls()
        written_addrs = {addr for addr, _ in writes}
        # only the power target should be rewritten — everything else was already correct
        self.assertEqual(written_addrs, {ic.REG_BATT_POWER_TARGET})
        self.assertTrue(ic._forced_active)

    def test_zero_power_returns_to_auto_instead_of_forcing(self):
        inv = make_inverter(soc_pct=50.0)
        ic.force_charge(inv, 0)

        writes = dict(inv.client.write_calls())
        self.assertEqual(writes.get(ic.REG_WORK_MODE), ic.WORK_MODE_GENERAL)
        self.assertEqual(writes.get(ic.REG_BATT_POWER_TARGET), 0)
        self.assertFalse(ic._forced_active)

    def test_at_or_above_soc_ceiling_returns_to_auto_instead_of_charging(self):
        inv = make_inverter(soc_pct=ic.SOC_CEILING_PCT)
        ic.force_charge(inv, 3000)

        writes = dict(inv.client.write_calls())
        self.assertEqual(writes.get(ic.REG_WORK_MODE), ic.WORK_MODE_GENERAL)
        self.assertNotIn(ic.REG_PRIORITY, writes)  # never entered the charge setup path
        self.assertFalse(ic._forced_active)

    def test_disarmed_never_touches_the_client(self):
        ic.ARMED = False
        try:
            inv = make_inverter(soc_pct=50.0)
            ic.force_charge(inv, 3000)
            self.assertEqual(inv.client.write_calls(), [])
        finally:
            ic.ARMED = True


class ForceDischargeTests(InverterControlTestCase):
    def test_full_setup_sequence_when_not_already_set(self):
        inv = make_inverter(soc_pct=50.0)
        ic.force_discharge(inv, 2000)

        writes = dict(inv.client.write_calls())
        self.assertEqual(writes[ic.REG_PRIORITY], 1)  # battery priority for discharging
        self.assertEqual(writes[ic.REG_WORK_MODE], ic.WORK_MODE_EMS_BATTCTRL)
        # neg_charge sign: discharge is the OPPOSITE of charge -> POSITIVE raw target
        self.assertEqual(inv.client.regs[ic.REG_BATT_POWER_TARGET], 200)
        self.assertTrue(ic._forced_active)

    def test_fast_path_skips_setup_writes_when_already_set(self):
        inv = make_inverter(soc_pct=50.0)
        set_already_in_ems_mode(inv, priority=1)

        ic.force_discharge(inv, 2000)

        written_addrs = {addr for addr, _ in inv.client.write_calls()}
        self.assertEqual(written_addrs, {ic.REG_BATT_POWER_TARGET})

    def test_at_or_below_soc_floor_returns_to_auto_instead_of_discharging(self):
        inv = make_inverter(soc_pct=ic.SOC_FLOOR_PCT)
        ic.force_discharge(inv, 2000)

        writes = dict(inv.client.write_calls())
        self.assertEqual(writes.get(ic.REG_WORK_MODE), ic.WORK_MODE_GENERAL)
        self.assertNotIn(ic.REG_PRIORITY, writes)
        self.assertFalse(ic._forced_active)


class MiscTests(InverterControlTestCase):
    def test_clamp_power_w_respects_battery_and_grid_caps(self):
        self.assertEqual(ic.clamp_power_w(-500), 0)
        self.assertEqual(ic.clamp_power_w(10**9), min(ic.BATTERY_MAX_W, ic.GRID_CAP_W))
        self.assertEqual(ic.clamp_power_w(1234), 1234)

    def test_charge_sign_requires_confirmed_convention(self):
        ic.SIGN = ""
        self.assertRaises(RuntimeError, ic._charge_sign)


if __name__ == "__main__":
    unittest.main()
