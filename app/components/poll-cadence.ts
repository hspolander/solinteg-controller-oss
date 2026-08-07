/**
 * The dashboard's client-side poll cadence, shared by the two cards that refresh themselves
 * between server renders: Systemstatus (LiveInverterPanel → /api/inverter) and Dispatch
 * (DispatchCard → /api/dispatch).
 *
 * One constant rather than a copy per card so they can't drift out of step — they sit next to
 * each other on screen, and a visible disagreement between two panels is worse than either
 * being slightly stale. Deliberately faster than any underlying data actually changes (the
 * dispatch loop decides on its own interval, the poller writes live.json every 30 s): these
 * are cheap local reads of already-computed state, and matching cadences is what keeps the
 * panels consistent with each other.
 *
 * NOT shared: what each card does when a poll FAILS. That is a real per-card decision, spelled
 * out at each call site — Systemstatus blanks (a stale power figure styled as "live" is worse
 * than PowerFlowCard's explicit "no current data" state), Dispatch keeps its last known
 * decision (a decision stays meaningful as it ages; instantaneous power does not).
 */
export const DASHBOARD_POLL_MS = 10_000;
