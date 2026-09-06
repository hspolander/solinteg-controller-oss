"""Tests for scripts/tools/build-intraday-profile.py's telemetry path.

Second test file for scripts/tools/ (see test_fetch_ellevio_history.py for why that needs
justifying). It earns the exception for the same reason: the output of this function is pasted
straight into lib/consumption-data.ts and then silently shapes every fallback plan, and its two
most important behaviours are both invisible when wrong.

The timezone conversion is the sharp edge. Telemetry buckets are UTC; hourShareByMonth is
indexed by STOCKHOLM local hour (slotConsumptionKwh reads the hour straight off a local
timestamp). Get that backwards and the profile is simply shifted one or two hours, which looks
entirely plausible in a table of numbers — the summer refresh moved that peak from
18h to 16h, and a two-hour move is exactly what an offset bug would produce, so "it looks
shifted" cannot distinguish the fix from the bug. Only a test with a known answer can.

Run: py -m unittest scripts.tests.test_build_intraday_profile -v   (from the repo root)
     or: py -m unittest discover -s scripts/tests
"""
import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_TOOL = Path(__file__).resolve().parent.parent / "tools" / "build-intraday-profile.py"
_spec = importlib.util.spec_from_file_location("build_intraday_profile", _TOOL)
bip = importlib.util.module_from_spec(_spec)
sys.modules["build_intraday_profile"] = bip
_spec.loader.exec_module(bip)  # the filename has dashes, so it can't be a plain import


def make_db(buckets):
    """buckets: {"YYYY-MM-DDTHH" (UTC): watts} -> path to a throwaway readings db."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    con = sqlite3.connect(tmp.name)
    con.execute("CREATE TABLE readings (timestamp TEXT, house_load_w REAL)")
    con.executemany(
        "INSERT INTO readings VALUES (?, ?)",
        [(f"{b}:00:00+00:00", w) for b, w in buckets.items()],
    )
    con.commit()
    con.close()
    return Path(tmp.name)


def full_day(date_str, watts_by_utc_hour):
    """UTC buckets for one UTC calendar day."""
    return {f"{date_str}T{h:02d}": w for h, w in watts_by_utc_hour.items()}


def local_day(date_str, watts):
    """UTC buckets covering one COMPLETE Stockholm summer day (UTC+2) at a constant wattage.

    Local hours 00-01 come from the previous UTC day's 22:00/23:00 buckets. Building fixtures
    by UTC day instead is a good way to write a test that asserts the wrong number: a UTC day
    covers local 02:00 through the next day's 01:00, so it leaves BOTH local days incomplete.
    """
    y, m, d = (int(x) for x in date_str.split("-"))
    prev = f"{y:04d}-{m:02d}-{d - 1:02d}"
    buckets = {f"{prev}T22": watts, f"{prev}T23": watts}
    buckets.update({f"{date_str}T{h:02d}": watts for h in range(22)})
    return buckets


class TelemetrySharesTests(unittest.TestCase):
    def build(self, buckets, months={7}):
        path = make_db(buckets)
        self.addCleanup(path.unlink)
        return bip.telemetry_shares(path, months)

    def test_utc_buckets_are_reported_in_stockholm_local_hours(self):
        """July is CEST (UTC+2): the 14:00 UTC bucket must land on local hour 16.

        This is the whole reason the file exists — see the module docstring.
        """
        # A flat day with one spike at 14:00 UTC.
        watts = {h: 1000.0 for h in range(24)}
        watts[14] = 5000.0
        # Two local days' worth of UTC buckets so one local day is complete.
        buckets = {**full_day("2026-07-10", watts), **full_day("2026-07-11", watts)}
        out = self.build(buckets)
        row = out[7][0]
        self.assertEqual(max(range(24), key=lambda h: row[h]), 16)

    def test_winter_uses_cet_not_cest(self):
        """January is UTC+1, so the same 14:00 UTC bucket lands on 15h, not 16h. Hard-coding a
        +2 offset would pass the July test and quietly corrupt every winter row."""
        watts = {h: 1000.0 for h in range(24)}
        watts[14] = 5000.0
        buckets = {**full_day("2026-01-10", watts), **full_day("2026-01-11", watts)}
        out = self.build(buckets, months={1})
        row = out[1][0]
        self.assertEqual(max(range(24), key=lambda h: row[h]), 15)

    def test_shares_sum_to_one(self):
        watts = {h: float(100 * (h + 1)) for h in range(24)}
        buckets = {**full_day("2026-07-10", watts), **full_day("2026-07-11", watts)}
        out = self.build(buckets)
        self.assertAlmostEqual(sum(out[7][0]), 1.0, places=9)

    def test_incomplete_days_are_excluded(self):
        """A partial first/last day would over-weight whichever hours it happens to cover."""
        watts = {h: 1000.0 for h in range(24)}
        partial = {f"2026-07-12T{h:02d}": 9999.0 for h in range(0, 6)}  # only 6 hours
        buckets = {**full_day("2026-07-10", watts), **full_day("2026-07-11", watts), **partial}
        out = self.build(buckets)
        row, n_days, _kwh = out[7]
        # Only local 2026-07-11 is complete: its 00/01 come from the 10th's 22:00/23:00 UTC
        # buckets, while local 07-10 never receives an hour 00 at all.
        self.assertEqual(n_days, 1)
        self.assertAlmostEqual(max(row), min(row), places=9)  # the 9999s did not leak in

    def test_days_are_weighted_equally_not_by_sample_count(self):
        """The poll interval changed over the life of the DB (30s -> 10s -> 20s), so a
        count-weighted mean would over-represent whichever weeks were polled fastest."""
        buckets = {**local_day("2026-07-11", 1000.0), **local_day("2026-07-12", 3000.0)}
        out = self.build(buckets)
        # One quiet day and one busy day, each complete -> hourly mean 2000 W -> 48 kWh/day.
        # A count-weighted mean could not tell these apart from one day of either kind.
        _row, n_days, kwh_day = out[7]
        self.assertEqual(n_days, 2)
        self.assertAlmostEqual(kwh_day, 24 * 2.0, places=6)

    def test_a_month_with_no_complete_day_is_omitted_rather_than_guessed(self):
        partial = {f"2026-07-10T{h:02d}": 1000.0 for h in range(0, 5)}
        self.assertEqual(self.build(partial), {})

    def test_null_load_rows_are_ignored(self):
        watts = {h: 1000.0 for h in range(24)}
        buckets = {**full_day("2026-07-10", watts), **full_day("2026-07-11", watts)}
        path = make_db(buckets)
        self.addCleanup(path.unlink)
        con = sqlite3.connect(path)
        con.execute("INSERT INTO readings VALUES ('2026-07-10T23:00:00+00:00', NULL)")
        con.commit()
        con.close()
        out = bip.telemetry_shares(path, {7})
        self.assertAlmostEqual(sum(out[7][0]), 1.0, places=9)


if __name__ == "__main__":
    unittest.main()
