import { describe, it, expect } from 'vitest';
import { isValidInverterLiveData } from '../inverter';

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
