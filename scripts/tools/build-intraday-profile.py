#!/usr/bin/env python3
"""
Build hourShareByMonth for lib/consumption-data.ts — the measured hour-of-day share of
daily household load, per calendar month — from the Ellevio meter history
(solar-data/ellevio/, fetch-ellevio-history.py).

Grid import equals true load only when PV/battery aren't masking it, so each month uses
only its clean window (established 2026-07-11 by cross-checking Ellevio against the plant
reports — see build-corrected-consumption.py):

  Nov, Dec, Jan, Feb   all days 2022-11-01 .. 2025-12-31 in those months (winter PV is
                       1-5 kWh/day — negligible; verified: the pre-PV 2022-23 winter's
                       midday trough matches the post-PV winters). Jan 2026+ excluded:
                       the hybrid battery (installed Jan 2026) night-charges.
  Mar, May..Oct        pre-PV window only (2022-05-19 .. 2023-03-31): any later, daytime
                       import is solar-masked and the share profile would be distorted.
  Apr                  no clean month exists (data starts mid-May 2022; Apr 2023 is
                       already PV-masked) — interpolated as the Mar/May mean.

Prints the 12x24 TS array literal (each row sums to 1) plus per-month diagnostics.

Usage: python scripts/tools/build-intraday-profile.py
"""
import json
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ELLEVIO_DIR = ROOT / "solar-data" / "ellevio"

PRE_PV_END = date(2023, 3, 31)
WINTER_MONTHS = {11, 12, 1, 2}
WINTER_END = date(2025, 12, 31)  # battery installed Jan 2026


def clean(dt: datetime) -> bool:
    d = dt.date()
    if dt.month in WINTER_MONTHS:
        return d <= WINTER_END
    return d <= PRE_PV_END


def main() -> int:
    # month (1-12) -> hour (0-23) -> kWh, deduped across overlapping chunk files
    by_mh = defaultdict(lambda: defaultdict(float))
    days = defaultdict(set)
    seen = set()
    for path in sorted(ELLEVIO_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        for c in (payload.get("data") or {}).get("consumptions") or []:
            if c.get("status") != "OK" or c.get("total") is None or c["start"] in seen:
                continue
            seen.add(c["start"])
            dt = datetime.fromisoformat(c["start"])  # local Stockholm wall time
            if not clean(dt):
                continue
            by_mh[dt.month][dt.hour] += float(c["total"])
            days[dt.month].add(dt.date())

    shares = {}
    print("month  days  kWh/day  peak%@h  trough%@h")
    for m in sorted(by_mh):
        hours = by_mh[m]
        total = sum(hours.values())
        row = [hours.get(h, 0.0) / total for h in range(24)]
        shares[m] = row
        pk = max(range(24), key=lambda h: row[h])
        tr = min(range(24), key=lambda h: row[h])
        print(
            f"  {m:02d}  {len(days[m]):4d}  {total / len(days[m]):7.1f}  "
            f"{row[pk] * 100:4.1f}@{pk:02d}  {row[tr] * 100:4.1f}@{tr:02d}"
        )

    # April: interpolate Mar/May
    if 4 not in shares and 3 in shares and 5 in shares:
        row = [(shares[3][h] + shares[5][h]) / 2 for h in range(24)]
        total = sum(row)
        shares[4] = [v / total for v in row]
        print("  04  (interpolated Mar/May mean)")

    missing = [m for m in range(1, 13) if m not in shares]
    if missing:
        print(f"ERROR: no data for months {missing}")
        return 1

    print("\n// hourShareByMonth — paste into lib/consumption-data.ts")
    print("export const hourShareByMonth: number[][] = [")
    for m in range(1, 13):
        row = ", ".join(f"{v:.4f}" for v in shares[m])
        print(f"  [{row}],")
    print("];")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
