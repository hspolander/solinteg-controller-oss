import { describe, it, expect } from 'vitest';
import {
  toneFor,
  decisionOutcomeFor,
  actionLabel,
  gaugeFillPct,
  gaugeTone,
  buildDispatchCardData,
} from '../dispatch-card';
import type { LatestControlAction } from '../telemetry';

function action(overrides: Partial<LatestControlAction>): LatestControlAction {
  return {
    timestamp: '2026-07-03T10:00:00.000Z',
    slotTime: '2026-07-03T12:00:00',
    plannedAction: 'idle',
    powerW: 0,
    armed: true,
    outcome: 'applied',
    detail: '',
    detailJson: null,
    ...overrides,
  };
}

describe('toneFor', () => {
  it('is AKTIV for an applied charge', () => {
    expect(toneFor(action({ outcome: 'applied', plannedAction: 'charge' }))).toBe('AKTIV');
  });
  it('is AKTIV for an applied discharge', () => {
    expect(toneFor(action({ outcome: 'applied', plannedAction: 'discharge' }))).toBe('AKTIV');
  });
  it('is PLANERAT for an applied idle', () => {
    expect(toneFor(action({ outcome: 'applied', plannedAction: 'idle' }))).toBe('PLANERAT');
  });
  it('is AVVAKTAR for skipped_divergence', () => {
    expect(toneFor(action({ outcome: 'skipped_divergence' }))).toBe('AVVAKTAR');
  });
  it('is AVVAKTAR for skipped_solar_shortfall', () => {
    expect(toneFor(action({ outcome: 'skipped_solar_shortfall' }))).toBe('AVVAKTAR');
  });
  it('is AVVAKTAR for both error outcomes', () => {
    expect(toneFor(action({ outcome: 'error_reverted' }))).toBe('AVVAKTAR');
    expect(toneFor(action({ outcome: 'error_revert_failed' }))).toBe('AVVAKTAR');
  });
});

describe('decisionOutcomeFor', () => {
  it('maps applied -> ok', () => {
    expect(decisionOutcomeFor('applied')).toBe('ok');
  });
  it('maps both skip outcomes -> skip', () => {
    expect(decisionOutcomeFor('skipped_divergence')).toBe('skip');
    expect(decisionOutcomeFor('skipped_solar_shortfall')).toBe('skip');
  });
  it('maps both error outcomes -> error', () => {
    expect(decisionOutcomeFor('error_reverted')).toBe('error');
    expect(decisionOutcomeFor('error_revert_failed')).toBe('error');
  });
});

describe('actionLabel', () => {
  it('labels charge/discharge regardless of outcome text', () => {
    expect(actionLabel('charge', 'applied')).toBe('Laddning');
    expect(actionLabel('discharge', 'applied')).toBe('Urladdning');
  });
  it('labels an applied idle as Auto', () => {
    expect(actionLabel('idle', 'applied')).toBe('Auto');
  });
  it('labels a skipped idle as Överhoppad', () => {
    expect(actionLabel('idle', 'skipped_divergence')).toBe('Överhoppad');
  });
  it('labels any error outcome as Fel, even if the row somehow has a charge/discharge action', () => {
    expect(actionLabel('charge', 'error_reverted')).toBe('Fel');
    expect(actionLabel('idle', 'error_revert_failed')).toBe('Fel');
  });
});

describe('gaugeFillPct', () => {
  it('computes a plain ratio as a percentage', () => {
    expect(gaugeFillPct(0.1, 3.0)).toBeCloseTo(3.333, 2);
  });
  it('clamps at 100 when value exceeds limit', () => {
    expect(gaugeFillPct(5, 3)).toBe(100);
  });
  it('clamps at 0 for a negative value', () => {
    expect(gaugeFillPct(-1, 3)).toBe(0);
  });
  it('returns 0 when limit is zero or negative (avoids divide-by-zero/NaN)', () => {
    expect(gaugeFillPct(1, 0)).toBe(0);
    expect(gaugeFillPct(1, -1)).toBe(0);
  });
});

describe('gaugeTone', () => {
  it('is green under 50%', () => {
    expect(gaugeTone(0)).toBe('green');
    expect(gaugeTone(49.9)).toBe('green');
  });
  it('is amber from 50% up to (not including) 100%', () => {
    expect(gaugeTone(50)).toBe('amber');
    expect(gaugeTone(99.9)).toBe('amber');
  });
  it('is red at or beyond 100%', () => {
    expect(gaugeTone(100)).toBe('red');
    expect(gaugeTone(150)).toBe('red');
  });
});

