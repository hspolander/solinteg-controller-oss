#!/usr/bin/env python3
"""
Does wind add predictive power to the daily load model beyond temperature?

Physically it should (infiltration heat loss grows with wind), but in coastal Göteborg
wind and cold anti-correlate (windy = mild Atlantic air; coldest = calm high pressure),
so the marginal value on top of HDD is an empirical question — this probe answers it on
the corrected consumption series instead of by assumption.

Fits, all with per-calendar-month levels and within-month deviations (exactly
build-load-model.mjs's structure):
  A  current:      dc ~ s × (HDD − HDDnormal_m),          HDD = max(0, Tb − T)
  B  wind-chill:   dc ~ s × (HDDe − HDDenormal_m),        HDDe = max(0, Tb − (T − k×W))
                   (k scanned; k°C of effective cooling per m/s of daily-mean wind)
  C  interaction:  dc ~ s × dHDD + b × d(HDD×W)           (2-var OLS at model A's best Tb)

Prints R²/RMSE overall and for Nov-Feb specifically — the months where it matters.

Usage: python scripts/tools/probe-wind-load.py   (network: Open-Meteo Archive)
"""
import csv
import json
import urllib.request
from collections import defaultdict
from math import sqrt
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERIES = ROOT / "solar-data" / "consumption-daily-corrected.csv"
LAT, LON = 57.64, 11.78  # keep in sync with lib/constants.ts
WINTER = {11, 12, 1, 2}


def load_series():
    out = {}
    with SERIES.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["Date"]] = float(row["Daily consumption(kWh)"])
    return out


def fetch_weather(d0, d1):
    url = (
        f"https://archive-api.open-meteo.com/v1/archive?latitude={LAT}&longitude={LON}"
        f"&start_date={d0}&end_date={d1}"
        f"&daily=temperature_2m_mean,wind_speed_10m_mean&timezone=Europe%2FStockholm"
        f"&wind_speed_unit=ms"
    )
    with urllib.request.urlopen(url, timeout=60) as resp:
        arch = json.load(resp)["daily"]
    return {
        d: (t, w)
        for d, t, w in zip(arch["time"], arch["temperature_2m_mean"], arch["wind_speed_10m_mean"])
        if t is not None and w is not None
    }


def month_of(d):
    return int(d[5:7])


def fit_1var(pts, xfun):
    """Within-month-centered single-regressor OLS. pts: (date, load). Returns (slope, r2, rmse, winter_rmse)."""
    months = defaultdict(lambda: {"c": [], "x": []})
    for d, c in pts:
        months[month_of(d)]["c"].append(c)
        months[month_of(d)]["x"].append(xfun(d))
    lvl = {m: sum(v["c"]) / len(v["c"]) for m, v in months.items()}
    xn = {m: sum(v["x"]) / len(v["x"]) for m, v in months.items()}
    sxy = sxx = syy = 0.0
    for d, c in pts:
        m = month_of(d)
        dc, dx = c - lvl[m], xfun(d) - xn[m]
        sxy += dc * dx
        sxx += dx * dx
        syy += dc * dc
    s = sxy / sxx if sxx else 0.0
    r2 = (sxy * sxy) / (sxx * syy) if sxx and syy else 0.0
    sse = wsse = 0.0
    wn = 0
    for d, c in pts:
        m = month_of(d)
        e = (c - lvl[m]) - s * (xfun(d) - xn[m])
        sse += e * e
        if m in WINTER:
            wsse += e * e
            wn += 1
    return s, r2, sqrt(sse / len(pts)), sqrt(wsse / wn)


