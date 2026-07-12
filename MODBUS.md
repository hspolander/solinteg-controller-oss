# Solinteg Modbus reference (read + control)

Source-verified against `plugin_solinteg.py` @ commit `350266f`
(wills106/homeassistant-solax-modbus), cross-checked with the official Solinteg
Hybrid Inverter MODBUS Protocol PDF (MHT-25-50). 31/31 register addresses/encodings
confirmed against those sources — but that is not the same as "safe to command power
on this unit": see the "DO NOT enable live control" table below for the two items
(50208/50209 polarity, model/firmware match) still open on-device.

## Connection

- Transport: **Modbus-TCP, port 502**, **unit/device id 255 (0xFF)** on this install — the
  dongle is a TCP→RTU gateway forwarding to slave 255, NOT 1. (Confirmed 2026-07: id 1 and all
  other ids return no response; only 255 answers. Set `SOLINTEG_SLAVE_ID=255`.)
- **Single SIMULTANEOUS connection, in practice more forgiving than that sounds:** the dongle
  accepts one Modbus TCP client at a time — a genuinely concurrent second connection is reset
  by peer. This originally read as "the poller must be the sole client, forever" (superseded —
  see below). Empirically (2026-07-02, see `dispatch_loop.py`'s CONNECTION MODEL docstring): a
  **brief, on-demand** second connection — opened, used, closed within a second or two — ran
  undisturbed alongside the poller's persistent one across five separate connect/write/close
  cycles from other scripts, including two that held a connection for 16+ minutes each. Current
  callers relying on this: `modbus_poller.py` (persistent), `dispatch_loop.py` and
  `watchdog.py` (both brief/on-demand, at most once a minute each). Keeping those connections
  brief and infrequent minimizes overlap regardless, rather than treating that finding as
  airtight — it is not a documented guarantee from the vendor, just a repeated empirical result
  on this exact dongle/firmware.
- Byte order big-endian; 32-bit word order **big** (high word at lower address)
- Block size 120; all registers are **holding** registers (FC03 read / FC06 write-single)
- pymodbus 3.13+: `read_holding_registers(addr, count=N, device_id=ID)`, `write_register(addr, val, device_id=ID)`. The older `slave=` kwarg and positional `count` were removed. Pin `pymodbus>=3.13,<4`.

## Read registers (used by the poller)

| Addr | Name | Type | Scale | Sign / note |
|---|---|---|---|---|
| 33000 | Battery SoC | U16 | ×0.01 % | |
| 33001 | Battery SoH | U16 | ×0.01 % | Source-verified 2026-07-02 against `plugin_solinteg.py` @ `350266f`, same commit as the rest of this file. Ground truth for the wear-cost model's assumed degradation curve. |
| 33003 | Battery Temperature | U16 | ×0.1 °C | Plain unsigned register, no offset for negative temps in the source plugin — unconfirmed whether this pack can ever report sub-zero (a negative reading would wrap to a huge nonsensical positive value, not a sane negative one). (33002 is unused/reserved.) |
| 30258 | Battery power (W) | S32 | 1 | **−ve = charging, +ve = discharging** (as reported) |
| 11000 | Meter (grid) power (W) | S32 | 1 | **+ve = export, −ve = import** (as reported) |
| 11028 | Total PV power (W) | U32 | 1 | |
| 11016 | Inverter AC output (W) | S32 | 1 | **NOT house load** |
| 50000 | Working mode | U16 | enum | readback of the control register below |

**House load is derived**, not a register: `house_load = inverter_ac(11016) − meter_power(11000)`
(both raw). The poller computes and emits `house_load_w`.

Useful extras (not yet polled): battery V/I 30254/30255, BMS charge/discharge current limits
33021/33023, inverter status 10105, model 10008. (Battery temp 33003 and SoH 33001 were added
to the poller 2026-07-02 — see the table above.)

## Control registers (verified, high confidence)

### Mode / dispatch
| Addr | Name | Type | Scale | Values / encoding |
|---|---|---|---|---|
| **50000** | Working Mode | U16 | enum | `0x101`=General (self-use/AUTO), `0x303`=EMS BattCtrl, `0x302`=EMS General, `0x301`=EMS ACCtrl, `0x400`=ToU. Write raw enum key. |
| **50207** | EMS BattCtrl power target | S16 | 0.01 kW | `raw = int(W/10)`. Sign **−=charge, +=discharge** ✅ confirmed on-device 2026-07-02 (probe: +150→+1494 W discharge, −150→−1502 W charge; tracks setpoint within ~6 W). Active only when 50000=`0x303`. |
| 50208 | Max grid export (Pinv upper) | S16 | 0.01 kW | 0..200 kW. `raw=int(W/10)`. Set to grid cap (11 kW → 1100). |
| 50209 | Max grid import (Pinv lower) | S16 | 0.01 kW | −200..0 kW. `raw=int(W/10)`, −11 kW → −1100. Must satisfy 50208 ≥ 50209. |
| 50210 | Power output priority | U16 | enum | 0=PV, 1=Battery |

### Safety / limits
| Addr | Name | Type | Scale | Values |
|---|---|---|---|---|
| 52502 | SoC protection (on-grid) enable | U16 | enum | 0=off, 1=on |
| 52503 | SoC min (on-grid) | U16 | 0.1 % | 5..100 %; `raw=int(%/0.1)` |
| 52601 | Battery charge current limit | U16 | 0.1 A | 0..200 A |
| 52603 | Battery discharge current limit | U16 | 0.1 A | 0..200 A |
| 50007 | Import limit switch | U16 | enum | 0=off, 1=on |
| 50009 | Import limit value | U16 | 0.1 kW | 0..100 kW; enforce ~11 kW fuse cap → 110 |

### Command buttons (write raw command; momentary, no readback)
| Addr | Command | Effect |
|---|---|---|
| 25008 | `0x101` / `0x100` / `0x404` | start / soft-stop / full-stop |
| 25009 | `1` | restart |
| 50200 | `1` / `0` | force off-grid / on-grid |

## Control sequences

Encoding: 50207/50208/50209 are S16 in **0.01 kW units (10 W/LSB)** → `raw = int(W/10)`,
negatives as two's-complement (`raw & 0xFFFF`). Set **power before mode** so the inverter
never runs a stale setpoint.

**Force charge at P watts (− = charge, confirmed 2026-07-02):**
1. `50209 = -1100` (allow 11 kW grid import), `50208 = 1100`, `50210 = 0` (PV priority)
2. `50207 = int(-P/10)`
3. settle ~300 ms
4. `50000 = 0x303` (EMS BattCtrl) — activates the setpoint
5. read back: 50000==0x303, 50207≈target, 30258 goes negative, SoC rises

**Force discharge at P watts (+ = discharge):**
1. `50208 = 1100` (allow 11 kW export), `50209 = -1100`, `50210 = 1` (battery priority)
2. `50207 = int(+P/10)`
3. settle, then `50000 = 0x303`, read back

**Return to automatic (self-use) — also the fail-safe target:**
1. `50000 = 0x101` (General)
2. `50207 = 0` (housekeeping — neutralize stale setpoint)

**Idle slot = return to automatic.** Do *not* hold `0x303` with `50207=0` — that forces zero
battery power and blocks normal self-consumption.

## ⚠️ DO NOT enable live control until confirmed on-device

| Item | Why | Probe |
|---|---|---|
| ~~**Sign of 50207**~~ ✅ DONE 2026-07-02 | Probe verdict: **neg_charge** (+150→+1494 W discharge, −150→−1502 W charge). `SOLINTEG_50207_SIGN=neg_charge` set in `/opt/solinteg/solinteg.env`. | `scripts/tools/probe_50207_sign.py` |
| ~~**Setpoint persistence**~~ ✅ DONE 2026-07-02 | Probe verdict: **PERSISTS** — 63 samples / 16 min, 0 deviations (±300 W tol); battery held −1478..−1520 W vs −1500 target, 50207 and mode never changed. Once-per-slot writes suffice. | `scripts/tools/probe_setpoint_persistence.py` |
| **50208/50209 polarity** | Plugin labels read reversed; trust the Pinv sign rule (50208 ≥ 0 export, 50209 ≤ 0 import). **Lower-risk in practice:** `inverter_control.py` sidesteps this by always writing BOTH registers to their full symmetric range (50208=+1100, 50209=−1100) on every force-charge *and* force-discharge call — it never relies on asymmetric values, so a swapped label wouldn't restrict the wrong direction. Still formally unconfirmed; don't write asymmetric 50208/50209 values without confirming polarity first. | Read 11000 under a forced setpoint |
| ~~**Model / firmware**~~ ✅ DONE 2026-07-03 | PDF originally on file was for MHT-25-50; confirmed via the physical inverter nameplate + Solinteg's official "Integ M Series" datasheet (`EN-MHT-10-20-NO1.02-2026`) that the installed unit is genuinely a **MHT-20K-40**, matching CLAUDE.md's existing assumption — a real, current, documented Solinteg product (10-20kW Hybrid Inverter family: MHT-10/12/15/20K-40, one shared spec sheet, RS485/CAN comms), not a mismatched device. Confirmed by physical label, not by register read — see the abandoned attempt below. Doesn't retroactively "prove" every register address is identical across Solinteg's model lines, but the registers that actually matter for control (50207, 50000, 52502/52503, etc.) were already empirically verified by testing them on this exact device, independent of any datasheet. | Physical nameplate on the inverter, cross-checked against Solinteg's own current datasheet |
| ~~**Reg 10008 register read**~~ ❌ ABANDONED 2026-07-03 | Attempted as the original way to confirm the model (see item above, now resolved another way). `scripts/tools/read_model_register.py` tried reg 10008 (and 10105) via both FC03 (holding) and FC04 (input) — all four reads timed out with "No response received after 3 retries." Worse: the retry-heavy attempt caused a real ~70s Modbus outage on `solinteg-poller` (timeouts then `Connection refused` from 08:10:20 to 08:11:30 UTC, self-recovered via the poller's own 30s retry — no lasting harm, but a real data point that this dongle handles an unfamiliar/failing register request badly, likely by wedging its single connection slot until its own internal timeout clears). Registers in the 1xxxx block may simply not be exposed on this firmware/dongle combination. **Do not retry without a good reason** — this dongle has now twice given a reason (this outage, plus the already-known single-connection limit) to be conservative about ad hoc Modbus reads. | `scripts/tools/read_model_register.py` — kept for reference, not for routine use |
| ~~**Battery-model precondition (52500)**~~ ✅ DONE 2026-07-02 | Confirmed as a side effect of the probes: force_charge/force_discharge engaged EMS BattCtrl and controlled power correctly across both probes without 52500 ever being touched. | (observed during `probe_50207_sign.py` / `probe_setpoint_persistence.py`) |

## Software-only invariants (the inverter does not enforce these for us)

- **No charge-target-SoC register exists** → the controller must stop charging in software
  when SoC reaches the target ceiling.
- **No ToU upload** → drive every 15-min slot live via 50207; there is no schedule register.
- Clamp power to `min(battery 15.36 kW, grid 11 kW)` **before** encoding.
- On crash/shutdown/timeout → always write `50000=0x101` (revert to auto).