describe('buildDispatchCardData', () => {
  const now = new Date('2026-07-03T10:00:12.000Z');

  it('returns null for an empty decision list', () => {
    expect(buildDispatchCardData([], now)).toBeNull();
  });

  it('builds a solar-funded charge reasoning sentence with no warning', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'applied',
          plannedAction: 'charge',
          powerW: 5949,
          detailJson: { solarShortfallKwh: 0, sellOre: 25.2 },
        }),
      ],
      now,
    );
    expect(result?.current.badge).toBe('AKTIV');
    expect(result?.current.reason).toContain('Laddar 5.9 kW');
    expect(result?.current.reason).toContain('helt täckt av solöverskott');
    expect(result?.current.warning).toBeUndefined();
  });

  it('flags a partially grid-funded charge differently from a fully solar-funded one', () => {
    const result = buildDispatchCardData(
      [action({ outcome: 'applied', plannedAction: 'charge', powerW: 1000, detailJson: { solarShortfallKwh: 0.3 } })],
      now,
    );
    expect(result?.current.reason).toContain('delvis från nätet');
  });

  it('labels a discharge with net grid export as a grid sale at the sell price', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'applied',
          plannedAction: 'discharge',
          powerW: 2000,
          detailJson: { gridKwh: -0.4, sellOre: 180.5, buyOre: 250.1 },
        }),
      ],
      now,
    );
    expect(result?.current.reason).toContain('Laddar ur 2.0 kW');
    expect(result?.current.reason).toContain('säljer till nätet');
    expect(result?.current.reason).toContain('180.5');
  });

  it('labels a discharge without net export as covering the house load at the avoided buy price', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'applied',
          plannedAction: 'discharge',
          powerW: 490,
          detailJson: { gridKwh: 0.02, sellOre: 180.5, buyOre: 250.1 },
        }),
      ],
      now,
    );
    expect(result?.current.reason).toContain('täcker husets förbrukning');
    expect(result?.current.reason).toContain('250.1');
    expect(result?.current.reason).not.toContain('säljer till nätet');
  });

  it('reads a discharge row without gridKwh (pre-grid_kwh telemetry) as self-use, not a sale', () => {
    const result = buildDispatchCardData(
      [action({ outcome: 'applied', plannedAction: 'discharge', powerW: 490, detailJson: { sellOre: 180.5 } })],
      now,
    );
    expect(result?.current.reason).toContain('täcker husets förbrukning');
    expect(result?.current.reason).not.toContain('säljer till nätet');
  });

  it('builds an idle reasoning sentence naming the next action when known', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'applied',
          plannedAction: 'idle',
          detailJson: { nextAction: 'charge', nextActionTime: '2026-07-03T14:45:00' },
        }),
      ],
      now,
    );
    expect(result?.current.badge).toBe('PLANERAT');
    expect(result?.current.reason).toBe('Automatiskt läge — nästa laddning kl 14:45.');
  });

  it('falls back to a generic idle sentence when there is no next-action data', () => {
    const result = buildDispatchCardData([action({ outcome: 'applied', plannedAction: 'idle' })], now);
    expect(result?.current.reason).toContain('följer planen');
  });

  it('surfaces a solar-shortfall skip with its gauge numbers and a warning line', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'skipped_solar_shortfall',
          plannedAction: 'idle',
          detailJson: { solarShortfallKwh: 0.85, solarShortfallLimitKwh: 0.5 },
        }),
      ],
      now,
    );
    expect(result?.current.badge).toBe('AVVAKTAR');
    expect(result?.current.warning).toContain('0.85 kWh');
    expect(result?.current.warning).toContain('0.5 kWh');
    expect(result?.current.solarDeficitKwh).toBe(0.85);
    expect(result?.current.solarDeficitLimitKwh).toBe(0.5);
  });

  it('surfaces a SoC-divergence skip with its gauge numbers and a warning line', () => {
    const result = buildDispatchCardData(
      [
        action({
          outcome: 'skipped_divergence',
          plannedAction: 'idle',
          detailJson: { socDriftKwh: 3.4, socDriftLimitKwh: 3.0 },
        }),
      ],
      now,
    );
    expect(result?.current.warning).toContain('3.40 kWh');
    expect(result?.current.socDeviationKwh).toBe(3.4);
  });

  it('falls back to default gauge limits when detailJson is missing them', () => {
    const result = buildDispatchCardData([action({ outcome: 'applied', plannedAction: 'idle' })], now);
    expect(result?.current.solarDeficitLimitKwh).toBe(0.5);
    expect(result?.current.socDeviationLimitKwh).toBe(3.0);
  });

  it('surfaces error outcomes with the raw detail text as the warning', () => {
    const result = buildDispatchCardData(
      [action({ outcome: 'error_reverted', detail: 'connect failed 192.168.1.50:502' })],
      now,
    );
    expect(result?.current.badge).toBe('AVVAKTAR');
    expect(result?.current.reason).toContain('återställd till automatiskt läge');
    expect(result?.current.warning).toBe('connect failed 192.168.1.50:502');
  });

  it('computes secondsAgo from the latest row only, ignoring older rows in the list', () => {
    const result = buildDispatchCardData(
      [
        action({ timestamp: '2026-07-03T09:00:00.000Z' }),
        action({ timestamp: '2026-07-03T09:59:42.000Z' }),
      ],
      now, // 2026-07-03T10:00:12.000Z
    );
    expect(result?.current.secondsAgo).toBeCloseTo(30, 0);
  });

  it('builds a timeline with one DecisionEvent per row, oldest first', () => {
    const result = buildDispatchCardData(
      [
        action({ timestamp: '2026-07-03T09:45:00.000Z', plannedAction: 'idle', outcome: 'applied', powerW: 0 }),
        action({ timestamp: '2026-07-03T10:00:00.000Z', plannedAction: 'charge', outcome: 'applied', powerW: 5949 }),
      ],
      now,
    );
    expect(result?.recentDecisions).toHaveLength(2);
    expect(result?.recentDecisions[0]).toEqual({ time: '11:45', action: 'Auto', powerKw: 0, outcome: 'ok' });
    expect(result?.recentDecisions[1]).toEqual({ time: '12:00', action: 'Laddning', powerKw: 5.949, outcome: 'ok' });
  });
});
