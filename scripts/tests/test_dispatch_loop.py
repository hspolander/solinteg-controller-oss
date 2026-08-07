"""Tests for the decision-math and the apply half of scripts/services/dispatch_loop.py —
slot indexing, SoC-drift interpolation, the solar-funding/live-load-tracking guards, and (since
2026-08-07) the write-gating and apply/recover path that used to be inline in main().

Still deliberately does NOT test decide()/main() end-to-end: decide() needs a populated
telemetry.db and main() is an infinite loop over wall-clock time. What changed is that the
non-trivial logic main() used to hold inline — effective_target / needs_apply /
check_soc_divergence / apply_decision — is now extracted and testable, so the guards and the
two-level failure recovery are no longer verified only by reading them. Verify the
live-behaviour side against your deployment's own control_actions rows.

Run: python3 -m unittest scripts.tests.test_dispatch_loop -v   (from the repo root)
     or: python3 -m unittest discover -s scripts/tests
"""
import json
import sqlite3
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


class ApplyTargetRouting(unittest.TestCase):
    """apply_target() is the whole executor half of the ACTION CONTRACT (see dispatch_loop.py's
    note beside FORCED_ACTIONS, and lib/__tests__/action-contract.test.ts for the TS half).
    It previously had no coverage at all, which is how an unknown action silently resolving to
    auto stayed invisible."""

    def setUp(self):
        self.calls = []
        self._orig = (dl.force_charge, dl.force_discharge, dl.return_to_auto)
        dl.force_charge = lambda inv, w: self.calls.append(("charge", w))
        dl.force_discharge = lambda inv, w: self.calls.append(("discharge", w))
        dl.return_to_auto = lambda inv: self.calls.append(("auto", None))

    def tearDown(self):
        dl.force_charge, dl.force_discharge, dl.return_to_auto = self._orig

    def test_charge_forces_a_charge_setpoint(self):
        dl.apply_target(object(), "charge", 1500)
        self.assertEqual(self.calls, [("charge", 1500)])

    def test_discharge_forces_a_discharge_setpoint(self):
        dl.apply_target(object(), "discharge", 2000)
        self.assertEqual(self.calls, [("discharge", 2000)])

    def test_idle_returns_to_auto_without_warning(self):
        # 'idle' is a declared AUTO_ACTION, so auto is intended and must stay quiet — otherwise
        # the warning below would fire on every idle slot and become noise nobody reads.
        with self.assertLogs("solinteg.dispatch", level="WARNING") as caught:
            dl.log.warning("sentinel")  # assertLogs requires at least one record
            dl.apply_target(object(), "idle", 0)
        self.assertEqual(self.calls, [("auto", None)])
        self.assertEqual([r for r in caught.output if "sentinel" not in r], [])

    def test_unknown_action_still_fails_safe_but_warns_loudly(self):
        # The scenario this exists for: the optimizer emits an action this executor does not
        # implement.
        # Auto is still the right fail-safe, but it must not be silent — auto CHARGES from
        # surplus, which for a hold-style action is the opposite of what was planned.
        with self.assertLogs("solinteg.dispatch", level="WARNING") as caught:
            dl.apply_target(object(), "hold", 0)
        self.assertEqual(self.calls, [("auto", None)])
        joined = "\n".join(caught.output)
        self.assertIn("unrecognised dispatch action", joined)
        self.assertIn("hold", joined)

    def test_declared_vocabularies_are_disjoint(self):
        # An action in both tuples would make the contract test's union check pass while
        # apply_target's actual routing stayed ambiguous.
        self.assertEqual(set(dl.FORCED_ACTIONS) & set(dl.AUTO_ACTIONS), set())


