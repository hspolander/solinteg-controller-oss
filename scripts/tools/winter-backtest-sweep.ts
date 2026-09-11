// Real-history counterpart to battery-size-sweep-continuous.ts. That script can only sweep
// hypothetical capacities over whatever window your live telemetry.db already covers — if your
// deployment is young, that might be a single season, which understates (or overstates) a
// battery's value in a season you haven't lived through yet. If you have older utility/meter
// history predating this system (a pre-battery smart-meter export, an old inverter's production
// log, a historical weather archive for your site — solar-data/README.md is where per-
// installation historical data like that goes; it's gitignored, never shared, and there's no
// standard format because every utility's export differs), you can assemble it into the same
// flat slot shape this script expects and get a real multi-season sweep instead of guessing.
//
// This script itself has no data-source opinions — it just runs the DP sweep against whatever
// JSON you hand it, sourced from:
//   - real sub-hourly load (from your own historical meter export)
//   - real daily solar yield, reshaped into an hourly curve using a real regional irradiance
//     archive for those exact days, scaled to match your measured daily total (real shape x
//     real total, not an invented curve)
//   - real historical spot prices for your bidding zone (elprisetjustnu.se serves Swedish
//     zones going back years, free, no key)
// identical in structure to battery-size-sweep-continuous.ts (see that file for the day-by-day-
// stitching pitfall this avoids by running one continuous horizon).
//
// Usage: SOLINTEG_BATTERY_KWH=32 npx tsx scripts/tools/winter-backtest-sweep.ts <slots.json>
// <slots.json> is a flat array of {startTime, solarKwh, consumptionKwh, buyPrice, sellPrice} —
// assemble it yourself from your own historical sources; there's no assembly script here since
// every adopter's data shape will differ.

import { readFileSync } from 'fs';
import { optimizeDispatch, evaluateDispatch, BATTERY_KWH } from '../../lib/optimizer';
import { baselineCashOre } from '../../lib/oracle';
import type { OptimizerSlot } from '../../lib/optimizer';

interface RawSlot {
  startTime: string;
  solarKwh: number;
  consumptionKwh: number;
  buyPrice: number;
  sellPrice: number;
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: winter-backtest-sweep.ts <slots.json>');
    process.exit(2);
  }
  const raw: RawSlot[] = JSON.parse(readFileSync(path, 'utf-8'));
  const slots: OptimizerSlot[] = raw.map((r) => ({
    startTime: r.startTime,
    solarKwh: r.solarKwh,
    consumptionKwh: r.consumptionKwh,
    buyPrice: r.buyPrice,
    sellPrice: r.sellPrice,
  }));

  // Start SoC: no real SoC exists pre-battery, so start at half capacity (matches
  // optimizeDispatch's own default) - a 90-day window makes the one-off start choice
  // immaterial to the per-day average.
  const startSoc = BATTERY_KWH / 2;
  const dispatch = optimizeDispatch(slots, startSoc);
  const evalResult = evaluateDispatch(slots, dispatch, startSoc);
  const baselineOre = baselineCashOre(slots);
  const prizeOre = evalResult.valueOre - baselineOre;

  const days = slots.length / 96;
  const totalSolarKwh = slots.reduce((a, s) => a + s.solarKwh, 0);
  const totalLoadKwh = slots.reduce((a, s) => a + (s.consumptionKwh ?? 0), 0);

  console.log({
    batteryKwh: BATTERY_KWH,
    days: Math.round(days * 10) / 10,
    totalSolarKwh: Math.round(totalSolarKwh),
    totalLoadKwh: Math.round(totalLoadKwh),
    startSocKwh: Math.round(startSoc * 100) / 100,
    endSocKwh: Math.round(dispatch[dispatch.length - 1].socAfter * 100) / 100,
    cashOre: Math.round(evalResult.cashOre),
    wearOre: Math.round(evalResult.wearOre),
    valueOre: Math.round(evalResult.valueOre),
    baselineOre: Math.round(baselineOre),
    prizeKr: Math.round((prizeOre / 100) * 10) / 10,
    prizeKrPerDay: Math.round((prizeOre / 100 / days) * 100) / 100,
  });
}

main();
