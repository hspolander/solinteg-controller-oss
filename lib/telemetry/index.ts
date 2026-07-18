/**
 * Decision-side telemetry — the price curves and optimizer runs the web app sees, split by
 * concern across this directory (core.ts: connection; readings.ts: price_snapshots/readings;
 * dispatch.ts: control_actions/optimizer_runs; oracle.ts: oracle_daily). This barrel
 * re-exports everything so every existing `from '@/lib/telemetry'` / `from '../telemetry'`
 * import keeps working unchanged — see each submodule for the real documentation.
 */
export * from './readings';
export * from './dispatch';
export * from './oracle';
