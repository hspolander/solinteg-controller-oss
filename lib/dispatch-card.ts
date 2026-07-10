/**
 * Pure presentation logic for the Dispatch card: turns raw control_actions rows
 * (lib/telemetry.ts's LatestControlAction, one row per logged dispatch-loop decision)
 * into the shape app/components/DispatchCard.tsx renders. No React, no I/O — kept
 * separate and pure so the reasoning-sentence/gauge/tone logic is unit-testable
 * (see lib/__tests__/dispatch-card.test.ts), matching lib/chart-utils.ts's pattern.
 */
import type { LatestControlAction } from './telemetry';

export type DispatchTone = 'AKTIV' | 'PLANERAT' | 'AVVAKTAR';
export type DecisionOutcome = 'ok' | 'skip' | 'error';
export type GaugeTone = 'green' | 'amber' | 'red';

export interface DispatchState {
  reason: string;
  badge: DispatchTone;
  secondsAgo: number;
  warning?: string;
  buyOre?: number;
  sellOre?: number;
  solarDeficitKwh: number;
  solarDeficitLimitKwh: number;
  socDeviationKwh: number;
  socDeviationLimitKwh: number;
}

export interface DecisionEvent {
  time: string; // "HH:mm", Stockholm local
  action: string; // display label, e.g. "Laddning" | "Urladdning" | "Auto" | "Överhoppad" | "Fel"
  powerKw: number;
  outcome: DecisionOutcome;
}

export interface DispatchCardData {
  current: DispatchState;
  recentDecisions: DecisionEvent[]; // chronological, most recent last
}

// Mirrors dispatch_loop.py's env-var defaults (DISPATCH_SOLAR_SHORTFALL_KWH /
// DISPATCH_SOC_DIVERGENCE_KWH) — used only as a display fallback when a decision's
// detail_json doesn't carry the real figure (the check didn't run this decision).
// If those env vars are ever overridden on the NUC, this fallback would be mildly
// stale for exactly those absent-check cases; the real value is always used when present.
const DEFAULT_SOLAR_SHORTFALL_LIMIT_KWH = 0.5;
const DEFAULT_SOC_DRIFT_LIMIT_KWH = 3.0;

const STHLM_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function stockholmTimeLabel(isoUtc: string): string {
  const label = STHLM_TIME.format(new Date(isoUtc));
  return label === '24:00' ? '00:00' : label; // some engines emit 24:00 at midnight
}

export function toneFor(action: LatestControlAction): DispatchTone {
  if (action.outcome === 'applied') return action.plannedAction === 'idle' ? 'PLANERAT' : 'AKTIV';
  return 'AVVAKTAR'; // both skip outcomes and both error outcomes read as "needs attention"
}

export function decisionOutcomeFor(outcome: string): DecisionOutcome {
  if (outcome === 'applied') return 'ok';
  if (outcome === 'error_reverted' || outcome === 'error_revert_failed') return 'error';
  return 'skip'; // skipped_divergence | skipped_solar_shortfall
}

export function actionLabel(action: LatestControlAction['plannedAction'], outcome: string): string {
  if (outcome === 'error_reverted' || outcome === 'error_revert_failed') return 'Fel';
  if (action === 'charge') return 'Laddning';
  if (action === 'discharge') return 'Urladdning';
  return outcome === 'applied' ? 'Auto' : 'Överhoppad';
}

/** fillPct in [0, 100], clamped — used to size the gauge bar without overflowing its track. */
export function gaugeFillPct(value: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return Math.min(100, Math.max(0, (value / limit) * 100));
}

/** green < 50%, amber 50–99%, red >= 100% (value at/past its stated limit). */
export function gaugeTone(fillPct: number): GaugeTone {
  if (fillPct >= 100) return 'red';
  if (fillPct >= 50) return 'amber';
  return 'green';
}

