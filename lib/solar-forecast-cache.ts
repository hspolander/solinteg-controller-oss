import { readFile, writeFile, rename } from 'node:fs/promises';

/**
 * Last-good solar forecast, persisted to disk — the tier between the live weather sources and
 * seasonal-average climatology.
 *
 * Why this is worth having rather than leaning on the framework cache: `fetchSolarForecast`
 * already asks Next to keep serving a stale forecast for up to 8 h (`cacheLife({ expire })`,
 * lib/forecast.ts) for exactly this reason. On the reference deployment, on the one morning both
 * upstream tiers failed together, the plan fell through to climatology anyway — with no service
 * restart beforehand that would explain an empty cache. Whatever that window does, it did not
 * survive the single occasion it was needed. This is the same idea made explicit and
 * inspectable: a file with a timestamp on it, written by us, read by us, and visible in the
 * plan's own `solarSource` when it is in use.
 *
 * Why the tier matters more than its position suggests: climatology (lib/irradiance-data.ts) is
 * a decades-long monthly mean, so it describes a day that essentially never happens. Measured on
 * the reference deployment over 26 late-summer days, its mean daily error was 13.3 kWh against
 * the live forecast's 8.0 — only 1.7x worse, which badly undersells it. On unremarkable days it
 * was near-exact (one day: off by 0.3 kWh); on the days that actually decide a plan it was
 * hopeless (a heavily overcast day produced 10.1 kWh where climatology said 47.3). Roughly one
 * day in six was off by 20 kWh or more, and every one of those was a dark day — precisely when
 * a plan most needs to buy overnight and hold charge rather than count on a refill that never
 * arrives. A several-hours-old real forecast still encodes today's front and today's cloud; a
 * monthly average cannot. Re-measure on your own site before trusting the magnitudes, but the
 * shape of the argument travels: an average is a bad description of a bimodal day.
 */

const CACHE_PATH =
  process.env.SOLAR_FORECAST_CACHE_PATH ?? '/opt/solinteg/solar-forecast-cache.json';

/** Hours a persisted forecast may still be used. Matches lib/forecast.ts's own stale window so
 *  the two tiers do not disagree about what "too old" means. Deliberately generous: the
 *  comparison is never against a fresh forecast (this path only opens when every live source is
 *  down), it is against climatology, and a 7-hour-old forecast beats a decades-long average on
 *  any day with weather in it. The bound mainly stops yesterday's file being mistaken for
 *  today's, and matters less than it looks because the snapshot is keyed by DATE — a date it
 *  does not cover falls back per-slot to the seasonal profile on its own (see slotSolarKwh). */
const MAX_AGE_MS = Number(process.env.SOLAR_FORECAST_CACHE_MAX_AGE_H ?? 8) * 60 * 60 * 1000;

export interface SolarForecastSnapshot {
  fetchedAt: string; // ISO 8601, UTC
  forecast: Record<string, number[]>; // date -> 96 kWh-per-15-min-slot values
}

/** True if `data` is a snapshot we can actually use: a timestamp plus at least one date mapping
 *  to a full 96-slot array of finite numbers. Mirrors isValidInverterLiveData's reasoning — a
 *  half-written or version-skewed file must degrade to climatology, not reach the optimizer as
 *  `undefined` slots and quietly distort a plan. */
export function isValidSolarForecastSnapshot(data: unknown): data is SolarForecastSnapshot {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.fetchedAt !== 'string' || Number.isNaN(Date.parse(d.fetchedAt))) return false;
  if (!d.forecast || typeof d.forecast !== 'object') return false;
  const entries = Object.entries(d.forecast as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([date, slots]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Array.isArray(slots) &&
      slots.length === 96 &&
      slots.every((v) => typeof v === 'number' && Number.isFinite(v)),
  );
}

/** Persists a freshly-fetched forecast. Best-effort by design: a plan that cannot write its
 *  cache must still be served, so every failure is logged and swallowed. Writes to a temp file
 *  and renames, so a crash mid-write cannot leave a truncated file that the validator would
 *  reject on the one morning it is needed. */
export async function saveSolarForecast(forecast: Record<string, number[]>): Promise<void> {
  const snapshot: SolarForecastSnapshot = {
    fetchedAt: new Date().toISOString(),
    forecast,
  };
  if (!isValidSolarForecastSnapshot(snapshot)) return; // nothing worth persisting
  const tmp = `${CACHE_PATH}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await rename(tmp, CACHE_PATH);
  } catch (err) {
    console.error('saveSolarForecast failed (continuing without a persisted forecast):', err);
  }
}

/** Returns the persisted forecast if it exists, parses, validates and is younger than
 *  MAX_AGE_MS — otherwise null, meaning the caller should fall back to climatology. */
export async function readFreshSolarForecast(
  nowMs: number = Date.now(),
): Promise<Record<string, number[]> | null> {
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (!isValidSolarForecastSnapshot(raw)) {
      console.error('persisted solar forecast is malformed, ignoring it');
      return null;
    }
    const ageMs = nowMs - Date.parse(raw.fetchedAt);
    if (ageMs > MAX_AGE_MS || ageMs < 0) {
      console.error(
        `persisted solar forecast is ${(ageMs / 3600_000).toFixed(1)}h old (limit ` +
          `${(MAX_AGE_MS / 3600_000).toFixed(1)}h), falling back to seasonal-average climatology`,
      );
      return null;
    }
    console.error(
      `using persisted solar forecast from ${raw.fetchedAt} ` +
        `(${(ageMs / 3600_000).toFixed(1)}h old) — both live sources are down`,
    );
    return raw.forecast;
  } catch {
    return null; // missing file is the normal case on a fresh install, not an error
  }
}
