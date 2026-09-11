#!/usr/bin/env python3
"""
Detect sustained high-power episodes in house_load_w that look like a large backup heating
element running (an electric backup/booster heater on a heat pump, an immersion element, similar)
rather than an ordinary appliance spike — built for sizing/scheduling questions where you want to
know how big and how schedulable your own home's heating load actually is, without adding
dedicated sub-metering hardware.

Two rounds of real evidence shaped this, both against actual data rather than assumption — worth
knowing if you're tuning the defaults for your own site:

1. A naive rule (power above some threshold, sustained a modest number of minutes) fires on
   ordinary cooking. Checked against a real summer month of NUC data on the reference deployment:
   right — dozens of episodes clear 3000 W for 15+ minutes, almost all 07:00-20:00 (meal-prep
   hours), several peaking above 10 kW, and their COEFFICIENT OF VARIATION (std/mean of raw power
   during the episode) is high (18-42%) — several burners/an oven cycling on and off, not a flat
   resistive load.

2. Real historical pre-battery meter data (a smart-meter export predating this deployment's
   battery, at 15-min resolution across three real winters) gave genuine ground truth for what
   that house's own heating actually looks like. Real heating events there are utterly unlike a
   cooking session: 285-810 MINUTES long (4.75-13.5 HOURS), starting evening and running into/
   through the night, at 4-8.7 kW mean above a low rolling baseline. The shortest genuine event on
   record was 285 min; the longest cooking false-positive was 42 min. That is a huge, clean
   separation — DURATION, not amplitude, is what actually distinguishes the two, so this defaults
   to a hard duration bar (90 min: well below the real population, well above the cooking one)
   rather than leaning on a higher power threshold alone.

3. Also uses a DELTA-ABOVE-ROLLING-BASELINE threshold, not an absolute one. The same historical
   data showed winter baseline itself isn't always as quiet as a mild-season sample might suggest
   — a genuinely cold week can sit at several kW overnight even before any backup heater adds
   anything on top, so a fixed absolute cutoff would both miss real events (if the baseline crept
   up near it) and behave inconsistently across seasons.

To keep a rolling median affordable over months of 10s NUC samples, this buckets the raw readings
into 5-min means first (also a free noise filter: a 1-2 min appliance blip gets diluted inside its
own bucket instead of registering at full power) and detects on the bucketed series; reported
peak/CV figures still read back the raw samples for real numbers, not the smoothed ones.

If you have your own historical pre-battery meter export (see solar-data/README.md for where
per-installation historical data like that goes — it's gitignored, never shared), run this
against it first to see what a real heating event looks like on YOUR site before trusting the
defaults below; they're a reasonable starting point from one reference deployment, not a
universal constant.

Usage:
  python scripts/tools/detect-heating-runs.py [--db PATH] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
    [--threshold-w 3000] [--min-duration-min 90] [--bucket-min 5] [--baseline-window-min 120]
    [--gap-tolerance-buckets 2] [--json]

If telemetry.db on your NUC is owned by a service account and isn't directly readable by your
login, and this script needs two tables (readings, price_snapshots) via arbitrary queries — more
than a single-SELECT-only passwordless wrapper (if you have one) allows — dump both tables with a
printable delimiter (not char(31): some sqlite3 column modes render it as a line break and split
rows across lines), gzip, copy down, rebuild a local sqlite copy, point --db at it.
"""
import argparse
import json
import statistics
import sys
from datetime import datetime, timedelta

sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")
import common

SKATT_OVERFORING_ORE = 71.0  # lib/constants.ts default; override not read here, this is offline analysis


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load_readings(cur, date_from, date_to):
    where = []
    params = []
    if date_from:
        where.append("timestamp >= ?")
        params.append(date_from)
    if date_to:
        where.append("timestamp < ?")
        params.append(date_to)
    sql = "SELECT timestamp, house_load_w FROM readings"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY timestamp"
    return [
        (parse_ts(ts), w)
        for ts, w in cur.execute(sql, params).fetchall()
        if w is not None
    ]


