// Exercises the real filesystem via a temp dir rather than mocking fs: the failure this module
// exists to prevent (a half-written or ancient file silently reaching the optimizer) lives
// precisely in the read/parse/validate seam that an fs mock would paper over.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'solar-cache-'));
  cachePath = join(dir, 'solar-forecast-cache.json');
  process.env.SOLAR_FORECAST_CACHE_PATH = cachePath;
  vi.resetModules(); // the path is read at module scope
});

afterEach(async () => {
  delete process.env.SOLAR_FORECAST_CACHE_PATH;
  await rm(dir, { recursive: true, force: true });
});

const FORECAST = { '2026-01-15': new Array(96).fill(0.25) };
const load = async () => await import('../solar-forecast-cache');

describe('saveSolarForecast / readFreshSolarForecast', () => {
  it('round-trips a forecast through the file', async () => {
    const { saveSolarForecast, readFreshSolarForecast } = await load();
    await saveSolarForecast(FORECAST);
    expect(await readFreshSolarForecast()).toEqual(FORECAST);
  });

  it('leaves no .tmp file behind (the write is atomic via rename)', async () => {
    const { saveSolarForecast } = await load();
    await saveSolarForecast(FORECAST);
    await expect(readFile(`${cachePath}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('returns null when no file exists — a fresh install is not an error', async () => {
    const { readFreshSolarForecast } = await load();
    expect(await readFreshSolarForecast()).toBeNull();
  });

  it('rejects a forecast older than the age limit rather than planning on yesterday', async () => {
    const { saveSolarForecast, readFreshSolarForecast } = await load();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await saveSolarForecast(FORECAST);
    const nineHoursLater = Date.now() + 9 * 60 * 60 * 1000;
    expect(await readFreshSolarForecast(nineHoursLater)).toBeNull();
    // ...but is still willing just inside the window, or the tier would be useless.
    expect(await readFreshSolarForecast(Date.now() + 7 * 60 * 60 * 1000)).toEqual(FORECAST);
    errSpy.mockRestore();
  });

  it('rejects a file from the future — a clock jump must not pin a forecast forever', async () => {
    const { readFreshSolarForecast } = await load();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: new Date(Date.now() + 3600_000).toISOString(), forecast: FORECAST }),
      'utf8',
    );
    expect(await readFreshSolarForecast()).toBeNull();
    errSpy.mockRestore();
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['a truncated slot array', JSON.stringify({ fetchedAt: new Date().toISOString(), forecast: { '2026-01-15': [1, 2, 3] } })],
    ['a non-numeric slot', JSON.stringify({ fetchedAt: new Date().toISOString(), forecast: { '2026-01-15': new Array(96).fill('x') } })],
    ['no dates at all', JSON.stringify({ fetchedAt: new Date().toISOString(), forecast: {} })],
    ['a missing timestamp', JSON.stringify({ forecast: FORECAST })],
    ['an unparseable timestamp', JSON.stringify({ fetchedAt: 'yesterday-ish', forecast: FORECAST })],
  ])('degrades to climatology on %s', async (_label, contents) => {
    const { readFreshSolarForecast } = await load();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(cachePath, contents, 'utf8');
    expect(await readFreshSolarForecast()).toBeNull();
    errSpy.mockRestore();
  });

  it('never throws when the destination is unwritable — a plan must still be served', async () => {
    process.env.SOLAR_FORECAST_CACHE_PATH = join(dir, 'no', 'such', 'dir', 'cache.json');
    vi.resetModules();
    const { saveSolarForecast } = await load();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(saveSolarForecast(FORECAST)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
