import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BATTERY_KWH,
  BATTERY_MIN_SOC_KWH,
  BATTERY_MAX_KW,
  BATTERY_RT_EFF,
  BATTERY_MAX_SOC_KWH,
  GRID_KW,
} from '../constants';

// Since 2026-07-10, TS and the Python control scripts read the SAME env var names for these
// (not just independently-hardcoded literals) — but each side still has its OWN hardcoded
// fallback default for when the env var is unset, and those two defaults can't be imported
// across the TS/Python boundary to compare directly. This test is the guard against those two
// defaults silently drifting apart.
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

function extractNumber(file: string, pattern: RegExp): number {
  const text = readFileSync(join(scriptsDir, file), 'utf-8');
  const match = text.match(pattern);
  if (!match) throw new Error(`Pattern not found in ${file}: ${pattern}`);
  return parseFloat(match[1]);
}

describe('BATTERY_KWH stays in sync across Python scripts', () => {
  it('matches dispatch_loop.py', () => {
    expect(extractNumber('dispatch_loop.py', /SOLINTEG_BATTERY_KWH",\s*"([\d.]+)"/)).toBe(BATTERY_KWH);
  });

  it('matches modbus_poller.py', () => {
    expect(extractNumber('modbus_poller.py', /SOLINTEG_BATTERY_KWH",\s*"([\d.]+)"/)).toBe(BATTERY_KWH);
  });
});

describe('BATTERY_RT_EFF stays in sync with dispatch_loop.py', () => {
  it('matches the SOLINTEG_BATTERY_RT_EFF default', () => {
    expect(extractNumber('dispatch_loop.py', /SOLINTEG_BATTERY_RT_EFF",\s*"([\d.]+)"/)).toBe(BATTERY_RT_EFF);
  });
});

describe('SoC floor stays in sync with inverter_control.py', () => {
  it('matches the SOLINTEG_SOC_FLOOR_PCT default', () => {
    const floorPct = extractNumber(
      'inverter_control.py',
      /SOLINTEG_SOC_FLOOR_PCT",\s*"([\d.]+)"/
    );
    expect(floorPct).toBe((BATTERY_MIN_SOC_KWH / BATTERY_KWH) * 100);
  });
});

describe('SoC ceiling stays in sync with inverter_control.py', () => {
  it('matches the SOLINTEG_SOC_CEILING_PCT default', () => {
    const ceilingPct = extractNumber(
      'inverter_control.py',
      /SOLINTEG_SOC_CEILING_PCT",\s*"([\d.]+)"/
    );
    expect(ceilingPct).toBe((BATTERY_MAX_SOC_KWH / BATTERY_KWH) * 100);
  });
});

describe('hardware limits stay in sync with inverter_control.py', () => {
  it('matches the SOLINTEG_BATTERY_MAX_W default (kW -> W)', () => {
    const maxW = extractNumber('inverter_control.py', /SOLINTEG_BATTERY_MAX_W",\s*"([\d.]+)"/);
    expect(maxW).toBe(BATTERY_MAX_KW * 1000);
  });

  it('matches the SOLINTEG_GRID_CAP_W default (kW -> W)', () => {
    const capW = extractNumber('inverter_control.py', /SOLINTEG_GRID_CAP_W",\s*"([\d.]+)"/);
    expect(capW).toBe(GRID_KW * 1000);
  });
});
