"""Tests for scripts/services/healthcheck.py.

Covers three things: probe_conditions_ready() — the opt-in "conditions suit the 50209=0 probe"
notice, whose whole job is to be RIGHT about a narrow window and which would otherwise only be
validated by whether a phone buzzed — check_control_errors' severity split, the rule that
decides whether a dispatch error wakes you up, and the alert state machine (should_alert plus
main()'s dedup/resolve bookkeeping) that decides how OFTEN it does.

The state machine's tests are worth reading before simplifying it: the rules look more elaborate
than "alert while the issue is present" because that simpler version behaved badly on an
intermittent hardware fault, resolving between blips and so treating every recurrence as brand
new. AlertStateMachineTests pins both halves of the fix.

For the probe notice the negative cases matter more than the positive one: a false ping is a
wasted trip to the computer, but a probe run in bad conditions produces a confidently wrong
answer about register behaviour, which is worse than no answer.

On check_control_errors: URGENT must mean "a write may have landed on the inverter and the revert did not".
If a failed *connect* can raise URGENT, the channel becomes noise: on the reference install 13 of
15 error_revert_failed rows in a 60-day window were connect failures that self-healed on the next
loop tick, and the one case that would actually matter looked identical to them.

The negative cases carry the weight here. This gate only ever DOWNGRADES an alert, so every way
it can be wrong is a way of staying quiet about something real.

Run: python3 -m unittest scripts.tests.test_healthcheck -v   (from the repo root)
"""
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

import healthcheck as hc  # noqa: E402

# Captured at import, BEFORE any test patches it — with PROBE_READY_MIN_PV_W unset in the
# environment (the normal case), this is literally the value healthcheck.py ships with.
SHIPPED_PROBE_READY_MIN_PV_W = hc.PROBE_READY_MIN_PV_W

UTC = timezone.utc
NOW = datetime(2026, 8, 6, 10, 0, 0, tzinfo=UTC)

# Detail strings in the exact shape dispatch_loop.py writes them, so the classifier is pinned
# against real output rather than against a paraphrase of it.
CONNECT_FAILED = (
    "Modbus Error: connect failed ModbusTcpClient 192.168.99.2:502 | revert also failed: "
    "Modbus Error: connect failed ModbusTcpClient 192.168.99.2:502"
)
NO_RESPONSE = (
    "Modbus Error: [Input/Output] No response received after 3 retries, continue with next "
    "request | revert also failed: Modbus Error: [Input/Output] No response received after 3 "
    "retries, continue with next request"
)


class ControlErrorSeverityTests(unittest.TestCase):
    def make_db(self, rows):
        """rows: list of (outcome, detail) recorded inside the alert window."""
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.execute("CREATE TABLE control_actions (timestamp TEXT, outcome TEXT, detail TEXT)")
        for outcome, detail in rows:
            con.execute("INSERT INTO control_actions VALUES (?, ?, ?)",
                        (NOW.isoformat(), outcome, detail))
        con.commit()
        return con

    def test_connect_failed_is_high_not_urgent(self):
        con = self.make_db([("error_revert_failed", CONNECT_FAILED)] * 3)
        _key, severity, _title, message, _fp = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_HIGH)
        self.assertIn("nothing written", message)
        self.assertNotIn("UNCONFIRMED", message)

    def test_no_response_is_urgent(self):
        """Could have died mid-sequence with a write in flight — the real thing."""
        con = self.make_db([("error_revert_failed", NO_RESPONSE)])
        _key, severity, _title, message, _fp = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("UNCONFIRMED", message)

    def test_one_unconfirmed_among_many_benign_still_escalates(self):
        """The case the split exists to protect: a real failure must not be buried by noise."""
        rows = [("error_revert_failed", CONNECT_FAILED)] * 12
        rows.append(("error_revert_failed", NO_RESPONSE))
        con = self.make_db(rows)
        _key, severity, _title, message, _fp = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("x12 (connect failed", message)
        self.assertIn("x1 (state UNCONFIRMED)", message)

    def test_error_reverted_alone_stays_high(self):
        con = self.make_db([("error_reverted", "Modbus Error: whatever")])
        _key, severity, _title, message, _fp = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_HIGH)
        self.assertIn("error_reverted x1", message)

    def test_error_reverted_message_does_not_claim_nothing_was_written(self):
        """Regression from a real alert: for error_reverted the apply failed and the revert
        SUCCEEDED, so a write may well have landed and then been undone. Only a failed *connect*
        guarantees nothing was written, and the shared HIGH tail must not assert that for both."""
        con = self.make_db([("error_reverted", "Modbus Error: whatever")])
        _key, _severity, _title, message, _fp = hc.check_control_errors(con, NOW)
        self.assertNotIn("No write reached the inverter", message)
        self.assertIn("unconfirmed state", message)

    def test_no_rows_means_no_alert(self):
        con = self.make_db([])
        self.assertIsNone(hc.check_control_errors(con, NOW))

    def test_unparseable_detail_fails_loud(self):
        """The gate only ever downgrades, so an unrecognised detail must stay URGENT — including
        one that mentions a connect failure but isn't the two-half shape we can reason about."""
        for detail in (None, "", "something entirely new",
                       "Modbus Error: connect failed ModbusTcpClient 192.168.1.50:502"):
            with self.subTest(detail=detail):
                con = self.make_db([("error_revert_failed", detail)])
                _key, severity, _t, _m, _fp = hc.check_control_errors(con, NOW)
                self.assertEqual(severity, hc.notify.PRIORITY_URGENT)

    def test_connect_failure_only_counts_on_the_apply_half(self):
        """A write that timed out but whose REVERT hit a connect failure is still unconfirmed —
        classifying on the whole string instead of the apply half would wrongly downgrade it."""
        detail = ("Modbus Error: [Input/Output] No response received after 3 retries "
                  "| revert also failed: Modbus Error: connect failed ModbusTcpClient x:502")
        con = self.make_db([("error_revert_failed", detail)])
        _key, severity, _t, message, _fp = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("UNCONFIRMED", message)


