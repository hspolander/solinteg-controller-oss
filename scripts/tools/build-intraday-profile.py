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

Months given with --telemetry-months are instead built from the house's OWN measured
`house_load_w` in telemetry.db, which is strictly better provenance than the meter history:
it is the derived whole-house load, so it has no solar-masking problem at all and needs no
"clean window" argument. Added for the summer rows, whose meter-history source is pre-PV behaviour — on the
reference deployment that shape ran ~25% low overnight and ~40% high at the modelled
dinner peak, because the household no longer runs the way it did before the PV and
battery arrived.

Scope note, so nobody over-values this: `hourShareByMonth` feeds slotConsumptionKwh, which
is only the FALLBACK — with telemetry present the plan uses
readTrailingLoadProfile's live 14-day measured shape instead. Refreshing these rows changes
nothing on a healthy deployment. It matters because the fallback engages exactly when the
poller is already down, i.e. when you are least able to afford a shape that is 40% wrong at
the evening peak.

Two hygiene rules the meter path does not need:
  - Only COMPLETE local days count (all 24 hours present). The first and last days of a
    telemetry window are partial and would over-weight whichever hours they do cover.
  - Each day contributes EQUALLY, rather than weighting by sample count. The poll interval
    has changed over the life of the DB (30s -> 10s -> 20s), so a count-weighted mean would
    silently over-represent whichever weeks happened to be polled fastest.

Prints the 12x24 TS array literal (each row sums to 1) plus per-month diagnostics.

Usage: python scripts/tools/build-intraday-profile.py
       python scripts/tools/build-intraday-profile.py --telemetry-db telemetry.db            --telemetry-months 7,8
"""
import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

STOCKHOLM = ZoneInfo("Europe/Stockholm")

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



def telemetry_shares(db_path: Path, months: set[int]):
    """month -> (24 shares, complete-day count, mean kWh/day) from measured house_load_w.

    Bucketing by UTC hour and mapping to Stockholm afterwards mirrors readTrailingLoadProfile
    (lib/telemetry/readings.ts) exactly, so the fallback shape is built the same way as the live
    one it stands in for. Safe because every Stockholm offset is a whole number of hours.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT strftime('%Y-%m-%dT%H', timestamp) AS bucket, AVG(house_load_w) AS w "
            "FROM readings WHERE house_load_w IS NOT NULL GROUP BY bucket"
        ).fetchall()
    finally:
        con.close()

    # (local date, local hour) -> mean W
    by_day_hour: dict[tuple[date, int], float] = {}
    for bucket, w in rows:
        if w is None:
            continue
        utc = datetime.fromisoformat(f"{bucket}:00:00+00:00")
        local = utc.astimezone(STOCKHOLM)
        by_day_hour[(local.date(), local.hour)] = float(w)

    days_by_month = defaultdict(list)
    for (d, _h) in by_day_hour:
        if d not in days_by_month[d.month]:
            days_by_month[d.month].append(d)

    out = {}
    for m in sorted(months):
        complete = sorted(
            d for d in days_by_month.get(m, [])
            if all((d, h) in by_day_hour for h in range(24))
        )
        if not complete:
            continue
        # Equal weight per day, not per sample — see the module docstring.
        hourly = [
            sum(by_day_hour[(d, h)] for d in complete) / len(complete) for h in range(24)
        ]
        total_w = sum(hourly)
        if total_w <= 0:
            continue
        out[m] = ([w / total_w for w in hourly], len(complete), total_w / 1000.0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--telemetry-db", type=Path, default=None,
                    help="telemetry.db to build --telemetry-months from (measured house_load_w)")
    ap.add_argument("--telemetry-months", default="",
                    help="comma-separated month numbers to take from telemetry instead of Ellevio")
    args = ap.parse_args()
    telemetry_months = {int(m) for m in args.telemetry_months.split(",") if m.strip()}
    if telemetry_months and args.telemetry_db is None:
        print("ERROR: --telemetry-months needs --telemetry-db")
        return 1

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

    if telemetry_months:
        measured = telemetry_shares(args.telemetry_db, telemetry_months)
        missing_t = sorted(telemetry_months - set(measured))
        if missing_t:
            print(f"ERROR: no complete measured days for month(s) {missing_t}")
            return 1
        print()
        print("measured from telemetry (house_load_w) — replaces the Ellevio rows above")
        print("month  days  kWh/day  peak%@h  trough%@h   evening 17-21%  (was)")
        for m, (row, n_days, kwh_day) in sorted(measured.items()):
            was_evening = sum(shares[m][h] for h in range(17, 22)) * 100 if m in shares else float("nan")
            evening = sum(row[h] for h in range(17, 22)) * 100
            pk = max(range(24), key=lambda h: row[h])
            tr = min(range(24), key=lambda h: row[h])
            print(
                f"  {m:02d}  {n_days:4d}  {kwh_day:7.1f}  {row[pk] * 100:4.1f}@{pk:02d}  "
                f"{row[tr] * 100:4.1f}@{tr:02d}        {evening:5.1f}          {was_evening:5.1f}"
            )
            shares[m] = row

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
