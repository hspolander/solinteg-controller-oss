# Python service tests

Unit tests for the pure decision logic in `scripts/services/` — slot indexing and SoC-drift
interpolation (`dispatch_loop.py`), Modbus write ordering plus the fast-path optimization
(`inverter_control.py`), and the independent watchdog fail-safe that forces the inverter back
to auto if the dispatch loop's heartbeat goes stale (`watchdog.py`).

Deliberately stdlib-only (`unittest`), matching this project's own "no extra dependencies"
convention for the services themselves — no pytest, no test-only pip installs needed on a
fresh dev machine or the deployment box.

`fakes.py` stubs `pymodbus` (a deployment-only runtime dependency, not expected to be
installed in a plain dev environment — `inverter_control.py` hard-exits at import if it's
missing) so `inverter_control.py`/`dispatch_loop.py`/`watchdog.py` can be imported and
exercised against an in-memory fake Modbus client instead.

**What's NOT covered here, deliberately:** `decide()`/`main()` in dispatch_loop.py (they need
a real telemetry.db + real time, or a much larger fixture harness) — verify that side against
your deployment's own `control_actions` rows instead.

## The one `scripts/tools/` test

`test_fetch_ellevio_history.py` is the exception to "services only". Offline tools are
otherwise left untested on purpose — they're run by hand, and a wrong answer shows up in the
output you're already reading. This one doesn't: it covers the guard that catches Ellevio
answering for the *other* meter when `--site` and `--direction` disagree, which the API does
with HTTP 200 and a full slot count. Nothing about that failure is visible downstream — the
files are named correctly and full of plausible numbers — so the guard is the only thing
standing between it and a `reconcile-ellevio-meter.py` run that compares import against itself
and declares the export side perfect. A guard against a silent failure has to be tested, or
it's just a second silent failure. The dashed filename means it's loaded via `importlib.util`,
not a plain import.

## Running

```
python3 -m unittest discover -s scripts/tests -p "test_*.py"
```

(on Windows, use the `py` launcher in place of `python3` — same as `npm run test:py`). Run a
single module or add `-v` for verbose per-test output as usual.