def build_probe_db(pv_series, house_w=2000, soc=40.0, planned_action="idle",
                   outcome="applied", armed=1, sample_gap_s=10):
    """In-memory telemetry.db with `pv_series` as consecutive readings ending at NOW."""
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE readings (timestamp TEXT, pv_w REAL, house_load_w REAL, soc_pct REAL)")
    con.execute("CREATE TABLE control_actions (timestamp TEXT, planned_action TEXT, "
                "outcome TEXT, armed INTEGER)")
    n = len(pv_series)
    for i, pv in enumerate(pv_series):
        ts = NOW - timedelta(seconds=(n - 1 - i) * sample_gap_s)
        con.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (ts.isoformat(), pv, house_w, soc))
    if planned_action is not None:
        con.execute("INSERT INTO control_actions VALUES (?, ?, ?, ?)",
                    (NOW.isoformat(), planned_action, outcome, armed))
    con.commit()
    return con


STEADY = [7000.0] * 60           # 10 min of flat 7 kW at 10 s spacing
BROKEN = [3379.0, 10621.0] * 30  # broken cumulus, exaggerated to strict alternation


class ProbeConditionsReadyTests(unittest.TestCase):
    # The check ships DISABLED (PROBE_READY_MIN_PV_W defaults to 0), so these tests set the PV
    # floor themselves rather than inheriting whatever the shipped default happens to be. That
    # default is documented as a switch, and a suite depending on its value would break every
    # time someone flipped it.
    PV_FLOOR = 3000.0

    def setUp(self):
        patcher = mock.patch.object(hc, "PROBE_READY_MIN_PV_W", self.PV_FLOOR)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_db(self, *args, **kwargs):
        con = build_probe_db(*args, **kwargs)
        self.addCleanup(con.close)
        return con

    def test_fires_on_steady_sun_with_headroom(self):
        result = hc.probe_conditions_ready(self.make_db(STEADY), NOW)
        self.assertIsNotNone(result)
        key, _title, message = result
        self.assertTrue(key.startswith(hc.ONESHOT_PREFIX + "probe_ready:"))
        self.assertIn("2026-08-06", key)   # keyed per date, so it retries tomorrow
        self.assertIn("7000", message)

    def test_rejects_broken_cloud_even_though_average_pv_is_high(self):
        """The failure this check exists to prevent. Mean PV is ~7 kW — the same as the steady
        case — and the minimum clears the floor, so only the swing test catches it."""
        self.assertGreater(sum(BROKEN) / len(BROKEN), hc.PROBE_READY_MIN_PV_W)
        self.assertIsNone(hc.probe_conditions_ready(self.make_db(BROKEN), NOW))

    def test_rejects_steady_but_weak_sun(self):
        self.assertIsNone(hc.probe_conditions_ready(self.make_db([1500.0] * 60), NOW))

    def test_rejects_when_house_load_eats_the_surplus(self):
        """Steady 7 kW, but a 6 kW house leaves too little surplus for the blocked/unblocked
        contrast to be visible."""
        self.assertIsNone(hc.probe_conditions_ready(self.make_db(STEADY, house_w=6000), NOW))

    def test_rejects_when_battery_is_nearly_full(self):
        """A brilliant day fills the battery, and force_charge bails at the SoC ceiling — so
        'sunniest' is not the same as 'best'."""
        self.assertIsNone(hc.probe_conditions_ready(self.make_db(STEADY, soc=92.0), NOW))

    def test_rejects_while_a_forced_discharge_is_running(self):
        """Perfect-looking sun, but the loop is mid-sell: probing would interrupt revenue."""
        con = self.make_db(STEADY, planned_action="discharge")
        self.assertIsNone(hc.probe_conditions_ready(con, NOW))

    def test_allows_a_planned_but_skipped_forced_action(self):
        """A charge the loop DECIDED but did not apply leaves the inverter in auto, so the
        window is still usable."""
        con = self.make_db(STEADY, planned_action="charge", outcome="skipped_solar_shortfall")
        self.assertIsNotNone(hc.probe_conditions_ready(con, NOW))

    def test_rejects_when_disarmed(self):
        """Writes short-circuit when disarmed, so the probe would measure nothing at all."""
        self.assertIsNone(hc.probe_conditions_ready(self.make_db(STEADY, armed=0), NOW))

    def test_rejects_on_too_few_samples(self):
        """A degraded poller must not produce a confident verdict from a handful of rows —
        min/max over 4 samples says nothing about stability."""
        con = self.make_db([7000.0] * 4, sample_gap_s=120)
        self.assertIsNone(hc.probe_conditions_ready(con, NOW))

    def test_rejects_when_no_dispatch_decision_exists(self):
        self.assertIsNone(hc.probe_conditions_ready(self.make_db(STEADY, planned_action=None), NOW))

    def test_ignores_readings_older_than_the_window(self):
        """Steady now, but the window must not be padded out by ancient rows — a long gap
        followed by a few good samples is not 10 minutes of stability."""
        con = self.make_db([7000.0] * 60, sample_gap_s=600)  # 60 samples over 10 hours
        self.assertIsNone(hc.probe_conditions_ready(con, NOW))

    def test_disabled_by_zero_threshold(self):
        """The off switch — and the shipped default."""
        con = self.make_db(STEADY)
        with mock.patch.object(hc, "PROBE_READY_MIN_PV_W", 0):
            self.assertIsNone(hc.probe_conditions_ready(con, NOW))

    @unittest.skipIf("PROBE_READY_MIN_PV_W" in os.environ,
                     "PROBE_READY_MIN_PV_W is set in the environment — cannot see the default")
    def test_ships_disabled_by_default(self):
        """This notice is opt-in on purpose: it is a 'go run this probe' nag, and most installs
        never need to. A stray re-default would turn it on for everyone."""
        self.assertEqual(
            SHIPPED_PROBE_READY_MIN_PV_W, 0.0,
            "PROBE_READY_MIN_PV_W should default to 0 (off) — the notice is opt-in",
        )


