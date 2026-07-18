#!/usr/bin/env python3
"""
Forecast-vs-actual validation for the two model inputs that drive dispatch decisions —
Open-Meteo solar and the load model.

Why this exists: the optimizer's decision quality is bounded by its inputs, and until now
their live accuracy was unmeasured (the SMHI/Ecowitt/CAMS comparisons validated a static
climatological baseline, not the live pipeline). This script joins every logged optimizer
run's per-slot forecasts (optimizer_runs.inputs_json — the exact numbers the DP planned
against) to what the poller actually measured (readings.pv_w / house_load_w bucketed into
the same 15-min slots). It exists to answer three specific questions:

  1. How good is the solar forecast, by forecast lead time? (input to the solar-side
     "haircut" design for the morning-oversell failure mode — selling in the morning
     against a 100%-trusted solar-refill forecast, DESIGN-reserve.md §9's deferred half)
  2. How good is the load forecast, especially overnight? (the 2026-07-17/18 incident:
     a stale hour shape ran ~25% low overnight and the plan sold the safety margin)
  3. Is LOAD_FORECAST_MARGIN = 1.15 the right α? (compare against the measured per-night
     actual/forecast ratio distribution — the margin should sit near the high quantiles)

Method:
- Every (run, slot) pair is one forecast observation at lead time
  (slot start − run logged_at). Slots are matched to actuals via UTC 15-min buckets
  (inputs_json startTime is naive Stockholm local; converted with zoneinfo).
- Per-slot errors are reported per lead-time bucket, split by provenance tag
  (solarSource 'forecast' vs 'typical'; loadSource 'modeled'/'baseline'/'live') — mixing
  climatology-fallback slots into the live-forecast stats would understate real skill
  (the tags exist for exactly this, deploy/schema.sql).
- Decision-relevant aggregates: per-NIGHT load ratio (22:00–06:00 local, using the last
  run logged before 22:00 local — the plan that actually carries the night) and
  per-MORNING solar ratio (06:00–12:00 local, using the earliest run of that day).

Caveats (read before acting on a number):
- Replans cluster at eventful hours, so per-slot stats overweight slots that got replanned
  often. The per-night/per-morning aggregates use one run each and don't have this bias.
- consumptionKwh in inputs_json is the HONEST forecast (the DP's ×LOAD_FORECAST_MARGIN
  robustness margin is applied inside optimizeDispatch and never logged), so load stats
  here measure the model, not the margin — comparing dispatch_json grid flows would not.
- Load-model regime change 2026-07-18 (static hour shape → live trailing profile,
  loadSource 'live'): don't average across the boundary; the split-by-tag output keeps
  the regimes separate.
- A slot's actual is the poller mean over the bucket; slots with < --min-samples readings
  (poller downtime) are skipped, so outages don't masquerade as forecast error.
- DST fold: naive local slot times are resolved with fold=0; the two ambiguous hours per
  year are noise at this aggregation level.

Usage (on the NUC, or against a pulled copy of telemetry.db):
  python3 scripts/tools/compare-forecast-actual.py [--db /opt/solinteg/telemetry.db]
      [--from 2026-07-02] [--to 2026-07-18] [--min-samples 10] [--min-days 7]
"""
import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