def bucket_readings(rows, bucket_min):
    """Collapse raw samples into fixed-width time buckets (mean power), and keep each bucket's
    own raw samples alongside for later peak/CV reporting. Bucket boundaries are aligned to
    bucket_min from the epoch, so re-runs on overlapping ranges get identical bucket edges."""
    if not rows:
        return []
    bucket_s = bucket_min * 60
    buckets = {}
    for t, w in rows:
        key = int(t.timestamp() // bucket_s) * bucket_s
        buckets.setdefault(key, []).append((t, w))
    out = []
    for key in sorted(buckets):
        samples = buckets[key]
        vals = [w for _, w in samples]
        out.append({
            "t": datetime.fromtimestamp(key, tz=rows[0][0].tzinfo),
            "mean": statistics.mean(vals),
            "samples": samples,
        })
    return out


def rolling_baseline(buckets, idx, window_min, bucket_min):
    """Median bucket-mean over the preceding window_min, excluding the current bucket — a
    robust 'what was normal right before this' figure that adapts to the season instead of a
    single fixed number (see module docstring point 3)."""
    n_back = max(1, int(window_min // bucket_min))
    window = buckets[max(0, idx - n_back):idx]
    if not window:
        return buckets[idx]["mean"]
    return statistics.median(b["mean"] for b in window)


def detect_episodes(buckets, threshold_w, min_duration_min, bucket_min, baseline_window_min, gap_tolerance_buckets):
    episodes = []
    i = 0
    n = len(buckets)
    while i < n:
        baseline = rolling_baseline(buckets, i, baseline_window_min, bucket_min)
        if buckets[i]["mean"] - baseline < threshold_w:
            i += 1
            continue
        start_idx = i
        last_above_idx = i
        j = i + 1
        while j < n:
            gap_buckets = j - last_above_idx
            if gap_buckets > gap_tolerance_buckets + 1:
                break
            if buckets[j]["mean"] - baseline >= threshold_w:
                last_above_idx = j
            j += 1
        end_idx = last_above_idx
        # timestamp-based, not index-arithmetic: correct even when the source data's native
        # cadence is coarser than bucket_min (e.g. 15-min meter readings bucketed at 5 min),
        # where consecutive populated buckets aren't actually bucket_min apart in real time.
        duration_min = (buckets[end_idx]["t"] - buckets[start_idx]["t"]).total_seconds() / 60.0 + bucket_min
        if duration_min >= min_duration_min:
            episodes.append((start_idx, end_idx, baseline))
        i = end_idx + 1
    return episodes


def episode_energy_kwh(buckets, start_idx, end_idx, baseline_w, bucket_min):
    """Sum of (bucket mean - baseline) * bucket duration, in kWh — the incremental energy the
    episode itself is responsible for, above what would have been drawn anyway."""
    wh = sum(max(0.0, buckets[k]["mean"] - baseline_w) * (bucket_min / 60.0) for k in range(start_idx, end_idx + 1))
    return wh / 1000.0


def episode_raw_stats(buckets, start_idx, end_idx):
    """Peak + coefficient of variation from the RAW samples inside the episode (not the bucket
    means) — a flat resistive heater should read low CV, cooking's cycling burners high CV."""
    vals = [w for k in range(start_idx, end_idx + 1) for _, w in buckets[k]["samples"]]
    peak = max(vals)
    mean = statistics.mean(vals)
    cv = (statistics.pstdev(vals) / mean * 100) if mean else 0.0
    return peak, cv


def load_price_lookup(cur, dates):
    need = set()
    for d in dates:
        need.add(d)
        need.add((datetime.strptime(d, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d"))
    lookup = {}
    for d in need:
        row = cur.execute("SELECT prices_json FROM price_snapshots WHERE date = ?", (d,)).fetchone()
        if not row:
            continue
        for slot in json.loads(row[0]):
            buy = slot["priceIncludingTaxAndSurcharge"] + SKATT_OVERFORING_ORE
            lookup[slot["startTime"]] = (buy, slot["price"])
    return lookup


def slot_key(dt_local: datetime) -> str:
    floored = dt_local.replace(minute=(dt_local.minute // 15) * 15, second=0, microsecond=0)
    return floored.strftime("%Y-%m-%dT%H:%M:%S")


def to_stockholm(dt) -> datetime:
    return dt.astimezone(common.STOCKHOLM).replace(tzinfo=None)


def episode_price_stats(buckets, start_idx, end_idx, bucket_min, price_lookup):
    weighted_sum = 0.0
    total_h = 0.0
    day_keys_seen = set()
    for k in range(start_idx, end_idx + 1):
        t_local = to_stockholm(buckets[k]["t"])
        day_keys_seen.add(t_local.strftime("%Y-%m-%d"))
        price = price_lookup.get(slot_key(t_local))
        if price is None:
            continue
        dt_h = bucket_min / 60.0
        weighted_sum += price[0] * dt_h
        total_h += dt_h
    avg_buy = weighted_sum / total_h if total_h else None
    day_prices = [p[0] for key, p in price_lookup.items() if key[:10] in day_keys_seen]
    day_min = min(day_prices) if day_prices else None
    day_max = max(day_prices) if day_prices else None
    return avg_buy, day_min, day_max


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common.add_db_arg(ap)
    ap.add_argument("--from", dest="date_from", default=None, help="UTC ISO or date, inclusive")
    ap.add_argument("--to", dest="date_to", default=None, help="UTC ISO or date, exclusive")
    ap.add_argument("--threshold-w", type=float, default=3000.0,
                     help="power ABOVE THE ROLLING BASELINE that counts as 'elevated' (default "
                          "3000 W — matches the delta real winter heating events showed against "
                          "their own preceding baseline in the pre-battery Ellevio archive)")
    ap.add_argument("--min-duration-min", type=float, default=90.0,
                     help="minimum sustained duration (default 90 — real Ellevio heating events "
                          "ran 285-810 min; the longest cooking-session false positive found in "
                          "this year's summer NUC data was 42 min. Big margin either side.")
    ap.add_argument("--bucket-min", type=float, default=5.0,
                     help="bucket width for smoothing + affordable rolling-median (default 5 min)")
    ap.add_argument("--baseline-window-min", type=float, default=120.0,
                     help="trailing window the rolling baseline is computed over (default 120 min)")
    ap.add_argument("--gap-tolerance-buckets", type=int, default=2,
                     help="how many consecutive below-threshold buckets are tolerated inside a "
                          "run without ending it (default 2 = up to 10 min at the default bucket width)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    conn = common.connect_ro(args.db)
    cur = conn.cursor()

    rows = load_readings(cur, args.date_from, args.date_to)
    if not rows:
        print("no readings in range", file=sys.stderr)
        sys.exit(1)

    buckets = bucket_readings(rows, args.bucket_min)
    episodes = detect_episodes(
        buckets, args.threshold_w, args.min_duration_min, args.bucket_min,
        args.baseline_window_min, args.gap_tolerance_buckets,
    )

    dates = sorted({to_stockholm(buckets[s]["t"]).strftime("%Y-%m-%d") for s, _, _ in episodes})
    price_lookup = load_price_lookup(cur, dates) if dates else {}

    results = []
    for start_idx, end_idx, baseline_w in episodes:
        peak_w, cv = episode_raw_stats(buckets, start_idx, end_idx)
        duration_min = (buckets[end_idx]["t"] - buckets[start_idx]["t"]).total_seconds() / 60.0 + args.bucket_min
        energy_kwh = episode_energy_kwh(buckets, start_idx, end_idx, baseline_w, args.bucket_min)
        avg_buy, day_min, day_max = episode_price_stats(buckets, start_idx, end_idx, args.bucket_min, price_lookup)
        cost_ore = energy_kwh * avg_buy if avg_buy is not None else None
        saving_ore = energy_kwh * (avg_buy - day_min) if avg_buy is not None and day_min is not None else None
        results.append({
            "start": to_stockholm(buckets[start_idx]["t"]).isoformat(),
            "end": to_stockholm(buckets[end_idx]["t"]).isoformat(),
            "durationMin": duration_min,
            "baselineW": round(baseline_w),
            "peakW": round(peak_w),
            "cvPct": round(cv, 1),
            "incrementalEnergyKwh": round(energy_kwh, 2),
            "avgBuyPriceOre": round(avg_buy, 1) if avg_buy is not None else None,
            "dayMinBuyOre": round(day_min, 1) if day_min is not None else None,
            "dayMaxBuyOre": round(day_max, 1) if day_max is not None else None,
            "costAtRetailKr": round(cost_ore / 100, 2) if cost_ore is not None else None,
            "savingIfPrechargedAtDayMinKr": round(saving_ore / 100, 2) if saving_ore is not None else None,
        })

    if args.json:
        print(json.dumps(results, indent=2))
        return

    print(f"window: {rows[0][0].isoformat()} .. {rows[-1][0].isoformat()}  "
          f"bucket={args.bucket_min:.0f}min  baseline_window={args.baseline_window_min:.0f}min  "
          f"threshold={args.threshold_w:.0f}W-above-baseline  min_duration={args.min_duration_min:.0f}min\n")
    print(f"{len(results)} candidate sustained heating episode(s) found.\n")
    if not results:
        print("(nothing yet - expected while there's no real heating demand; re-run once it's cold)")
        return

    hdr = (f"{'start (Sthlm)':20} {'dur':>6} {'base':>6} {'peak':>6} {'cv%':>6} "
           f"{'kWh':>6} {'buy':>6} {'min':>6} {'max':>6} {'retail':>7} {'vs-cheap':>9}")
    print(hdr)
    print("-" * len(hdr))
    total_kwh = total_cost = total_saving = 0.0
    nan = float("nan")
    for r in results:
        print(
            f"{r['start']:20} {r['durationMin']:6.0f} {r['baselineW']:6.0f} {r['peakW']:6.0f} "
            f"{r['cvPct']:6.1f} {r['incrementalEnergyKwh']:6.2f} "
            f"{r['avgBuyPriceOre'] if r['avgBuyPriceOre'] is not None else nan:6.1f} "
            f"{r['dayMinBuyOre'] if r['dayMinBuyOre'] is not None else nan:6.1f} "
            f"{r['dayMaxBuyOre'] if r['dayMaxBuyOre'] is not None else nan:6.1f} "
            f"{r['costAtRetailKr'] if r['costAtRetailKr'] is not None else nan:7.2f} "
            f"{r['savingIfPrechargedAtDayMinKr'] if r['savingIfPrechargedAtDayMinKr'] is not None else nan:9.2f}"
        )
        total_kwh += r["incrementalEnergyKwh"]
        total_cost += r["costAtRetailKr"] or 0.0
        total_saving += r["savingIfPrechargedAtDayMinKr"] or 0.0
    print("-" * len(hdr))
    print(f"totals: {total_kwh:.1f} kWh, {total_cost:.2f} kr at retail, "
          f"{total_saving:.2f} kr if every run had been pre-charged at that day's cheapest slot")
    print("\ncv% is the coefficient of variation of raw power WITHIN the episode — low (~single "
          "digits) suggests a flat resistive load (heater-like); high (20%+) suggests fluctuating "
          "draw (cooking-like, several elements cycling). Real winter events in the Ellevio "
          "archive weren't cross-checked for this since that data is only 15-min resolution.")


if __name__ == "__main__":
    main()