class ControlErrorFingerprintTests(unittest.TestCase):
    """The fingerprint decides what breaks through the alert cooldown. It must track the SEVERITY
    CLASS and nothing else — putting counts in it would re-classify on every blip and defeat the
    de-duplication the fingerprint exists to make safe. `reverted` and `benign` collapse into one
    "benign_errors" token: both leave the inverter in a known-good state, so treating them as
    different classifications just re-alerted on the ordinary mix of failure types shifting run
    to run, drowning out the one unconfirmed transition that actually matters."""

    def fingerprint(self, rows):
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        con.execute("CREATE TABLE control_actions (timestamp TEXT, outcome TEXT, detail TEXT)")
        for outcome, detail in rows:
            con.execute("INSERT INTO control_actions VALUES (?, ?, ?)",
                        (NOW.isoformat(), outcome, detail))
        con.commit()
        return hc.check_control_errors(con, NOW)[4]

    def test_count_alone_does_not_change_the_fingerprint(self):
        three = self.fingerprint([("error_revert_failed", CONNECT_FAILED)] * 3)
        seven = self.fingerprint([("error_revert_failed", CONNECT_FAILED)] * 7)
        self.assertEqual(three, seven)

    def test_benign_to_unconfirmed_changes_the_fingerprint(self):
        """The transition that MUST page even mid-cooldown."""
        benign = self.fingerprint([("error_revert_failed", CONNECT_FAILED)] * 3)
        escalated = self.fingerprint([("error_revert_failed", CONNECT_FAILED)] * 3
                                     + [("error_revert_failed", NO_RESPONSE)])
        self.assertNotEqual(benign, escalated)
        self.assertIn("unconfirmed", escalated)

    def test_reverted_and_benign_share_a_fingerprint(self):
        """These are equally non-urgent (see the shared HIGH `tail` message), so their mix must
        NOT reclassify — that was the entire source of the alert-fatigue bug this fixes."""
        reverted = self.fingerprint([("error_reverted", "Modbus Error: whatever")])
        benign = self.fingerprint([("error_revert_failed", CONNECT_FAILED)])
        mixed = self.fingerprint([("error_reverted", "Modbus Error: whatever"),
                                  ("error_revert_failed", CONNECT_FAILED)])
        self.assertEqual(reverted, benign)
        self.assertEqual(reverted, mixed)
        self.assertNotIn("unconfirmed", reverted)

    def test_unconfirmed_alone_is_distinct_from_benign_errors(self):
        unconfirmed = self.fingerprint([("error_revert_failed", NO_RESPONSE)])
        benign = self.fingerprint([("error_revert_failed", CONNECT_FAILED)])
        self.assertNotEqual(unconfirmed, benign)
        self.assertIn("unconfirmed", unconfirmed)
        self.assertNotIn("benign_errors", unconfirmed)


