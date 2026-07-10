# Domain Knowledge — solinteg-controller

## Electricity pricing

Spot prices come from **elprisetjustnu.se** (raw Nord Pool day-ahead, zone **SE3**, 15-min slots,
excl VAT). It publishes tomorrow's prices reliably ~13:00 CET — it replaced the Mölndal Energi feed,
which lagged by hours. `lib/prices.ts` derives two fields per slot:

| Field | Meaning |
|---|---|
| `price` | **Sell price** (öre/kWh) — raw spot **+ export compensation** (`EXPORT_BONUS_ORE`, 5.10 öre) |
| `priceIncludingTaxAndSurcharge` | `(spot + 11.5 öre) × 1.25` — supplier surcharge (påslag + elcertifikat), then moms 25% |

The 11.5 öre surcharge and 25% moms were measured against the Mölndal feed (exact fit, 0.00 öre
residual over 96 slots) — see `SUPPLIER_SURCHARGE_ORE` / `VAT_RATE` in `lib/constants.ts`.
Re-measure if the electricity contract changes.

### When buying (consuming from grid)
Full consumer price = `priceIncludingTaxAndSurcharge` + skatt & överföringsavgift (71 öre/kWh flat).

### When selling (export to grid)
You receive the raw spot **plus a flat grid-export compensation** (nätnytta), `EXPORT_BONUS_ORE`
= 5.10 öre/kWh, per exported kWh regardless of source (solar or battery). This is folded into
`price` at fetch time, so the optimizer, economics, and chart all value an exported kWh at
`spot + 5.10`. Moms, the supplier surcharge, skatt, and överföring are **never** part of the
sell price. Adjust `EXPORT_BONUS_ORE` in `lib/constants.ts` if the compensation changes.

### Chart display
The chart shows both real prices at once — a **Köp** line (full consumer buy price) and a **Sälj**
line (spot + nätnytta) — no toggles.

---

## Solar installation

**Location:** Göteborg archipelago, Sweden — approx. 57.64°N, 11.78°E (fuzzed to ~1 km; see
your own `SITE_LATITUDE`/`SITE_LONGITUDE` env vars to set your real coordinates)

**Three arrays — 38 × 370 W panels, 14.06 kWp nameplate:**

| Array | Panels | kWp  | Tilt | Azimuth | Facing    |
|-------|--------|------|------|---------|-----------|
| A     | 20     | 7.40 | 27°  | 123°    | Southeast |
| B     | 15     | 5.55 | 18°  | 303°    | Northwest |
| C     | 3      | 1.11 | 18°  | 214°    | Southwest |

### Production model

Estimated production uses a performance ratio (PR) per array that accounts for the difference between Global Horizontal Irradiance (GHI, measured on a flat surface) and actual panel output including tilt, orientation, inverter losses, and shading:

```
kWh = GHI_kWh_per_m2 × kWp × performanceRatio
```

Performance ratios:
- Array A (SE 123°, 27°): **0.77** — morning peak, good all-day summer output
- Array B (NW 303°, 18°): **0.58** — afternoon/evening only; heavy annual penalty due to north component; near-zero production October–February
- Array C (SW 214°, 18°): **0.72** — afternoon contributor, small capacity

Combined system PR ≈ 0.68 (weighted by kWp).

### Solar data source

Historical hourly GHI (W/m²) and sunshine duration from SMHI station **Göteborg Sol** (station 71415), 1983–2026, quality code G (validated). Processed into monthly averages stored in `lib/irradiance-data.ts`.

**Important:** SMHI times are UTC. Price slot times from elprisetjustnu.se are Stockholm local time. Conversion: UTC hour = Stockholm hour − 2 (April–October, CEST) or − 1 (November–March, CET). This is a month-level approximation, not the real rule (DST actually flips on the last Sunday of March and October) — it's wrong for the boundary week in late March and late October. Fine for eyeballing, but don't hand-apply it in an offline comparison script for those weeks; use a real TZ-aware conversion instead.
(The app itself *does* use this month-level rule — `stockholmUtcOffset` in `lib/slot-utils.ts` —
deliberately, and only on the typical-profile *fallback* path, where a one-hour mis-mapping
during the two DST boundary weeks is noise relative to climatology's own error. Don't "fix" it
to a real TZ conversion without checking `slot-utils.test.ts` first.)

### Seasonal patterns

| Month | Typical daily kWh | Notes |
|-------|-------------------|-------|
| Jun–Jul | 45–55 kWh | Peak; Array B contributes meaningfully in long evenings |
| Apr–May, Aug–Sep | 25–40 kWh | Shoulder season |
| Oct, Mar | 8–15 kWh | Low sun angle, Array B ≈ 0 |
| Nov–Feb | 1–5 kWh | Near-zero; dark months in Gothenburg |

---

## Adapting to a new site

Everything above this line describes one specific installation (Göteborg, Solinteg
MHT-20K-40, this owner's panels/contract). A new adopter needs to replace four generated data
sources, in this order — each script depends on the previous one's output, so running them out
of order produces numbers that don't mean anything:

1. **`scripts/process-smhi-data.ts <csv>`** — historical hourly GHI for your own location →
   `lib/irradiance-data.ts`'s `avgGhiByMonthHour`. Source doesn't have to be SMHI specifically;
   any station-level or reanalysis GHI archive with enough history works, as long as you can get
   it into the same CSV shape this script expects (see its own header comment).
2. **`scripts/build-load-model.mjs`** — reads `solar-data/*.csv` (your own household's daily
   consumption export) + Open-Meteo Archive temperatures for your coordinates → `HDD_T_BASE_C`,
   `LOAD_SLOPE_KWH_PER_HDD`, `hddNormalByMonth` in `lib/consumption-data.ts`. Needs network
   access (Open-Meteo Archive) and at least a full year of your own consumption history to fit
   anything meaningful — a partial year will fit, just less reliably.
3. **`scripts/process-inverter-data.ts <csv>`** — the same (or a matching) CSV export →
   `avgDailyProductionByMonth` / `avgDailyConsumptionByMonth` in `lib/consumption-data.ts`.
4. **`scripts/build-solar-calibration.ts`** — run AFTER steps 1 and 3 both reflect your own
   site: divides your measured production (step 3) by the raw GHI-model estimate (step 1, run
   through `lib/solar.ts`'s `ghiToKwh()` and your own `SOLAR_ARRAYS` in `lib/constants.ts`) →
   `solarCalibrationByMonth`.

**If you're standing this up for the first time with zero production history:** skip step 4 and
ship `solarCalibrationByMonth` as twelve `1.0`s (no correction) rather than guessing — the
GHI model will then systematically underestimate (this owner's installation runs +13% to +43%
low, worst in spring/fall, per the table above), which is a known, bounded, self-correcting gap:
regenerate step 3 and re-run step 4 once you have a real season or two of your own data, per the
same "fitted models need your own history, not a portable default" reasoning `SOLAR_ARRAYS`'s
`performanceRatio` field already carries (see `lib/constants.ts`). The same applies to
`avgDailyConsumptionByMonth`/the HDD regression in step 2 — there's no honest universal default
for another household's consumption shape or heating behavior, only your own measured history.
