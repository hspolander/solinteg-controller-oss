#!/usr/bin/env python3
"""Cross-check the two independent house-load derivations against each other.

Reads ONLY existing `readings` rows — no Modbus traffic, no service change, no new registers.
All four columns it needs (pv_w, battery_w, grid_w, inverter_ac_w) are already polled and
stored by scripts/services/modbus_poller.py.

WHY THIS EXISTS
---------------
House load is not a register; it is derived. The poller uses:

    house_load = inverter_ac(11016) - meter(11000)                          … (A)

There is a second, independent identity over the same readings (confirmed against the
third-party Solinteg EMS BattCtrl reverse-engineering doc, 2026-08-02 revision, and consistent
with this repo's own documented sign conventions — see MODBUS.md):

    house_load = pv(11028) + battery(30258) - meter(11000)                  … (B)
    demand_after_pv = battery - meter        (= house_load - pv)

Both use +ve = export for the meter and +ve = discharging for the battery. (A) and (B) differ
only by inverter conversion losses, because inverter_ac ≈ pv + battery_discharge. So their
difference reduces to:

    d = pv_w + battery_w - inverter_ac_w

which makes the pair a cheap sanity oracle: two derivations of the same physical quantity that
must agree. A large or sign-flipped divergence means a bad reading, a register that has changed
meaning under a firmware update, or a flipped sign convention — NOT a real load event.

CALIBRATE AGAINST YOUR OWN INSTALL BEFORE TRUSTING THE DEFAULTS
---------------------------------------------------------------
The divergence is dominated by your inverter's conversion losses and your poll cadence, so the
thresholds below are starting points, not universal constants. Run this once over a few weeks of
your own readings and look at `mean|d|` and the longest run before deciding what "abnormal" is.

On the reference install (Solinteg MHT-20K-40, 10 s polling) the identity held to a mean|d| of
roughly 40-50 W, with isolated excursions into the kW range and a longest consecutive breach run
in the low single digits at the 500 W threshold. If your own mean|d| is an order of magnitude
larger than that, suspect a sign convention before suspecting the hardware.

DEFAULT_MIN_RUN exists because a *single* breach means nothing. Don't read the gap between your
observed max run and the trigger as the safety margin: a genuine changed-register or flipped-sign
fault is *persistent* and would show a run in the thousands. The run threshold only has to clear
sampling noise — if you see occasional runs just under the trigger, widen it rather than treating
the check as broken.

IMPORTANT — do not alert per-sample. In the same window 505 rows (0.23%) exceeded 1 kW, with
extremes near ±10 kW. Those are not errors: the poller reads the four registers in separate
Modbus transactions, so during a fast transient (a cloud edge, a load step, a mode change) the
values come from slightly different instants and legitimately fail to balance. At a 10 s poll
cadence that works out to roughly a dozen or two spurious excursions per day. This script therefore reports the DISTRIBUTION and a consecutive-run length, and only calls a
problem when a run of consecutive samples breaches the threshold — a real convention/register
change is persistent, sampling skew is not.

USAGE
-----
    # PASSWORDLESS routine check — print a single SELECT and hand it to the read-only wrapper
    # (scripts/services/telemetry-ro.sh; see deploy/README.md). Same numbers as the full run.
    python3 scripts/tools/check-flow-consistency.py --print-sql --days 30
    sudo solinteg-telemetry-ro sql "<the SELECT it printed>"

    # FULL run (adds the exit status and the plain-language verdict). telemetry.db is owned by
    # the solinteg user and is not readable by the login user, so this needs a password unless
    # you run it as that user. Prefer --print-sql when that matters.
    sudo -u solinteg python3 /opt/solinteg/app/scripts/tools/check-flow-consistency.py --days 30

    # or point it at a copy anywhere
    TELEMETRY_DB_PATH=./telemetry.db python3 scripts/tools/check-flow-consistency.py --days 7

Exit status: 0 = consistent, 1 = a sustained divergence worth investigating.
"""
from __future__ import annotations

import argparse
import sys

import common  # sibling module (scripts/tools/) — script dir is sys.path[0]

DEFAULT_DB = common.DEFAULT_DB

# Well clear of the ~50 W typical divergence measured above, and clear of the sampling-skew
# excursions that a single transient produces.
DEFAULT_THRESHOLD_W = 500
# A real register/convention change persists; sampling skew does not. 6 consecutive samples
# ≈ 1 minute of sustained imbalance at the current 10 s poll cadence — long enough that no
# single load step or cloud edge explains it.
DEFAULT_MIN_RUN = 6