class ShouldAlertTests(unittest.TestCase):
    """The three ways an already-known issue earns another push (healthcheck.should_alert)."""

    def prior(self, alert_ago_s, fingerprint="benign"):
        stamp = (NOW - timedelta(seconds=alert_ago_s)).isoformat()
        entry = {"last_alert": stamp, "last_seen": stamp}
        if fingerprint is not None:
            entry["fingerprint"] = fingerprint
        return entry

    def test_an_unknown_issue_alerts(self):
        self.assertTrue(hc.should_alert(None, "benign", NOW)[0])
        self.assertTrue(hc.should_alert({}, "benign", NOW)[0])

    def test_same_fingerprint_inside_the_cooldown_is_suppressed(self):
        alert, reason = hc.should_alert(self.prior(600), "benign", NOW)
        self.assertFalse(alert)
        self.assertIn("last alerted", reason)

    def test_a_changed_fingerprint_breaks_through_the_cooldown(self):
        """A benign run followed by an unconfirmed one must page immediately — otherwise the one
        case that matters is swallowed by the ongoing benign condition."""
        alert, reason = hc.should_alert(self.prior(60), "benign+unconfirmed", NOW)
        self.assertTrue(alert)
        self.assertIn("reclassified", reason)

    def test_the_cooldown_still_re_alerts_a_standing_issue(self):
        """Edge-triggering alone would go silent while a fault got steadily worse."""
        alert, reason = hc.should_alert(self.prior(hc.ALERT_COOLDOWN_S + 1), "benign", NOW)
        self.assertTrue(alert)
        self.assertIn("still unresolved", reason)

    def test_a_prior_without_a_fingerprint_is_not_treated_as_a_change(self):
        """State files written by an older version have no fingerprint. Upgrading must not
        manufacture one spurious push per standing issue."""
        alert, _reason = hc.should_alert(self.prior(600, fingerprint=None), "benign", NOW)
        self.assertFalse(alert)


class AlertStateMachineTests(unittest.TestCase):
    """main()'s state file behaviour, including the intermittent-fault regression the resolve
    hysteresis exists for. Drives main() against a controlled issue list, with real wall-clock
    `now` and hand-written state timestamps."""

    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.state_path = os.path.join(tmp, "healthcheck-state.json")
        db_path = os.path.join(tmp, "telemetry.db")
        sqlite3.connect(db_path).close()  # empty but openable read-only
        for attr, value in (("STATE_PATH", self.state_path), ("DB_PATH", db_path)):
            p = mock.patch.object(hc, attr, value)
            p.start()
            self.addCleanup(p.stop)
        # One-shot notices are milestones on a different code path — silence them here.
        # check_weather_fallback_dead joins the one-shots for a different reason: main()
        # calls it, and it would otherwise make a real HTTP request out of these tests. It has
        # its own class below; what main() owes it here is only that the resolve sweep leaves
        # its bookkeeping key alone.
        for fn in ("oracle_review_ready", "probe_conditions_ready",
                   "check_weather_fallback_dead"):
            p = mock.patch.object(hc, fn, return_value=None)
            p.start()
            self.addCleanup(p.stop)
        self.sent = []
        p = mock.patch.object(hc.notify, "send",
                              side_effect=lambda t, m, **kw: self.sent.append((t, m)) or True)
        p.start()
        self.addCleanup(p.stop)

    ISSUE = ("control_errors", 4, "Solinteg: dispatch loop hit errors", "3 blips", "benign")

    def run_main(self, issues):
        with mock.patch.object(hc, "run_checks", return_value=issues):
            hc.main()
        return hc.load_state()

    def write_state(self, **kwargs):
        hc.save_state({"control_errors": kwargs})

    def test_a_recurrence_inside_the_quiet_window_does_not_re_alert(self):
        """THE regression. Resolving after one clean run deleted the entry, so a recurrence an
        hour later took the 'new' path and pushed again — an intermittent fault cost two
        notifications per blip and the cooldown never engaged."""
        ago = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        self.write_state(last_alert=ago, last_seen=ago, fingerprint="benign")
        state = self.run_main([self.ISSUE])
        self.assertEqual(self.sent, [])
        self.assertIn("control_errors", state)
        self.assertEqual(state["control_errors"]["last_alert"], ago)

    def test_an_absent_issue_is_held_not_resolved_inside_the_quiet_window(self):
        ago = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        self.write_state(last_alert=ago, last_seen=ago, fingerprint="benign")
        state = self.run_main([])
        self.assertEqual(self.sent, [])
        self.assertIn("control_errors", state)

    def test_an_absent_issue_resolves_once_the_quiet_window_elapses(self):
        ago = (datetime.now(UTC) - timedelta(seconds=hc.RESOLVE_QUIET_S + 60)).isoformat()
        self.write_state(last_alert=ago, last_seen=ago, fingerprint="benign")
        state = self.run_main([])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("resolved", self.sent[0][0])
        self.assertNotIn("control_errors", state)

    def test_last_seen_advances_on_a_suppressed_run(self):
        """Otherwise a continuously-present issue would age into 'resolved' while still firing."""
        ago = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        self.write_state(last_alert=ago, last_seen=ago, fingerprint="benign")
        state = self.run_main([self.ISSUE])
        self.assertGreater(state["control_errors"]["last_seen"], ago)

    def test_a_new_issue_alerts_and_records_its_fingerprint(self):
        state = self.run_main([self.ISSUE])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(state["control_errors"]["fingerprint"], "benign")

    def test_a_reclassified_issue_alerts_inside_the_cooldown(self):
        ago = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        self.write_state(last_alert=ago, last_seen=ago, fingerprint="benign")
        escalated = self.ISSUE[:4] + ("benign+unconfirmed",)
        state = self.run_main([escalated])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(state["control_errors"]["fingerprint"], "benign+unconfirmed")

    def test_a_check_without_a_fingerprint_falls_back_to_its_severity(self):
        """Most checks return 4-tuples and must keep working — with severity as the implicit
        fingerprint, so a severity change still breaks through."""
        state = self.run_main([("disk_low", 4, "t", "m")])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(state["disk_low"]["fingerprint"], "4")

    def test_a_probe_bookkeeping_key_survives_the_sweep(self):
        """probe: keys have no last_seen, so the malformed-entry path below would delete them —
        and deleting check_weather_fallback_dead's entry means a daily rate limiter that resets
        every 5 minutes, i.e. ~288 NetCDF subsets a day out of thredds.met.no."""
        hc.save_state({"probe:weather_fallback": {"last_probe": NOW.isoformat(), "ok": True}})
        state = self.run_main([])
        self.assertIn("probe:weather_fallback", state)
        self.assertEqual(self.sent, [])  # and it is not mistaken for a resolved issue

    def test_a_malformed_entry_is_dropped_rather_than_wedging_the_sweep(self):
        self.write_state(fingerprint="benign")  # no last_seen, no last_alert
        state = self.run_main([])
        self.assertNotIn("control_errors", state)
        self.assertEqual(self.sent, [])


