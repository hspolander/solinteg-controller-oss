"""Tests for scripts/services/notify.py's quiet-hours delay logic.

Added 2026-09-21 after PRIORITY_LOW/DEFAULT/HIGH pushes (the vast majority of what healthcheck.py
sends) were waking the phone up overnight with the same vibration as a real fault. Quiet hours
hold those back via ntfy's own `delay` scheduling instead of dropping or muting them — nothing
here should ever make a real alert (>= NTFY_QUIET_HOURS_MIN_PRIORITY, PRIORITY_URGENT by default)
arrive late, which is the one thing worth pinning tightly.

Run: py -m unittest scripts.tests.test_notify -v   (from the repo root)
"""
import io
import json
import sys
import unittest
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

import notify  # noqa: E402

STOCKHOLM = ZoneInfo("Europe/Stockholm")


class FakeHttpResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return b"{}"


class QuietHoursWindowTests(unittest.TestCase):
    """_in_quiet_hours — pure function, the wraparound arithmetic is the whole risk here."""

    def test_the_default_window_wraps_past_midnight(self):
        self.assertTrue(notify._in_quiet_hours(23, 22, 7))    # 23:xx, well inside
        self.assertTrue(notify._in_quiet_hours(0, 22, 7))     # just past midnight
        self.assertTrue(notify._in_quiet_hours(6, 22, 7))     # just before the end
        self.assertFalse(notify._in_quiet_hours(7, 22, 7))    # end hour itself is OUT
        self.assertFalse(notify._in_quiet_hours(21, 22, 7))   # just before start
        self.assertFalse(notify._in_quiet_hours(12, 22, 7))   # broad daylight

    def test_a_non_wrapping_window_works_too(self):
        self.assertTrue(notify._in_quiet_hours(2, 1, 5))
        self.assertFalse(notify._in_quiet_hours(0, 1, 5))
        self.assertFalse(notify._in_quiet_hours(5, 1, 5))

    def test_equal_start_and_end_disables_it_rather_than_covering_all_day(self):
        """The escape hatch: NTFY_QUIET_HOURS_START == END must mean 'off', not 'always on' —
        the whole config surface would be a footgun otherwise."""
        for hour in range(24):
            self.assertFalse(notify._in_quiet_hours(hour, 9, 9))


class QuietHoursDelayTests(unittest.TestCase):
    """_quiet_hours_delay — what actually decides whether send() adds `delay` to the payload."""

    def setUp(self):
        for name, value in (("NTFY_QUIET_HOURS_START", 22),
                            ("NTFY_QUIET_HOURS_END", 7),
                            ("NTFY_QUIET_HOURS_MIN_PRIORITY", notify.PRIORITY_URGENT)):
            p = mock.patch.object(notify, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_a_low_priority_push_at_2am_is_delayed_until_7am(self):
        now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
        delay = notify._quiet_hours_delay(notify.PRIORITY_LOW, now)
        self.assertIsNotNone(delay)
        expected = datetime(2026, 9, 22, 7, 0, tzinfo=STOCKHOLM)
        self.assertEqual(delay, int(expected.timestamp()))

    def test_a_high_priority_push_at_2am_is_also_delayed(self):
        """PRIORITY_HIGH covers real-but-not-urgent things (a dead poller, a full disk) — still
        held back by default, only PRIORITY_URGENT bypasses."""
        now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
        self.assertIsNotNone(notify._quiet_hours_delay(notify.PRIORITY_HIGH, now))

    def test_an_urgent_push_at_2am_is_never_delayed(self):
        now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
        self.assertIsNone(notify._quiet_hours_delay(notify.PRIORITY_URGENT, now))

    def test_a_push_during_the_day_is_never_delayed_regardless_of_priority(self):
        now = datetime(2026, 9, 22, 14, 0, tzinfo=STOCKHOLM)
        self.assertIsNone(notify._quiet_hours_delay(notify.PRIORITY_LOW, now))

    def test_late_evening_delays_to_tomorrow_mornings_end_hour(self):
        """23:30 is inside the window that wraps past midnight — the delay must land on the
        NEXT day's end hour, not today's (which has already passed)."""
        now = datetime(2026, 9, 22, 23, 30, tzinfo=STOCKHOLM)
        delay = notify._quiet_hours_delay(notify.PRIORITY_LOW, now)
        expected = datetime(2026, 9, 23, 7, 0, tzinfo=STOCKHOLM)
        self.assertEqual(delay, int(expected.timestamp()))

    def test_a_utc_now_is_converted_to_stockholm_before_judging_the_hour(self):
        """02:00 UTC in September (CEST, UTC+2) is 04:00 Stockholm — inside quiet hours. Passing
        now() in the wrong zone would silently misjudge this by up to two hours."""
        now_utc = datetime(2026, 9, 22, 2, 0, tzinfo=timezone.utc)
        self.assertIsNotNone(notify._quiet_hours_delay(notify.PRIORITY_LOW, now_utc))

    def test_disabling_quiet_hours_never_delays_anything(self):
        with mock.patch.object(notify, "NTFY_QUIET_HOURS_START", 9), \
             mock.patch.object(notify, "NTFY_QUIET_HOURS_END", 9):
            now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
            self.assertIsNone(notify._quiet_hours_delay(notify.PRIORITY_LOW, now))


class SendPayloadTests(unittest.TestCase):
    """send() — that the quiet-hours decision actually reaches the ntfy payload."""

    def setUp(self):
        p = mock.patch.object(notify, "NTFY_TOPIC", "test-topic")
        p.start()
        self.addCleanup(p.stop)
        for name, value in (("NTFY_QUIET_HOURS_START", 22),
                            ("NTFY_QUIET_HOURS_END", 7),
                            ("NTFY_QUIET_HOURS_MIN_PRIORITY", notify.PRIORITY_URGENT)):
            q = mock.patch.object(notify, name, value)
            q.start()
            self.addCleanup(q.stop)

    def send_and_capture(self, priority, now):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["payload"] = json.loads(req.data.decode("utf-8"))
            return FakeHttpResponse()

        with mock.patch.object(notify, "datetime") as mock_dt:
            mock_dt.now.return_value = now
            mock_dt.fromtimestamp = datetime.fromtimestamp
            with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
                ok = notify.send("title", "message", priority=priority)
        return ok, captured["payload"]

    def test_a_low_priority_night_push_carries_a_delay_field(self):
        now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
        ok, payload = self.send_and_capture(notify.PRIORITY_LOW, now)
        self.assertTrue(ok)
        self.assertIn("delay", payload)

    def test_an_urgent_night_push_carries_no_delay_field(self):
        now = datetime(2026, 9, 22, 2, 0, tzinfo=STOCKHOLM)
        ok, payload = self.send_and_capture(notify.PRIORITY_URGENT, now)
        self.assertTrue(ok)
        self.assertNotIn("delay", payload)

    def test_a_daytime_push_carries_no_delay_field_regardless_of_priority(self):
        now = datetime(2026, 9, 22, 14, 0, tzinfo=STOCKHOLM)
        ok, payload = self.send_and_capture(notify.PRIORITY_LOW, now)
        self.assertTrue(ok)
        self.assertNotIn("delay", payload)


if __name__ == "__main__":
    unittest.main()
