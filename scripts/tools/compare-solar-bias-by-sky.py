#!/usr/bin/env python3
"""
Sky-condition breakdown of solar forecast error, as a follow-up to compare-forecast-actual.py.

If that script shows solarKwh running systematically hot or cold, the next question is WHY, and
the shape of the error tells you. A bias that is flat across lead-time buckets argues against a
weather-forecast-skill explanation (forecast skill should decay with lead time) and points at the
conversion layer instead — GHI to panel output. But there are two distinct conversion-layer
stories, and they make opposite predictions about how the bias splits by sky condition:

  1. Calibration-vintage mismatch: solarCalibrationByMonth (lib/consumption-data.ts) is fitted
     from avgDailyProductionByMonth, i.e. from whatever production history you had when you last
     regenerated it. If the array, inverter or shading has changed since — or if you are still
     running the reference values shipped with this repo rather than your own — the bias should
     be roughly UNIFORM across sky conditions. It is an equipment fact, not a weather fact.

  2. Sky-condition-mix mismatch: solarCalibrationByMonth is a single ratio per month, blended
     across whatever mix of clear and cloudy days the fitting window happened to contain. But
     GHI-to-tilted-panel transposition is not linear across sky conditions — the direct/diffuse
     fraction changes with cloudiness. If this is the driver, the error should CONCENTRATE on
     clear days (or on overcast ones), not spread evenly. A comparison window that is unusually
     sunny or unusually grey will then disagree with the fitted average.

Telling them apart matters because the fixes differ: (1) wants the calibration regenerated
(DOMAIN.md's "Adapting to a new site", step 4), while (2) wants a sky-dependent correction, which
is a modelling change rather than a refit.

This script re-derives per-day sky class from your own weather station's measured GHI (the
`weather` table, if you run the weather poller — no extra instrumentation), using the same method
compare-metno-solar.mjs uses: daily total against the window's own P90 day, <40% of peak =
overcast, <75% = mixed, else clear. It then splits compare-forecast-actual.py's
(solarKwh - actual) error series by that per-day class instead of by lead time.

Caveats:
- Same joins/skips as compare-forecast-actual.py (readings need >= --min-samples per 15-min
  bucket; solarSource=='forecast' slots only, matching the haircut-input convention there).
- The P90 threshold is relative to the window you pass, so a short window classifies days
  against a weak baseline. A week or so is enough to see which side a given day falls on; it is
  not enough to trust the thresholds themselves. Widen --from as data accumulates.
- Needs a weather station logging to the `weather` table. Without one there is nothing to derive
  sky class from and the script has no input.
- weather.timestamp is UTC; classification buckets by the Stockholm LOCAL calendar date, to
  match the local dates optimizer_runs' inputs_json slots are keyed on.

Usage (on the server, or against a pulled copy of telemetry.db):
  python3 scripts/tools/compare-solar-bias-by-sky.py [--db /opt/solinteg/telemetry.db]
      [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-samples 10]
"""
import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone

import common  # sibling module (scripts/tools/) — script dir is sys.path[0]

STOCKHOLM = common.STOCKHOLM