class SolarSourceDegradedTests(unittest.TestCase):
    """check_solar_source_degraded — is the plan still made from real weather?

    Added after finding the direct MET Norway tier had been dead for weeks without anything
    noticing (raw brackets in the OPeNDAP query -> 400 on every run). The point of this
    check is that a fallback which only runs when the primary fails has no liveness signal of
    its own, so the degradation has to be read off the plan itself.
    """

    @staticmethod
    def _db(sources, logged_at=NOW):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        slots = [{"startTime": f"2026-08-06T{i // 4:02d}:00:00", "solarSource": src}
                 for i, src in enumerate(sources)]
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)",
                    (logged_at.isoformat(), json.dumps(slots)))
        return con

    def test_all_climatology_alerts_high(self):
        issue = hc.check_solar_source_degraded(self._db(["typical"] * 24), NOW)
        self.assertIsNotNone(issue)
        key, priority, _title, message, fingerprint = issue
        self.assertEqual(key, "solar_source_climatology")
        self.assertEqual(priority, hc.notify.PRIORITY_HIGH)
        self.assertEqual(fingerprint, "typical")
        self.assertIn("24/24", message)

    def test_persisted_forecast_is_informational_not_urgent(self):
        # The mitigation working is worth knowing about, not worth an urgent push.
        issue = hc.check_solar_source_degraded(self._db(["stale"] * 24), NOW)
        self.assertIsNotNone(issue)
        _key, priority, _title, _message, fingerprint = issue
        self.assertEqual(priority, hc.notify.PRIORITY_LOW)
        self.assertEqual(fingerprint, "stale")

    def test_stale_and_typical_share_a_key_so_the_fingerprint_breaks_the_cooldown(self):
        # A slide from "degraded" to "blind" must re-alert rather than read as the same
        # ongoing issue — that is exactly what the fingerprint mechanism is for.
        stale = hc.check_solar_source_degraded(self._db(["stale"] * 24), NOW)
        typical = hc.check_solar_source_degraded(self._db(["typical"] * 24), NOW)
        self.assertEqual(stale[0], typical[0])
        self.assertNotEqual(stale[4], typical[4])

    def test_healthy_plan_is_silent(self):
        self.assertIsNone(hc.check_solar_source_degraded(self._db(["forecast"] * 24), NOW))

    def test_one_typical_slot_at_the_horizon_edge_is_not_an_alert(self):
        # Slots past the weather horizon are legitimately climatological; alerting on any single
        # one would make this check useless within a day.
        sources = ["forecast"] * 23 + ["typical"]
        self.assertIsNone(hc.check_solar_source_degraded(self._db(sources), NOW))

    def test_only_the_near_term_is_judged(self):
        # A run whose FIRST 6 h are healthy is healthy, however climatological its far end is.
        sources = ["forecast"] * 24 + ["typical"] * 72
        self.assertIsNone(hc.check_solar_source_degraded(self._db(sources), NOW))

    def test_an_old_run_is_left_to_check_todays_plan(self):
        # Don't double-report: a stale plan is already somebody else's alert.
        old = NOW - timedelta(hours=3)
        self.assertIsNone(hc.check_solar_source_degraded(self._db(["typical"] * 24, old), NOW))

    def test_no_runs_at_all_is_silent(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        self.assertIsNone(hc.check_solar_source_degraded(con, NOW))

    def test_missing_table_does_not_crash(self):
        self.assertIsNone(hc.check_solar_source_degraded(sqlite3.connect(":memory:"), NOW))

    def test_malformed_inputs_json_does_not_crash(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)", (NOW.isoformat(), "{not json"))
        self.assertIsNone(hc.check_solar_source_degraded(con, NOW))

    def test_slots_without_a_source_field_do_not_crash(self):
        # Rows written before solarSource existed must degrade to silence, not a traceback.
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)",
                    (NOW.isoformat(), json.dumps([{"startTime": "x"}] * 24)))
        self.assertIsNone(hc.check_solar_source_degraded(con, NOW))


