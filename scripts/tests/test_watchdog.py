"""Tests for scripts/services/watchdog.py — the independent safety net that forces the
inverter back to auto if dispatch_loop.py's heartbeat goes stale. This is the fail-safe of
last resort (see the module's own docstring: a hard crash skips inverter_control.py's atexit
handler entirely), so its own decision logic — when to intervene, when to alert, when to
de-dupe repeat alerts, and how a FAILED revert attempt escalates differently from a successful
one — is exactly the kind of thing that must not regress silently.

Inverter()/return_to_auto are mocked directly (attempt_revert's own boundary) rather than run
against fakes.FakeModbusClient — this file is about the watchdog's decision logic, not
inverter_control's Modbus behaviour (already covered by test_inverter_control.py).

Run: py -m unittest scripts.tests.test_watchdog -v   (from the repo root)
     or: py -m unittest discover -s scripts/tests
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

from fakes import install_pymodbus_stub  # noqa: E402

install_pymodbus_stub()

import watchdog as wd  # noqa: E402

UTC = timezone.utc


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


class WatchdogTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.heartbeat_path = Path(self.tmp.name) / "heartbeat.json"
        self.state_path = Path(self.tmp.name) / "state.json"

        self._patches = [
            mock.patch.object(wd, "HEARTBEAT_PATH", str(self.heartbeat_path)),
            mock.patch.object(wd, "STATE_PATH", str(self.state_path)),
            mock.patch.object(wd, "STALE_S", 240),
            mock.patch.object(wd, "ALERT_COOLDOWN_S", 1800),
            mock.patch.object(wd, "ARMED", True),
        ]
        for p in self._patches:
            p.start()

        self.notify_send = mock.patch.object(wd.notify, "send").start()
        # Default: revert succeeds (fake Inverter with a no-op close()).
        self.fake_inverter = mock.MagicMock()
        mock.patch.object(wd, "Inverter", return_value=self.fake_inverter).start()
        self.return_to_auto = mock.patch.object(wd, "return_to_auto").start()

    def tearDown(self):
        mock.patch.stopall()
        self.tmp.cleanup()

    def write_heartbeat(self, age_s: float) -> None:
        ts = datetime.now(UTC) - timedelta(seconds=age_s)
        write_json(self.heartbeat_path, {"timestamp": ts.isoformat()})

    def read_state(self) -> dict:
        return json.loads(self.state_path.read_text(encoding="utf-8"))


class HeartbeatAgeTests(WatchdogTestCase):
    def test_missing_file_returns_none(self):
        self.assertIsNone(wd.heartbeat_age_s(datetime.now(UTC)))

    def test_malformed_json_returns_none(self):
        self.heartbeat_path.write_text("not json", encoding="utf-8")
        self.assertIsNone(wd.heartbeat_age_s(datetime.now(UTC)))

    def test_missing_timestamp_key_returns_none(self):
        write_json(self.heartbeat_path, {"other": "field"})
        self.assertIsNone(wd.heartbeat_age_s(datetime.now(UTC)))

    def test_valid_file_returns_elapsed_seconds(self):
        now = datetime.now(UTC)
        write_json(self.heartbeat_path, {"timestamp": (now - timedelta(seconds=90)).isoformat()})
        age = wd.heartbeat_age_s(now)
        self.assertAlmostEqual(age, 90, delta=1)


class NoHeartbeatYetTests(WatchdogTestCase):
    def test_main_is_a_noop_when_heartbeat_never_existed(self):
        self.assertEqual(wd.main(), 0)
        self.notify_send.assert_not_called()
        self.return_to_auto.assert_not_called()


class FreshHeartbeatTests(WatchdogTestCase):
    def test_fresh_heartbeat_does_not_intervene_or_alert(self):
        self.write_heartbeat(age_s=10)
        self.assertEqual(wd.main(), 0)
        self.notify_send.assert_not_called()
        self.return_to_auto.assert_not_called()
        self.assertEqual(self.read_state(), {})

    def test_fresh_heartbeat_after_prior_intervention_sends_recovery_notice(self):
        write_json(self.state_path, {"intervened": True, "last_alert": datetime.now(UTC).isoformat()})
        self.write_heartbeat(age_s=10)

        self.assertEqual(wd.main(), 0)

        self.notify_send.assert_called_once()
        title = self.notify_send.call_args.args[0]
        self.assertIn("recovered", title.lower())
        self.assertEqual(self.read_state(), {})


class StaleArmedTests(WatchdogTestCase):
    def test_stale_and_armed_reverts_and_alerts_urgent(self):
        self.write_heartbeat(age_s=300)

        self.assertEqual(wd.main(), 0)

        self.return_to_auto.assert_called_once_with(self.fake_inverter)
        self.fake_inverter.close.assert_called_once()
        self.notify_send.assert_called_once()
        kwargs = self.notify_send.call_args.kwargs
        self.assertEqual(kwargs.get("priority"), wd.notify.PRIORITY_URGENT)
        self.assertEqual(self.read_state()["intervened"], True)

    def test_stale_and_armed_when_revert_itself_fails_escalates_and_returns_1(self):
        self.return_to_auto.side_effect = RuntimeError("connect failed")
        self.write_heartbeat(age_s=300)

        self.assertEqual(wd.main(), 1)

        self.notify_send.assert_called_once()
        title = self.notify_send.call_args.args[0]
        message = self.notify_send.call_args.args[1]
        self.assertIn("FAILED", title)
        self.assertIn("connect failed", message)
        kwargs = self.notify_send.call_args.kwargs
        self.assertEqual(kwargs.get("priority"), wd.notify.PRIORITY_URGENT)
        self.assertEqual(self.read_state()["intervened"], True)

    def test_failed_revert_alert_ignores_cooldown(self):
        # Armed + dead loop + failed fail-safe is the one scenario that must always alert,
        # even if a routine alert just fired moments ago.
        write_json(self.state_path, {"intervened": True, "last_alert": datetime.now(UTC).isoformat()})
        self.return_to_auto.side_effect = RuntimeError("connect failed")
        self.write_heartbeat(age_s=300)

        self.assertEqual(wd.main(), 1)
        self.notify_send.assert_called_once()


class StaleDisarmedTests(WatchdogTestCase):
    def setUp(self):
        super().setUp()
        mock.patch.object(wd, "ARMED", False).start()

    def test_stale_and_disarmed_still_attempts_revert_but_alerts_as_monitoring_gap(self):
        self.write_heartbeat(age_s=300)

        self.assertEqual(wd.main(), 0)

        # attempt_revert() is unconditional regardless of ARMED (write_u16 itself no-ops
        # when disarmed) — only the alert wording/priority differs.
        self.return_to_auto.assert_called_once()
        self.notify_send.assert_called_once()
        title = self.notify_send.call_args.args[0]
        message = self.notify_send.call_args.args[1]
        self.assertIn("looks dead", title)
        self.assertIn("monitoring gap", message)
        kwargs = self.notify_send.call_args.kwargs
        self.assertEqual(kwargs.get("priority"), wd.notify.PRIORITY_DEFAULT)
        self.assertEqual(self.read_state()["intervened"], False)


class AlertCooldownTests(WatchdogTestCase):
    def test_repeat_stale_check_within_cooldown_does_not_resend(self):
        self.write_heartbeat(age_s=300)
        self.assertEqual(wd.main(), 0)
        self.notify_send.assert_called_once()

        self.notify_send.reset_mock()
        self.write_heartbeat(age_s=310)  # still stale, alert fired moments ago
        self.assertEqual(wd.main(), 0)
        self.notify_send.assert_not_called()
        # revert is still attempted every tick regardless of alert cooldown
        self.assertEqual(self.return_to_auto.call_count, 2)

    def test_repeat_stale_check_after_cooldown_resends(self):
        write_json(self.state_path, {
            "intervened": True,
            "last_alert": (datetime.now(UTC) - timedelta(seconds=wd.ALERT_COOLDOWN_S + 1)).isoformat(),
        })
        self.write_heartbeat(age_s=300)

        self.assertEqual(wd.main(), 0)
        self.notify_send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
