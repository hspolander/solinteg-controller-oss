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
Room names + floor areas (optional — scripts/tools/room-config.json, {thermostat_id:
{"name", "area_m2"}}) let the report show real names instead of raw IDs and add a per-m²
normalized column. That per-m² normalization assumes each room's loop was DESIGNED with
roughly similar heating capacity per m² (a common but unverified installer assumption,
not something derivable from this data) — the un-normalized "Duty/°C need" column below
does NOT depend on that assumption at all (it compares a loop against its OWN behavior at
different outdoor temps, not against other rooms' size), so treat it as the primary
signal and the per-m² column as a secondary, assumption-dependent view. Without a room
config file at all, room floor area is simply unknown — a genuinely larger room will still
rank as a heavier consumer on the primary metric even if equally well built.

This measures RELATIVE heat-loop effort (valve-open time / modulation duty), not an
isolated electrical watt figure — the heat pump and its water loop are shared across all
rooms, with no per-loop flow meter or wattage sensor, so there is no way to hand back "N
kWh went to the bedroom" from this data alone; that would need physical flow + delta-T
metering per loop, a real plumbing project, not a software one.

Per-room combined valve-open % is max(head1_valve_pct, head2_valve_pct) — a room's loop
may be split across two heads (larger rooms) or use only head1, in which case head2 reads
0 (not NULL), indistinguishable from "closed"; max() is the simplest number that's
correct whether a room has one head or two.

Usage: python scripts/tools/analyze-room-heat-demand.py [--db path] [--days 14] [--room-config path]
Defaults to TELEMETRY_DB_PATH or /opt/solinteg/telemetry.db — run on the NUC (or against a
copy) since telemetry.db lives only there. Requires enough winter data with real heating
demand to say anything — reports "not enough active-heating samples yet" otherwise
(expected through at least autumn 2026, added mid-July when the whole system is idle).
"""
import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

MIN_ACTIVE_SAMPLES = 20  # per room, with demand=1 or valve open — below this, ranking is noise
DEFAULT_ROOM_CONFIG = Path(__file__).with_name("room-config.json")


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


def load_room_config(path) -> dict:
    """{thermostat_id: {"name": str, "area_m2": float}} — entirely optional; every caller
    below degrades to the raw thermostat ID when a room (or the file) isn't present."""
    if not path or not Path(path).exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        print(f"Warning: couldn't read room config {path}: {exc} — continuing without it.")
        return {}


def label(room: str, room_config: dict) -> str:
    name = room_config.get(room, {}).get("name")
    return f"{name} ({room})" if name else room


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db"))
    ap.add_argument("--days", type=int, default=90, help="lookback window (default 90 days)")
    ap.add_argument("--room-config", default=str(DEFAULT_ROOM_CONFIG),
                     help="JSON {thermostat_id: {name, area_m2}} — optional, adds names and a "
                          "per-m² column; defaults to room-config.json next to this script")
    args = ap.parse_args()
    room_config = load_room_config(args.room_config)

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
        area_m2 = room_config.get(room, {}).get("area_m2")
        verr = any(s["valve_error"] for s in samples)
        if verr:
            any_errors.append(label(room, room_config))
        active = [s for s in samples if s["outdoor_c"] is not None and s["setpoint_c"] is not None]
        # "Heating need" for a sample: how much colder outside than the room wants to be —
        # clamped at 0 so a mild/warm sample (no real call for heat expected) doesn't count
        # as negative need and distort the ratio.
        needy = [s for s in active if max(0.0, s["setpoint_c"] - s["outdoor_c"]) > 0.5]
        row = {"room": room, "label": label(room, room_config), "area_m2": area_m2,
               "samples": len(needy), "valve_error": verr, "duty_per_degree": None}
        if len(needy) >= MIN_ACTIVE_SAMPLES:
            mean_duty = sum(max(s["valve_pct"], s["pwm"]) for s in needy) / len(needy)
            mean_need = sum(max(0.0, s["setpoint_c"] - s["outdoor_c"]) for s in needy) / len(needy)
            mean_undershoot = sum(max(0.0, s["setpoint_c"] - s["room_temp_c"]) for s in needy
                                   if s["room_temp_c"] is not None) / len(needy)
            duty_per_degree = mean_duty / mean_need if mean_need > 0 else None
            row.update(mean_duty=mean_duty, mean_need=mean_need, mean_undershoot=mean_undershoot,
                       duty_per_degree=duty_per_degree,
                       duty_per_degree_per_m2=duty_per_degree / area_m2
                       if duty_per_degree is not None and area_m2 else None)
        ranking.append(row)

    scored = [r for r in ranking if r["duty_per_degree"] is not None]
    unscored = [r for r in ranking if r["duty_per_degree"] is None]

    # Valve-error flag is worth surfacing regardless of how much duty-cycle data exists for
    # that room, so check it before the "not enough data" early-return, not only inside it.
    if any_errors:
        print(f"Valve-error flag seen on: {', '.join(any_errors)} — worth checking regardless "
              f"of duty-cycle data volume.\n")

    if not scored:
        print(f"Not enough active-heating samples yet (need >= {MIN_ACTIVE_SAMPLES}/room with a "
              f"real setpoint-vs-outdoor gap) — expected through at least autumn 2026. "
              f"{len(unscored)} room(s) seen, all with too little heating-demand data so far: "
              f"{', '.join(r['label'] for r in unscored)}")
        return 0

    scored.sort(key=lambda r: r["duty_per_degree"], reverse=True)
    has_any_area = any(r["area_m2"] for r in scored)
    header = f"{'Room':28s} {'Duty/°C need':>13s} {'MeanDuty%':>10s} {'MeanNeed°C':>11s} {'Undershoot°C':>13s} {'Samples':>8s}"
    if has_any_area:
        header += f" {'Duty/°C/m²':>11s}"
    print(header)
    for r in scored:
        line = (f"{r['label']:28s} {r['duty_per_degree']:13.2f} {r['mean_duty']:10.1f} "
                f"{r['mean_need']:11.1f} {r['mean_undershoot']:13.1f} {r['samples']:8d}")
        if has_any_area:
            per_m2 = r.get("duty_per_degree_per_m2")
            line += f" {per_m2:11.3f}" if per_m2 is not None else f" {'—':>11s}"
        print(line + ("  VALVE ERROR" if r["valve_error"] else ""))

    if len(scored) >= 2:
        worst, best = scored[0], scored[-1]
        if best["duty_per_degree"] > 0:
            print(f"\n{worst['label']} works {worst['duty_per_degree'] / best['duty_per_degree']:.1f}x "
                  f"harder per degree of heating need than {best['label']} — the largest gap in "
                  f"this window (raw loop-effort metric, no area assumption).")

    area_scored = [r for r in scored if r.get("duty_per_degree_per_m2") is not None]
    if len(area_scored) == len(scored) and len(area_scored) >= 2:
        area_scored = sorted(area_scored, key=lambda r: r["duty_per_degree_per_m2"], reverse=True)
        worst, best = area_scored[0], area_scored[-1]
        if best["duty_per_degree_per_m2"] > 0:
            print(f"Per m²: {worst['label']} works "
                  f"{worst['duty_per_degree_per_m2'] / best['duty_per_degree_per_m2']:.1f}x harder "
                  f"than {best['label']} for its size — ASSUMES similar per-m² loop design "
                  f"capacity across rooms, not verified from this data.")
    elif not has_any_area:
        print("\nNo room floor area supplied (scripts/tools/room-config.json) — a larger room "
              "ranks as a heavier consumer on the metric above even if equally well insulated; "
              "add room m² there for the per-m² column too.")

    if unscored:
        print(f"{len(unscored)} room(s) skipped (too few active-heating samples): "
              f"{', '.join(r['label'] for r in unscored)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
