import { describe, it, expect } from 'vitest';
import { buildOracleCardData, capturedPct } from '../oracle-card';
import type { OracleDaySummaryRow } from '../telemetry';

function day(overrides: Partial<OracleDaySummaryRow>): OracleDaySummaryRow {
  return {
    date: '2026-07-05',
    status: 'ok',
    armedFraction: 0.95,
    regretOre: 150, // 1.50 kr
    regretIntradayOre: 140,
    regretCarryOre: 10,
    achievedTotalOre: 5000,
    oracleTotalOre: 5150,
    baselineNetOre: 2000,
    ...overrides,
  };
}

describe('capturedPct', () => {
  it('computes the share of possible value captured', () => {
    // possible = 5150 − 2000 = 3150; captured = (5000 − 2000) / 3150
    expect(capturedPct(5000, 5150, 2000)).toBeCloseTo(95.238, 2);
  });

  it('returns null when the oracle found less than ~1 kr of possible value', () => {
    expect(capturedPct(2000, 2050, 2000)).toBeNull(); // 0.5 kr possible — noise
  });

  it('returns null when any input is missing', () => {
    expect(capturedPct(null, 5150, 2000)).toBeNull();
    expect(capturedPct(5000, null, 2000)).toBeNull();
    expect(capturedPct(5000, 5150, null)).toBeNull();
  });

  it('clamps small negative regret (model drift) to 100 instead of reading >100%', () => {
    expect(capturedPct(5200, 5150, 2000)).toBe(100);
  });

  it('clamps a worse-than-baseline day to 0', () => {
    expect(capturedPct(1900, 5150, 2000)).toBe(0);
  });
});

describe('buildOracleCardData', () => {
  it('returns null when no ok day exists yet', () => {
    expect(buildOracleCardData([])).toBeNull();
    expect(buildOracleCardData([day({ status: 'shadow' })])).toBeNull();
  });

  it('headlines the most recent ok day even when later days are not ok', () => {
    const result = buildOracleCardData([
      day({ date: '2026-07-04', regretOre: 100 }),
      day({ date: '2026-07-05', regretOre: 250 }),
      day({ date: '2026-07-06', status: 'shadow', regretOre: 900 }),
    ]);
    expect(result?.latest.date).toBe('2026-07-05');
    expect(result?.latest.regretKr).toBeCloseTo(2.5);
  });

  it('computes the median regret over ok days only', () => {
    const result = buildOracleCardData([
      day({ date: '2026-07-03', regretOre: 100 }),
      day({ date: '2026-07-04', status: 'degraded', regretOre: 9000 }), // excluded
      day({ date: '2026-07-05', regretOre: 200 }),
      day({ date: '2026-07-06', regretOre: 400 }),
    ]);
    expect(result?.okDays).toBe(3);
    expect(result?.medianRegretKr).toBeCloseTo(2.0);
  });

  it('averages the two middle values for an even ok-day count', () => {
    const result = buildOracleCardData([
      day({ date: '2026-07-05', regretOre: 100 }),
      day({ date: '2026-07-06', regretOre: 300 }),
    ]);
    expect(result?.medianRegretKr).toBeCloseTo(2.0);
  });

  it('keeps non-ok days in the trend with their status', () => {
    const result = buildOracleCardData([
      day({ date: '2026-07-05' }),
      day({ date: '2026-07-06', status: 'skipped_no_readings', regretOre: null, achievedTotalOre: null, oracleTotalOre: null, baselineNetOre: null }),
    ]);
    expect(result?.days).toHaveLength(2);
    expect(result?.days[1].status).toBe('skipped_no_readings');
    expect(result?.days[1].regretKr).toBeNull();
  });

  it('carries the regret split for the headline day', () => {
    const result = buildOracleCardData([day({ regretIntradayOre: 140, regretCarryOre: 10 })]);
    expect(result?.latestIntradayKr).toBeCloseTo(1.4);
    expect(result?.latestCarryKr).toBeCloseTo(0.1);
  });

  it('tolerates a null regret split (infeasible terminal-constrained DP)', () => {
    const result = buildOracleCardData([day({ regretIntradayOre: null, regretCarryOre: null })]);
    expect(result?.latestIntradayKr).toBeNull();
    expect(result?.latestCarryKr).toBeNull();
  });
});
