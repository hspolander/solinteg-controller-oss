import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PriceData } from '../prices';
import type { OptimizerSlot, DispatchSlot } from '../optimizer';

// producePlan() is the single function every dashboard render AND every triggered replan
// (app/api/replan -> dispatch_loop.py's maybe_request_replan) goes through — see its own
// module docstring. Its own logic is orchestration: three network-fetch fallback chains, the
// nowSlotIdx clamp/slice that anchors the optimizer to a live mid-day SoC reading, and wiring
// the risk-aware planning params into optimizeDispatch. None of that is covered by unit tests
// of optimizer.ts/pipeline.ts in isolation (they test the pieces, not this file's wiring), so a
// typo'd option name or a broken fallback chain here wouldn't be caught anywhere else.
//
// These tests run under the default SOLAR_FORECAST_MODEL ('metno_nordic'), where the solar/temp
// fallback chains behave unconditionally, same as this project's reference deployment. If you've
// set SOLAR_FORECAST_MODEL to something else, producePlan() skips the direct-MET-Norway leg
// entirely (see plan.ts's own SOLAR_FORECAST_MODEL check) — not covered here.
//
// Every dependency is mocked (module-level, not real network/Next.js/telemetry) — this is the
// first file in this repo to use vi.mock, since it's the first case where the module under
// test is pure orchestration around I/O rather than pure computation or a real sqlite temp db.
vi.mock('../prices', () => ({
  fetchPrices: vi.fn(),
  currentSlotIndexInPrices: vi.fn(),
}));
vi.mock('../forecast', () => ({
  fetchSolarForecast: vi.fn(),
  fetchDailyMeanTemp: vi.fn(),
}));
vi.mock('../metno-thredds', () => ({
  fetchSolarForecastDirect: vi.fn(),
  fetchDailyMeanTempDirect: vi.fn(),
}));
vi.mock('../pipeline', () => ({
  buildSolarProfiles: vi.fn(),
  buildOptimizerSlots: vi.fn(),
}));
vi.mock('../optimizer', () => ({
  optimizeDispatch: vi.fn(),
}));
vi.mock('../inverter', () => ({
  readLiveInverterData: vi.fn(),
  socKwhOrDefault: vi.fn(),
}));
vi.mock('../telemetry', () => ({
  logPriceSnapshot: vi.fn(),
  logOptimizerRun: vi.fn(),
  readTrailingLoadProfile: vi.fn(),
}));

import { fetchPrices, currentSlotIndexInPrices } from '../prices';
import { fetchSolarForecast, fetchDailyMeanTemp } from '../forecast';
import { fetchSolarForecastDirect, fetchDailyMeanTempDirect } from '../metno-thredds';
import { buildSolarProfiles, buildOptimizerSlots } from '../pipeline';
import { optimizeDispatch } from '../optimizer';
import { readLiveInverterData, socKwhOrDefault } from '../inverter';
import { logPriceSnapshot, logOptimizerRun, readTrailingLoadProfile } from '../telemetry';
import {
  LOAD_FORECAST_MARGIN,
  DEFERRAL_RATE_ORE_PER_KWH_HOUR,
  SOLAR_RISK_PREMIUM_ORE_PER_KWH,
  LIVE_LOAD_PROFILE_DAYS,
} from '../constants';
import { producePlan } from '../plan';

const PRICE_DATA: PriceData = {
  today: '2026-01-15',
  tomorrow: '2026-01-16',
  hasTomorrow: false,
  maxForMonth: 100,
  minForMonth: 10,
  maxAge: 3600,
  prices: [
    { startTime: '2026-01-15T00:00:00', endTime: '2026-01-15T00:15:00', price: 50, priceIncludingTaxAndSurcharge: 80 },
    { startTime: '2026-01-15T00:15:00', endTime: '2026-01-15T00:30:00', price: 55, priceIncludingTaxAndSurcharge: 85 },
    { startTime: '2026-01-15T00:30:00', endTime: '2026-01-15T00:45:00', price: 52, priceIncludingTaxAndSurcharge: 82 },
    { startTime: '2026-01-15T00:45:00', endTime: '2026-01-15T01:00:00', price: 51, priceIncludingTaxAndSurcharge: 81 },
  ],
};

const ALL_SLOTS: OptimizerSlot[] = PRICE_DATA.prices.map((p, i) => ({
  startTime: p.startTime,
  buyPrice: p.priceIncludingTaxAndSurcharge,
  sellPrice: p.price,
  solarKwh: i,
  consumptionKwh: 0.1,
}));

