/**
 * Tests for app/api/oracle/route.ts — the nightly hindsight-scoring endpoint.
 *
 * Why (added 2026-08-09): this route was at 0% coverage while producing every number on the
 * Facit card. Two things in it are worth pinning specifically:
 *
 *  1. The DST-aware slot-count guard. `expectD` is derived from the real Stockholm midnight
 *     span, so it is 96 on a normal day, 92 on the spring-forward day and 100 on the fall-back
 *     day. A hardcoded 96 would silently mark both DST days `skipped_no_prices` forever, and
 *     since the route reports skips as ordinary output nobody would notice a hole appearing in
 *     the record once a year.
 *  2. The GET guards around scoring: the two-day scorability lag (a day is only scorable once
 *     the day AFTER it has fully elapsed — lib/oracle.ts needs its actuals), and the
 *     already-scored short-circuit that `force`/`dry` override differently.
 *
 * `computeOracleDay` itself is mocked here — it has its own thorough tests in oracle.test.ts,
 * and re-running the real DP would make these tests about the optimizer rather than the route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PriceSlot } from '../prices';

vi.mock('../telemetry', () => ({
  buildPriceLookup: vi.fn(),
  readReadings: vi.fn(),
  readOracleReadings: vi.fn(),
  readArmedEvents: vi.fn(),
  readPriceSnapshot: vi.fn(),
  readOracleDates: vi.fn(),
  upsertOracleDaily: vi.fn(),
}));
vi.mock('../oracle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oracle')>();
  return { ...actual, computeOracleDay: vi.fn() };
});
vi.mock('../economics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../economics')>();
  return { ...actual, computeDailyEconomics: vi.fn(() => new Map()) };
});

import {
  buildPriceLookup,
  readReadings,
  readOracleReadings,
  readArmedEvents,
  readPriceSnapshot,
  readOracleDates,
  upsertOracleDaily,
} from '../telemetry';
import { computeOracleDay } from '../oracle';
import { GET, addDays, midnightMs, slotsForDay, kr } from '@/app/api/oracle/route';

/** A snapshot's worth of contiguous 15-min slots for `date`, in naive Stockholm local time. */
function daySlots(date: string, count: number): PriceSlot[] {
  const out: PriceSlot[] = [];
  for (let i = 0; i < count; i++) {
    const h = String(Math.floor(i / 4)).padStart(2, '0');
    const m = String((i % 4) * 15).padStart(2, '0');
    out.push({
      startTime: `${date}T${h}:${m}:00`,
      price: 10,
      priceIncludingTaxAndSurcharge: 50,
    } as PriceSlot);
  }
  return out;
}

const ORACLE_ROW = {
  status: 'ok',
  regretOre: 87,
  regretIntradayOre: 40,
  regretCarryOre: 47,
  oracleTotalOre: 1000,
  achievedTotalOre: 913,
  achievedCashOre: 950,
  baselineNetOre: -200,
  armedFraction: 0.99,
  readingCoverage: 1,
  diagnostics: { balance: { residualKwh: 1.4 } },
};

function req(qs = ''): Request {
  return new Request(`http://localhost:3000/api/oracle${qs}`);
}

