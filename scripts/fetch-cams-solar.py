#!/usr/bin/env python3
"""
Fetch CAMS satellite-derived solar irradiance (GHI) for our site coordinates,
via the SoDa web service (api.soda-solardata.com) through pvlib's get_cams() wrapper.

Unlike every other comparison so far in this investigation (our own Ecowitt station,
two neighboring stations, SMHI's Göteborg Sol ground station), CAMS is a SATELLITE
estimate for our site's coordinates (see DOMAIN.md), not a physical sensor anywhere
that could be miscalibrated, shaded, or degrading over time. It's the closest thing
to an independent ground truth we have for "does this exact site get more or less
sun than Göteborg city" — the question that started this whole investigation.

Auth: just a free registered email at soda-pro.com (no API key/token, no per-dataset
license click-through) — see https://www.soda-pro.com.

Output is the same `timestamp,solar_wm2` CSV shape compare-ecowitt-smhi.mjs's --out-csv
already produces, so the two scripts' output is directly comparable.

Usage:
  python scripts/fetch-cams-solar.py --email you@example.com --start 2026-02-22 \
    --end 2026-07-02 --out solar-data/cams_archipelago.csv

Requires: pip install pvlib
"""
import argparse
import sys

try:
    import pvlib
except ImportError:
    sys.exit("pip install pvlib")

# Keep in sync with lib/constants.ts's SITE_LATITUDE/SITE_LONGITUDE (the canonical source,
# overridable via env there) — this is a one-off offline script, not part of the running app,
# so it just hardcodes the same values rather than importing across languages.
LATITUDE = 57.64
LONGITUDE = 11.78


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True, help="email registered at soda-pro.com")
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--out", default="cams_solar.csv")
    args = ap.parse_args()

    print(f"Fetching CAMS radiation for ({LATITUDE}, {LONGITUDE}) {args.start}..{args.end}...")
    data, metadata = pvlib.iotools.get_cams(
        latitude=LATITUDE,
        longitude=LONGITUDE,
        start=args.start,
        end=args.end,
        email=args.email,
        identifier="cams_radiation",  # all-sky (actual conditions), not 'mcclear' (clear-sky only)
        time_step="1h",               # matches the hourly resolution used throughout this comparison
        time_ref="UT",
        integrated=False,             # W/m^2 average power, not Wh/m^2 accumulated energy
        map_variables=True,
    )
    print(f"  {len(data)} hourly rows, radiation_unit={metadata.get('radiation_unit')}, "
          f"reliability avg={data['Reliability'].mean():.3f}")

    out = data[["ghi"]].rename(columns={"ghi": "solar_wm2"})
    out.index.name = "timestamp"
    out.to_csv(args.out)
    print(f"Wrote {len(out)} readings to {args.out}")


if __name__ == "__main__":
    main()
