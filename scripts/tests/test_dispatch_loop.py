"""Tests for the pure decision-math in scripts/services/dispatch_loop.py — slot indexing,
SoC-drift interpolation, and the solar-funding/live-load-tracking guards. Deliberately does
NOT test decide()/main() (those need a live telemetry.db + real time — verify that side
against your deployment's own control_actions rows instead).

Run: python3 -m unittest scripts.tests.test_dispatch_loop -v   (from the repo root)
     or: python3 -m unittest discover -s scripts/tests
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

from fakes import install_pymodbus_stub  # noqa: E402

install_pymodbus_stub()

import dispatch_loop as dl  # noqa: E402
import inverter_control as ic  # noqa: E402

STOCKHOLM = ZoneInfo("Europe/Stockholm")
UTC = ZoneInfo("UTC")


def make_dispatch(n: int, start: str = "2026-01-15T00:00:00", soc_start: float = 10.0, soc_step: float = -0.5):
    soc = soc_start
    slots = []
    for i in range(n):
        soc += soc_step
        slots.append({"startTime": start, "socAfter": round(soc, 3), "gridKwh": 0.1 * i})
    return slots


def stockholm(iso: str) -> datetime:
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=STOCKHOLM)


class SlotIndexForInstantTests(unittest.TestCase):
    def test_at_the_first_slot_start(self):
        dispatch = make_dispatch(4)
        now = stockholm("2026-01-15T00:00:00").astimezone(UTC)
        self.assertEqual(dl.slot_index_for_instant(dispatch, now), 0)

    def test_partway_into_a_later_slot(self):
        dispatch = make_dispatch(4)
        now = stockholm("2026-01-15T00:00:00").astimezone(UTC) + timedelta(minutes=16)
        self.assertEqual(dl.slot_index_for_instant(dispatch, now), 1)

    def test_before_the_plan_starts_returns_none(self):
        dispatch = make_dispatch(4)
        now = stockholm("2026-01-15T00:00:00").astimezone(UTC) - timedelta(minutes=1)
        self.assertIsNone(dl.slot_index_for_instant(dispatch, now))

    def test_past_the_end_of_the_plan_returns_none(self):
        dispatch = make_dispatch(4)  # covers 1 hour
        now = stockholm("2026-01-15T00:00:00").astimezone(UTC) + timedelta(hours=2)
        self.assertIsNone(dl.slot_index_for_instant(dispatch, now))

    def test_empty_dispatch_returns_none(self):
        self.assertIsNone(dl.slot_index_for_instant([], datetime.now(UTC)))

    def test_anchors_on_elapsed_time_across_a_dst_spring_forward_gap(self):
        # 2026-03-29 is a Stockholm spring-forward day (02:00 -> 03:00 doesn't exist).
        # dispatch[0] starts just before the gap; real elapsed time must still land on
        # slot 1 rather than crashing or misindexing on the missing wall-clock hour.
        dispatch = make_dispatch(4, start="2026-03-29T01:45:00")
        now = stockholm("2026-03-29T01:45:00").astimezone(UTC) + timedelta(minutes=20)
        self.assertEqual(dl.slot_index_for_instant(dispatch, now), 1)


class ExpectedPrevSocKwhTests(unittest.TestCase):
    def test_first_slot_uses_the_plans_own_start_soc(self):
        dispatch = make_dispatch(4)
        self.assertEqual(dl.expected_prev_soc_kwh(dispatch, 0, start_soc_kwh=12.34), 12.34)

    def test_later_slot_uses_the_previous_slots_socafter(self):
        dispatch = make_dispatch(4)
        self.assertEqual(dl.expected_prev_soc_kwh(dispatch, 2, start_soc_kwh=12.34), dispatch[1]["socAfter"])


class PlanExpectedSocNowTests(unittest.TestCase):
    def setUp(self):
        self.dispatch = make_dispatch(4, soc_start=10.0, soc_step=-1.0)  # slot idx0 socAfter=9.0
        self.slot_start_utc = stockholm("2026-01-15T00:00:00").astimezone(UTC)

    def test_at_slot_start_returns_prev_soc(self):
        got = dl.plan_expected_soc_now(self.dispatch, 0, prev_soc=10.0, now=self.slot_start_utc)
        self.assertAlmostEqual(got, 10.0)

    def test_at_slot_end_returns_socafter(self):
        now = self.slot_start_utc + timedelta(minutes=15)
        got = dl.plan_expected_soc_now(self.dispatch, 0, prev_soc=10.0, now=now)
        self.assertAlmostEqual(got, self.dispatch[0]["socAfter"])

    def test_midpoint_interpolates_linearly(self):
        now = self.slot_start_utc + timedelta(minutes=7.5)
        got = dl.plan_expected_soc_now(self.dispatch, 0, prev_soc=10.0, now=now)
        self.assertAlmostEqual(got, (10.0 + self.dispatch[0]["socAfter"]) / 2, places=3)

    def test_before_slot_start_clamps_to_prev_soc(self):
        now = self.slot_start_utc - timedelta(minutes=5)
        got = dl.plan_expected_soc_now(self.dispatch, 0, prev_soc=10.0, now=now)
        self.assertAlmostEqual(got, 10.0)

    def test_past_slot_end_clamps_to_socafter(self):
        now = self.slot_start_utc + timedelta(minutes=45)
        got = dl.plan_expected_soc_now(self.dispatch, 0, prev_soc=10.0, now=now)
        self.assertAlmostEqual(got, self.dispatch[0]["socAfter"])


class SlotPowerWTests(unittest.TestCase):
    def test_discharge_magnitude_matches_the_planned_soc_delta(self):
        dispatch = [{"socAfter": 9.75}]
        # 0.25 kWh drop over a 0.25 h slot = 1000 W
        self.assertEqual(dl.slot_power_w(dispatch, 0, prev_soc=10.0), 1000)

    def test_clamps_to_the_hardware_power_limits(self):
        dispatch = [{"socAfter": -900.0}]  # absurd delta, must clamp not overflow
        self.assertEqual(dl.slot_power_w(dispatch, 0, prev_soc=10.0), min(ic.BATTERY_MAX_W, ic.GRID_CAP_W))


class CheckSolarFundingTests(unittest.TestCase):
    def test_no_inputs_for_slot_reports_unable_to_check(self):
        skip, detail, numbers = dl.check_solar_funding([], 0, charge_kwh=2.0, surplus_w=500)
        self.assertFalse(skip)
        self.assertEqual(numbers, {})

    def test_no_live_surplus_skips_conservatively_past_the_threshold(self):
        inputs = [{"solarKwh": 3.0, "consumptionKwh": 0.0}]  # plan expects the full charge from solar
        skip, _detail, numbers = dl.check_solar_funding(inputs, 0, charge_kwh=3.0, surplus_w=None)
        self.assertTrue(skip)
        self.assertGreater(numbers["solar_shortfall_kwh"], numbers["solar_shortfall_limit_kwh"])

    def test_no_live_surplus_but_plan_barely_uses_solar_does_not_skip(self):
        inputs = [{"solarKwh": 0.05, "consumptionKwh": 0.0}]
        skip, _detail, _numbers = dl.check_solar_funding(inputs, 0, charge_kwh=3.0, surplus_w=None)
        self.assertFalse(skip)

    def test_live_surplus_matching_the_plans_own_solar_assumption_does_not_skip(self):
        # plan assumed 3.0 kWh of solar surplus funds this charge (the rest of need_kwh,
        # inflated by round-trip losses, was always going to come from the grid) — live
        # surplus matching that SAME 3.0 kWh means reality matched the plan exactly.
        inputs = [{"solarKwh": 3.0, "consumptionKwh": 0.0}]
        surplus_w = 3.0 / dl.SLOT_HOURS * 1000
        skip, _detail, numbers = dl.check_solar_funding(inputs, 0, charge_kwh=3.0, surplus_w=surplus_w)
        self.assertFalse(skip)
        self.assertAlmostEqual(numbers["solar_shortfall_kwh"], 0.0, places=2)

    def test_live_surplus_far_below_plan_skips(self):
        inputs = [{"solarKwh": 3.0, "consumptionKwh": 0.0}]  # plan assumed solar covers it all
        skip, _detail, numbers = dl.check_solar_funding(inputs, 0, charge_kwh=3.0, surplus_w=0.0)
        self.assertTrue(skip)
        self.assertGreater(numbers["solar_shortfall_kwh"], 0)


class LiveDischargePowerWTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.live_json_path = Path(self.tmpdir.name) / "live.json"
        self._orig_path = dl.LIVE_JSON_PATH
        self._orig_enabled = dl.LIVE_LOAD_TRACKING_ENABLED
        dl.LIVE_JSON_PATH = str(self.live_json_path)
        dl.LIVE_LOAD_TRACKING_ENABLED = True

    def tearDown(self):
        dl.LIVE_JSON_PATH = self._orig_path
        dl.LIVE_LOAD_TRACKING_ENABLED = self._orig_enabled
        self.tmpdir.cleanup()

    def write_live_json(self, now: datetime, pv_w: float, house_load_w: float):
        self.live_json_path.write_text(json.dumps({
            "timestamp": now.isoformat(),
            "pv_w": pv_w,
            "house_load_w": house_load_w,
        }))

    def test_disabled_falls_back_to_planned_power_unchanged(self):
        dl.LIVE_LOAD_TRACKING_ENABLED = False
        dispatch = [{"gridKwh": 0.0}]
        power_w, detail, numbers = dl.live_discharge_power_w(dispatch, 0, datetime.now(UTC), planned_power_w=1200)
        self.assertEqual(power_w, 1200)
        self.assertEqual(numbers, {})
        self.assertIn("disabled", detail)

    def test_missing_live_json_falls_back_to_planned_power(self):
        dispatch = [{"gridKwh": 0.0}]
        power_w, detail, numbers = dl.live_discharge_power_w(dispatch, 0, datetime.now(UTC), planned_power_w=1200)
        self.assertEqual(power_w, 1200)
        self.assertEqual(numbers, {})
        self.assertIn("missing/stale", detail)

    def test_load_spike_beyond_plan_increases_discharge(self):
        now = datetime.now(UTC)
        # plan assumed net export of 0 (gridKwh=0 over 0.25h); live load is much higher than
        # live PV, so the battery must cover the extra load beyond what was planned.
        self.write_live_json(now, pv_w=500, house_load_w=3500)
        dispatch = [{"gridKwh": 0.0}]
        power_w, _detail, numbers = dl.live_discharge_power_w(dispatch, 0, now, planned_power_w=1000)
        # required_w = house_load - pv - planned_grid_w = 3500 - 500 - 0 = 3000
        self.assertEqual(power_w, 3000)
        self.assertEqual(numbers["live_house_load_w"], 3500)
        self.assertEqual(numbers["live_pv_w"], 500)


if __name__ == "__main__":
    unittest.main()
