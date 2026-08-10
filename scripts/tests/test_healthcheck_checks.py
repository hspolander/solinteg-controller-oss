"""Tests for scripts/services/healthcheck.py's alert checks.

Why this file exists (added 2026-08-10): healthcheck.py is what NOTICES when everything else
breaks, and most of its `check_*` functions had no coverage at all — only check_control_errors was
exercised (test_healthcheck.py).

That is the worst shape a gap can have here. A wrong comparison in check_poller_stale means the
poller can die and no alert fires, and the absence of an alert is indistinguishable from health
— a broken smoke detector reads exactly like no fire. It matters more than usual for an unattended
deployment, where these pushes are the only thing watching.

Each check is a pure decision over (connection, injected now), so the interesting cases are
cheap: the threshold either side, the empty-table case, and the missing-table case (a service
that has never started successfully never creates its table, and that must not crash the
healthcheck run that would have reported it).

Run: py -m unittest scripts.tests.test_healthcheck_checks -v   (from the repo root)
     or: py -m unittest discover -s scripts/tests
"""
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

import healthcheck as hc  # noqa: E402
import notify  # noqa: E402

UTC = timezone.utc
NOW = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)

# Alert-tuple shape: (key, priority, title, body).
KEY, PRIORITY = 0, 1


def con_with(*tables: str) -> sqlite3.Connection:
    """An in-memory db holding only the named tables — anything else is genuinely ABSENT, which
    is the real state on a box where that service has never run."""
    con = sqlite3.connect(":memory:")
    schema = {
        "readings": "CREATE TABLE readings (timestamp TEXT, pv_w REAL)",
        "weather": "CREATE TABLE weather (timestamp TEXT, temp_c REAL)",
        "price_snapshots": "CREATE TABLE price_snapshots (date TEXT, logged_at TEXT)",
        "optimizer_runs": "CREATE TABLE optimizer_runs (price_date TEXT, logged_at TEXT)",
    }
    for t in tables:
        con.execute(schema[t])
    return con


def ago(seconds: float) -> str:
    return (NOW - timedelta(seconds=seconds)).isoformat()


class SafeScalarTests(unittest.TestCase):
    """The shared guard every staleness check leans on."""

    def test_returns_none_for_a_missing_table_rather_than_raising(self):
        # This is what lets a healthcheck run survive a service that has never started. If it
        # raised, the run would die and report nothing — including the problems it CAN see.
        self.assertIsNone(hc.safe_scalar(con_with(), "SELECT MAX(timestamp) FROM readings"))

    def test_returns_none_for_an_empty_table(self):
        self.assertIsNone(hc.safe_scalar(con_with("readings"), "SELECT MAX(timestamp) FROM readings"))

    def test_returns_the_value_when_there_is_one(self):
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(10),))
        self.assertEqual(hc.safe_scalar(con, "SELECT MAX(timestamp) FROM readings"), ago(10))


class CheckPollerStaleTests(unittest.TestCase):
    """The most consequential check in the file: every other number in the system derives from
    `readings`, so a dead poller silently freezes the whole dataset."""

    def test_no_table_at_all_reports_never_ran(self):
        alert = hc.check_poller_stale(con_with(), NOW)
        self.assertEqual(alert[KEY], "poller_no_data")
        self.assertEqual(alert[PRIORITY], notify.PRIORITY_HIGH)

    def test_empty_table_reports_never_ran(self):
        alert = hc.check_poller_stale(con_with("readings"), NOW)
        self.assertEqual(alert[KEY], "poller_no_data")

    def test_a_fresh_reading_is_silent(self):
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(30),))
        self.assertIsNone(hc.check_poller_stale(con, NOW))

    def test_just_inside_the_threshold_is_silent(self):
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(hc.POLLER_STALE_S - 1),))
        self.assertIsNone(hc.check_poller_stale(con, NOW))

    def test_exactly_at_the_threshold_is_silent(self):
        # The comparison is `>`, not `>=` — pinned so a later tightening is a deliberate choice.
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(hc.POLLER_STALE_S),))
        self.assertIsNone(hc.check_poller_stale(con, NOW))

    def test_past_the_threshold_alerts_high(self):
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(hc.POLLER_STALE_S + 1),))
        alert = hc.check_poller_stale(con, NOW)
        self.assertEqual(alert[KEY], "poller_stale")
        self.assertEqual(alert[PRIORITY], notify.PRIORITY_HIGH)

    def test_uses_the_NEWEST_reading_not_the_oldest(self):
        # MAX(timestamp), not MIN — reading the wrong end means a long-running poller looks dead
        # forever from its first row.
        con = con_with("readings")
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(99_999),))
        con.execute("INSERT INTO readings VALUES (?, 0)", (ago(10),))
        self.assertIsNone(hc.check_poller_stale(con, NOW))


