#!/usr/bin/env python3
"""
Build solar-data/consumption-daily-corrected.csv — the daily household-consumption series
build-load-model.mjs should fit on — by merging the plant reports with the Ellevio meter
history (solar-data/ellevio/, from fetch-ellevio-history.py).

Why a corrected series exists at all (found 2026-07-11 by cross-checking the two sources):
the old inverter's meter was misconfigured through its first winter — plant-report
"consumption" for Dec 2022..Mar 2023 sits BELOW the DSO billing meter's import with
near-zero PV, which is physically impossible. And the plant report only starts 2022-12-06
while Ellevio has 2022-05-19 onward.

Rules, per day:
  2022-05-19 .. 2023-03-31  consumption := Ellevio import. Pre-PV (or winter-negligible
                            PV from Dec 2022, yield 0-6 kWh/day), so import ≈ true load;
                            ignoring winter self-use biases ~1-3 kWh/day low, noted.
  2023-04-01 .. 2026-01-19  consumption := plant report (its meter is sane by then;
                            every day is validated against consumption ≥ 0.9 × import
                            and violations are reported, not silently kept).
  after 2026-01-19          excluded — battery era (hybrid inverter night-charging makes
                            import ≠ load, and the old plant report ends there anyway).

Usage: python scripts/build-corrected-consumption.py
"""
import csv
import json
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ELLEVIO_DIR = ROOT / "solar-data" / "ellevio"
PLANT_CSV = ROOT / "solar-data" / "Plant Reports 2022-2026.csv"
OUT = ROOT / "solar-data" / "consumption-daily-corrected.csv"

ELLEVIO_WINDOW_END = date(2023, 3, 31)  # last day consumption := Ellevio import
PLANT_WINDOW_END = date(2026, 1, 19)  # old inverter's last day; battery era after


def ellevio_daily() -> dict:
    by_day = defaultdict(float)
    for path in sorted(ELLEVIO_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        seen = set()
        for c in (payload.get("data") or {}).get("consumptions") or []:
            if c.get("status") != "OK" or c.get("total") is None or c["start"] in seen:
                continue
            seen.add(c["start"])
            d = datetime.fromisoformat(c["start"]).date()
            by_day[(d, c["start"])] = float(c["total"])
    # collapse slot-level dedup (keyed by start) to day totals, deduping across chunk files
    daily = defaultdict(float)
    starts = set()
    for (d, start), kwh in by_day.items():
        if start in starts:
            continue
        starts.add(start)
        daily[d] += kwh
    return daily


def plant_daily() -> dict:
    out = {}
    with PLANT_CSV.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                d = date.fromisoformat(row["Date"])
                out[d] = (float(row["Daily consumption(kWh)"]), float(row["Daily imported energy(kWh)"]))
            except (KeyError, ValueError):
                continue
    return out


def main() -> int:
    imp = ellevio_daily()
    plant = plant_daily()

    rows = []
    violations = []
    for d in sorted(imp):
        if d <= ELLEVIO_WINDOW_END:
            rows.append((d, imp[d]))
    for d in sorted(plant):
        if ELLEVIO_WINDOW_END < d <= PLANT_WINDOW_END:
            cons, _plant_imp = plant[d]
            ell = imp.get(d)
            if ell is not None and cons < 0.9 * ell:
                # Plant-report dropout day (e.g. inverter offline): consumption below the
                # billing meter's import is impossible. Import is a hard lower bound on
                # consumption, so take max() — exact in winter (self-use ≈ 0), still a
                # conservative floor in summer.
                violations.append((d, cons, ell))
                cons = max(cons, ell)
            rows.append((d, cons))

    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Daily consumption(kWh)"])
        for d, kwh in rows:
            w.writerow([d.isoformat(), f"{kwh:.2f}"])

    print(f"{len(rows)} days written to {OUT.name} ({rows[0][0]} .. {rows[-1][0]})")
    if violations:
        print(f"{len(violations)} days where plant consumption < 0.9 x Ellevio import (kept, but review):")
        for d, cons, ell in violations[:15]:
            print(f"  {d}: plant {cons:.1f} vs import {ell:.1f}")
        if len(violations) > 15:
            print(f"  ... and {len(violations) - 15} more")
    else:
        print("plant window fully consistent with Ellevio import (no violations)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
