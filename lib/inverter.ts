import { readFile } from 'node:fs/promises';
import { connection } from 'next/server';
import { BATTERY_KWH } from './constants';

const DATA_PATH = process.env.INVERTER_DATA_PATH ?? '/opt/solinteg/live.json';
const STALE_MS = 2 * 60 * 1000;

export interface InverterLiveData {
  timestamp: string;
  soc_pct: number;
  soc_kwh: number;
  soh_pct: number; // battery state of health
  battery_temp_c: number; // plain U16 register — see MODBUS.md, no confirmed negative-temp handling
  pv_w: number;
  grid_w: number; // +ve = export, -ve = import (as reported by the inverter)
  battery_w: number; // -ve = charging, +ve = discharging (as reported)
  inverter_ac_w: number; // inverter AC output — NOT house load
  house_load_w: number; // derived: inverter_ac_w - grid_w
  work_mode: string; // e.g. "General", "EMS BattCtrl"
  work_mode_raw: number;
}

/** True if `data` has every InverterLiveData field with the expected type. Guards against a
 *  poller version skew that dropped or renamed a field — without this, a missing field reaches
 *  a component as `undefined` and crashes on `.toFixed()` instead of degrading gracefully. */
export function isValidInverterLiveData(data: unknown): data is InverterLiveData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.timestamp === 'string' &&
    typeof d.soc_pct === 'number' &&
    typeof d.soc_kwh === 'number' &&
    typeof d.soh_pct === 'number' &&
    typeof d.battery_temp_c === 'number' &&
    typeof d.pv_w === 'number' &&
    typeof d.grid_w === 'number' &&
    typeof d.battery_w === 'number' &&
    typeof d.inverter_ac_w === 'number' &&
    typeof d.house_load_w === 'number' &&
    typeof d.work_mode === 'string' &&
    typeof d.work_mode_raw === 'number'
  );
}

/** Returns live inverter data, or null if the file is missing, unreadable, malformed, or >2 min stale. */
export async function readLiveInverterData(): Promise<InverterLiveData | null> {
  await connection();
  try {
    const text = await readFile(DATA_PATH, 'utf-8');
    const data: unknown = JSON.parse(text);
    if (!isValidInverterLiveData(data)) return null;
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age > STALE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function socKwhOrDefault(data: InverterLiveData | null): number {
  return data?.soc_kwh ?? BATTERY_KWH / 2;
}