class CheckWeatherStaleTests(unittest.TestCase):
    """Same shape as the poller check but deliberately LOW priority — the solar forecast falls
    back to climatology, so this costs accuracy, not money or safety."""

    def test_no_data_is_low_priority(self):
        alert = hc.check_weather_stale(con_with("weather"), NOW)
        self.assertEqual(alert[KEY], "weather_no_data")
        self.assertEqual(alert[PRIORITY], notify.PRIORITY_LOW)

    def test_fresh_is_silent(self):
        con = con_with("weather")
        con.execute("INSERT INTO weather VALUES (?, 18.0)", (ago(60),))
        self.assertIsNone(hc.check_weather_stale(con, NOW))

    def test_stale_alerts_low_not_high(self):
        con = con_with("weather")
        con.execute("INSERT INTO weather VALUES (?, 18.0)", (ago(hc.WEATHER_STALE_S + 1),))
        alert = hc.check_weather_stale(con, NOW)
        self.assertEqual(alert[KEY], "weather_stale")
        self.assertEqual(alert[PRIORITY], notify.PRIORITY_LOW)

    def test_its_threshold_is_looser_than_the_pollers(self):
        # Weather polls every 60 s but only matters hourly; sharing POLLER_STALE_S would alert
        # on every transient cloud-API hiccup.
        self.assertGreater(hc.WEATHER_STALE_S, hc.POLLER_STALE_S)


class CheckTodaysPlanTests(unittest.TestCase):
    """Guards the post-midnight grace window that this alert used to false-fire inside."""

    TODAY = "2026-08-10"

    def midnight_plus(self, seconds: int) -> datetime:
        """A UTC instant `seconds` into the Stockholm day — the check reasons in local time."""
        local_midnight = datetime(2026, 8, 10, 0, 0, 0, tzinfo=hc.STOCKHOLM)
        return (local_midnight + timedelta(seconds=seconds)).astimezone(UTC)

    def test_inside_the_grace_window_is_silent_even_with_nothing_logged(self):
        # The first render after midnight is what logs the day's snapshot+plan; before that
        # their absence is scheduling, not failure.
        con = con_with("price_snapshots", "optimizer_runs")
        now = self.midnight_plus(hc.PLAN_GRACE_AFTER_MIDNIGHT_S - 60)
        self.assertIsNone(hc.check_todays_plan(con, self.TODAY, now))

    def test_past_the_grace_window_with_no_snapshot_alerts(self):
        con = con_with("price_snapshots", "optimizer_runs")
        now = self.midnight_plus(hc.PLAN_GRACE_AFTER_MIDNIGHT_S + 60)
        alert = hc.check_todays_plan(con, self.TODAY, now)
        self.assertEqual(alert[KEY], "no_price_snapshot_today")

    def test_prices_logged_but_no_plan_alerts_separately(self):
        con = con_with("price_snapshots", "optimizer_runs")
        con.execute("INSERT INTO price_snapshots VALUES (?, ?)", (self.TODAY, ago(60)))
        now = self.midnight_plus(hc.PLAN_GRACE_AFTER_MIDNIGHT_S + 60)
        alert = hc.check_todays_plan(con, self.TODAY, now)
        self.assertEqual(alert[KEY], "no_optimizer_run_today")

    def test_both_present_is_silent(self):
        con = con_with("price_snapshots", "optimizer_runs")
        con.execute("INSERT INTO price_snapshots VALUES (?, ?)", (self.TODAY, ago(60)))
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)", (self.TODAY, ago(60)))
        now = self.midnight_plus(hc.PLAN_GRACE_AFTER_MIDNIGHT_S + 60)
        self.assertIsNone(hc.check_todays_plan(con, self.TODAY, now))

    def test_yesterdays_rows_do_not_satisfy_today(self):
        # Matching on date, not just "a row exists" — a stalled pipeline would otherwise look
        # healthy indefinitely off yesterday's plan.
        con = con_with("price_snapshots", "optimizer_runs")
        con.execute("INSERT INTO price_snapshots VALUES (?, ?)", ("2026-08-09", ago(90_000)))
        con.execute("INSERT INTO optimizer_runs VALUES (?, ?)", ("2026-08-09", ago(90_000)))
        now = self.midnight_plus(hc.PLAN_GRACE_AFTER_MIDNIGHT_S + 60)
        self.assertEqual(hc.check_todays_plan(con, self.TODAY, now)[KEY], "no_price_snapshot_today")

    def test_late_in_the_day_still_checks(self):
        con = con_with("price_snapshots", "optimizer_runs")
        now = self.midnight_plus(20 * 3600)
        self.assertIsNotNone(hc.check_todays_plan(con, self.TODAY, now))


