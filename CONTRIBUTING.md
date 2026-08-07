# Contributing

Thanks for looking. This is a small project run by one maintainer alongside a live installation,
so the bar below is less about ceremony and more about a specific fact: **the code in this repo
drives a real battery and a real grid connection.** A bug here doesn't fail a build, it moves
energy at the wrong time, or leaves an inverter parked in a mode that blocks self-consumption.

Contributions are genuinely welcome. This file exists so you don't have to guess what will be
asked of a PR.

## Scope

This is not a generic battery-dispatch framework, on purpose. Two dependencies are fixed:

- **The Swedish day-ahead market** (Nord Pool SE1–SE4 via elprisetjustnu.se). Stockholm timezone
  handling and the feed's 92/100-slot DST-transition quirk are structural, not swappable
  constants. `lib/prices.ts` is the market adapter you'd replace.
- **Solinteg "Integ M Series" inverters** over Modbus TCP. See `MODBUS.md`. Another model in the
  same family needs config; another vendor is a from-scratch field-verification project.

See README.md's "Scope" section for the reasoning. PRs that generalise these are unlikely to be
merged — not because generality is bad, but because neither the maintainer nor CI can verify
behaviour against hardware or a market they don't have.

## What gets merged

**1. Default-off for anything that changes existing behaviour.** Existing installs must be
bit-identical after your change unless the operator opts in. If you're adding a planning
behaviour, gate it behind a flag that defaults to off, and include a test proving the disabled
path is unchanged.

**2. New logic comes with tests.** `npm test` (vitest) and `npm run test:py` (Python stdlib
unittest) must both pass. There are no route tests here; the established pattern is to put logic
in a pure, I/O-free module with tests, and keep the route or component thin — see
`lib/dispatch-card.ts` and `lib/oracle-card.ts` for the shape.

**3. Respect the action contract.** `lib/optimizer.ts`'s `Action` union and
`scripts/services/dispatch_loop.py`'s `apply_target()` are two halves of one contract. The Python
side forces a setpoint for charge/discharge and returns to **auto** for everything else — and
auto *charges* from solar surplus. So an action added in TypeScript but unknown to Python does
not fail loudly, it quietly does something else, possibly the opposite of what you planned.
`lib/__tests__/action-contract.test.ts` enforces this; if it fails, it will tell you what to do.

**4. Check the hardware can express it before building on it.** `MODBUS.md` documents what the
inverter can actually be told to do, including things that look reasonable and are not — e.g.
holding EMS BattCtrl at 0 W to "pause" the battery blocks normal self-consumption and is
explicitly ruled out. If a feature needs a register behaviour that isn't documented there, it
needs an on-device probe first (see `scripts/tools/probe_50207_sign.py` for the pattern), not
just code.

**5. No new runtime dependencies without discussing it first.** The Python services are stdlib +
pymodbus by design, and run unattended on a small always-on box.

**6. Nothing that requires running something the maintainer doesn't.** Integrations — Home
Assistant, MQTT, other dashboards — are welcome to *consume* this project's read-only HTTP
routes, and those routes are a fine thing to contribute. But the project itself must keep working
with none of them installed, and can't take on behaviour only verifiable inside someone else's
stack.

## Things worth knowing before you start

**The optimizer is a dynamic program, and its tests are the spec.** `optimizeDispatch()` runs a DP
over a discretised SoC trajectory. Its useful properties — never selling below the future rebuy
cost, reserving for a dearer future load, grid-charging in the cheapest hour — are *emergent*
from full-horizon optimality, not written anywhere as rules you can grep for.
`lib/__tests__/optimizer.test.ts` is the only written statement of intended behaviour. Read it
before changing the DP, and expect changes there to be scrutinised.

**The hindsight oracle must stay an upper bound.** The oracle scores each day in hindsight and
regret is `oracle − achieved`, with `regret >= 0` as an invariant the tests pin. Anything that
gives the *live plan* options the oracle doesn't have breaks that: the plan can then "beat"
perfect hindsight and regret goes negative. Planning-only penalties (deferral bias, solar risk
premium) are deliberately one-directional for this reason — they make the plan more conservative,
never more capable. If your change widens what the plan can do, say so in the PR.

**Safety model.** Every register write is gated behind `SOLINTEG_CONTROL_ARMED`. Unset, the
dispatch loop computes and logs real decisions but never touches the inverter (shadow mode).
That's the default, and it's the right way to evaluate a change for a few weeks before trusting
it. An independent watchdog forces the inverter back to auto if the dispatch loop's heartbeat
goes stale while armed.

**The shipped data is one specific site's.** `solarCalibrationByMonth`, `hourShareByMonth`, the
HDD load regression and the irradiance climatology are all fitted to the reference installation's
own roof, household and meter history. They're defaults so the project runs out of the box, not
universal constants — if you're running this on your own site and haven't regenerated them, your
production and load figures are quietly wrong. `DOMAIN.md`'s "Adapting to a new site" walks
through regenerating all four, in order.

## Practical

**What you need to run the tests:** Node 24+ and Python 3.10+. Both are hard floors, not
preferences — the app reads SQLite via the built-in `node:sqlite`, and the Python services use
PEP 604 (`X | None`) annotations evaluated at import time. `package.json` declares the Node
requirement, so npm will warn you. README.md's Prerequisites section is the full list.

**You do not need the hardware, a Linux box, or an inverter to contribute.** The suites make no
network calls and talk to no inverter — the Python tests run against a pymodbus fake, and the few
TypeScript integration tests create their own throwaway SQLite database in a temp directory. They
run on Windows, macOS or Linux. `npm run dev` serves the dashboard against seasonal-average
fallbacks with no telemetry database present at all. Only *deployment* is Linux-and-systemd
specific (see `deploy/README.md`); development isn't.

```bash
npm ci            # `ci` not `install` — respects the lockfile
npm test          # vitest
npm run test:py   # Python; use the `py` launcher on Windows in place of python3
npm run lint
npm run typecheck # tsc --noEmit; typechecks the TESTS too, which `build` does not
npm run build     # catches type/CSS errors the tests won't
```

Small PRs get reviewed faster than large ones, and a PR that changes behaviour plus adds tests
plus refactors is three PRs. If you're planning something substantial, open an issue first — not
for permission, but so you don't spend a weekend on something that turns out to be blocked by the
hardware or by the scope above.

Reviews may take a while. This is a side project.