class EffectiveTargetTests(unittest.TestCase):
    """The solar-funding guard folded into the target actually applied."""

    def test_charge_that_cannot_be_solar_funded_becomes_idle_at_zero(self):
        self.assertEqual(dl.effective_target("charge", 4000, solar_skip=True), ("idle", 0, True))

    def test_charge_that_can_be_funded_passes_through(self):
        self.assertEqual(dl.effective_target("charge", 4000, solar_skip=False), ("charge", 4000, False))

    def test_the_guard_only_applies_to_charges(self):
        # solar_skip is meaningless for a discharge — check_solar_funding never even runs for
        # one — so a stale True must not silently cancel a planned discharge.
        self.assertEqual(dl.effective_target("discharge", 3000, solar_skip=True), ("discharge", 3000, False))

    def test_idle_passes_through(self):
        self.assertEqual(dl.effective_target("idle", 0, solar_skip=False), ("idle", 0, False))


class NeedsApplyTests(unittest.TestCase):
    """Write-gating: the three rules in tension (change / reassert / deadband)."""

    def test_first_decision_after_restart_always_applies(self):
        # last_target is None on startup — this is what self-heals a setpoint a crashed prior
        # instance left forced, so it must apply even for a plain idle.
        self.assertTrue(dl.needs_apply(("t0", "idle", 0), None, "idle", 0, due_for_reassert=False))

    def test_unchanged_idle_target_does_not_rewrite(self):
        t = ("t0", "idle", 0)
        self.assertFalse(dl.needs_apply(t, t, "idle", 0, due_for_reassert=False))

    def test_unchanged_idle_target_is_never_reasserted_on_a_timer(self):
        # The load-bearing one: General mode doesn't decay, so a timed re-poke would blindly
        # overwrite a work mode the owner set by hand in the inverter's own app.
        t = ("t0", "idle", 0)
        self.assertFalse(dl.needs_apply(t, t, "idle", 0, due_for_reassert=True))

    def test_unchanged_forced_target_is_reasserted_on_the_timer(self):
        t = ("t0", "discharge", 3000)
        self.assertFalse(dl.needs_apply(t, t, "discharge", 3000, due_for_reassert=False))
        self.assertTrue(dl.needs_apply(t, t, "discharge", 3000, due_for_reassert=True))

    def test_a_new_slot_always_applies(self):
        self.assertTrue(dl.needs_apply(("t1", "idle", 0), ("t0", "idle", 0), "idle", 0, False))

    def test_retarget_below_the_deadband_waits_for_the_next_reassert(self):
        last = ("t0", "discharge", 3000)
        small = 3000 + dl.LIVE_LOAD_DEADBAND_W - 1
        self.assertFalse(dl.needs_apply(("t0", "discharge", small), last, "discharge", small, False))

    def test_retarget_at_or_above_the_deadband_applies_immediately(self):
        # A heat-pump-scale change must not be delayed by the noise filter.
        last = ("t0", "discharge", 3000)
        big = 3000 + dl.LIVE_LOAD_DEADBAND_W
        self.assertTrue(dl.needs_apply(("t0", "discharge", big), last, "discharge", big, False))

    def test_a_suppressed_small_move_still_applies_once_it_is_due_for_reassert(self):
        last = ("t0", "discharge", 3000)
        small = 3000 + dl.LIVE_LOAD_DEADBAND_W - 1
        self.assertTrue(dl.needs_apply(("t0", "discharge", small), last, "discharge", small, True))

    def test_an_action_change_within_a_slot_is_never_deadband_suppressed(self):
        # charge -> discharge is a direction reversal, not load noise, however small the delta.
        last = ("t0", "charge", 100)
        self.assertTrue(dl.needs_apply(("t0", "discharge", 100), last, "discharge", 100, False))


class FakeInverter:
    """Stands in for inverter_control.Inverter in apply_decision tests."""

    def __init__(self, soc_pct=50.0, fail_on=None):
        self._soc_pct = soc_pct
        self.closed = False
        self.fail_on = fail_on or set()

    def soc_pct(self):
        if "soc" in self.fail_on:
            raise RuntimeError("modbus read failed")
        return self._soc_pct

    def close(self):
        self.closed = True


