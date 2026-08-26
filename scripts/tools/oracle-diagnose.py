#!/usr/bin/env python3
"""
Oracle regret DIAGNOSIS — the "why" layer under the hindsight oracle's "how much".

Why this exists: `oracle_daily` answers how much money the pipeline left on the table, and the
intraday/carry split has answered "intraday" every day since carry was solved in July — so a
review that wants to know *where* the gap comes from has had to re-derive the same handful of
analyses from the raw tables every time. That happened at the 2026-07-27 review and again on
2026-08-24, and both times the analysis was thrown away afterwards, so each review restarted
from zero and the previous review's NULL results (the most reusable part) survived only as prose.
This script is that analysis, committed: one command, output directly comparable to the baselines
printed inline below.

It reports four things:

  1. CAPTURE RATIO — regret as a share of the perfect-foresight prize, pooled over the window.
     Regret in kr/day is confounded by price level (corr +0.35 with the day's buy spread over
     2026-07-20..08-22; the high-spread third averaged 1.93 kr against 0.84 kr for the low
     third), so it cannot show whether dispatch got BETTER between two periods with different
     prices. The pooled share can: it decorrelated to −0.15 on the same window. Pooled, not a
     mean of per-day ratios — days with almost nothing to win send the ratio to noise (per-day
     cv 1.04 vs 0.69 for kr/day). The prize is day-D-only
     (`oracle_day_cash − oracle_day_wear − baseline_net`), so both a total-regret and a
     scope-matched intraday-only percentage are printed; they differ by ~1.4 points because
     total regret also carries the cost of the SoC handed to D+1.
  2. HOUR-OF-DAY CASH — the oracle's day-D grid cash minus what actually happened, by Stockholm
     hour. This is what shows the shape of the gap (which hours it lives in) rather than its size.
  3. HOUR-OF-DAY SoC — oracle trajectory minus measured trajectory, same buckets. Says whether
     the oracle was holding or spending relative to reality when it earned the difference.
  4. CORRELATIONS — intraday regret against the candidate explanations, so a hypothesis gets
     falsified in one run instead of over an afternoon. The 2026-08-24 baseline killed four:
     battery saturation, day-ahead solar error, load error, and (weakly) start SoC. Print your
     own numbers next to those before believing a new story about the same data.

Method / caveats (read before acting on a number):
- Only `status='ok'` rows are used; shadow/degraded/skipped days are context, never headline
  (a shadow/degraded day was not being dispatched, or its data is too thin to trust). Days
  whose perfect-foresight prize is under --min-prize are dropped from
  the capture ratio and correlations — a 3 kr prize divides into a meaningless percentage.
- Actual energy is integrated at reading cadence with a MAX_GAP_S guard, so poller downtime is
  skipped rather than counted as a flat line. The oracle side comes from the stored
  `oracle_dispatch_json`, i.e. the trajectory that was actually scored, not a re-run.
- Slots are joined on UTC 15-min buckets (naive-local `startTime` converted with zoneinfo,
  fold=0) and only LABELLED by Stockholm hour — keying the join on local time would collide two
  real hours into one bucket on the October DST day.
- SoC comparison puts the oracle's mid-slot SoC against the slot's mean measured SoC. The
  half-slot offset is a few tenths of a kWh at most, immaterial against the 1-3 kWh differences
  this surfaces, but it is why small values here are not signal.
- Cash uses each slot's settled buy/sell from `optimizer_runs.inputs_json` (last run of that
  price_date). Rows written before 2026-07-18 predate the grid-flow attribution fields in
  DispatchSlot; those fall back to net `gridKwh`, which cannot split a slot that both imported
  and exported. The oracle's own plans are one-directional per slot in practice.
- Correlation on ~30 days is weak evidence for a WEAK correlation and reasonable evidence
  against a strong one. Treat |r| < 0.4 here as "this is not the explanation", not as a
  measurement of a real small effect.

Usage (on the host, or against a pulled copy of telemetry.db — if the deployment directory is
not readable by your login, dump the columns these queries select and rebuild a local copy
rather than loosening permissions on the live database):
  python3 scripts/tools/oracle-diagnose.py [--db PATH] [--from 2026-07-20] [--to 2026-08-22]
      [--min-prize 50] [--battery-kwh 25.6] [--min-days 14]
"""
import argparse
import json
import math
import os
import sqlite3
import statistics as st
import sys
from collections import defaultdict
from datetime import datetime

import common  # sibling module (scripts/tools/) — script dir is sys.path[0]

STOCKHOLM = common.STOCKHOLM
UTC = common.UTC
SLOT_MIN = 15
MAX_GAP_S = 120  # readings further apart than this bracket a poller gap — don't integrate it
FULL_SOC_FRAC = 0.95  # "battery is full" threshold for the saturation hypothesis
DEFAULT_BATTERY_KWH = 25.6  # only for the threshold above; mirrors lib/constants.ts's default

