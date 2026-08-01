"""Tests for scripts/tools/fetch-ellevio-history.py's site/direction guard.

First test file for scripts/tools/ (the suite otherwise covers scripts/services/ only). It
earns the exception because the thing under test is a guard against a SILENT failure, and an
untested guard against a silent failure is itself a silent failure: Ellevio's API ignores the
`direction` parameter and answers for whichever meter `--site` names, with HTTP 200 and a full
slot count, so without this check import data lands in correctly-named Production_*.json files
and reconcile-ellevio-meter.py compares import against itself and reports a perfect export
match. Nothing downstream would notice.

`urllib.request.urlopen` is faked, so these run with no network and no session cookie.

Run: python3 -m unittest scripts.tests.test_fetch_ellevio_history -v   (from the repo root)
     or: python3 -m unittest discover -s scripts/tests
"""
import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.request
from datetime import date
from pathlib import Path
from unittest import mock

_TOOL = Path(__file__).resolve().parent.parent / "tools" / "fetch-ellevio-history.py"
_spec = importlib.util.spec_from_file_location("fetch_ellevio_history", _TOOL)
feh = importlib.util.module_from_spec(_spec)
sys.modules["fetch_ellevio_history"] = feh
_spec.loader.exec_module(feh)  # the filename has dashes, so it can't be a plain import


class FakeResponse:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return self._data


def payload(*, is_consumption_site, slots=4):
    """A response shaped like the real one. `isConsumptionSite` is the ONLY field that reveals
    which meter answered — the consumptions themselves look identical either way."""
    return {
        "data": {
            "consumptions": [
                {"start": f"2026-07-15T0{i}:00:00+02:00", "total": 0.5, "status": "OK"}
                for i in range(slots)
            ],
            "summary": {"isConsumptionSite": is_consumption_site},
        }
    }


def fake_urlopen(response_payload):
    def _open(_req, timeout=None):
        return FakeResponse(response_payload)
    return _open


D1, D2 = date(2026, 7, 15), date(2026, 7, 21)


class SiteDirectionGuard(unittest.TestCase):
    def test_production_direction_against_consumption_site_raises(self):
        """The failure this guard exists for: --direction Production, consumption --site,
        HTTP 200, and a response that looks entirely healthy."""
        with mock.patch.object(urllib.request, "urlopen",
                               fake_urlopen(payload(is_consumption_site=True))):
            with self.assertRaises(feh.SiteDirectionMismatch) as ctx:
                feh.fetch_chunk("735999...285", "c=1", D1, D2, "QuarterHourly", "Production")
        msg = str(ctx.exception)
        self.assertIn("deliverysites", msg)  # tells them how to find the right id
        self.assertIn("consumption", msg.lower())

    def test_consumption_direction_against_production_site_raises(self):
        """The mirror image is worse if anything — production data in unprefixed files feeds
        the load model."""
        with mock.patch.object(urllib.request, "urlopen",
                               fake_urlopen(payload(is_consumption_site=False))):
            with self.assertRaises(feh.SiteDirectionMismatch):
                feh.fetch_chunk("735999...736", "c=1", D1, D2, "QuarterHourly", "Consumption")

    def test_matching_site_and_direction_pass(self):
        for is_cons, direction in ((True, "Consumption"), (False, "Production")):
            with self.subTest(direction=direction):
                with mock.patch.object(urllib.request, "urlopen",
                                       fake_urlopen(payload(is_consumption_site=is_cons))):
                    got = feh.fetch_chunk("735999...", "c=1", D1, D2, "QuarterHourly", direction)
                self.assertEqual(len(got["data"]["consumptions"]), 4)

    def test_absent_field_does_not_block_the_fetch(self):
        """Older API versions may not carry the field — degrade to the old behaviour rather
        than refuse to fetch anything at all."""
        no_field = {"data": {"consumptions": [{"start": "x", "total": 1.0, "status": "OK"}],
                             "summary": {}}}
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen(no_field)):
            got = feh.fetch_chunk("s", "c=1", D1, D2, "QuarterHourly", "Production")
        self.assertEqual(len(got["data"]["consumptions"]), 1)

    def test_empty_response_still_raises_the_plain_error(self):
        """A genuinely empty range is a retryable failure, not a mismatch."""
        with mock.patch.object(urllib.request, "urlopen",
                               fake_urlopen({"data": {"consumptions": []}})):
            with self.assertRaises(ValueError):
                feh.fetch_chunk("s", "c=1", D1, D2, "QuarterHourly", "Consumption")


class AbortsWithoutWriting(unittest.TestCase):
    def test_main_stops_on_the_first_chunk_and_writes_nothing(self):
        """The promise the guard actually makes: not 'warns', but 'does not save a month of
        wrong data'. Retrying would also burn the 3-failure budget and blame the cookie."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            cookie = tmp / "cookie.txt"
            cookie.write_text("c=1", encoding="utf-8")
            out = tmp / "out"
            argv = ["fetch-ellevio-history.py", "--site", "735999...285",
                    "--from", "2026-07-01", "--to", "2026-07-31",
                    "--direction", "Production",
                    "--out", str(out), "--cookie-file", str(cookie)]
            with mock.patch.object(sys, "argv", argv), \
                 mock.patch.object(urllib.request, "urlopen",
                                   fake_urlopen(payload(is_consumption_site=True))), \
                 mock.patch.object(feh.time, "sleep"):
                rc = feh.main()
        self.assertEqual(rc, 1)
        self.assertEqual(list(out.glob("*.json")), [], "no chunk may be saved on a mismatch")


if __name__ == "__main__":
    unittest.main()
