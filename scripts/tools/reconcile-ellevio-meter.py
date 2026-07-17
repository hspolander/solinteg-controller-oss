#!/usr/bin/env python3
"""
Reconcile the poller's grid flows against the Ellevio billing meter.

Why this exists: every SEK figure in this system (economics card, oracle regret) is computed
from the INVERTER's own grid measurement (readings.grid_w) and our pricing constants. The
oracle is deliberately self-consistent (it values both the achieved day and its hindsight
benchmark through the same arithmetic — lib/oracle.ts), which means a systematic error in the
measurement layer is invisible from inside. The Ellevio billing meter is the one instrument in
the house that none of our code touches, and it is what the invoice is settled on — so this
comparison is the external anchor for everything the oracle stands on. Expect the inverter CT
and the billing meter to disagree by a small systematic amount (CT calibration, metering
point vs inverter topology, inverter standby drawn from the grid side); the point is to KNOW
the number and watch that it stays small and stable.

Inputs:
- telemetry.db (readings.grid_w, sign convention: +export / -import, UTC timestamps)
- solar-data/ellevio/*.json chunks from fetch-ellevio-history.py:
    unprefixed files            = Consumption (grid import, kWh per slot)
    Production_*.json           = Production  (grid export) — fetch with --direction Production
  Item shape: data.consumptions[] of {start: Stockholm-local ISO, total: kWh, status: "OK"},
  deduped by start across chunk files (same rule as build-corrected-consumption.py).

Method: integrate readings.grid_w into per-Stockholm-hour import/export kWh (left-Riemann,
gaps > --max-gap-s excluded); sum Ellevio slots into the same hours; compare only hours where
readings coverage >= --min-coverage (default 90% of the hour) so poller outages don't read as
meter disagreement. Reports per-month totals with delta %, and the worst days.

Usage (run wherever both the db and solar-data/ellevio are available):
  python3 scripts/tools/reconcile-ellevio-meter.py [--db /opt/solinteg/telemetry.db]
      [--ellevio-dir solar-data/ellevio] [--from 2026-07-01] [--to 2026-07-31]
      [--max-gap-s 600] [--min-coverage 0.9] [--flag-pct 5.0]
"""
import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

STHLM = ZoneInfo("Europe/Stockholm")