class CheckDiskSpaceTests(unittest.TestCase):
    """telemetry.db writes and the nightly backup both fail at 0%, so this is the one check
    about the box rather than the system running on it."""

    def fake_usage(self, free_pct: float):
        total = 100 * 10**9
        free = int(total * free_pct / 100)
        return mock.patch.object(hc.shutil, "disk_usage", return_value=(total, total - free, free))

    def test_plenty_of_space_is_silent(self):
        with self.fake_usage(50):
            self.assertIsNone(hc.check_disk_space("/"))

    def test_just_above_the_floor_is_silent(self):
        with self.fake_usage(hc.DISK_FREE_MIN_PCT + 1):
            self.assertIsNone(hc.check_disk_space("/"))

    def test_below_the_floor_alerts_high(self):
        with self.fake_usage(hc.DISK_FREE_MIN_PCT - 1):
            alert = hc.check_disk_space("/")
            self.assertEqual(alert[KEY], "disk_low")
            self.assertEqual(alert[PRIORITY], notify.PRIORITY_HIGH)

    def test_exactly_at_the_floor_is_silent(self):
        with self.fake_usage(hc.DISK_FREE_MIN_PCT):
            self.assertIsNone(hc.check_disk_space("/"))

    def test_the_body_reports_the_percentage_and_the_gigabytes(self):
        with self.fake_usage(2):
            body = hc.check_disk_space("/")[3]
            self.assertIn("2.0%", body)
            self.assertIn("GB", body)


class AlertKeysAreDistinctTests(unittest.TestCase):
    def test_no_two_checks_share_an_alert_key(self):
        # main() de-duplicates and tracks "resolved" per KEY, so two checks sharing one would
        # make each silence the other's alert.
        keys = [
            hc.check_poller_stale(con_with(), NOW)[KEY],
            hc.check_weather_stale(con_with("weather"), NOW)[KEY],
        ]
        keys.append(hc.check_todays_plan(
            con_with("price_snapshots", "optimizer_runs"), "2026-08-10",
            datetime(2026, 8, 10, 20, 0, 0, tzinfo=hc.STOCKHOLM).astimezone(UTC),
        )[KEY])
        with mock.patch.object(hc.shutil, "disk_usage", return_value=(100, 99, 1)):
            keys.append(hc.check_disk_space("/")[KEY])
        self.assertEqual(len(keys), len(set(keys)), keys)


if __name__ == "__main__":
    unittest.main()
