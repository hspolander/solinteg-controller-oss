import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Which of producePlan()'s inputs may be served from a `'use cache'` entry, enforced against the
 * source rather than trusted to a docstring — because trusting the docstring is what failed.
 *
 * lib/plan.ts asserted for months that its call graph carried no `'use cache'` directive
 * anywhere. It wasn't true: fetchPrices() carried one, so the plan's price horizon came from a
 * cache entry that a GET page render and a POST route handler resolved differently. On the
 * reference deployment the visible result was the dashboard alternating between "tomorrow's
 * prices aren't available yet" and the real day-ahead chart for the better part of an hour after
 * each release, while the newest published plan — the one the dispatch loop acts on — flip-flopped
 * between horizon-aware and today-only. Nothing failed loudly; a wrong-but-plausible plan just
 * went to the inverter, and two rounds of tuning cacheLife failed to fix it because the setting
 * was never the problem.
 *
 * The rule these tests encode is NOT "never cache". It is **staleness is only acceptable where a
 * stale answer beats the fallback** — which is why the forecast assertion below deliberately
 * demands the opposite of the price one.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** Comments stripped — see functionBody below for why prose must not be scanned. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const planSrc = stripComments(readFileSync(join(here, '..', 'plan.ts'), 'utf-8'));
const pricesSrc = readFileSync(join(here, '..', 'prices.ts'), 'utf-8');
const forecastSrc = readFileSync(join(here, '..', 'forecast.ts'), 'utf-8');

/**
 * The body of a top-level `export async function <name>`, up to the next top-level declaration,
 * with comments stripped. Stripping matters: the assertions below look for the literal strings
 * `use cache` and `cacheLife`, and the prose explaining *why* a function does or doesn't cache
 * naturally contains both. Without this, the guard fires on its own documentation.
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found — did it get renamed?`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport (async )?function |\nexport const /);
  const body = next < 0 ? rest : rest.slice(0, next);
  return stripComments(body);
}

describe('producePlan cache contract — prices', () => {
  it('plan.ts reads prices through the UNCACHED entry point', () => {
    expect(planSrc).toContain('fetchPricesUncached');
  });

  it('plan.ts never touches the cached wrapper', () => {
    // The wrapper exists only for app/api/prices/route.ts. Importing it here is the regression:
    // it type-checks, it returns the right shape, and it silently reintroduces the flip-flop.
    const cachedRefs = planSrc.match(/\bfetchPrices\b(?!Uncached)/g) ?? [];
    expect(cachedRefs).toEqual([]);
  });

  it('fetchPricesUncached carries no cache directive', () => {
    const body = functionBody(pricesSrc, 'fetchPricesUncached');
    expect(body).not.toContain('use cache');
    expect(body).not.toContain('cacheLife');
  });

  it('the cached wrapper still exists and still caches, for the display-only route', () => {
    // Deleting the wrapper instead of bypassing it would make /api/prices hammer the feed on
    // every request; the split is the point, not the removal.
    const body = functionBody(pricesSrc, 'fetchPrices');
    expect(body).toContain('use cache');
    expect(body).toContain('cacheLife');
  });
});

describe('producePlan cache contract — forecasts stay cached ON PURPOSE', () => {
  // If you are here because you made these uncached "for consistency with prices": don't. A
  // several-hours-old real forecast still encodes today-specific conditions (an approaching
  // front, expected cloud cover). The fallback when it's missing is seasonal-average
  // climatology, which knows none of that — so stale strictly beats fresh-or-nothing here. The
  // 8 h expire is a resilience feature against an upstream outage, not an oversight.
  // Prices are the opposite case: there, stale means solving yesterday's problem.
  it.each(['fetchSolarForecast', 'fetchDailyMeanTemp'])('%s keeps its cache', (fn) => {
    const body = functionBody(forecastSrc, fn);
    expect(body).toContain('use cache');
    expect(body).toContain('cacheLife');
  });
});
