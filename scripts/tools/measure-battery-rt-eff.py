#!/usr/bin/env python3
"""
Measure the battery's realized round-trip efficiency from telemetry readings and compare it
to the BATTERY_RT_EFF constant (0.96, datasheet) that BOTH the optimizer and the hindsight
oracle assume.

Why this exists: the oracle scores the controller with the DP's own physics, so an efficiency
constant that diverges from the real pack biases regret in a way the oracle cannot see from
inside (a too-optimistic eta inflates the hindsight benchmark -> phantom regret attributed to
execution; see lib/oracle.ts's "materially NEGATIVE regret is a diagnostic" note for the
mirror-image failure). This script is a measurement against that assumption: it needs nothing
but the poller's battery_w/soc_kwh series, so it is independent of the DP, the plans, and the
oracle code.

Method, per window of --window-days (default 7) and for the whole range:
  E_in  = integral of charge power    (battery_w < 0; sign convention: -charge/+discharge)
  E_out = integral of discharge power (battery_w > 0)
  dSoC  = soc_kwh at window end - at window start (endpoints = nearest non-null reading)
Energy balance with one unknown x = sqrt(eta_rt), same split-leg model the DP uses
(charging stores x kWh per terminal kWh, discharging yields x kWh per stored kWh):
  E_in * x - E_out / x = dSoC   ->   E_in * x^2 - dSoC * x - E_out = 0
  x = (dSoC + sqrt(dSoC^2 + 4 * E_in * E_out)) / (2 * E_in)      (positive root)
  eta_rt = x^2

Caveats (read before acting on a number):
- Standby/BMS drain while idle is attributed to cycling loss here, so the measured eta_rt is
  a slight UNDERestimate of pure cycling efficiency; windows with lots of cycling (winter
  arbitrage) are more trustworthy than idle summer weeks — hence the --min-cycle-kwh floor.
- soc_kwh is quantized (derived from soc_pct); noise shrinks as windows grow.
- If measured eta_rt sits stably more than ~2-3 points from BATTERY_RT_EFF across
  well-cycled windows, update the constant (lib/constants.ts, SOLINTEG_BATTERY_RT_EFF env)
  — that corrects the planner and the oracle's benchmark in the same move. Cross-check
  against oracle_daily's diagnostics.balance / params.pvDerate first: the oracle's
  energy-balance correction (2026-07-13) already absorbs part of any model-vs-reality gap,
  and the two numbers should tell one consistent story.

Usage (on the NUC, or against a pulled copy of telemetry.db):
  python3 scripts/tools/measure-battery-rt-eff.py [--db /opt/solinteg/telemetry.db]
      [--from 2026-07-01] [--to 2026-07-31] [--window-days 7]
      [--max-gap-s 600] [--min-cycle-kwh 2.0]
"""
import argparse
import math
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

ASSUMED_RT_EFF = 0.96  # keep in sync with lib/constants.ts BATTERY_RT_EFF default