describe('date helpers', () => {
  it('addDays walks forward and backward', () => {
    expect(addDays('2026-08-09', 1)).toBe('2026-08-10');
    expect(addDays('2026-08-09', -2)).toBe('2026-08-07');
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('addDays handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('midnightMs spans exactly 24 h on an ordinary day', () => {
    const span = midnightMs('2026-08-10') - midnightMs('2026-08-09');
    expect(span / 3_600_000).toBe(24);
  });

  it('midnightMs spans 23 h across the spring-forward day', () => {
    // 2026-03-29: Stockholm loses an hour. 92 slots, not 96.
    const span = midnightMs('2026-03-30') - midnightMs('2026-03-29');
    expect(span / 3_600_000).toBe(23);
    expect(span / 900_000).toBe(92);
  });

  it('midnightMs spans 25 h across the fall-back day', () => {
    // 2026-10-25: Stockholm repeats an hour. 100 slots.
    const span = midnightMs('2026-10-26') - midnightMs('2026-10-25');
    expect(span / 3_600_000).toBe(25);
    expect(span / 900_000).toBe(100);
  });

  it('slotsForDay picks only the requested day out of a two-day snapshot', () => {
    const prices = [...daySlots('2026-08-09', 4), ...daySlots('2026-08-10', 4)];
    expect(slotsForDay(prices, '2026-08-09')).toHaveLength(4);
    expect(slotsForDay(prices, '2026-08-10')).toHaveLength(4);
    expect(slotsForDay(prices, '2026-08-11')).toHaveLength(0);
  });

  it('slotsForDay tolerates a missing snapshot', () => {
    expect(slotsForDay(undefined, '2026-08-09')).toEqual([]);
  });

  it('kr converts öre to kronor, rounding to whole öre first', () => {
    expect(kr(1234)).toBe(12.34);
    expect(kr(1234.6)).toBe(12.35);
    expect(kr(-87)).toBe(-0.87);
    expect(kr(null)).toBeNull();
  });
});

describe('GET /api/oracle', () => {
  const REAL_DB_PATH = process.env.TELEMETRY_DB_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEMETRY_DB_PATH = '/tmp/fake-telemetry.db';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00+02:00')); // Stockholm 2026-08-09
    vi.mocked(readOracleDates).mockReturnValue(new Map());
    vi.mocked(readOracleReadings).mockReturnValue([]);
    vi.mocked(readArmedEvents).mockReturnValue([]);
    vi.mocked(readReadings).mockReturnValue([]);
    vi.mocked(buildPriceLookup).mockReturnValue(() => null);
    vi.mocked(upsertOracleDaily).mockReturnValue(true);
    vi.mocked(computeOracleDay).mockReturnValue(ORACLE_ROW as never);
    // Default: every requested date has a complete 96-slot snapshot for itself and D+1.
    vi.mocked(readPriceSnapshot).mockImplementation((date: string) => ({
      hasTomorrow: false,
      prices: daySlots(date, 96),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (REAL_DB_PATH === undefined) delete process.env.TELEMETRY_DB_PATH;
    else process.env.TELEMETRY_DB_PATH = REAL_DB_PATH;
  });

  it('503s when telemetry is disabled rather than scoring against nothing', async () => {
    delete process.env.TELEMETRY_DB_PATH;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it('400s on a malformed date', async () => {
    const res = await GET(req('?date=09-08-2026'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('bad date') });
  });

  it('400s on a day that is not scorable yet', async () => {
    // "Today" is 2026-08-09, so the newest scorable day is 08-07. 08-08 needs 08-09's actuals,
    // which are still being recorded.
    const res = await GET(req('?date=2026-08-08'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('not scorable') });
    expect(computeOracleDay).not.toHaveBeenCalled();
  });

  it('scores the newest scorable day (today − 2)', async () => {
    const res = await GET(req('?date=2026-08-07'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({ date: '2026-08-07', status: 'ok', wrote: true, regretKr: 0.87 });
    expect(upsertOracleDaily).toHaveBeenCalledOnce();
  });

  it('short-circuits an already-scored day instead of recomputing it', async () => {
    vi.mocked(readOracleDates).mockReturnValue(new Map([['2026-08-07', 'ok']]));
    const body = await (await GET(req('?date=2026-08-07'))).json();
    expect(body.days[0]).toMatchObject({ wrote: false, reason: expect.stringContaining('already scored') });
    expect(computeOracleDay).not.toHaveBeenCalled();
  });

  it('force=1 recomputes an already-scored day', async () => {
    vi.mocked(readOracleDates).mockReturnValue(new Map([['2026-08-07', 'ok']]));
    const body = await (await GET(req('?date=2026-08-07&force=1'))).json();
    expect(computeOracleDay).toHaveBeenCalledOnce();
    expect(body.days[0].wrote).toBe(true);
  });

  it('dry=1 computes but never writes', async () => {
    const body = await (await GET(req('?date=2026-08-07&dry=1'))).json();
    expect(computeOracleDay).toHaveBeenCalledOnce();
    expect(upsertOracleDaily).not.toHaveBeenCalled();
    expect(body.days[0].wrote).toBe(false);
  });

  it('sweeps a 14-day window when no date is given', async () => {
    const body = await (await GET(req())).json();
    expect(body.days).toHaveLength(14);
    expect(body.days[0].date).toBe(addDays('2026-08-07', -13));
    expect(body.days[13].date).toBe('2026-08-07');
  });

  it('skips a day whose price snapshot is incomplete, without writing a junk row', async () => {
    vi.mocked(readPriceSnapshot).mockImplementation((date: string) =>
      date === '2026-08-07' ? { hasTomorrow: false, prices: daySlots(date, 90) } : { hasTomorrow: false, prices: daySlots(date, 96) },
    );
    const body = await (await GET(req('?date=2026-08-07'))).json();
    expect(body.days[0]).toMatchObject({ status: 'skipped_no_prices', wrote: false });
    expect(body.days[0].reason).toContain('90/96');
    expect(upsertOracleDaily).not.toHaveBeenCalled();
  });

  it('accepts 92 slots on the spring-forward day (not 96)', async () => {
    // The whole point of deriving the expected count from real midnights: a hardcoded 96 would
    // reject this day every year, and it would only show up as a permanent hole in the record.
    vi.mocked(readPriceSnapshot).mockImplementation((date: string) => ({
      hasTomorrow: false,
      prices: daySlots(date, date === '2026-03-29' ? 92 : 96),
    }));
    vi.setSystemTime(new Date('2026-03-31T12:00:00+02:00'));
    const body = await (await GET(req('?date=2026-03-29'))).json();
    expect(body.days[0].status).toBe('ok');
  });

  it('accepts 100 slots on the fall-back day', async () => {
    vi.mocked(readPriceSnapshot).mockImplementation((date: string) => ({
      hasTomorrow: false,
      prices: daySlots(date, date === '2026-10-25' ? 100 : 96),
    }));
    vi.setSystemTime(new Date('2026-10-27T12:00:00+01:00'));
    const body = await (await GET(req('?date=2026-10-25'))).json();
    expect(body.days[0].status).toBe('ok');
  });

  it("falls back to yesterday's tomorrow-half when day D has no snapshot of its own", async () => {
    // Post-13:00 snapshots hold today+tomorrow, so D's slots can live in D-1's row.
    vi.mocked(readPriceSnapshot).mockImplementation((date: string) => {
      if (date === '2026-08-07') return null;
      if (date === '2026-08-06') return { hasTomorrow: true, prices: daySlots('2026-08-07', 96) };
      return { hasTomorrow: false, prices: daySlots(date, 96) };
    });
    const body = await (await GET(req('?date=2026-08-07'))).json();
    expect(body.days[0].status).toBe('ok');
  });

  it('500s with the message when scoring throws, rather than hanging the nightly job', async () => {
    vi.mocked(computeOracleDay).mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await GET(req('?date=2026-08-07'));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'boom' });
  });
});