def parse_ts(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def local_to_utc(start_time: str) -> datetime:
    return datetime.fromisoformat(start_time).replace(tzinfo=STOCKHOLM).astimezone(timezone.utc)


def bucket_key(dt_utc: datetime) -> str:
    return dt_utc.strftime("%Y-%m-%dT%H:") + f"{(dt_utc.minute // 15) * 15:02d}"


def quantile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return float("nan")
    idx = min(len(sorted_vals) - 1, max(0, round(q * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def fmt_stats(errs: list[float]) -> str:
    if not errs:
        return "no data"
    n = len(errs)
    bias = sum(errs) / n
    abs_sorted = sorted(abs(e) for e in errs)
    return (
        f"n={n:5d}  bias={bias * 1000:+7.1f} Wh  MAE={sum(abs_sorted) / n * 1000:6.1f} Wh  "
        f"P90|err|={quantile(abs_sorted, 0.9) * 1000:6.1f} Wh"
    )


def sky_class(rel: float) -> str:
    return "overcast" if rel < 0.4 else "mixed" if rel < 0.75 else "clear"


def main() -> int:
    ap = argparse.ArgumentParser()
    common.add_db_arg(ap)
    ap.add_argument("--from", dest="from_date", default=None, help="first price_date (YYYY-MM-DD)")
    ap.add_argument("--to", dest="to_date", default=None, help="last price_date inclusive")
    ap.add_argument("--min-samples", type=int, default=10, help="min poller readings per 15-min slot")
    args = ap.parse_args()

    con = common.connect_ro(args.db)
    con.row_factory = sqlite3.Row

    where, params = [], []
    if args.from_date:
        where.append("price_date >= ?")
        params.append(args.from_date)
    if args.to_date:
        where.append("price_date <= ?")
        params.append(args.to_date)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    runs = con.execute(
        f"SELECT logged_at, price_date, inputs_json FROM optimizer_runs{where_sql} ORDER BY logged_at",
        params,
    ).fetchall()
    if not runs:
        print("No optimizer runs in range - nothing to validate.")
        return 1

    # ── Actuals: bucket readings.pv_w into UTC 15-min slots (same as compare-forecast-actual.py) ──
    lo = min(parse_ts(r["logged_at"]) for r in runs).strftime("%Y-%m-%dT%H:%M")
    actual: dict[str, float] = {}
    acc: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])  # n, sum_pv
    for row in con.execute(
        "SELECT timestamp, pv_w FROM readings WHERE timestamp >= ? AND pv_w IS NOT NULL", (lo,)
    ):
        a = acc[bucket_key(parse_ts(row["timestamp"]))]
        a[0] += 1
        a[1] += row["pv_w"]
    for k, (n, s_pv) in acc.items():
        if n >= args.min_samples:
            actual[k] = s_pv / n / 4000.0  # kWh/slot

    # ── Per-day sky class from the Ecowitt station's own measured GHI ──
    daily_ghi: dict[str, float] = defaultdict(float)
    for row in con.execute(
        "SELECT timestamp, solar_wm2 FROM weather WHERE timestamp >= ? AND solar_wm2 IS NOT NULL", (lo,)
    ):
        local_date = parse_ts(row["timestamp"]).astimezone(STOCKHOLM).date().isoformat()
        daily_ghi[local_date] += row["solar_wm2"]

    if len(daily_ghi) < 3:
        print(f"Only {len(daily_ghi)} day(s) of weather data - too few to classify sky condition.")
        return 1

    peak = quantile(sorted(daily_ghi.values()), 0.9)
    classes = {date: sky_class(total / peak) for date, total in daily_ghi.items()}
    print("Per-day sky classification (vs this window's own P90 day):")
    for date in sorted(classes):
        print(f"  {date}  {classes[date]:8s}  (relative total {daily_ghi[date] / peak:.2f})")
    print()

    # ── Solar forecast error, split by the LOCAL DATE's sky class instead of lead-time bucket ──
    errs_by_class: dict[str, list[float]] = defaultdict(list)
    for run in runs:
        try:
            slots = json.loads(run["inputs_json"])
        except json.JSONDecodeError:
            continue
        for s in slots:
            if s.get("solarSource") != "forecast":
                continue
            local_date = datetime.fromisoformat(s["startTime"]).date().isoformat()
            cls = classes.get(local_date)
            if cls is None:
                continue
            a = actual.get(bucket_key(local_to_utc(s["startTime"])))
            if a is None:
                continue
            errs_by_class[cls].append(s["solarKwh"] - a)

    print("SOLAR FORECAST ERROR (solarKwh - actual) BY SKY CONDITION:")
    for cls in ("clear", "mixed", "overcast"):
        print(f"  {cls:8s}  {fmt_stats(errs_by_class.get(cls, []))}")
    print(
        "\nIf 'clear' carries most of the positive bias -> sky-condition-mix mismatch "
        "(fix: split solarCalibrationByMonth by sky condition, not just month).\n"
        "If bias is roughly uniform across classes -> equipment-vintage mismatch "
        "(fix: re-derive avgDailyProductionByMonth from post-Jan-2026 inverter data once "
        "enough same-season data exists)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