def parse_ts(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def solve_rt_eff(e_in: float, e_out: float, d_soc: float) -> float | None:
    """Positive root of E_in*x^2 - dSoC*x - E_out = 0; eta_rt = x^2. None if degenerate."""
    if e_in <= 0:
        return None
    disc = d_soc * d_soc + 4.0 * e_in * e_out
    x = (d_soc + math.sqrt(disc)) / (2.0 * e_in)
    if x <= 0:
        return None
    return x * x


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/opt/solinteg/telemetry.db")
    ap.add_argument("--from", dest="date_from", default=None, help="UTC date, inclusive")
    ap.add_argument("--to", dest="date_to", default=None, help="UTC date, inclusive")
    ap.add_argument("--window-days", type=int, default=7)
    ap.add_argument("--max-gap-s", type=int, default=600,
                    help="ignore integration across reading gaps longer than this")
    ap.add_argument("--min-cycle-kwh", type=float, default=2.0,
                    help="windows with less charge OR discharge energy than this are reported "
                         "but not solved — too little cycling for the SoC noise floor")
    args = ap.parse_args()

    where, params = [], []
    if args.date_from:
        where.append("timestamp >= ?")
        params.append(f"{args.date_from}T00:00:00")
    if args.date_to:
        where.append("timestamp < ?")
        params.append((datetime.fromisoformat(args.date_to) + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"))
    sql = "SELECT timestamp, battery_w, soc_kwh FROM readings"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY timestamp"

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    rows = [(parse_ts(t), bw, soc) for t, bw, soc in con.execute(sql, params)]
    con.close()
    if len(rows) < 2:
        print("not enough readings in range", file=sys.stderr)
        return 1

    start = rows[0][0]
    win_len = timedelta(days=args.window_days)

    def window_index(ts: datetime) -> int:
        return int((ts - start) // win_len)

    # Per-window accumulators: [e_in, e_out, first_soc, last_soc, covered_s]
    windows: dict[int, list] = {}
    for (t1, bw1, soc1), (t2, _bw2, _soc2) in zip(rows, rows[1:]):
        dt_s = (t2 - t1).total_seconds()
        w = windows.setdefault(window_index(t1), [0.0, 0.0, None, None, 0.0])
        if soc1 is not None:
            if w[2] is None:
                w[2] = soc1
            w[3] = soc1
        if bw1 is None or dt_s <= 0 or dt_s > args.max_gap_s:
            continue
        kwh = abs(bw1) * dt_s / 3_600_000.0
        if bw1 < 0:
            w[0] += kwh
        elif bw1 > 0:
            w[1] += kwh
        w[4] += dt_s
    # Last row's SoC closes its window's endpoint.
    t_last, _, soc_last = rows[-1]
    if soc_last is not None:
        w = windows.setdefault(window_index(t_last), [0.0, 0.0, None, None, 0.0])
        if w[2] is None:
            w[2] = soc_last
        w[3] = soc_last

    print(f"readings: {len(rows)}  range: {rows[0][0]:%Y-%m-%d %H:%M} .. {t_last:%Y-%m-%d %H:%M} UTC")
    print(f"{'window':<24}{'E_in':>8}{'E_out':>8}{'dSoC':>8}{'cov%':>6}{'eta_rt':>8}")
    tot_in = tot_out = 0.0
    solved: list[tuple[float, float]] = []  # (eta, weight = min(E_in, E_out))
    for idx in sorted(windows):
        e_in, e_out, soc_a, soc_b, cov_s = windows[idx]
        w_start = start + idx * win_len
        label = f"{w_start:%Y-%m-%d} +{args.window_days}d"
        cov = 100.0 * cov_s / win_len.total_seconds()
        tot_in += e_in
        tot_out += e_out
        if soc_a is None or soc_b is None or min(e_in, e_out) < args.min_cycle_kwh:
            print(f"{label:<24}{e_in:>8.2f}{e_out:>8.2f}{'n/a':>8}{cov:>6.0f}{'(skip)':>8}")
            continue
        eta = solve_rt_eff(e_in, e_out, soc_b - soc_a)
        if eta is None or not (0.5 < eta < 1.1):
            print(f"{label:<24}{e_in:>8.2f}{e_out:>8.2f}{soc_b - soc_a:>8.2f}{cov:>6.0f}{'(degen)':>8}")
            continue
        solved.append((eta, min(e_in, e_out)))
        print(f"{label:<24}{e_in:>8.2f}{e_out:>8.2f}{soc_b - soc_a:>8.2f}{cov:>6.0f}{eta:>8.3f}")

    # Whole-range solve: endpoints from the first/last non-null SoC anywhere in range.
    soc_first = next((soc for _, _, soc in rows if soc is not None), None)
    soc_final = next((soc for _, _, soc in reversed(rows) if soc is not None), None)
    print()
    if soc_first is not None and soc_final is not None and min(tot_in, tot_out) >= args.min_cycle_kwh:
        eta_all = solve_rt_eff(tot_in, tot_out, soc_final - soc_first)
        if eta_all:
            delta_pts = 100.0 * (eta_all - ASSUMED_RT_EFF)
            print(f"whole range: E_in {tot_in:.2f} kWh, E_out {tot_out:.2f} kWh, "
                  f"dSoC {soc_final - soc_first:+.2f} kWh -> eta_rt = {eta_all:.3f}")
            print(f"assumed BATTERY_RT_EFF = {ASSUMED_RT_EFF:.3f}  (measured - assumed = {delta_pts:+.1f} points)")
            if abs(delta_pts) > 3.0 and min(tot_in, tot_out) >= 20.0:
                print("=> stable gap > 3 points on real cycling: consider updating BATTERY_RT_EFF "
                      "(lib/constants.ts / SOLINTEG_BATTERY_RT_EFF) -- fixes planner AND oracle together. "
                      "Cross-check oracle_daily diagnostics first (see docstring).")
            elif abs(delta_pts) > 3.0:
                print("=> gap > 3 points but little total cycling -- wait for more charge/discharge "
                      "throughput before acting (see --min-cycle-kwh caveat).")
            else:
                print("=> within noise of the assumed constant; no action.")
    else:
        print("whole range: insufficient cycling or missing SoC endpoints — nothing to conclude yet.")
    if solved:
        wsum = sum(w for _, w in solved)
        wavg = sum(e * w for e, w in solved) / wsum
        print(f"cycling-weighted mean of {len(solved)} solved windows: eta_rt = {wavg:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
