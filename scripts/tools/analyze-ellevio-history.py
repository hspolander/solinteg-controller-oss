#!/usr/bin/env python3
"""
Analyze the Ellevio meter history downloaded by fetch-ellevio-history.py:
what does this household's WINTER intraday load shape actually look like, and how
wrong is lib/load.ts's uniform-across-the-day assumption?

Reads every solar-data/ellevio/*.json chunk, dedups slots by start timestamp, and prints:
  1. Monthly import totals (kWh/day) — also reveals empirically when PV/battery began
     masking grid import (import collapses), i.e. which months are trustworthy as LOAD.
  2. Hour-of-day load profile per winter season (Nov-Feb core; Oct/Mar shown separately
     since shoulder-month daytime solar already bites) — mean kWh per local hour,
     normalized to share-of-day, with a uniform-assumption error summary.
  3. A machine-readable JSON profile (--json-out) for wiring into lib/consumption-data.ts.

Grid import == true electric load only while there is no meaningful PV/battery
activity; in Nov-Feb Göteborg solar is 1-5 kWh/day so winter import ≈ load even after
the PV install. The monthly table (1) is the evidence for that judgment, not an
assumption — check it before trusting a season.

Usage: python scripts/tools/analyze-ellevio-history.py [--dir solar-data/ellevio] [--json-out profile.json]
"""
import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

WINTER_CORE = {11, 12, 1, 2}  # Nov-Feb: solar negligible, import ≈ load
SHOULDER = {10, 3}  # Oct/Mar: some daytime solar bias possible post-PV-install


def load_slots(dir_: Path) -> dict:
    """start-ISO -> (local_datetime, kwh, slot_hours). Dedup across overlapping chunks."""
    slots = {}
    for path in sorted(dir_.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        for c in (payload.get("data") or {}).get("consumptions") or []:
            if c.get("status") != "OK" or c.get("total") is None:
                continue
            start = c["start"]
            if start in slots:
                continue
            dt = datetime.fromisoformat(start)  # local Stockholm time with offset
            end = datetime.fromisoformat(c["end"])
            hours = round((end - dt).total_seconds() / 3600 + 1 / 3600, 4)  # end is :59:59
            slots[start] = (dt, float(c["total"]), hours)
    return slots


def season_of(dt: datetime) -> str:
    """Winter season label: Nov-Dec belong to season 'YYYY-YY+1', Jan-Mar to 'YYYY-1-YY'."""
    if dt.month >= 10:
        return f"{dt.year}-{(dt.year + 1) % 100:02d}"
    return f"{dt.year - 1}-{dt.year % 100:02d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="solar-data/ellevio")
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    slots = load_slots(Path(args.dir))
    print(f"{len(slots)} unique slots loaded\n")

    # 1) Monthly import totals — the PV/battery-contamination evidence table.
    by_month = defaultdict(float)
    days_in_month = defaultdict(set)
    for dt, kwh, _h in slots.values():
        key = f"{dt.year}-{dt.month:02d}"
        by_month[key] += kwh
        days_in_month[key].add(dt.date())
    print("== Monthly grid import (kWh/day) — watch for the PV/battery collapse ==")
    for key in sorted(by_month):
        n = len(days_in_month[key])
        print(f"  {key}: {by_month[key] / max(1, n):6.1f} kWh/day  ({n} days)")

    # 2) Winter hour-of-day profiles, per season.
    #    hourly[season][hour] accumulates kWh; hours with quarter data just sum 4 slots.
    profiles = {}
    for label, months in (("Nov-Feb", WINTER_CORE), ("Oct+Mar", SHOULDER)):
        by_season = defaultdict(lambda: defaultdict(float))
        season_days = defaultdict(set)
        for dt, kwh, _h in slots.values():
            if dt.month not in months:
                continue
            s = season_of(dt)
            by_season[s][dt.hour] += kwh
            season_days[s].add(dt.date())
        print(f"\n== {label} hour-of-day load share (uniform would be 4.17%/h) ==")
        for s in sorted(by_season):
            hours = by_season[s]
            total = sum(hours.values())
            ndays = len(season_days[s])
            if total <= 0 or ndays < 20:
                print(f"  season {s}: skipped ({ndays} days, {total:.0f} kWh)")
                continue
            shares = [hours.get(h, 0.0) / total * 100 for h in range(24)]
            peak_h = max(range(24), key=lambda h: shares[h])
            trough_h = min(range(24), key=lambda h: shares[h])
            mad = sum(abs(sh - 100 / 24) for sh in shares) / 24
            print(
                f"  season {s} ({ndays} d, {total / ndays:.1f} kWh/d): "
                f"peak {shares[peak_h]:.1f}% @ {peak_h:02d}h, "
                f"trough {shares[trough_h]:.1f}% @ {trough_h:02d}h, "
                f"peak/trough {shares[peak_h] / max(0.01, shares[trough_h]):.1f}x, "
                f"MAD vs uniform {mad:.2f} pp"
            )
            row = " ".join(f"{sh:4.1f}" for sh in shares)
            print(f"    h00-23: {row}")
            if label == "Nov-Feb":
                profiles[s] = shares

    if args.json_out and profiles:
        Path(args.json_out).write_text(json.dumps(profiles, indent=1), encoding="utf-8")
        print(f"\nNov-Feb per-season hour shares written to {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
