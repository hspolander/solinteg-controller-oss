/**
 * Pure presentation logic for the Facit card: turns raw oracle_daily rows
 * (lib/telemetry.ts's OracleDaySummaryRow, one per scored Stockholm day) into the
 * shape app/components/OracleCard.tsx renders. No React, no I/O — kept separate and
 * pure so the median/captured-value math is unit-testable (see
 * lib/__tests__/oracle-card.test.ts), matching lib/dispatch-card.ts's pattern.
 *
 * Only status='ok' days carry headline numbers (armed ≥ 90% of the day, good data —
 * see deploy/schema.sql); other days still appear in the trend, muted, so a gap in
 * the bars never silently hides a disarmed/degraded stretch.
 */
import type { OracleDaySummaryRow } from './telemetry';

export interface OracleTrendDay {
  date: string; // Stockholm day, "YYYY-MM-DD"
  status: string; // 'ok' | 'shadow' | 'degraded' | 'skipped_no_readings'
  regretKr: number | null; // null when the day was unscorable
  achievedKr: number | null;
  oracleKr: number | null;
  capturedPct: number | null; // share of the battery's theoretically possible value captured
}

export interface OracleCardData {
  latest: OracleTrendDay; // most recent status='ok' day — the headline
  latestIntradayKr: number | null; // regret split for the headline day
  latestCarryKr: number | null;
  medianRegretKr: number; // over the ok days in the window
  medianCapturedPct: number | null;
  okDays: number; // how many days the medians rest on
  days: OracleTrendDay[]; // chronological, all statuses, for the trend bars
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Share of the battery's possible value-over-no-battery that dispatch captured:
 * (achieved − baseline) / (oracle − baseline). Null when the oracle found nearly no
 * value to capture (denominator below ~1 kr — a ratio against noise means nothing).
 * Clamped to [0, 100] for display: tiny negative regret (model-vs-reality drift, a
 * documented diagnostic) would otherwise read as an impossible ">100%".
 */
export function capturedPct(
  achievedOre: number | null,
  oracleOre: number | null,
  baselineOre: number | null,
): number | null {
  if (achievedOre == null || oracleOre == null || baselineOre == null) return null;
  const possible = oracleOre - baselineOre;
  if (possible < 100) return null; // < 1 kr of possible value — ratio is noise
  const ratio = ((achievedOre - baselineOre) / possible) * 100;
  return Math.min(100, Math.max(0, ratio));
}

function toTrendDay(r: OracleDaySummaryRow): OracleTrendDay {
  return {
    date: r.date,
    status: r.status,
    regretKr: r.regretOre == null ? null : r.regretOre / 100,
    achievedKr: r.achievedTotalOre == null ? null : r.achievedTotalOre / 100,
    oracleKr: r.oracleTotalOre == null ? null : r.oracleTotalOre / 100,
    capturedPct: capturedPct(r.achievedTotalOre, r.oracleTotalOre, r.baselineNetOre),
  };
}

/**
 * Builds the Facit card view-model from oracle_daily rows (oldest first, most recent
 * last — see readRecentOracleDays). Returns null when no status='ok' day exists yet —
 * the card should render its waiting state (the nightly sweep needs a full day D
 * plus its D+1 before anything is scorable).
 */
export function buildOracleCardData(rows: OracleDaySummaryRow[]): OracleCardData | null {
  const okRows = rows.filter((r) => r.status === 'ok' && r.regretOre != null);
  if (okRows.length === 0) return null;

  const latestRow = okRows[okRows.length - 1];
  const captured = okRows
    .map((r) => capturedPct(r.achievedTotalOre, r.oracleTotalOre, r.baselineNetOre))
    .filter((v): v is number => v != null);

  return {
    latest: toTrendDay(latestRow),
    latestIntradayKr: latestRow.regretIntradayOre == null ? null : latestRow.regretIntradayOre / 100,
    latestCarryKr: latestRow.regretCarryOre == null ? null : latestRow.regretCarryOre / 100,
    medianRegretKr: median(okRows.map((r) => r.regretOre as number)) / 100,
    medianCapturedPct: captured.length ? median(captured) : null,
    okDays: okRows.length,
    days: rows.map(toTrendDay),
  };
}
