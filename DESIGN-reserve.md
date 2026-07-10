# Design note — adaptive battery reserve & telemetry

**Status:** proposed, NOT implemented. The base control path (fixed floor) is what
`solinteg-dispatch.service` runs — every register write gated behind
`SOLINTEG_CONTROL_ARMED` (unset = shadow mode: it computes and logs real per-slot
decisions without touching the inverter; see README.md's "Safety model"). This document
covers the *adaptive* confidence-weighted reserve on top of that fixed floor, which
remains unbuilt — captured here so the roadmap isn't lost.

---

## 1. Two different kinds of "reserve"

These are routinely conflated; keep them separate.

### Economic reserve — dynamic, already implemented
The optimizer — a full-horizon dynamic program over the SoC trajectory
([lib/optimizer.ts](lib/optimizer.ts)) — already declines to discharge now when the energy
is worth more later. There are no per-slot rule variables or line numbers to cite; these are
emergent properties of the DP, pinned by `lib/__tests__/optimizer.test.ts`:

- It only sells to grid when that beats every alternative future use of the energy after
  round-trip losses and wear — it never sells cheaply then rebuys dear (tests: "discharges
  to sell when the sell price beats the future rebuy cost"; "does not charge from grid when
  arbitrage is not viable").
- It holds charge for the dearest upcoming deficit rather than spending it on a cheap one
  (test: "reserves energy to cover a dearer future load rather than selling it cheaply now").

So the working reserve already **floats with the price curve**. On any day with a
meaningful spread it reserves far more than the safety floor; the floor rarely binds.

### Safety floor — fixed backstop
Independent of economics. Protects the cells and covers failure modes:

- **BMS** — absolute cell voltage/temperature cutoffs. Always on.
- **Inverter reg 52503** ("SoC min, on-grid", range 5–100%) — over-discharge floor
  enforced by inverter firmware, **with the NUC switched off**. This is the real
  NUC-death protection; the *software* floor does nothing when the software isn't running.
- **Software floor** (`SOLINTEG_SOC_FLOOR_PCT`, optimizer `BATTERY_MIN_SOC_KWH`) — a
  redundant in-software limit for normal operation.

**Principle:** keep the hard floor low and fixed (8%, set on the inverter via 52503).
The backstop should be dumb and dependable. Put all adaptive cleverness in the economic
layer, never in the safety floor.

## 2. The blind spot the floor actually guards

The economic reserve can only see as far as prices are known: today, plus tomorrow once
Nord Pool day-ahead releases (~13:00 CET; exposed as `hasTomorrow` in the prices API).
At the **end of the known horizon** the optimizer deliberately spends the battery down
rather than stranding charge — the DP's terminal value is 0, so energy left above the floor
at the horizon is worth nothing to the plan (see the `costToGo` initialisation in
`optimizeDispatch`).

→ Late at night, with only "today" known, it can drain toward the floor because it sees
no future need — then an unknown, possibly expensive morning arrives. The fixed floor is
what stops that. This is the case the economic reserve is structurally blind to.

## 3. Proposal — confidence-weighted carry-over target

Replace the DP's zero terminal value with a **carry-over SoC target** `T = f(confidence)`,
so the battery is left fuller when the plan is less trustworthy. Mechanically: initialise
`costToGo` at the horizon with a penalty for terminal SoC below `T` (equivalently, a positive
value per kWh held above the floor), instead of all-zeros:

- High confidence → `T` near the hard floor (~8%): deep-cycle freely.
- Low confidence → `T` up to ~15%: keep more in hand.

The hard safety floor (52503 / BMS) stays low and fixed underneath `T`. `T` is a *soft*
target in the look-ahead, not a safety limit.

### Confidence signals (ranked by cleanliness)
1. **Price horizon known** — `hasTomorrow` from the prices feed. `false` (pre-release) →
   short horizon → raise `T`. `true` → the optimizer can see and reserve for the morning
   economically → drop `T`. Strongest signal, free.
2. **Expected refill** — solar forecast ([lib/forecast.ts](lib/forecast.ts)) + load model
   ([lib/load.ts](lib/load.ts)). Confident sunny tomorrow → safe to run low tonight;
   cloudy/low-solar → hold more.
3. **System health / data freshness** — `live.json` age (poller heartbeat), recent comms
   reliability. Stale/flaky → raise `T`. (Also auto-covers the NUC-degraded case.) Note: as
   of 2026-07-02 this same staleness is already independently monitored operationally
   (`solinteg-healthcheck.timer` alerts on it) — that's a separate concern from using it as
   an *input signal* to `T` here, but the data/plumbing already exists to pull from.
4. **(stretch) SoC-reading trust** — high right after a BMS top-balance at 100%, lower
   after many partial cycles (LFP's flat mid-curve hides drift). Hard to measure without
   BMS internals.

## 4. Data prerequisites — the gate

`f(confidence)` cannot be tuned or validated without history. This section originally
proposed building a telemetry store; `telemetry.db` (SQLite — canonical schema in
`deploy/schema.sql`) now exists and is live,
so §5's storage choice below is already made and built. What's still missing is *history*:
the db has been recording only since go-live (2026-07-02), so there isn't yet enough
forecast-vs-actual data to tune or backtest `f(confidence)` against. Adaptive control must
not ship before that history accumulates.

### Telemetry to capture (see §5)
- **Poller readings** — the dict already built in `read_inverter()` (SoC, PV, grid,
  battery, load, mode, timestamp), appended as a time-series instead of only overwritten.
- **Price curves** — the daily price array the optimizer saw (incl. `hasTomorrow` at
  decision time).
- **Dispatch decisions** — optimizer output per slot (action/power) plus its inputs
  (forecast solar, predicted load, start SoC).
- **Forecast-vs-actual** — actual solar vs forecast, actual load vs predicted, actual SoC
  trajectory vs planned. This is the feedback loop for learning (recalibrate load model,
  solar PR, SoC trust).

## 5. Storage options

| Option | Pros | Cons |
|---|---|---|
| **SQLite** (recommended) | queryable, compact, one file, great for analysis/backtest | tiny bit more code |
| Daily JSONL | dead-simple append, greppable | manual rotation, parse-heavy for analysis |
| Rely on journald | already emitted | unstructured, rotated away, not analysis-grade |

Scale is trivial: 30 s polls = ~2 880 rows/day, ~1 M/year → tens of MB. SQLite on the
NUC's NVMe handles this comfortably. Keep the latest-snapshot `live.json` as-is for the
web app; add the time-series alongside it.

## 6. Backtest plan
Replay recorded price curves + actual SoC/PV/load against candidate policies (fixed floor
vs confidence-weighted `T`), measuring both SEK captured and how often SoC dipped into
risky territory. Existing consumption history (`solar-data/`) seeds the load side
until enough live data accumulates.

## 7. Cost/benefit & sequencing
Estimated payoff is modest (tens–low-hundreds SEK/yr, same band as the floor choice) and
the policy needs tuning. Therefore:

1. Ship the simple fixed setup now (low hard floor + existing economic reserve).
2. **Start logging telemetry from day one** so history accumulates.
3. Once the inverter is live and data exists, backtest and ship `f(confidence)` as a
   *measured* upgrade — not a speculative one.

## 8. Open questions / dependencies
- ~~**Setpoint persistence**~~ ✅ resolved 2026-07-02 — holds a full 15-min slot, 0 deviations.
- ~~**50207 sign**~~ ✅ resolved 2026-07-02 — confirmed `neg_charge`.
- ~~Confirm reg 52503 write behavior~~ ✅ resolved 2026-07-02 — 8% floor is written and the
  inverter grid-charges back up to it, confirmed on-device.
- Remaining open question for *this* proposal specifically: none of the confidence signals
  in §3 have real telemetry to validate against yet (§4) — that's the actual gate before
  building the adaptive layer, not the base-control probes above.