function buildReason(a: LatestControlAction): { reason: string; warning?: string } {
  const d = a.detailJson ?? {};
  const powerKw = (a.powerW ?? 0) / 1000;

  if (a.outcome === 'applied') {
    if (a.plannedAction === 'charge') {
      const fundedBySolar = d.solarShortfallKwh != null && d.solarShortfallKwh <= 0.02;
      const priceNote = d.sellOre != null ? ` (säljpris just nu ${d.sellOre.toFixed(1)} öre/kWh)` : '';
      return {
        reason: fundedBySolar
          ? `Laddar ${powerKw.toFixed(1)} kW — helt täckt av solöverskott${priceNote}.`
          : `Laddar ${powerKw.toFixed(1)} kW — delvis från nätet enligt planen${priceNote}.`,
      };
    }
    if (a.plannedAction === 'discharge') {
      const priceNote = d.sellOre != null ? ` för ${d.sellOre.toFixed(1)} öre/kWh` : '';
      return { reason: `Laddar ur ${powerKw.toFixed(1)} kW — säljer till nätet${priceNote}.` };
    }
    // idle
    if (a.detail && (a.detail.startsWith('no optimizer plan') || a.detail.startsWith('now falls outside'))) {
      return { reason: 'Automatiskt läge — ingen aktuell plan hittades.', warning: a.detail };
    }
    if (d.nextAction && d.nextActionTime) {
      const time = d.nextActionTime.slice(11, 16); // already naive Stockholm local, no conversion needed
      const label = d.nextAction === 'charge' ? 'laddning' : 'urladdning';
      return { reason: `Automatiskt läge — nästa ${label} kl ${time}.` };
    }
    return { reason: 'Automatiskt läge — följer planen, ingen tvingad laddning just nu.' };
  }

  if (a.outcome === 'skipped_solar_shortfall') {
    const shortfall = d.solarShortfallKwh?.toFixed(2) ?? '?';
    const limit = (d.solarShortfallLimitKwh ?? DEFAULT_SOLAR_SHORTFALL_LIMIT_KWH).toFixed(1);
    return {
      reason: 'Avvaktar laddning — solöverskottet räcker inte enligt planen just nu.',
      warning: `Solunderskott ${shortfall} kWh överskrider gränsen (${limit} kWh) — väntar tills solen räcker till.`,
    };
  }

  if (a.outcome === 'skipped_divergence') {
    const drift = d.socDriftKwh?.toFixed(2) ?? '?';
    const limit = (d.socDriftLimitKwh ?? DEFAULT_SOC_DRIFT_LIMIT_KWH).toFixed(1);
    return {
      reason: 'Avvaktar — verklig SoC avviker för mycket från planen just nu.',
      warning: `SoC-avvikelse ${drift} kWh överskrider gränsen (${limit} kWh) — väntar på ny synk innan laddning återupptas.`,
    };
  }

  if (a.outcome === 'error_reverted') {
    return {
      reason: 'Fel vid verkställande — återställd till automatiskt läge.',
      warning: a.detail || 'Okänt fel.',
    };
  }

  if (a.outcome === 'error_revert_failed') {
    return {
      reason: 'Fel vid verkställande OCH återställning — kontrollera växelriktaren.',
      warning: a.detail || 'Okänt fel.',
    };
  }

  return { reason: 'Okänt tillstånd.', warning: a.detail || undefined };
}

/**
 * Builds the full Dispatch card view-model from the last N control_actions rows
 * (oldest first, most recent last — see readRecentControlActions). Returns null when
 * there's no data yet (dispatch loop never ran) — the card should render an empty state.
 */
export function buildDispatchCardData(recent: LatestControlAction[], now: Date): DispatchCardData | null {
  if (recent.length === 0) return null;
  const latest = recent[recent.length - 1];
  const d = latest.detailJson ?? {};
  const { reason, warning } = buildReason(latest);

  const current: DispatchState = {
    reason,
    badge: toneFor(latest),
    secondsAgo: Math.max(0, (now.getTime() - new Date(latest.timestamp).getTime()) / 1000),
    warning,
    buyOre: d.buyOre,
    sellOre: d.sellOre,
    solarDeficitKwh: d.solarShortfallKwh ?? 0,
    solarDeficitLimitKwh: d.solarShortfallLimitKwh ?? DEFAULT_SOLAR_SHORTFALL_LIMIT_KWH,
    socDeviationKwh: d.socDriftKwh ?? 0,
    socDeviationLimitKwh: d.socDriftLimitKwh ?? DEFAULT_SOC_DRIFT_LIMIT_KWH,
  };

  const recentDecisions: DecisionEvent[] = recent.map((a) => ({
    time: stockholmTimeLabel(a.timestamp),
    action: actionLabel(a.plannedAction, a.outcome),
    powerKw: (a.powerW ?? 0) / 1000,
    outcome: decisionOutcomeFor(a.outcome),
  }));

  return { current, recentDecisions };
}