class SolarCacheWriteBrokenTests(unittest.TestCase):
    """check_solar_cache_write_broken — is the persisted-forecast tier's WRITE path alive?

    The tier-3 analogue of check_weather_fallback_dead/check_solar_source_degraded:
    solar-forecast-cache.json is only ever READ once both live weather tiers are down (rare), so
    a broken WRITE (saveSolarForecast silently failing) could sit invisible for weeks — the same
    shape that let tier 2 die silently before it got its own liveness probe. Deliberately does
    NOT fire on a stale-but-unused file: that is the fallback working, and
    check_solar_source_degraded's 'stale' branch already owns it.
    """

    def setUp(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        self.cache_path = os.path.join(tmpdir.name, "solar-forecast-cache.json")
        p = mock.patch.object(hc, "SOLAR_FORECAST_CACHE_PATH", self.cache_path)
        p.start()
        self.addCleanup(p.stop)

    @staticmethod
    def _db(solar_source, logged_at=NOW):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        slots = [{"startTime": "2026-09-12T00:00:00", "solarSource": solar_source}]
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)",
                    (logged_at.isoformat(), json.dumps(slots)))
        return con

    def _write_cache(self, fetched_at_text):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump({"fetchedAt": fetched_at_text, "forecast": {}}, f)

    def test_fresh_cache_is_silent(self):
        self._write_cache((NOW - timedelta(minutes=10)).isoformat())
        self.assertIsNone(hc.check_solar_cache_write_broken(self._db("forecast"), NOW))

    def test_real_js_z_suffix_timestamp_is_understood(self):
        # saveSolarForecast() writes new Date().toISOString(), which always ends in 'Z', never
        # '+00:00' — the actual format this will see in production.
        self._write_cache((NOW - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        self.assertIsNone(hc.check_solar_cache_write_broken(self._db("forecast"), NOW))

    def test_missing_cache_alerts(self):
        issue = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self.assertIsNotNone(issue)
        key, priority, _title, _message, fingerprint = issue
        self.assertEqual(key, "solar_cache_write_broken")
        self.assertEqual(priority, hc.notify.PRIORITY_LOW)
        self.assertEqual(fingerprint, "missing")

    def test_stale_cache_alerts_as_stale_write(self):
        self._write_cache((NOW - timedelta(hours=3)).isoformat())
        issue = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self.assertIsNotNone(issue)
        _key, _priority, _title, message, fingerprint = issue
        self.assertEqual(fingerprint, "stale_write")
        self.assertIn("3.0h", message)

    def test_missing_and_stale_share_a_key_so_the_fingerprint_breaks_the_cooldown(self):
        missing = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self._write_cache((NOW - timedelta(hours=3)).isoformat())
        stale = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self.assertEqual(missing[0], stale[0])
        self.assertNotEqual(missing[4], stale[4])

    def test_malformed_cache_alerts_as_missing(self):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            f.write("{not json")
        issue = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self.assertEqual(issue[4], "missing")

    def test_cache_without_fetchedat_alerts_as_missing(self):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump({"forecast": {}}, f)
        issue = hc.check_solar_cache_write_broken(self._db("forecast"), NOW)
        self.assertEqual(issue[4], "missing")

    def test_legitimate_fallback_use_is_silent_even_with_no_cache_file(self):
        # Both live tiers down: solarSource is 'stale' or 'typical', not 'forecast' — the cache
        # SHOULD be untouched right now, and check_solar_source_degraded already owns this case.
        self.assertIsNone(hc.check_solar_cache_write_broken(self._db("stale"), NOW))
        self.assertIsNone(hc.check_solar_cache_write_broken(self._db("typical"), NOW))

    def test_an_old_run_is_left_to_check_todays_plan(self):
        old = NOW - timedelta(hours=3)
        self.assertIsNone(hc.check_solar_cache_write_broken(self._db("forecast", old), NOW))

    def test_no_runs_at_all_is_silent(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        self.assertIsNone(hc.check_solar_cache_write_broken(con, NOW))

    def test_missing_table_does_not_crash(self):
        self.assertIsNone(hc.check_solar_cache_write_broken(sqlite3.connect(":memory:"), NOW))

    def test_malformed_inputs_json_does_not_crash(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)", (NOW.isoformat(), "{not json"))
        self.assertIsNone(hc.check_solar_cache_write_broken(con, NOW))

    def test_slots_without_a_source_field_do_not_crash(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE optimizer_runs (logged_at TEXT, inputs_json TEXT)")
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)",
                    (NOW.isoformat(), json.dumps([{"startTime": "x"}])))
        self.assertIsNone(hc.check_solar_cache_write_broken(con, NOW))


class FakeHttpResponse:
    """Context-managed stand-in for what urlopen() returns — enough for read()+json.loads."""

    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return self._data


def fake_urlopen(payload):
    def _open(_req, timeout=None):
        return FakeHttpResponse(payload)
    return _open


def raising_urlopen(exc):
    def _open(_req, timeout=None):
        raise exc
    return _open


class WeatherFallbackTransportTests(unittest.TestCase):
    """probe_weather_fallback — what each failure shape gets CALLED.

    The three verdict names carry consequences, which is why they are pinned here: 'failed'
    spends the day's probe budget and raises an alert, 'unreachable' does neither. Confuse the
    two and you either blame the weather tier for the web app being down, or retry a 4 GB
    NetCDF subset every five minutes against a server whose operator asked you not to.
    """

    def test_a_200_reports_the_run_it_reached(self):
        with mock.patch.object(urllib.request, "urlopen",
                               fake_urlopen({"ok": True, "run": "2026-01-15T06:00:00.000Z",
                                             "hours": 44})):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "ok")
        self.assertIn("2026-01-15T06:00:00.000Z", detail)

    def test_the_routes_own_error_text_becomes_the_detail(self):
        """The failure shape that motivated this: every run in the walk-back
        returning the same status, reported through the route."""
        body = io.BytesIO(json.dumps({"ok": False,
                                      "error": "met.no thredds fetch failed: 400"}).encode())
        exc = urllib.error.HTTPError(hc.WEATHER_FALLBACK_URL, 503, "Service Unavailable", {}, body)
        with mock.patch.object(urllib.request, "urlopen", raising_urlopen(exc)):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "failed")
        self.assertEqual(detail, "met.no thredds fetch failed: 400")

    def test_a_404_is_a_finding_not_a_transport_error(self):
        """This is what "deployed against an app that predates the route" looks like."""
        exc = urllib.error.HTTPError(hc.WEATHER_FALLBACK_URL, 404, "Not Found", {}, None)
        with mock.patch.object(urllib.request, "urlopen", raising_urlopen(exc)):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "failed")
        self.assertIn("404", detail)

    def test_a_refused_connection_is_unreachable_not_a_dead_tier(self):
        exc = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        with mock.patch.object(urllib.request, "urlopen", raising_urlopen(exc)):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "unreachable")
        self.assertIn("Refused", detail)

    def test_a_timeout_counts_as_a_real_probe(self):
        """The route fired, so the upstream request went out — the budget is spent either way,
        and "no answer inside the budget" is a verdict on the tier, not on the transport."""
        with mock.patch.object(urllib.request, "urlopen",
                               raising_urlopen(urllib.error.URLError(TimeoutError("timed out")))):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "failed")
        self.assertIn("within", detail)

    def test_an_unexpected_exception_type_does_not_escape(self):
        """http.client's BadStatusLine/IncompleteRead are HTTPException, not OSError, so they
        would sail past the named handlers — and an exception escaping this check aborts main()
        before it sends any alert at all, which is the failure mode the whole file is written
        against."""
        import http.client
        with mock.patch.object(urllib.request, "urlopen",
                               raising_urlopen(http.client.BadStatusLine("garbage"))):
            verdict, detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "failed")
        self.assertIn("BadStatusLine", detail)

    def test_a_non_json_body_is_a_failure_not_a_crash(self):
        class Garbage(FakeHttpResponse):
            def __init__(self):
                self._data = b"<html>nope</html>"
        with mock.patch.object(urllib.request, "urlopen",
                               lambda _req, timeout=None: Garbage()):
            verdict, _detail = hc.probe_weather_fallback()
        self.assertEqual(verdict, "failed")


