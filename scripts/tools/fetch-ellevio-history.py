#!/usr/bin/env python3
"""
Fetch historical meter data from Ellevio's Mina Sidor API (the same endpoint the
consumption page's day view calls), one date-range request at a time, into
solar-data/ellevio/ as raw JSON — the UI only exposes one day at a time, this loops.

Auth is a logged-in browser session's Cookie header, pasted into a file (default
ellevio-cookie.txt in the repo root — gitignored, NEVER commit it; it expires on its
own within hours). Capture it via DevTools -> Network -> the consumption XHR ->
"Copy as cURL" and extract the cookie header value.

Usage:
  python scripts/tools/fetch-ellevio-history.py --site <deliverySiteId> \
      --from 2023-09-20 --to 2026-07-10 [--resolution QuarterHourly] \
      [--direction Consumption|Production] \
      [--chunk-days 7] [--out solar-data/ellevio] [--cookie-file ellevio-cookie.txt]

Direction: Consumption = grid import (the default). Production = grid export — needed
once for the meter reconciliation (scripts/tools/reconcile-ellevio-meter.py). Production
files get a "Production_" filename prefix so the two series can't be confused; Consumption
keeps the historical unprefixed names so existing files still count for resume.

The site id is the long number in the consumption page's API URL (a GSRN meter id —
personal, so it is an argument rather than a committed constant).

Behavior:
- Requests [from, to] in --chunk-days chunks (the API accepts multi-day ranges even
  though the UI asks day-by-day; probe with --chunk-days 1 if a range ever 4xxes).
- Saves each chunk as <out>/<resolution>_<from>_<to>.json; existing files that parse
  as JSON with a non-empty consumptions array are skipped, so reruns resume cleanly
  after a session-cookie swap.
- Stops after 3 consecutive failures (expired session presents as an HTML login
  redirect, i.e. a JSON parse failure) and reports where it stopped.
- Sleeps 300 ms between requests — this is someone's production API; be polite.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

API = "https://www.ellevio.se/api/mypages/energy/consumption/{site}"

HEADERS = {
    "accept": "*/*",
    "accept-language": "sv-SE,sv;q=0.9,en;q=0.5",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    ),
    "referer": "https://www.ellevio.se/privat/mina-sidor/elanvandning/",
}


def fetch_chunk(site: str, cookie: str, d1: date, d2: date, resolution: str, direction: str) -> dict:
    params = {
        "from": d1.isoformat(),
        "to": d2.isoformat(),
        "previous": "false",
        "next": "false",
        "resolution": resolution,
        "interval": "Daily",
        "isPowerTariff": "false",
        "isRolling12Months": "false",
        "direction": direction,
        "comparePrevious": "false",
        "comparePreviousYear": "false",
    }
    url = API.format(site=site) + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={**HEADERS, "cookie": cookie})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    payload = json.loads(body)  # HTML login page here -> JSONDecodeError -> counted as failure
    consumptions = (payload.get("data") or {}).get("consumptions")
    if not consumptions:
        raise ValueError(f"no consumptions in response for {d1}..{d2}")
    return payload


def existing_ok(path: Path) -> bool:
    try:
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        return bool((payload.get("data") or {}).get("consumptions"))
    except (OSError, ValueError):
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, help="deliverySiteId from the API URL")
    ap.add_argument("--from", dest="date_from", required=True)
    ap.add_argument("--to", dest="date_to", required=True)
    ap.add_argument("--resolution", default="QuarterHourly", choices=["QuarterHourly", "Hourly"])
    ap.add_argument("--direction", default="Consumption", choices=["Consumption", "Production"])
    ap.add_argument("--chunk-days", type=int, default=7)
    ap.add_argument("--out", default="solar-data/ellevio")
    ap.add_argument("--cookie-file", default="ellevio-cookie.txt")
    args = ap.parse_args()

    cookie = Path(args.cookie_file).read_text(encoding="utf-8").strip()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    d = date.fromisoformat(args.date_from)
    end = date.fromisoformat(args.date_to)
    fetched = skipped = 0
    consecutive_failures = 0

    prefix = "" if args.direction == "Consumption" else f"{args.direction}_"
    while d <= end:
        d2 = min(d + timedelta(days=args.chunk_days - 1), end)
        path = out / f"{prefix}{args.resolution}_{d.isoformat()}_{d2.isoformat()}.json"
        if existing_ok(path):
            skipped += 1
        else:
            try:
                payload = fetch_chunk(args.site, cookie, d, d2, args.resolution, args.direction)
                path.write_text(json.dumps(payload), encoding="utf-8")
                fetched += 1
                consecutive_failures = 0
                n = len(payload["data"]["consumptions"])
                print(f"ok  {d} .. {d2}  ({n} slots)", flush=True)
            except Exception as exc:  # noqa: BLE001
                consecutive_failures += 1
                print(f"FAIL {d} .. {d2}: {exc}", flush=True)
                if consecutive_failures >= 3:
                    print(
                        f"aborting after 3 consecutive failures — session cookie likely "
                        f"expired. Resume from {d} with a fresh ellevio-cookie.txt; "
                        f"already-saved chunks are skipped automatically.",
                        file=sys.stderr,
                    )
                    return 1
            time.sleep(0.3)
        d = d2 + timedelta(days=1)

    print(f"done: {fetched} fetched, {skipped} already present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