STOCKHOLM = ZoneInfo("Europe/Stockholm")
LEAD_BUCKETS = [(0, 2), (2, 6), (6, 12), (12, 38)]  # hours


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
    """bias / MAE / P90(|err|) in Wh per 15-min slot (kWh numbers are tiny and unreadable)."""
    if not errs:
        return "no data"
    n = len(errs)
    bias = sum(errs) / n
    abs_sorted = sorted(abs(e) for e in errs)
    return (
        f"n={n:5d}  bias={bias * 1000:+7.1f} Wh  MAE={sum(abs_sorted) / n * 1000:6.1f} Wh  "
        f"P90|err|={quantile(abs_sorted, 0.9) * 1000:6.1f} Wh"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/opt/solinteg/telemetry.db")
    ap.add_argument("--from", dest="from_date", default=None, help="first price_date (YYYY-MM-DD)")
    ap.add_argument("--to", dest="to_date", default=None, help="last price_date inclusive")
    ap.add_argument("--min-samples", type=int, default=10, help="min poller readings per 15-min slot")
    ap.add_argument("--min-days", type=int, default=7, help="min distinct days before reporting")
    args = ap.parse_args()

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
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
        print("No optimizer runs in range — nothing to validate.")
        return 1

    # Actuals: one pass over readings, bucketed per UTC 15-min slot.
    lo = min(parse_ts(r["logged_at"]) for r in runs).strftime("%Y-%m-%dT%H:%M")
    actual: dict[str, dict[str, float]] = {}
    acc: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])  # n, sum_pv, sum_load
    for row in con.execute(
        "SELECT timestamp, pv_w, house_load_w FROM readings WHERE timestamp >= ? "
        "AND pv_w IS NOT NULL AND house_load_w IS NOT NULL",
        (lo,),
    ):
        a = acc[bucket_key(parse_ts(row["timestamp"]))]
        a[0] += 1
        a[1] += row["pv_w"]
        a[2] += row["house_load_w"]
    for k, (n, s_pv, s_load) in acc.items():
        if n >= args.min_samples:
            actual[k] = {"solar": s_pv / n / 4000.0, "load": s_load / n / 4000.0}  # kWh/slot

    # Per-slot observations, split by lead bucket and provenance tag.
    solar_errs: dict[tuple, list[float]] = defaultdict(list)  # (bucket, tag) -> forecast-actual
    load_errs: dict[tuple, list[float]] = defaultdict(list)
    days = set()
    for run in runs:
        logged = parse_ts(run["logged_at"])
        try:
            slots = json.loads(run["inputs_json"])
        except json.JSONDecodeError:
            continue
        for s in slots:
            slot_utc = local_to_utc(s["startTime"])
            a = actual.get(bucket_key(slot_utc))
            if a is None:
                continue
            lead_h = (slot_utc - logged).total_seconds() / 3600.0
            bucket = next((b for b in LEAD_BUCKETS if b[0] <= lead_h < b[1]), None)
            if bucket is None:
                continue
            days.add(run["price_date"])
            solar_errs[(bucket, s.get("solarSource", "?"))].append(s["solarKwh"] - a["solar"])
            load_errs[(bucket, s.get("loadSource", "?"))].append(
                s.get("consumptionKwh", 0.0) - a["load"]
            )

    if len(days) < args.min_days:
        print(f"Only {len(days)} day(s) with joinable data (< --min-days {args.min_days}) — "
              "not enough data yet for stable distributions.")
        return 1

    print(f"Forecast-vs-actual over {len(days)} days, {len(runs)} optimizer runs "
          f"(readings slots with >= {args.min_samples} samples: {len(actual)})\n")
    for title, errs in (("SOLAR (solarKwh)", solar_errs), ("LOAD (consumptionKwh)", load_errs)):
        print(title)
        for (b, tag) in sorted(errs, key=lambda k: (k[0], k[1])):
            print(f"  lead {b[0]:2d}-{b[1]:2d} h  [{tag:8s}]  {fmt_stats(errs[(b, tag)])}")
        print()

    # ── Decision aggregate 1: per-night load ratio (α check for LOAD_FORECAST_MARGIN) ──
    # The plan that carries the night = last run logged before 22:00 local that evening.
    night_ratios: list[tuple[str, float, float, float]] = []
    by_date: dict[str, list] = defaultdict(list)
    for run in runs:
        by_date[run["price_date"]].append(run)
    for date in sorted(by_date):
        cutoff = datetime.fromisoformat(f"{date}T22:00:00").replace(tzinfo=STOCKHOLM)
        evening_runs = [r for r in by_date[date] if parse_ts(r["logged_at"]) <= cutoff]
        if not evening_runs:
            continue
        run = evening_runs[-1]
        fc = act = 0.0
        covered = 0
        for s in json.loads(run["inputs_json"]):
            t = datetime.fromisoformat(s["startTime"])
            in_night = (t.date().isoformat() == date and t.hour >= 22) or (
                t.hour < 6 and t.date().isoformat() > date
            )
            if not in_night:
                continue
            a = actual.get(bucket_key(local_to_utc(s["startTime"])))
            if a is None:
                continue
            fc += s.get("consumptionKwh", 0.0)
            act += a["load"]
            covered += 1
        if covered >= 24 and fc > 0:  # >= 6 h of the 8 h night joinable
            night_ratios.append((date, act / fc, fc, act))

    print("PER-NIGHT LOAD RATIO (actual/forecast, 22:00-06:00 local, evening plan) — α input:")
    for date, ratio, fc, act in night_ratios:
        print(f"  {date}  ratio={ratio:5.2f}  forecast={fc:5.2f} kWh  actual={act:5.2f} kWh")
    ratios = sorted(r for _, r, _, _ in night_ratios)
    if ratios:
        print(f"  -> median={quantile(ratios, 0.5):.2f}  P80={quantile(ratios, 0.8):.2f}  "
              f"P95={quantile(ratios, 0.95):.2f}  (LOAD_FORECAST_MARGIN should sit near P80-P95)\n")

    # ── Decision aggregate 2: per-morning solar ratio (haircut input) ──
    morning_ratios: list[tuple[str, float, float, float]] = []
    for date in sorted(by_date):
        run = by_date[date][0]  # earliest run of the day = longest planning lead
        fc = act = 0.0
        covered = 0
        for s in json.loads(run["inputs_json"]):
            t = datetime.fromisoformat(s["startTime"])
            if not (t.date().isoformat() == date and 6 <= t.hour < 12):
                continue
            if s.get("solarSource") != "forecast":
                continue
            a = actual.get(bucket_key(local_to_utc(s["startTime"])))
            if a is None:
                continue
            fc += s["solarKwh"]
            act += a["solar"]
            covered += 1
        if covered >= 16 and fc > 0.5:  # >= 4 h joinable and a non-trivial forecast
            morning_ratios.append((date, act / fc, fc, act))

    print("PER-MORNING SOLAR RATIO (actual/forecast, 06:00-12:00 local, first plan of day) — haircut input:")
    for date, ratio, fc, act in morning_ratios:
        print(f"  {date}  ratio={ratio:5.2f}  forecast={fc:5.2f} kWh  actual={act:5.2f} kWh")
    ratios = sorted(r for _, r, _, _ in morning_ratios)
    if ratios:
        print(f"  -> median={quantile(ratios, 0.5):.2f}  P20={quantile(ratios, 0.2):.2f}  "
              f"P05={quantile(ratios, 0.05):.2f}  (a refill-dependent sale is safe against ~P20)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
