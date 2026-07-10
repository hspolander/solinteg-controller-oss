# solinteg-controller

A day-ahead battery dispatch optimizer for home solar+battery systems on the Swedish electricity
market — built for and running on a Solinteg hybrid inverter, planning against real Nord Pool
spot prices, a solar production forecast, and a weather-aware household load model.

It doesn't run rules like "charge when cheap, discharge when expensive." It runs a full
dynamic program over the whole known price/solar/load horizon, so it never sells energy cheaply
now only to rebuy it dear later, and it holds charge for whichever future slot needs it most —
not just the next one.

## Scope — read this before investing time

This is **not** a generic multi-vendor, multi-market framework. Two things are fixed by design,
not configuration:

- **Electricity market:** Swedish day-ahead spot prices (Nord Pool, any of SE1–SE4) via the free
  [elprisetjustnu.se](https://elprisetjustnu.se) API. The tax/surcharge/VAT formulas assume a
  Swedish electricity contract's shape (they're still numerically configurable — see
  Configuration below — but the *formula* isn't pluggable for other markets).
- **Inverter:** Solinteg's "Integ M Series" hybrid inverters (MHT-10/12/15/20K-40) over Modbus
  TCP. A different model in the same family works with just a config change (below); a
  different vendor entirely is a from-scratch project (a new register map, on-device
  verification of sign conventions and setpoint persistence — nothing here is guessable from a
  datasheet alone, see `MODBUS.md`).

If you're on the Swedish market with one of these inverters, this is a working reference
implementation you can adapt to your own site by changing config values, not code. If either
assumption doesn't hold, most of the *architecture* (the DP optimizer, the Next.js dashboard, the
telemetry/oracle scoring) is still a reasonable reference to build from, but plan for real
engineering work, not a config change — see `CLAUDE.md`'s "Fixed dependencies" section for the
specific reasons.

## What's included

- **`lib/optimizer.ts`** — the dispatch engine: a dynamic program over a discretised battery
  state-of-charge trajectory. See `CLAUDE.md`'s "Key invariants" for the emergent behaviors this
  gets you (never sells cheap then rebuys dear, reserves energy for the dearest future need,
  solar-aware charging, cheapest-hour buying) and `lib/__tests__/optimizer.test.ts` for the tests
  that pin them — treat those tests as the spec if you touch this file.
- **A Next.js dashboard** (`app/`) — live inverter state, the price/dispatch chart, earnings.
- **A Python control loop** (`scripts/dispatch_loop.py` + `scripts/inverter_control.py`) —
  applies the optimizer's plan to the real inverter via Modbus, gated behind an explicit
  `SOLINTEG_CONTROL_ARMED` safety flag (unset by default: shadow mode, computes and logs real
  decisions without ever touching the inverter).
- **A weather-aware load model + solar forecast pipeline** (`lib/load.ts`, `lib/solar.ts`,
  `lib/forecast.ts`) — fitted to your own household's consumption/production history, not a
  generic curve. See `DOMAIN.md`'s "Adapting to a new site" for the four-script pipeline that
  regenerates these for your own site.
- **A hindsight-oracle scoring system** (`lib/oracle.ts`) — nightly scores each completed day
  against what a perfect-information dispatcher could have achieved, so you can tell whether a
  design decision (recompute cadence, guard thresholds, wear cost) is actually costing you money.
- **Telemetry + alerting** — SQLite-backed history, ntfy push alerts for poller/dispatch health,
  a dead-man's-switch heartbeat.

## Prerequisites

- A Solinteg hybrid inverter (Integ M Series) with a battery and solar array already installed,
  reachable over Modbus TCP.
- A small, always-on Linux box on the same network as the inverter (the reference deployment
  uses an Intel NUC) — this needs a persistent process talking to the inverter, so it isn't
  deployable to Vercel/serverless.
- Node.js 24+, Python 3 with `pymodbus` (`>=3.13,<4`).
- A Swedish electricity contract with a day-ahead (spot price) tariff.

## Quick start

```bash
npm ci
cp deploy/solinteg.env.example .env.local   # optional — the dev dashboard runs on the defaults
npm run dev
```

This gets you the dashboard running locally against real price/weather APIs, in shadow mode
(no register writes — `SOLINTEG_CONTROL_ARMED` is unset). For a real always-on deployment
(systemd services, the Python poller/dispatch loop, alerting), see **`deploy/README.md`** —
that's the actual step-by-step guide for standing this up on a dedicated box.

## Configuration

Every site-specific constant (electricity contract terms, GPS coordinates, solar array specs,
battery capacity, hardware power limits) lives in `lib/constants.ts`, overridable via the shared
env file both the Node app and the Python scripts read — see `deploy/solinteg.env.example` for
the full list. Most defaults are the reference deployment's real values (contract terms, hardware
limits); a few (GPS coordinates, battery replacement cost) are illustrative placeholders rather
than that installation's real numbers — set your own either way.

Fitted/historical data (your household's load shape, your panels' real-world derating, your
site's solar climatology) can't be a portable default — see **`DOMAIN.md`'s "Adapting to a new
site"** for the four-script pipeline that regenerates these from your own data, and what to ship
as a neutral placeholder before you have any history to fit against.

## Safety model

Every Modbus register write is gated behind `SOLINTEG_CONTROL_ARMED` — unset (the default), the
dispatch loop computes and logs exactly what it *would* do every cycle, without ever writing to
the inverter. Recommended path: run in shadow mode for at least a few days, compare its logged
decisions against what you'd expect, verify your own inverter's sign convention and setpoint
persistence with the probe scripts in `scripts/`, and only then set
`SOLINTEG_CONTROL_ARMED=1`. An independent watchdog timer forces the inverter back to safe
auto/self-use mode if the dispatch loop's heartbeat ever goes stale while armed.

## Testing

```bash
npm test
```

231+ tests, no network or hardware required — the optimizer, load model, and telemetry logic are
all pure functions tested against synthetic fixtures. `lib/__tests__/constants-cross-language.test.ts`
additionally guards the TS/Python config values against drifting apart.

## Status

This is a working, single-installation reference — everything in this repo runs the reference
deployment's own real inverter, on real Nord Pool prices, today. It has **not** been tested
against a second installation, a different Solinteg model, or a non-Swedish price feed — treat
the "should just work" claims above as "designed to," not "verified across many sites." If you
adapt this for your own site, issues and PRs describing what needed to change are genuinely
useful to future adopters.

## License

[GNU AGPL-3.0-or-later](LICENSE). Chosen deliberately over the plain GPL or a permissive
license (MIT/Apache): copyleft ensures anyone who distributes a modified version — including
as a hardware+software bundle — must release their changes too, and the "Affero" clause closes
the one gap plain GPL leaves open, extending that same obligation to someone who runs a modified
version as a hosted/cloud service without ever distributing the software itself. The intent is
that this stays free and open for everyone to use and build on, not something a company can fork
into a closed, proprietary product or SaaS.

## Acknowledgments

Built with substantial AI assistance (Claude). The design decisions, trade-offs, and domain
knowledge captured throughout this codebase's comments and `CLAUDE.md`/`DOMAIN.md`/`MODBUS.md`
reflect real hardware testing and real operational experience, not just plausible-sounding code.