class ApplyDecisionTests(unittest.TestCase):
    """The apply/recover path lifted out of main() on 2026-08-07. Until then this was the one
    part of the executor with no unit coverage — including both failure branches, where the
    ordering (revert BEFORE logging) and the loop_in_auto bookkeeping are load-bearing."""

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.execute("""
            CREATE TABLE control_actions (
                id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, slot_time TEXT,
                planned_action TEXT NOT NULL, power_w INTEGER, armed INTEGER NOT NULL,
                outcome TEXT NOT NULL, detail TEXT, detail_json TEXT)
        """)
        self.applied = []
        self.replans = []
        self.inverters = []
        self.revert_fails = False

        def _make_inverter():
            inv = FakeInverter(soc_pct=self.soc_pct, fail_on=self.inverter_fail_on)
            self.inverters.append(inv)
            return inv

        self.soc_pct = 50.0
        self.inverter_fail_on = set()
        self._orig = (dl.Inverter, dl.apply_target, dl.return_to_auto, dl.maybe_request_replan)
        dl.Inverter = _make_inverter
        dl.apply_target = lambda inv, a, w: self.applied.append((a, w))
        dl.return_to_auto = lambda inv: (_ for _ in ()).throw(RuntimeError("revert failed")) \
            if self.revert_fails else self.applied.append(("auto", 0))
        dl.maybe_request_replan = lambda reason: self.replans.append(reason)

    def tearDown(self):
        dl.Inverter, dl.apply_target, dl.return_to_auto, dl.maybe_request_replan = self._orig
        self.con.close()

    def rows(self):
        return self.con.execute(
            "SELECT planned_action, power_w, outcome, detail FROM control_actions").fetchall()

    def test_normal_charge_applies_and_logs_one_row(self):
        # expected SoC matches actual (50% of 25.6 = 12.8 kWh) — no drift, no guard.
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "charge", 4000, expected_soc_kwh=12.8, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "applied")
        self.assertFalse(in_auto)
        self.assertEqual(self.applied, [("charge", 4000)])
        self.assertEqual(len(self.rows()), 1)
        self.assertTrue(all(inv.closed for inv in self.inverters))  # connection never leaked

    def test_solar_shortfall_demotes_to_auto_and_requests_a_replan(self):
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "charge", 4000, expected_soc_kwh=12.8, solar_skipped_now=True,
            detail="shortfall 1.2 kWh", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "skipped_solar_shortfall")
        self.assertTrue(in_auto)
        # Demoted to idle, which apply_target routes to return_to_auto (see ApplyTargetRouting).
        # The point here is that the planned charge was never applied.
        self.assertEqual(self.applied, [("idle", 0)])
        self.assertIn("solar_shortfall", self.replans)

    def test_soc_divergence_demotes_to_auto_and_requests_a_replan(self):
        # plan expected 20 kWh, live SoC is 12.8 -> 7.2 kWh drift, way past the 3.0 guard
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "discharge", 3000, expected_soc_kwh=20.0, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "skipped_divergence")
        self.assertTrue(in_auto)
        self.assertEqual(self.applied, [("idle", 0)])  # not the planned discharge
        self.assertIn("divergence_skip", self.replans)

    def test_idle_while_already_in_auto_logs_a_row_but_writes_no_register(self):
        # The row still matters: armed-coverage measurement reads control_actions cadence as
        # "the loop is alive" (lib/oracle.ts ARMED_SEGMENT_CAP_MS).
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "idle", 0, expected_soc_kwh=None, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=True)
        self.assertEqual(outcome, "applied")
        self.assertTrue(in_auto)
        self.assertEqual(self.applied, [])          # no register poked
        self.assertEqual(len(self.rows()), 1)       # but the heartbeat row is there
        self.assertEqual(self.inverters, [])        # and no connection was even opened

    def test_idle_when_the_loop_is_not_known_to_be_in_auto_does_write(self):
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "idle", 0, expected_soc_kwh=None, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "applied")
        self.assertTrue(in_auto)
        self.assertEqual(self.applied, [("idle", 0)])

    def test_a_failed_apply_reverts_to_auto_and_still_logs(self):
        self.inverter_fail_on = {"soc"}  # blow up inside the divergence check
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "discharge", 3000, expected_soc_kwh=12.8, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "error_reverted")
        self.assertTrue(in_auto)
        self.assertEqual(self.applied, [("auto", 0)])
        self.assertEqual(self.rows()[0][2], "error_reverted")

    def test_a_failed_apply_whose_revert_also_fails_reports_unconfirmed_state(self):
        # Both failed, so the inverter may still be running the previous slot's setpoint.
        # loop_in_auto MUST go False: the next idle tick has to write rather than assume auto.
        self.inverter_fail_on = {"soc"}
        self.revert_fails = True
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "discharge", 3000, expected_soc_kwh=12.8, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "error_revert_failed")
        self.assertFalse(in_auto)
        row = self.rows()[0]
        self.assertEqual(row[2], "error_revert_failed")
        self.assertIn("revert also failed", row[3])

    def test_a_telemetry_write_failure_cannot_skip_the_fail_safe_revert(self):
        # telemetry.db is a shared WAL file and contention is realistic. The revert must
        # already have happened by the time logging is attempted.
        self.inverter_fail_on = {"soc"}
        self.con.close()  # every log_action from here on raises
        outcome, in_auto = dl.apply_decision(
            self.con, "t0", "discharge", 3000, expected_soc_kwh=12.8, solar_skipped_now=False,
            detail="", numbers={}, loop_in_auto=False)
        self.assertEqual(outcome, "error_reverted")
        self.assertEqual(self.applied, [("auto", 0)])  # reverted despite the logging failure
        self.con = sqlite3.connect(":memory:")         # keep tearDown happy


