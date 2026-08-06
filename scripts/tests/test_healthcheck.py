"""Tests for scripts/services/healthcheck.py.

Covers check_control_errors' severity split — the rule that decides whether a dispatch error
wakes you up. URGENT must mean "a write may have landed on the inverter and the revert did not".
If a failed *connect* can raise URGENT, the channel becomes noise: on the reference install 13 of
15 error_revert_failed rows in a 60-day window were connect failures that self-healed on the next
loop tick, and the one case that would actually matter looked identical to them.

The negative cases carry the weight here. This gate only ever DOWNGRADES an alert, so every way
it can be wrong is a way of staying quiet about something real.

Run: python3 -m unittest scripts.tests.test_healthcheck -v   (from the repo root)
"""
import sqlite3
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

import healthcheck as hc  # noqa: E402

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
        _key, severity, _title, message = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_HIGH)
        self.assertIn("nothing written", message)
        self.assertNotIn("UNCONFIRMED", message)

    def test_no_response_is_urgent(self):
        """Could have died mid-sequence with a write in flight — the real thing."""
        con = self.make_db([("error_revert_failed", NO_RESPONSE)])
        _key, severity, _title, message = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("UNCONFIRMED", message)

    def test_one_unconfirmed_among_many_benign_still_escalates(self):
        """The case the split exists to protect: a real failure must not be buried by noise."""
        rows = [("error_revert_failed", CONNECT_FAILED)] * 12
        rows.append(("error_revert_failed", NO_RESPONSE))
        con = self.make_db(rows)
        _key, severity, _title, message = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("x12 (connect failed", message)
        self.assertIn("x1 (state UNCONFIRMED)", message)

    def test_error_reverted_alone_stays_high(self):
        con = self.make_db([("error_reverted", "Modbus Error: whatever")])
        _key, severity, _title, message = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_HIGH)
        self.assertIn("error_reverted x1", message)

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
                _key, severity, _t, _m = hc.check_control_errors(con, NOW)
                self.assertEqual(severity, hc.notify.PRIORITY_URGENT)

    def test_connect_failure_only_counts_on_the_apply_half(self):
        """A write that timed out but whose REVERT hit a connect failure is still unconfirmed —
        classifying on the whole string instead of the apply half would wrongly downgrade it."""
        detail = ("Modbus Error: [Input/Output] No response received after 3 retries "
                  "| revert also failed: Modbus Error: connect failed ModbusTcpClient x:502")
        con = self.make_db([("error_revert_failed", detail)])
        _key, severity, _t, message = hc.check_control_errors(con, NOW)
        self.assertEqual(severity, hc.notify.PRIORITY_URGENT)
        self.assertIn("UNCONFIRMED", message)


if __name__ == "__main__":
    unittest.main()