# Baselines from the 2026-08-24 review (34 clean days, 2026-07-20..08-22). Printed next to every
# run so a later review compares instead of re-deriving. Update these when a review supersedes
# them — a stale baseline is worse than none, because it invites a false comparison. These are
# the reference deployment's own numbers; replace them with yours once you have a few weeks.
BASELINE = {
    "days": 34,
    "captured_pct": 91.6,        # on TOTAL regret; 93.0% on intraday alone (see the note below)
    "captured_intraday_pct": 93.0,
    "regret_kr_mean": 1.76,
    "corr": {
        "hours at >=95% SoC": -0.08,
        "|day-ahead solar err| kWh": +0.02,
        "|day-ahead load err| kWh": -0.12,
        "buy spread (öre)": +0.35,
        "start SoC kWh": +0.33,
    },
}


def parse_ts(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def local_to_utc(start_time: str) -> datetime:
    """inputs_json / dispatch_json startTime is naive Stockholm local (deploy/schema.sql)."""
    return datetime.fromisoformat(start_time).replace(tzinfo=STOCKHOLM).astimezone(UTC)


def slot_key(dt_utc: datetime) -> str:
    return dt_utc.strftime("%Y-%m-%dT%H:") + f"{(dt_utc.minute // SLOT_MIN) * SLOT_MIN:02d}"


def corr(xs, ys):
    if len(xs) < 3:
        return float("nan")
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return num / den if den else float("nan")


def date_filter(date_from, date_to, column):
    where, params = [], []
    if date_from:
        where.append(f"{column} >= ?")
        params.append(date_from)
    if date_to:
        where.append(f"{column} <= ?")
        params.append(date_to)
    return (" WHERE " + " AND ".join(where) if where else ""), params


def load_runs(con, date_from, date_to):
    """Settled prices per UTC slot, and the first (day-ahead) plan of each price_date.

    Prices come from the LAST run of a price_date (the curve as finally settled); the day-ahead
    forecast comes from the FIRST, which is the plan the day actually started on.
    """
    where_sql, params = date_filter(date_from, date_to, "price_date")
    prices, first = {}, {}
    for pd, ij in con.execute(
        f"SELECT price_date, inputs_json FROM optimizer_runs{where_sql} ORDER BY logged_at",
        params,
    ):
        try:
            slots = json.loads(ij)
        except json.JSONDecodeError:
            continue
        first.setdefault(pd, slots)
        for s in slots:
            prices[slot_key(local_to_utc(s["startTime"]))] = (s["buyPrice"], s["sellPrice"])
    return prices, first


def load_actuals(con, ts_from, full_soc_kwh):
    """Per-slot measured energy and SoC, integrated at reading cadence.

    Power is attributed to the slot of the EARLIER reading of each pair and weighted by the real
    gap, so a 10 s and a 20 s poll interval integrate identically (economics.ts does the same).
    """
    out = defaultdict(lambda: {"imp": 0.0, "exp": 0.0, "pv": 0.0, "load": 0.0,
                               "soc_sum": 0.0, "soc_n": 0, "full_s": 0.0, "n": 0})
    prev = None
    for ts, pv, hl, soc, grid in con.execute(
        "SELECT timestamp, pv_w, house_load_w, soc_kwh, grid_w FROM readings "
        "WHERE timestamp >= ? ORDER BY timestamp",
        (ts_from,),
    ):
        t = parse_ts(ts)
        if prev is not None:
            pt, ppv, phl, psoc, pgrid = prev
            dt = (t - pt).total_seconds()
            if 0 < dt <= MAX_GAP_S:
                b = out[slot_key(pt)]
                if pgrid is not None:
                    b["imp"] += max(0.0, -pgrid) * dt / 3_600_000
                    b["exp"] += max(0.0, pgrid) * dt / 3_600_000
                if ppv is not None:
                    b["pv"] += max(0.0, ppv) * dt / 3_600_000
                if phl is not None:
                    b["load"] += max(0.0, phl) * dt / 3_600_000
                if psoc is not None and psoc >= FULL_SOC_FRAC * full_soc_kwh:
                    b["full_s"] += dt
        b = out[slot_key(t)]
        b["n"] += 1
        if soc is not None:
            b["soc_sum"] += soc
            b["soc_n"] += 1
        prev = (t, pv, hl, soc, grid)
    return out


def oracle_flows(slot):
    """Gross (import, export) kWh for one stored oracle dispatch slot."""
    if "batteryToGridKwh" in slot:
        return (slot["gridToBatteryKwh"] + slot["loadFromGridKwh"],
                slot["batteryToGridKwh"] + slot["solarExportKwh"])
    g = slot["gridKwh"]  # pre-2026-07-18 rows stored only the net exchange
    return max(0.0, g), max(0.0, -g)


def main() -> int:
    ap = argparse.ArgumentParser()
    common.add_db_arg(ap)
    ap.add_argument("--from", dest="from_date", default=None, help="first oracle_daily date")
    ap.add_argument("--to", dest="to_date", default=None, help="last date, inclusive")
    ap.add_argument("--min-prize", type=float, default=50.0,
                    help="drop days whose perfect-foresight prize is under this many öre (default 50)")
    ap.add_argument("--battery-kwh", type=float, default=None,
                    help=f"capacity for the 'battery full' threshold "
                         f"(default $SOLINTEG_BATTERY_KWH, else {DEFAULT_BATTERY_KWH})")
    ap.add_argument("--min-days", type=int, default=14, help="minimum usable days before reporting")
    args = ap.parse_args()
    battery_kwh = args.battery_kwh or float(
        os.environ.get("SOLINTEG_BATTERY_KWH", DEFAULT_BATTERY_KWH))

    con = common.connect_ro(args.db)
    con.row_factory = sqlite3.Row

    where_sql, params = date_filter(args.from_date, args.to_date, "date")
    joiner = " AND " if where_sql else " WHERE "
    rows = con.execute(
        "SELECT date, regret_ore, regret_intraday_ore, oracle_day_cash_ore, oracle_day_wear_ore, "
        "baseline_net_ore, start_soc_kwh, oracle_dispatch_json FROM oracle_daily"
        f"{where_sql}{joiner}status = 'ok' ORDER BY date",
        params,
    ).fetchall()
    if not rows:
        print("No status='ok' oracle_daily rows in range — nothing to diagnose.")
        return 1

    # A day is usable only if it had something to win; otherwise the ratio is noise.
    kept, dropped = [], 0
    for d in rows:
        prize = ((d["oracle_day_cash_ore"] or 0) - (d["oracle_day_wear_ore"] or 0)
                 - (d["baseline_net_ore"] or 0))
        if prize >= args.min_prize and d["regret_ore"] is not None:
            kept.append((d, prize))
        else:
            dropped += 1
    if len(kept) < args.min_days:
        print(f"Only {len(kept)} usable day(s) (< --min-days {args.min_days}) — "
              "too few for a stable read.")
        return 1

    lo = kept[0][0]["date"]
    prices, day_ahead = load_runs(con, lo, args.to_date)
    actual = load_actuals(con, lo, battery_kwh)

    # ── 1. capture ratio ─────────────────────────────────────────────────────────────────────
    sum_regret = sum(d["regret_ore"] for d, _ in kept)
    sum_intraday = sum(d["regret_intraday_ore"] or 0 for d, _ in kept)
    sum_prize = sum(p for _, p in kept)
    print(f"Oracle diagnosis over {len(kept)} ok days "
          f"({kept[0][0]['date']}..{kept[-1][0]['date']})"
          + (f", {dropped} dropped as prize < {args.min_prize:.0f} öre" if dropped else ""))
    print("\n1. CAPTURE RATIO (pooled — the only form of this number that trends across seasons)")
    print(f"   perfect-foresight prize {sum_prize/100:8.1f} kr    regret {sum_regret/100:6.1f} kr"
          f"  (intraday {sum_intraday/100:.1f})")
    print(f"   captured {100*(1-sum_regret/sum_prize):.1f}% of what was winnable "
          f"(missed {100*sum_regret/sum_prize:.1f}%)"
          f"   [2026-08-24 baseline: {BASELINE['captured_pct']:.1f}% over {BASELINE['days']} days]")
    # The denominator is day-D-only; total regret also carries the cost of handing D+1 the wrong
    # SoC, so the line above slightly overstates the miss. The scope-matched version below is the
    # one to quote when comparing against a day-D quantity — track whichever you pick, but say
    # which, because the two differ by ~1.4 points and are easy to cite interchangeably.
    print(f"   scope-matched (intraday regret vs day-D prize): captured "
          f"{100*(1-sum_intraday/sum_prize):.1f}%"
          f"   [baseline {BASELINE['captured_intraday_pct']:.1f}%]")
    regrets = [d["regret_ore"] / 100 for d, _ in kept]
    print(f"   regret kr/day: mean {st.mean(regrets):.2f}  median {st.median(regrets):.2f}"
          f"  [baseline mean {BASELINE['regret_kr_mean']:.2f}]")

    # ── 2 & 3. hour-of-day cash and SoC ──────────────────────────────────────────────────────
    cash = defaultdict(lambda: [0.0, 0.0])  # local hour -> [oracle kr, actual kr]
    socd = defaultdict(lambda: [0.0, 0])    # local hour -> [sum(oracle - actual) kWh, n]
    for d, _ in kept:
        if not d["oracle_dispatch_json"]:
            continue
        try:
            slots = json.loads(d["oracle_dispatch_json"])
        except json.JSONDecodeError:
            continue
        prev_soc = d["start_soc_kwh"]
        for s in slots:
            key = slot_key(local_to_utc(s["startTime"]))
            mid_oracle = None if prev_soc is None else (prev_soc + s["socAfter"]) / 2
            prev_soc = s["socAfter"]
            pr, a = prices.get(key), actual.get(key)
            if pr is None or a is None:
                continue
            buy, sell = pr
            hour = int(s["startTime"][11:13])
            o_imp, o_exp = oracle_flows(s)
            c = cash[hour]
            c[0] += (o_exp * sell - o_imp * buy) / 100
            c[1] += (a["exp"] * sell - a["imp"] * buy) / 100
            if mid_oracle is not None and a["soc_n"]:
                sd = socd[hour]
                sd[0] += mid_oracle - a["soc_sum"] / a["soc_n"]
                sd[1] += 1

    n = len(kept)
    print("\n2. HOUR-OF-DAY day-D grid cash, mean kr/day (oracle - actual: where the gap lives)")
    print(f"   {'hour':6}{'oracle':>9}{'actual':>9}{'delta':>9}")
    tot = [0.0, 0.0]
    for h in sorted(cash):
        o, a = cash[h][0] / n, cash[h][1] / n
        tot[0] += o
        tot[1] += a
        print(f"   {h:02d}:00{o:9.2f}{a:9.2f}{o-a:+9.2f}  {'#' * min(28, int(abs(o-a) * 40))}")
    print(f"   TOTAL{tot[0]:9.2f}{tot[1]:9.2f}{tot[0]-tot[1]:+9.2f}"
          "   (the carry credit repays part of this — see regret_carry_ore)")

    print("\n3. HOUR-OF-DAY SoC, mean kWh (oracle - actual: + = oracle held more, - = spent more)")
    for h in sorted(socd):
        if not socd[h][1]:
            continue
        v = socd[h][0] / socd[h][1]
        print(f"   {h:02d}:00  {v:+6.2f}  {('+' if v >= 0 else '-') * min(30, int(abs(v) * 6))}")

    # ── 4. correlations ──────────────────────────────────────────────────────────────────────
    names = ["hours at >=95% SoC", "|day-ahead solar err| kWh", "|day-ahead load err| kWh",
             "buy spread (öre)", "midday export kWh (11-17h)", "start SoC kWh"]
    feats = {k: [] for k in names}
    y = []
    for d, _ in kept:
        date = d["date"]
        if d["regret_intraday_ore"] is None:
            continue
        # The day's own slots, taken from the price feed's own local date labelling — that is
        # what makes this DST-safe (92 or 100 slots on a transition day, not an assumed 96).
        d_slots = [s for s in day_ahead.get(date, []) if s["startTime"].startswith(date)]
        f_solar = f_load = a_solar = a_load = full_h = mid_exp = 0.0
        buys = []
        for s in d_slots:
            a = actual.get(slot_key(local_to_utc(s["startTime"])))
            if a is None or a["n"] < 10:
                continue
            f_solar += s["solarKwh"]
            f_load += s.get("consumptionKwh", 0.0)
            a_solar += a["pv"]
            a_load += a["load"]
            full_h += a["full_s"] / 3600
            if 11 <= int(s["startTime"][11:13]) < 17:
                mid_exp += a["exp"]
            buys.append(s["buyPrice"])
        if not buys:
            continue
        y.append(d["regret_intraday_ore"] / 100)
        feats["hours at >=95% SoC"].append(full_h)
        feats["|day-ahead solar err| kWh"].append(abs(f_solar - a_solar))
        feats["|day-ahead load err| kWh"].append(abs(f_load - a_load))
        feats["buy spread (öre)"].append(max(buys) - min(buys))
        feats["midday export kWh (11-17h)"].append(mid_exp)
        feats["start SoC kWh"].append(d["start_soc_kwh"] or 0.0)

    print(f"\n4. WHAT EXPLAINS INTRADAY REGRET? (n={len(y)} days; |r| < 0.4 here means "
          '"not the explanation")')
    for name in names:
        r = corr(feats[name], y)
        b = BASELINE["corr"].get(name)
        print(f"   corr(regret, {name:28}) = {r:+.2f}"
              + (f"   [08-24: {b:+.2f}]" if b is not None else ""))
    print("\n   2026-08-24 verdict, for comparison: no lever found. Saturation, solar error and")
    print("   load error were all falsified; only price spread predicted regret, i.e. relative")
    print("   dispatch efficiency was roughly constant and regret scaled with opportunity.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