def fit_2var(pts, x1fun, x2fun):
    """Within-month-centered two-regressor OLS. Returns (s1, s2, r2, rmse, winter_rmse)."""
    months = defaultdict(lambda: {"c": [], "x1": [], "x2": []})
    for d, c in pts:
        m = month_of(d)
        months[m]["c"].append(c)
        months[m]["x1"].append(x1fun(d))
        months[m]["x2"].append(x2fun(d))
    lvl = {m: sum(v["c"]) / len(v["c"]) for m, v in months.items()}
    n1 = {m: sum(v["x1"]) / len(v["x1"]) for m, v in months.items()}
    n2 = {m: sum(v["x2"]) / len(v["x2"]) for m, v in months.items()}
    a11 = a12 = a22 = b1 = b2 = syy = 0.0
    for d, c in pts:
        m = month_of(d)
        dc = c - lvl[m]
        d1, d2 = x1fun(d) - n1[m], x2fun(d) - n2[m]
        a11 += d1 * d1
        a12 += d1 * d2
        a22 += d2 * d2
        b1 += d1 * dc
        b2 += d2 * dc
        syy += dc * dc
    det = a11 * a22 - a12 * a12
    s1 = (b1 * a22 - b2 * a12) / det
    s2 = (b2 * a11 - b1 * a12) / det
    sse = wsse = 0.0
    wn = 0
    for d, c in pts:
        m = month_of(d)
        e = (c - lvl[m]) - s1 * (x1fun(d) - n1[m]) - s2 * (x2fun(d) - n2[m])
        sse += e * e
        if m in WINTER:
            wsse += e * e
            wn += 1
    r2 = 1 - sse / syy if syy else 0.0
    return s1, s2, r2, sqrt(sse / len(pts)), sqrt(wsse / wn)


def main() -> int:
    series = load_series()
    dates = sorted(series)
    wx = fetch_weather(dates[0], dates[-1])
    pts = [(d, series[d]) for d in dates if d in wx]
    T = {d: wx[d][0] for d, _ in pts}
    W = {d: wx[d][1] for d, _ in pts}
    winter_n = sum(1 for d, _ in pts if month_of(d) in WINTER)
    print(f"{len(pts)} days paired ({winter_n} winter); mean winter wind "
          f"{sum(W[d] for d, _ in pts if month_of(d) in WINTER) / winter_n:.1f} m/s")

    # A: current model, scan Tbase
    bestA = None
    for tb10 in range(120, 201, 5):
        tb = tb10 / 10
        fit = fit_1var(pts, lambda d, tb=tb: max(0.0, tb - T[d]))
        if not bestA or fit[1] > bestA[1][1]:
            bestA = (tb, fit)
    tbA, (sA, r2A, rmseA, wrmseA) = bestA
    print(f"\nA  HDD only          Tb={tbA:4.1f}          slope={sA:.2f}"
          f"  R2={r2A:.3f}  RMSE={rmseA:.1f}  winterRMSE={wrmseA:.1f}")

    # B: wind-chill effective temperature, scan Tbase x k
    bestB = None
    for tb10 in range(120, 201, 5):
        for k100 in range(0, 81, 5):
            tb, k = tb10 / 10, k100 / 100
            fit = fit_1var(pts, lambda d, tb=tb, k=k: max(0.0, tb - (T[d] - k * W[d])))
            if not bestB or fit[1] > bestB[2][1]:
                bestB = (tb, k, fit)
    tbB, kB, (sB, r2B, rmseB, wrmseB) = bestB
    print(f"B  wind-chill HDD    Tb={tbB:4.1f}  k={kB:.2f}  slope={sB:.2f}"
          f"  R2={r2B:.3f}  RMSE={rmseB:.1f}  winterRMSE={wrmseB:.1f}")

    # C: HDD + HDD*wind interaction at model A's Tbase
    s1, s2, r2C, rmseC, wrmseC = fit_2var(
        pts,
        lambda d: max(0.0, tbA - T[d]),
        lambda d: max(0.0, tbA - T[d]) * W[d],
    )
    print(f"C  HDD + HDD*wind    Tb={tbA:4.1f}          s_hdd={s1:.2f} s_hddw={s2:.3f}"
          f"  R2={r2C:.3f}  RMSE={rmseC:.1f}  winterRMSE={wrmseC:.1f}")

    print("\nverdict guide: wire wind in only if winterRMSE drops meaningfully (>~5%) "
          "with a physically-sane positive coefficient.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