def summary_sql(days: int, threshold: int) -> str:
    """A single self-contained SELECT giving the same numbers as a full run.

    Exists so the routine check can go through the passwordless `solinteg-telemetry-ro sql`
    wrapper, which allows exactly one read-only SELECT — no semicolons, and it must START with
    SELECT, which rules out a leading WITH/CTE. Hence the source rows are inlined as a subquery
    per aggregate rather than factored into a CTE; verbose, but it pastes as one statement.

    The longest-run figure uses the standard gaps-and-islands trick: across consecutive rows
    sharing a breach flag, (row_number over all) − (row_number within flag) is constant, so
    grouping on that difference counts each run.
    """
    src = (
        "(SELECT timestamp AS ts, (pv_w + battery_w - inverter_ac_w) AS v FROM readings"
        f" WHERE julianday(timestamp) >= julianday('now') - {days}"
        " AND pv_w IS NOT NULL AND battery_w IS NOT NULL AND inverter_ac_w IS NOT NULL)"
    )
    return (
        f"SELECT (SELECT COUNT(*) FROM {src}) AS rows_checked"
        f", (SELECT ROUND(AVG(v), 0) FROM {src}) AS mean_w"
        f", (SELECT ROUND(AVG(ABS(v)), 0) FROM {src}) AS mean_abs_w"
        f", (SELECT MAX(ABS(v)) FROM {src}) AS max_abs_w"
        f", (SELECT COUNT(*) FROM {src} WHERE ABS(v) > {threshold}) AS over_threshold"
        ", (SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM ("
        "SELECT ts, ROW_NUMBER() OVER (ORDER BY ts)"
        " - ROW_NUMBER() OVER (PARTITION BY breach ORDER BY ts) AS island, breach FROM ("
        f"SELECT ts, CASE WHEN ABS(v) > {threshold} THEN 1 ELSE 0 END AS breach FROM {src}"
        ")) WHERE breach = 1 GROUP BY island)) AS longest_run"
    )


def fetch(db: str, days: int) -> list[tuple[str, int]]:
    con = common.connect_ro(db)
    try:
        return con.execute(
            """
            SELECT timestamp, (pv_w + battery_w - inverter_ac_w) AS d
            FROM readings
            WHERE julianday(timestamp) >= julianday('now') - ?
              AND pv_w IS NOT NULL AND battery_w IS NOT NULL AND inverter_ac_w IS NOT NULL
            ORDER BY timestamp
            """,
            (days,),
        ).fetchall()
    finally:
        con.close()


def longest_run(rows: list[tuple[str, int]], threshold: int) -> tuple[int, str | None]:
    """Longest run of consecutive samples whose |d| exceeds threshold, and where it started."""
    best, best_at = 0, None
    run, run_at = 0, None
    for ts, d in rows:
        if abs(d) > threshold:
            if run == 0:
                run_at = ts
            run += 1
            if run > best:
                best, best_at = run, run_at
        else:
            run = 0
    return best, best_at


def pct(values: list[int], q: float) -> int:
    """Nearest-rank percentile (sqlite has none without extensions)."""
    if not values:
        return 0
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common.add_db_arg(ap)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--threshold-w", type=int, default=DEFAULT_THRESHOLD_W)
    ap.add_argument("--min-run", type=int, default=DEFAULT_MIN_RUN,
                    help="consecutive over-threshold samples before this is called a problem")
    ap.add_argument("--print-sql", action="store_true",
                    help="print a single SELECT for the passwordless solinteg-telemetry-ro wrapper "
                         "and exit, instead of opening the DB directly")
    args = ap.parse_args(argv[1:])

    if args.print_sql:
        print(summary_sql(args.days, args.threshold_w))
        return 0

    rows = fetch(args.db, args.days)
    if not rows:
        print(f"no readings rows in the last {args.days} days at {args.db} — nothing to check")
        return 0

    ds = [d for _, d in rows]
    abs_ds = [abs(d) for d in ds]
    over = sum(1 for d in abs_ds if d > args.threshold_w)
    run, run_at = longest_run(rows, args.threshold_w)

    print(f"house-load derivation cross-check — {len(rows)} rows over {args.days} days")
    print(f"  d = pv_w + battery_w - inverter_ac_w   (identity (A) minus identity (B))")
    print(f"  mean {sum(ds)/len(ds):+.0f} W   mean|d| {sum(abs_ds)/len(abs_ds):.0f} W"
          f"   p50 {pct(abs_ds, 0.50)} W   p99 {pct(abs_ds, 0.99)} W   max {max(abs_ds)} W")
    print(f"  |d| > {args.threshold_w} W: {over} rows ({100*over/len(rows):.2f}%)")
    print(f"  longest consecutive over-threshold run: {run} samples"
          + (f" starting {run_at}" if run_at else ""))

    if run >= args.min_run:
        print(f"\nPROBLEM: {run} consecutive samples over {args.threshold_w} W. Sampling skew "
              f"across non-atomic register reads does not persist like that — suspect a changed "
              f"register meaning or a flipped sign convention. Check MODBUS.md's sign table "
              f"against a live read before trusting house_load_w or any plan built on it.")
        return 1

    print("\nOK: no sustained divergence. Isolated excursions are expected (non-atomic reads "
          "across a transient) and are not errors.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