class CheckSocDivergenceTests(unittest.TestCase):
    def setUp(self):
        self.replans = []
        self._orig = dl.maybe_request_replan
        dl.maybe_request_replan = lambda reason: self.replans.append(reason)

    def tearDown(self):
        dl.maybe_request_replan = self._orig

    def test_small_drift_records_the_numbers_without_skipping_or_replanning(self):
        numbers = {}
        # 50% of 25.6 = 12.8 kWh actual; expect 12.9 -> 0.1 kWh drift, under both thresholds.
        skip, detail = dl.check_soc_divergence(FakeInverter(50.0), 12.9, "t0", "discharge", numbers)
        self.assertFalse(skip)
        self.assertAlmostEqual(numbers["soc_drift_kwh"], 0.1, places=2)
        self.assertEqual(numbers["soc_drift_limit_kwh"], dl.SOC_DIVERGENCE_KWH)
        self.assertEqual(self.replans, [])
        self.assertIn("drift", detail)

    def test_drift_past_the_replan_threshold_asks_for_a_plan_but_still_applies(self):
        # Between REPLAN_DRIFT_KWH (1.5) and SOC_DIVERGENCE_KWH (3.0): nudge, don't skip.
        numbers = {}
        skip, _ = dl.check_soc_divergence(FakeInverter(50.0), 12.8 + 2.0, "t0", "discharge", numbers)
        self.assertFalse(skip)
        self.assertEqual(self.replans, ["drift"])

    def test_drift_past_the_divergence_guard_skips(self):
        numbers = {}
        skip, _ = dl.check_soc_divergence(FakeInverter(50.0), 12.8 + 5.0, "t0", "discharge", numbers)
        self.assertTrue(skip)
        self.assertEqual(self.replans, ["drift"])  # the caller adds 'divergence_skip'

    def test_the_numbers_are_recorded_even_when_the_guard_does_not_trip(self):
        # This is what eventually lets the threshold be tuned from the real everyday
        # distribution in your own control_actions rows instead of a guess.
        numbers = {}
        dl.check_soc_divergence(FakeInverter(50.0), 12.8, "t0", "charge", numbers)
        self.assertIn("soc_drift_kwh", numbers)
        self.assertIn("soc_drift_limit_kwh", numbers)


if __name__ == "__main__":
    unittest.main()
