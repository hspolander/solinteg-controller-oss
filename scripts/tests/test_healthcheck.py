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
import os
import sqlite3
import sys
import tempfile
import unittest
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
    """The fingerprint decides what breaks through the alert cooldown. It must track the KIND of
    failure and nothing else — putting counts in it would re-classify on every blip and defeat the
    de-duplication the fingerprint exists to make safe."""

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

    def test_different_kinds_have_different_fingerprints(self):
        reverted = self.fingerprint([("error_reverted", "Modbus Error: whatever")])
        benign = self.fingerprint([("error_revert_failed", CONNECT_FAILED)])
        self.assertNotEqual(reverted, benign)


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
        for fn in ("oracle_review_ready", "probe_conditions_ready"):
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

    def test_a_malformed_entry_is_dropped_rather_than_wedging_the_sweep(self):
        self.write_state(fingerprint="benign")  # no last_seen, no last_alert
        state = self.run_main([])
        self.assertNotIn("control_errors", state)
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