const DISPATCH_FIXTURE: DispatchSlot[] = [
  {
    startTime: '2026-01-15T00:15:00',
    action: 'idle',
    gridKwh: 0,
    solarExportKwh: 0,
    batteryToGridKwh: 0,
    gridToBatteryKwh: 0,
    batteryToLoadKwh: 0,
    loadFromGridKwh: 0,
    socAfter: 5,
  },
];

const FORECAST = { A: [1, 2, 3] };
const TEMP_BY_DATE = { '2026-01-15': -2 };
const PROFILES = { 1: [0.1, 0.2] };
const LIVE_LOAD = { hourly: [1, 2, 3] } as unknown as ReturnType<typeof readTrailingLoadProfile>;
const INVERTER_DATA = { soc_kwh: 7.5 } as unknown as Awaited<ReturnType<typeof readLiveInverterData>>;

function silenceConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

beforeEach(() => {
  vi.mocked(fetchPrices).mockReset().mockResolvedValue(PRICE_DATA);
  vi.mocked(currentSlotIndexInPrices).mockReset().mockReturnValue(0);
  vi.mocked(fetchSolarForecast).mockReset().mockResolvedValue(FORECAST);
  vi.mocked(fetchDailyMeanTemp).mockReset().mockResolvedValue(TEMP_BY_DATE);
  // Baseline only — the happy path never reaches the direct MET Norway fallback (Open-Meteo
  // resolves first), and the tests that do exercise it override with a real value or a
  // rejection below. `{}` not `null`: both functions return a non-nullable Record, so a mock
  // resolving to null describes something the real code cannot do. plan.ts only ever sees null
  // from its own .catch() around these calls.
  vi.mocked(fetchSolarForecastDirect).mockReset().mockResolvedValue({});
  vi.mocked(fetchDailyMeanTempDirect).mockReset().mockResolvedValue({});
  vi.mocked(buildSolarProfiles).mockReset().mockReturnValue(PROFILES);
  vi.mocked(buildOptimizerSlots).mockReset().mockReturnValue(ALL_SLOTS);
  vi.mocked(optimizeDispatch).mockReset().mockReturnValue(DISPATCH_FIXTURE);
  vi.mocked(readLiveInverterData).mockReset().mockResolvedValue(INVERTER_DATA);
  vi.mocked(socKwhOrDefault).mockReset().mockReturnValue(7.5);
  vi.mocked(readTrailingLoadProfile).mockReset().mockReturnValue(LIVE_LOAD);
  vi.mocked(logPriceSnapshot).mockReset();
  vi.mocked(logOptimizerRun).mockReset();
});

describe('producePlan — happy path wiring', () => {
  it('threads live SoC, live load, and the risk-aware params through to the optimizer', async () => {
    vi.mocked(currentSlotIndexInPrices).mockReturnValue(1);

    const result = await producePlan();

    expect(result.data).toBe(PRICE_DATA);
    expect(result.solarProfiles).toBe(PROFILES);
    expect(result.solarForecast).toBe(FORECAST);
    expect(result.startSoc).toBe(7.5);
    expect(result.socIsLive).toBe(true);
    expect(result.inverterData).toBe(INVERTER_DATA);
    expect(result.dispatchSchedule).toBe(DISPATCH_FIXTURE);

    expect(buildOptimizerSlots).toHaveBeenCalledWith(PRICE_DATA, FORECAST, PROFILES, TEMP_BY_DATE, LIVE_LOAD);
    expect(readTrailingLoadProfile).toHaveBeenCalledWith(LIVE_LOAD_PROFILE_DAYS);

    // The single most important wiring assertion: a typo'd option name here would silently
    // disable risk-aware planning without any optimizer-level test ever catching it.
    expect(optimizeDispatch).toHaveBeenCalledWith(ALL_SLOTS.slice(1), 7.5, {
      loadFactor: LOAD_FORECAST_MARGIN,
      deferralRateOrePerKwhHour: DEFERRAL_RATE_ORE_PER_KWH_HOUR,
      solarRiskPremiumOre: SOLAR_RISK_PREMIUM_ORE_PER_KWH,
    });

    expect(logPriceSnapshot).toHaveBeenCalledWith(PRICE_DATA);
    // Logged inputs must be the HONEST forecast slots (pre-loadFactor), the same reference fed
    // to the optimizer — never a load-inflated copy, or a forecast-vs-actual check would be
    // measuring the deliberate margin instead of the model.
    expect(logOptimizerRun).toHaveBeenCalledWith(
      PRICE_DATA.today,
      PRICE_DATA.hasTomorrow,
      7.5,
      ALL_SLOTS.slice(1),
      DISPATCH_FIXTURE,
      true,
    );
  });

  it('reports a fallback-anchored SoC as not live', async () => {
    vi.mocked(readLiveInverterData).mockResolvedValue(null);
    vi.mocked(socKwhOrDefault).mockReturnValue(12.8);

    const result = await producePlan();

    expect(result.socIsLive).toBe(false);
    expect(result.startSoc).toBe(12.8);
    expect(logOptimizerRun).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 12.8, expect.anything(), expect.anything(), false,
    );
  });
});