def parse_utc(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def hour_key(dt_sthlm: datetime) -> str:
    return dt_sthlm.strftime("%Y-%m-%dT%H")


def load_ellevio(ellevio_dir: Path) -> tuple[dict, dict]:
    """-> ({hour_key: kWh} import, {hour_key: kWh} export), deduped by slot start."""
    imp: dict[str, float] = defaultdict(float)
    exp: dict[str, float] = defaultdict(float)
    seen: set[tuple[str, str]] = set()
    for path in sorted(ellevio_dir.glob("*.json")):
        direction = "Production" if path.name.startswith("Production_") else "Consumption"
        try:
            with path.open(encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, ValueError) as exc:
            print(f"skipping unreadable {path.name}: {exc}", file=sys.stderr)
            continue
        for c in (payload.get("data") or {}).get("consumptions") or []:
            if c.get("status") != "OK" or c.get("total") is None:
                continue
            key = (direction, c["start"])
            if key in seen:
                continue
            seen.add(key)
            dt = datetime.fromisoformat(c["start"])
            dt = dt.astimezone(STHLM) if dt.tzinfo else dt.replace(tzinfo=STHLM)
            bucket = imp if direction == "Consumption" else exp
            bucket[hour_key(dt)] += float(c["total"])
    return imp, exp


def load_readings(db: str, date_from: str | None, date_to: str | None,
                  max_gap_s: int) -> tuple[dict, dict, dict]:
    """-> per-Stockholm-hour {key: kWh} import, {key: kWh} export, {key: covered_seconds}."""
    where, params = [], []
    if date_from:  # widen by a day each side; Stockholm-hour bucketing re-trims
        where.append("timestamp >= ?")
        params.append((datetime.fromisoformat(date_from) - timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"))
    if date_to:
        where.append("timestamp < ?")
        params.append((datetime.fromisoformat(date_to) + timedelta(days=2)).strftime("%Y-%m-%dT00:00:00"))
    sql = "SELECT timestamp, grid_w FROM readings"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY timestamp"
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = [(parse_utc(t), gw) for t, gw in con.execute(sql, params)]
    con.close()

    imp: dict[str, float] = defaultdict(float)
    exp: dict[str, float] = defaultdict(float)
    cov: dict[str, float] = defaultdict(float)
    for (t1, gw1), (t2, _gw2) in zip(rows, rows[1:]):
        dt_s = (t2 - t1).total_seconds()
        if gw1 is None or dt_s <= 0 or dt_s > max_gap_s:
            continue
        key = hour_key(t1.astimezone(STHLM))  # left-Riemann: whole interval booked to t1's hour
        cov[key] += dt_s
        kwh = abs(gw1) * dt_s / 3_600_000.0
        if gw1 < 0:
            imp[key] += kwh
        elif gw1 > 0:
            exp[key] += kwh
    return imp, exp, cov


def compare(name: str, ours: dict, meter: dict, cov: dict, args) -> None:
    hours = sorted(set(meter) & set(cov))
    if args.date_from:
        hours = [h for h in hours if h >= args.date_from]
    if args.date_to:
        hours = [h for h in hours if h[:10] <= args.date_to]
    usable = [h for h in hours if cov[h] >= args.min_coverage * 3600.0]
    if not usable:
        print(f"\n== {name}: no overlapping hours with sufficient readings coverage ==")
        return
    dropped = len(hours) - len(usable)
    by_month: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    by_day: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for h in usable:
        for agg, key in ((by_month, h[:7]), (by_day, h[:10])):
            agg[key][0] += ours.get(h, 0.0)
            agg[key][1] += meter[h]
    print(f"\n== {name} -- readings vs Ellevio meter "
          f"({len(usable)} hours compared, {dropped} dropped for poller coverage) ==")
    print(f"{'month':<10}{'readings':>10}{'ellevio':>10}{'delta':>9}{'delta%':>8}")
    for m in sorted(by_month):
        r, e = by_month[m]
        pct = 100.0 * (r - e) / e if e > 0.05 else float("nan")
        flag = "  <-- exceeds threshold" if abs(pct) > args.flag_pct else ""
        print(f"{m:<10}{r:>10.2f}{e:>10.2f}{r - e:>+9.2f}{pct:>8.1f}{flag}")
    worst = sorted(
        ((d, r, e, 100.0 * (r - e) / e) for d, (r, e) in by_day.items() if e >= 1.0),
        key=lambda x: -abs(x[3]),
    )[:5]
    if worst:
        print("worst days (>=1 kWh metered):")
        for d, r, e, pct in worst:
            print(f"  {d}  readings {r:.2f} vs ellevio {e:.2f} kWh ({pct:+.1f}%)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/opt/solinteg/telemetry.db")
    ap.add_argument("--ellevio-dir", default="solar-data/ellevio")
    ap.add_argument("--from", dest="date_from", default=None, help="Stockholm date, inclusive")
    ap.add_argument("--to", dest="date_to", default=None, help="Stockholm date, inclusive")
    ap.add_argument("--max-gap-s", type=int, default=600)
    ap.add_argument("--min-coverage", type=float, default=0.9)
    ap.add_argument("--flag-pct", type=float, default=5.0,
                    help="monthly |delta%%| above this is flagged — investigate before "
                         "trusting economics/oracle SEK at face value")
    args = ap.parse_args()

    meter_imp, meter_exp = load_ellevio(Path(args.ellevio_dir))
    if not meter_imp and not meter_exp:
        print(f"no Ellevio data found under {args.ellevio_dir}", file=sys.stderr)
        return 1
    ours_imp, ours_exp, cov = load_readings(args.db, args.date_from, args.date_to, args.max_gap_s)

    compare("IMPORT (koep)", ours_imp, meter_imp, cov, args)
    if meter_exp:
        compare("EXPORT (saelj)", ours_exp, meter_exp, cov, args)
    else:
        print("\n(no Production_*.json files — fetch export once with "
              "fetch-ellevio-history.py --direction Production to reconcile the sell side)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
