#!/usr/bin/env python3
"""
Ranks rooms by how hard their underfloor-heating loop works relative to the others,
normalized for outdoor conditions — answers "does any room need a lot more heat than
the rest" from the Uponor poller's room_climate data (scripts/services/uponor_poller.py)
joined against the weather station's outdoor temperature.

Why normalize at all: a bigger or colder-facing room legitimately needs more heat even
when perfectly insulated, so raw valve-open time isn't a fair cross-room comparison.
What IS comparable is duty PER DEGREE of heating need, approximated here as
(setpoint − outdoor_temp): two rooms at the same setpoint, in the same outdoor cold spell,
"need" the same amount of heat if equally well insulated/sized. A room whose duty rises
faster than the others as it gets colder outside is losing heat faster than its
neighbors — worth checking for drafts, poor insulation, a missing door seal, etc.
Note this does NOT correct for room floor area (not available here) — a genuinely larger
room will rank as a heavier consumer even if equally well built; supply each room's m² to
get a true per-m² comparison instead of this room-to-room one.

This measures RELATIVE heat-loop effort (valve-open time / modulation duty), not an
isolated electrical watt figure — the heat pump and its water loop are shared across all
rooms, with no per-loop flow meter or wattage sensor, so there is no way to hand back "N
kWh went to the bedroom" from this data alone; that would need physical flow + delta-T
metering per loop, a real plumbing project, not a software one.

Per-room combined valve-open % is max(head1_valve_pct, head2_valve_pct) — a room's loop
may be split across two heads (larger rooms) or use only head1, in which case head2 reads
0 (not NULL), indistinguishable from "closed"; max() is the simplest number that's
correct whether a room has one head or two.

Usage: python scripts/tools/analyze-room-heat-demand.py [--db path] [--days 14]
Defaults to TELEMETRY_DB_PATH or /opt/solinteg/telemetry.db — run on the NUC (or against a
copy) since telemetry.db lives only there. Requires enough winter data with real heating
demand to say anything — reports "not enough active-heating samples yet" otherwise
(expected through at least autumn 2026, added mid-July when the whole system is idle).
"""
import argparse
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime

MIN_ACTIVE_SAMPLES = 20  # per room, with demand=1 or valve open — below this, ranking is noise


def connect_ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def nearest_outdoor_temps(con: sqlite3.Connection) -> list:
    """(timestamp, temp_c) from weather, sorted — for a nearest-neighbour join against
    room_climate's less-frequent (300 s vs 60 s) polls."""
    return con.execute(
        "SELECT timestamp, temp_c FROM weather WHERE temp_c IS NOT NULL ORDER BY timestamp"
    ).fetchall()


