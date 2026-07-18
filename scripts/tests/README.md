# Python service tests

Unit tests for the pure decision logic in `scripts/services/` — slot indexing and SoC-drift
interpolation (`dispatch_loop.py`), and Modbus write ordering plus the fast-path optimization
(`inverter_control.py`).

Deliberately stdlib-only (`unittest`), matching this project's own "no extra dependencies"
convention for the services themselves — no pytest, no test-only pip installs needed on a
fresh dev machine or the deployment box.

`fakes.py` stubs `pymodbus` (a deployment-only runtime dependency, not expected to be
installed in a plain dev environment — `inverter_control.py` hard-exits at import if it's
missing) so `inverter_control.py`/`dispatch_loop.py` can be imported and exercised against an
in-memory fake Modbus client instead.

**What's NOT covered here, deliberately:** `decide()`/`main()` in dispatch_loop.py (they need
a real telemetry.db + real time, or a much larger fixture harness) — verify that side against
your deployment's own `control_actions` rows instead.

## Running

```
python3 -m unittest discover -s scripts/tests -p "test_*.py"
```

(on Windows, use the `py` launcher in place of `python3` — same as `npm run test:py`). Run a
single module or add `-v` for verbose per-test output as usual.