describe('producePlan — slot-index clamping', () => {
  it('clamps a negative slot index to the start of the array rather than dropping everything', async () => {
    vi.mocked(currentSlotIndexInPrices).mockReturnValue(-3);

    await producePlan();

    expect(optimizeDispatch).toHaveBeenCalledWith(ALL_SLOTS, 7.5, expect.anything());
  });

  it('a slot index past the end of the loaded prices yields an empty optimizer window, not a crash', async () => {
    vi.mocked(currentSlotIndexInPrices).mockReturnValue(ALL_SLOTS.length + 5);

    const result = await producePlan();

    expect(optimizeDispatch).toHaveBeenCalledWith([], 7.5, expect.anything());
    expect(result.dispatchSchedule).toBe(DISPATCH_FIXTURE);
  });
});

describe('producePlan — prices outage', () => {
  it('degrades to a priceless plan without ever touching the optimizer', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(fetchPrices).mockRejectedValue(new Error('elprisetjustnu 503'));

    const result = await producePlan();

    expect(result.data).toBeNull();
    expect(result.dispatchSchedule).toBeNull();
    expect(result.solarProfiles).toEqual({});
    expect(buildOptimizerSlots).not.toHaveBeenCalled();
    expect(optimizeDispatch).not.toHaveBeenCalled();
    expect(logPriceSnapshot).not.toHaveBeenCalled();
    expect(logOptimizerRun).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('producePlan — solar forecast fallback chain (SOLAR_FORECAST_MODEL=metno_nordic)', () => {
  it('falls back to a direct MET Norway fetch when Open-Meteo fails', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(fetchSolarForecast).mockRejectedValue(new Error('open-meteo 502'));
    vi.mocked(fetchSolarForecastDirect).mockResolvedValue({ direct: [9] });

    const result = await producePlan();

    expect(fetchSolarForecastDirect).toHaveBeenCalled();
    expect(result.solarForecast).toEqual({ direct: [9] });
    errSpy.mockRestore();
  });

  it('falls back to climatology (null) when both solar forecast sources fail, but still plans', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(fetchSolarForecast).mockRejectedValue(new Error('open-meteo 502'));
    vi.mocked(fetchSolarForecastDirect).mockRejectedValue(new Error('metno-thredds timeout'));

    const result = await producePlan();

    expect(result.solarForecast).toBeNull();
    expect(result.dispatchSchedule).toBe(DISPATCH_FIXTURE); // data still present -> plan still runs
    errSpy.mockRestore();
  });
});

describe('producePlan — temperature forecast fallback chain (SOLAR_FORECAST_MODEL=metno_nordic)', () => {
  it('falls back to a direct MET Norway fetch when Open-Meteo fails', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(fetchDailyMeanTemp).mockRejectedValue(new Error('open-meteo 502'));
    vi.mocked(fetchDailyMeanTempDirect).mockResolvedValue({ '2026-01-15': -5 });

    await producePlan();

    expect(buildOptimizerSlots).toHaveBeenCalledWith(PRICE_DATA, FORECAST, PROFILES, { '2026-01-15': -5 }, LIVE_LOAD);
    errSpy.mockRestore();
  });

  it('falls back to the seasonal load model (null tempByDate) when both temp sources fail', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(fetchDailyMeanTemp).mockRejectedValue(new Error('open-meteo 502'));
    vi.mocked(fetchDailyMeanTempDirect).mockRejectedValue(new Error('metno-thredds timeout'));

    const result = await producePlan();

    expect(buildOptimizerSlots).toHaveBeenCalledWith(PRICE_DATA, FORECAST, PROFILES, null, LIVE_LOAD);
    expect(result.dispatchSchedule).toBe(DISPATCH_FIXTURE);
    errSpy.mockRestore();
  });
});

describe('producePlan — optimizer failure is non-fatal', () => {
  it('a throwing optimizer leaves the rest of the plan intact instead of rejecting producePlan', async () => {
    const errSpy = silenceConsoleError();
    vi.mocked(optimizeDispatch).mockImplementation(() => {
      throw new Error('DP blew up');
    });

    const result = await producePlan();

    expect(result.data).toBe(PRICE_DATA);
    expect(result.dispatchSchedule).toBeNull();
    expect(logOptimizerRun).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