def nearest_temp(ts: str, outdoor: list, idx_hint: int) -> tuple:
    """Advances idx_hint forward through the sorted outdoor list — O(1) amortized since
    both series are read in timestamp order, not a binary search per row."""
    i = idx_hint
    n = len(outdoor)
    while i + 1 < n and outdoor[i + 1][0] <= ts:
        i += 1
    return (outdoor[i][1] if i < n else None), i


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db"))
    ap.add_argument("--days", type=int, default=90, help="lookback window (default 90 days)")
    args = ap.parse_args()

    con = connect_ro(args.db)
    rows = con.execute(
        "SELECT timestamp, thermostat, room_temp_c, setpoint_c, demand, "
        "head1_valve_pct, head2_valve_pct, pwm_output_pct, valve_error "
        "FROM room_climate WHERE timestamp >= datetime('now', ?) ORDER BY timestamp",
        (f"-{args.days} days",),
    ).fetchall()
    if not rows:
        print(f"No room_climate rows in the last {args.days} days — is solinteg-uponor running?")
        return 1

    outdoor = nearest_outdoor_temps(con)
    if not outdoor:
        print("No weather data available — can't normalize for outdoor conditions.")
        return 1

    per_room = defaultdict(list)
    idx = 0
    for ts, thermostat, room_temp_c, setpoint_c, demand, h1, h2, pwm, verr in rows:
        outdoor_c, idx = nearest_temp(ts, outdoor, idx)
        valve_pct = max(h1 or 0, h2 or 0)
        per_room[thermostat].append({
            "demand": demand, "valve_pct": valve_pct, "pwm": pwm or 0,
            "setpoint_c": setpoint_c, "room_temp_c": room_temp_c,
            "outdoor_c": outdoor_c, "valve_error": verr,
        })

    print(f"{len(rows)} rows, {len(per_room)} rooms, last {args.days} days "
          f"({rows[0][0][:10]} .. {rows[-1][0][:10]})\n")

    ranking = []
    any_errors = []
    for room, samples in per_room.items():
        if any(s["valve_error"] for s in samples):
            any_errors.append(room)
        active = [s for s in samples if s["outdoor_c"] is not None and s["setpoint_c"] is not None]
        # "Heating need" for a sample: how much colder outside than the room wants to be —
        # clamped at 0 so a mild/warm sample (no real call for heat expected) doesn't count
        # as negative need and distort the ratio.
        needy = [s for s in active if max(0.0, s["setpoint_c"] - s["outdoor_c"]) > 0.5]
        if len(needy) < MIN_ACTIVE_SAMPLES:
            ranking.append((room, None, len(needy), any(s["valve_error"] for s in samples)))
            continue
        mean_duty = sum(max(s["valve_pct"], s["pwm"]) for s in needy) / len(needy)
        mean_need = sum(max(0.0, s["setpoint_c"] - s["outdoor_c"]) for s in needy) / len(needy)
        mean_undershoot = sum(max(0.0, s["setpoint_c"] - s["room_temp_c"]) for s in needy
                               if s["room_temp_c"] is not None) / len(needy)
        duty_per_degree = mean_duty / mean_need if mean_need > 0 else None
        ranking.append((room, duty_per_degree, len(needy), any(s["valve_error"] for s in samples),
                         mean_duty, mean_need, mean_undershoot))

    scored = [r for r in ranking if r[1] is not None]
    unscored = [r for r in ranking if r[1] is None]

    # Valve-error flag is worth surfacing regardless of how much duty-cycle data exists for
    # that room, so check it before the "not enough data" early-return, not only inside it.
    if any_errors:
        print(f"Valve-error flag seen on: {', '.join(any_errors)} — worth checking regardless "
              f"of duty-cycle data volume.\n")

    if not scored:
        print(f"Not enough active-heating samples yet (need >= {MIN_ACTIVE_SAMPLES}/room with a "
              f"real setpoint-vs-outdoor gap) — expected through at least autumn 2026. "
              f"{len(unscored)} room(s) seen, all with too little heating-demand data so far.")
        return 0

    scored.sort(key=lambda r: r[1], reverse=True)
    print(f"{'Room':10s} {'Duty/°C need':>13s} {'MeanDuty%':>10s} {'MeanNeed°C':>11s} "
          f"{'Undershoot°C':>13s} {'Samples':>8s}")
    for room, dpd, n, verr, duty, need, undershoot in scored:
        flag = "  VALVE ERROR" if verr else ""
        print(f"{room:10s} {dpd:13.2f} {duty:10.1f} {need:11.1f} {undershoot:13.1f} {n:8d}{flag}")

    if len(scored) >= 2:
        worst, best = scored[0], scored[-1]
        if best[1] > 0:
            print(f"\n{worst[0]} works {worst[1] / best[1]:.1f}x harder per degree of heating need "
                  f"than {best[0]} — the largest gap in this window.")
    print("\nNot corrected for room floor area — a larger room ranks as a heavier consumer even "
          "if equally well insulated; supply room m² for a true per-m² comparison.")
    if unscored:
        print(f"{len(unscored)} room(s) skipped (too few active-heating samples): "
              f"{', '.join(r[0] for r in unscored)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
