import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `connection()` is Next.js's dynamic-rendering opt-in — it has no behaviour worth exercising
// here, but readLiveInverterData awaits it before touching the filesystem, so it has to exist.
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { readFile } from 'node:fs/promises';
import { isValidInverterLiveData, readLiveInverterData, socKwhOrDefault } from '../inverter';
import { BATTERY_KWH } from '../constants';

const VALID = {
  timestamp: '2026-07-08T12:00:00.000Z',
  soc_pct: 62,
  soc_kwh: 15.9,
  soh_pct: 99,
  battery_temp_c: 27,
  pv_w: 4200,
  grid_w: -300,
  battery_w: -1500,
  inverter_ac_w: 3900,
  house_load_w: 3600,
  work_mode: 'General',
  work_mode_raw: 0,
};

describe('isValidInverterLiveData', () => {
  it('accepts a well-formed payload', () => {
    expect(isValidInverterLiveData(VALID)).toBe(true);
  });

  it('rejects a missing field (poller version skew)', () => {
    const { soc_pct, ...rest } = VALID;
    expect(isValidInverterLiveData(rest)).toBe(false);
  });

  it('rejects a field with the wrong type', () => {
    expect(isValidInverterLiveData({ ...VALID, soc_kwh: '15.9' })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isValidInverterLiveData(null)).toBe(false);
    expect(isValidInverterLiveData(undefined)).toBe(false);
    expect(isValidInverterLiveData('not json')).toBe(false);
    expect(isValidInverterLiveData(42)).toBe(false);
  });
});

/**
 * readLiveInverterData reads the poller's live.json and is the app's ONLY source of real SoC.
 * Its 2-minute staleness cutoff decides something with money attached: a fresh reading anchors
 * the DP to the battery's actual charge, while null falls back to socKwhOrDefault's assumed 50%
 * — and logOptimizerRun's publish gate keys off exactly that distinction (`socIsLive`), so a
 * fallback-anchored plan is computed and displayed but deliberately NOT published for the
 * dispatch loop to act on. Accepting a stale reading would publish a plan built from the wrong
 * starting point, which is precisely what the loop's own SoC-divergence guard then has to catch.
 *
 * The whole function was uncovered until 2026-08-10.
 */
const STALE_MS = 2 * 60 * 1000; // mirrors the module's own constant (private)

describe('readLiveInverterData', () => {
  const NOW = new Date('2026-07-08T12:00:00.000Z');

  /** live.json contents whose timestamp is `ageMs` old relative to the frozen clock. */
  const fileAged = (ageMs: number) =>
    JSON.stringify({ ...VALID, timestamp: new Date(NOW.getTime() - ageMs).toISOString() });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('returns a fresh reading', async () => {
    vi.mocked(readFile).mockResolvedValue(fileAged(30_000) as never);
    const data = await readLiveInverterData();
    expect(data).toMatchObject({ soc_kwh: 15.9, work_mode: 'General' });
  });

  it('reads the poller live.json path', async () => {
    vi.mocked(readFile).mockResolvedValue(fileAged(0) as never);
    await readLiveInverterData();
    const [path, encoding] = vi.mocked(readFile).mock.calls[0] as unknown as [string, string];
    expect(path).toContain('live.json');
    expect(encoding).toBe('utf-8');
  });

  it('accepts a reading exactly at the staleness boundary', async () => {
    // The comparison is `>`, not `>=`. Pinned so tightening it stays a deliberate choice.
    vi.mocked(readFile).mockResolvedValue(fileAged(STALE_MS) as never);
    expect(await readLiveInverterData()).not.toBeNull();
  });

  it('rejects a reading one millisecond past the boundary', async () => {
    vi.mocked(readFile).mockResolvedValue(fileAged(STALE_MS + 1) as never);
    expect(await readLiveInverterData()).toBeNull();
  });

  it('rejects a clearly stale reading — a dead poller must not anchor a plan', async () => {
    vi.mocked(readFile).mockResolvedValue(fileAged(30 * 60_000) as never);
    expect(await readLiveInverterData()).toBeNull();
  });

  it('returns null when live.json is missing (poller never ran)', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await readLiveInverterData()).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing into the render', async () => {
    // The poller writes atomically (temp + rename), so a torn read shouldn't happen — but a
    // throw here would take down the whole dashboard render, not just the SoC overlay.
    vi.mocked(readFile).mockResolvedValue('{ half a fi' as never);
    expect(await readLiveInverterData()).toBeNull();
  });

  it('returns null on a valid-JSON payload with a missing field (poller version skew)', async () => {
    const { soc_kwh, ...rest } = VALID;
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...rest, timestamp: NOW.toISOString() }) as never);
    expect(await readLiveInverterData()).toBeNull();
  });

  it('returns null on a future timestamp only if it is not within the window', async () => {
    // A slightly-ahead clock yields a negative age, which is NOT stale — rejecting it would
    // make the plan fall back to 50% over a second of NTP skew.
    vi.mocked(readFile).mockResolvedValue(fileAged(-5_000) as never);
    expect(await readLiveInverterData()).not.toBeNull();
  });
});

describe('socKwhOrDefault', () => {
  it('uses the live reading when there is one', () => {
    expect(socKwhOrDefault(VALID as never)).toBe(15.9);
  });

  it('falls back to half capacity when there is not', () => {
    // Half, deliberately: the least-committal assumption when the real SoC is unknown. Plans
    // built on it are display-only (see logOptimizerRun's publish gate).
    expect(socKwhOrDefault(null)).toBe(BATTERY_KWH / 2);
  });
});