class WeatherFallbackCheckTests(unittest.TestCase):
    """check_weather_fallback_dead — the rate limiter and the remembered verdict.

    The check that watches the second weather tier is the only one here that
    has to MAKE its own signal, so the two things worth pinning are both about restraint: it
    probes at most once per interval, and it keeps reporting a dead tier on the runs in between
    (rather than going quiet and letting the resolve sweep declare victory every few hours).
    """

    KEY = "probe:weather_fallback"
    ERROR = "met.no thredds fetch failed: 400"

    def setUp(self):
        p = mock.patch.object(hc, "WEATHER_FALLBACK_PROBE_INTERVAL_H", 24.0)
        p.start()
        self.addCleanup(p.stop)

    def run_check(self, state, verdict, detail=ERROR, now=NOW):
        """-> (issue, how many times the network probe was actually attempted)."""
        with mock.patch.object(hc, "probe_weather_fallback",
                               return_value=(verdict, detail)) as probe:
            issue = hc.check_weather_fallback_dead(state, now)
        return issue, probe.call_count

    def test_a_failed_probe_alerts_low_and_fingerprints_on_the_error(self):
        state = {}
        issue, calls = self.run_check(state, "failed")
        self.assertEqual(calls, 1)
        key, severity, title, message, fingerprint = issue
        self.assertEqual(key, "weather_fallback_dead")
        self.assertEqual(severity, hc.notify.PRIORITY_LOW)  # redundancy lost, nothing is down
        self.assertEqual(fingerprint, self.ERROR)  # a 400 (our bug) vs a timeout (their day)
        self.assertIn("400", message)
        self.assertIn("not answered once", message)  # no last_ok on record yet
        self.assertFalse(state[self.KEY]["ok"])

    def test_a_404_says_the_route_is_missing_rather_than_the_tier(self):
        """The half-finished-deploy case: healthcheck.py updated, web app not rebuilt. Waking
        someone with "the second weather source is dead" would send them to debug met.no."""
        state = {}
        issue, _calls = self.run_check(state, "failed", detail="HTTP 404")
        self.assertIn("route missing", issue[3])

    def test_a_dead_tier_keeps_being_reported_without_re_probing(self):
        """The flap guard: if this went quiet between probes, RESOLVE_QUIET_S (3 h) would
        declare it fixed and the next day's probe would push it as brand new — the alert-flap
        regression this file's dedup rules exist to prevent, reintroduced by a check that only
        speaks once a day."""
        state = {}
        self.run_check(state, "failed")
        issue, calls = self.run_check(state, "failed", now=NOW + timedelta(hours=1))
        self.assertEqual(calls, 0)  # nothing sent to met.no
        self.assertIsNotNone(issue)  # ...and yet the issue is still present

    def test_a_successful_probe_clears_it(self):
        state = {self.KEY: {"last_probe": (NOW - timedelta(days=2)).isoformat(),
                            "ok": False, "error": self.ERROR}}
        issue, calls = self.run_check(state, "ok", detail="run 2026-01-15T06:00:00Z, 44 hours")
        self.assertEqual(calls, 1)
        self.assertIsNone(issue)
        self.assertTrue(state[self.KEY]["ok"])
        self.assertEqual(state[self.KEY]["last_ok"], NOW.isoformat())
        self.assertNotIn("error", state[self.KEY])

    def test_the_interval_is_respected_then_elapses(self):
        state = {}
        self.run_check(state, "ok")
        _issue, calls = self.run_check(state, "ok", now=NOW + timedelta(hours=23, minutes=59))
        self.assertEqual(calls, 0)
        _issue, calls = self.run_check(state, "ok", now=NOW + timedelta(hours=24))
        self.assertEqual(calls, 1)

    def test_an_unreachable_web_app_does_not_spend_the_budget(self):
        """Nothing left the box, so it was not a probe. Retrying on the next 5-minute tick is
        free, and a web app that is genuinely down is check_todays_plan's alert to raise."""
        state = {}
        issue, calls = self.run_check(state, "unreachable", detail="ConnectionRefusedError: no")
        self.assertEqual(calls, 1)
        self.assertIsNone(issue)
        self.assertNotIn(self.KEY, state)  # no stamp: the very next run tries again

    def test_an_unreachable_run_leaves_an_earlier_verdict_standing(self):
        old = (NOW - timedelta(days=2)).isoformat()
        state = {self.KEY: {"last_probe": old, "ok": False, "error": self.ERROR}}
        issue, _calls = self.run_check(state, "unreachable", detail="ConnectionRefusedError: no")
        self.assertIsNotNone(issue)  # the tier was dead at the last real probe; still is
        self.assertEqual(state[self.KEY]["last_probe"], old)  # and the budget is unspent

    def test_zero_interval_disables_the_whole_check(self):
        state = {}
        with mock.patch.object(hc, "WEATHER_FALLBACK_PROBE_INTERVAL_H", 0.0):
            issue, calls = self.run_check(state, "failed")
        self.assertIsNone(issue)
        self.assertEqual(calls, 0)
        self.assertEqual(state, {})

    def test_a_malformed_stamp_probes_rather_than_wedging(self):
        state = {self.KEY: {"last_probe": "not a timestamp"}}
        _issue, calls = self.run_check(state, "ok")
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
