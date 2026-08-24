# Solinteg Modbus reference (read + control)

Source-verified against `plugin_solinteg.py` @ commit `350266f`
(wills106/homeassistant-solax-modbus), cross-checked with the official Solinteg
Hybrid Inverter MODBUS Protocol PDF (MHT-25-50). 31/31 register addresses/encodings
confirmed against those sources — but that is not the same as "safe to command power
on this unit": see the "DO NOT enable live control" table below. Two of those items
(50208/50209 polarity, and the write-order rule for the EMS limits) were settled on the
**reference deployment** on 2026-08-07 by `scripts/tools/probe_50209_pv_only.py`. Those
results are strong priors for any MHT-family unit, but they are one install — the table is
still a list of things to confirm on **your** hardware, and that script is there so you can.

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
- **The dongle stalls local Modbus for 4-8 s while it talks to the cloud — a design property of
  the hardware, not a fault, and it will affect YOUR install too (confirmed 2026-08-24).** It
  uploads to Solinteg's cloud **~once a minute** over the *same internal path* local Modbus uses;
  if that upload is slow it retries and monopolizes the path. Independently reported by other
  owners and reproduced on the reference deployment, where 61% of all read stalls fell in a 4-8 s
  band. It gets worse when Solinteg's cloud is unwell — a ~7 s stall mode appeared on 2026-08-07
  that had been entirely absent before, on identical hardware, cabling and poll interval.

  **How to recognise it**, because two separate investigations here blamed the hardware and then
  the cabling before finding it. Build a histogram of how long reads actually take — the gap
  between consecutive `readings` rows, minus your `POLL_INTERVAL`:

  ```sql
  SELECT CAST(gap - 20 AS INT) AS excess_s, COUNT(*) AS n   -- change 20 to your POLL_INTERVAL
  FROM (SELECT (julianday(timestamp) - julianday(LAG(timestamp) OVER (ORDER BY timestamp)))*86400.0 AS gap
        FROM readings WHERE timestamp >= date('now','-2 days'))
  WHERE gap IS NOT NULL AND gap > 21.5 AND gap < 300
  GROUP BY excess_s ORDER BY excess_s;
  ```

  - **A mode at 4-8 s → the cloud.** Not your dongle, not your cabling. Nothing local fixes it.
  - **A mode at exactly one `POLL_INTERVAL` → whole skipped cycles** (the read failed, the next
    succeeded). Cross-check your poller's log for failed polls.
  - **A long flat tail, with ping jitter to match → your network path.**

  **Consequences to design around:**
  - **Modbus client timeouts must exceed 8 s.** A timeout during a stall is worse than waiting for
    the result. Owner consensus in the Nordic user group is 10-12 s; several tools ship a 5 s
    default, which sits inside the stall band.
  - **Shorter poll intervals collide with these stalls more often**, costing whole skipped cycles
    — measured at 15.7/day at a 10 s interval vs 2.0/day at 20 s on the same install. Nothing
    downstream here needs sub-minute data, so prefer the longer interval.
  - A third-party local cloud simulator exists (github.com/sixuniform/YOUEMS
    `solinteg-cloud-simulator`, Apache 2.0) that answers the upload locally so the module never
    stalls. **Not used here.** It hijacks the vendor channel via iptables NAT and warns it may
    affect firmware services, warranty and safety notifications — weigh that against what the
    stalls actually cost you, which on the reference deployment was nothing measurable.
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

**Second, independent derivation:** `house_load ≈ pv(11028) + battery(30258) − meter(11000)`, and
equivalently `demand_after_pv ≈ battery − meter`. Same sign conventions as the table above, so
this holds as written. It differs from the 11016-based form only by inverter conversion losses
(11016 ≈ PV + battery discharge), which makes the pair a **cheap sanity oracle**: the two should
track closely, and a large or sign-flipped divergence means a bad reading or a changed register
meaning rather than a real load event. `scripts/tools/check-flow-consistency.py` runs the
comparison over stored `readings` rows — no Modbus traffic, no service change.
`battery − meter` is also how a feedback controller gets "house demand remaining after PV"
without touching 11016 at all.

Useful extras (not yet polled): battery V/I 30254/30255, BMS charge/discharge current limits
33021/33023, inverter status 10105, model 10008. (Battery temp 33003 and SoH 33001 were added
to the poller 2026-07-02 — see the table above.)

## Control registers (verified, high confidence)

### Mode / dispatch
| Addr | Name | Type | Scale | Values / encoding |
|---|---|---|---|---|
| **50000** | Working Mode | U16 | enum | `0x101`=General (self-use/AUTO), `0x303`=EMS BattCtrl, `0x302`=EMS General, `0x301`=EMS ACCtrl, `0x400`=ToU. Write raw enum key. |
| **50207** | EMS BattCtrl power target | S16 | 0.01 kW | `raw = int(W/10)`. Sign **−=charge, +=discharge** ✅ confirmed on-device 2026-07-02 (probe: +150→+1494 W discharge, −150→−1502 W charge; tracks setpoint within ~6 W). Active only when 50000=`0x303`. |
| 50208 | Max **inverter AC output** (Pinv upper) | S16 | 0.01 kW | 0..200 kW. `raw=int(W/10)`. Set to grid cap (11 kW → 1100). **Not a meter-level export cap** — see the note below. `200` kW is the effectively-unlimited value; `0` is a real zero. |
| 50209 | Max **inverter AC input** (Pinv lower) | S16 | 0.01 kW | −200..0 kW. `raw=int(W/10)`, −11 kW → −1100. Must satisfy 50208 ≥ 50209. **Not a meter-level import cap.** `0` blocks inverter AC input outright ✅ **confirmed on the reference deployment 2026-08-07** (forced 6 kW charge against 4.06 kW PV: inverter AC went +294 W, from −1952 W with the cap open). **Only takes effect when written AFTER mode entry — see the write-order rule below.** It does NOT give you an economically solar-only charge; see the note under this table. |
| 50210 | Power output priority | U16 | enum | 0=PV, 1=Battery. PV priority preserves PV and reduces the battery's share first when output is constrained; Battery priority does the reverse and can curtail available PV. |

**50208/50209 cap the INVERTER's own AC exchange, not the site's net utility-meter flow.**
House load sits downstream of the inverter's output calculation, so the meter can show *more*
import than 50209 allows (inverter input for charging **+** house load) and *less* export than
50208 allows. Two consequences: (a) the names in this table used to say "grid export/import",
which is exactly that misreading — renamed 2026-08-05, along with the Python constants
(`REG_MAX_AC_OUTPUT`/`REG_MAX_AC_INPUT`); (b) **±11 kW here is not a fuse-level guarantee.** The
real grid-side cap registers are **50007/50009** (below), which this controller does not write —
it relies on `clamp_power_w` plus the optimizer's own grid-cap feasibility check (`gImp >
SLOT_MAX_KWH` in `lib/optimizer.ts`, which *does* count charging **+** load against the cap), so
the planner is grid-cap-aware even though the executor's clamp is on the wrong quantity. Not a
live risk while the plan sets the power figure; know it before treating 50209 as a fuse guard.

Source: a third-party reverse-engineering doc for this inverter family
([sixuniform/YOUEMS](https://github.com/sixuniform/YOUEMS), "Solinteg EMS BattCtrl", MHT firmware
9.x), cross-checked against this deployment's own probes. Verify on your own unit and firmware.

**`50209 = 0` blocks the PHYSICAL grid→battery path but NOT the ECONOMIC one — measured
2026-08-07, and it is the reason not to build a "PV-only charge" on this register.** With AC
input blocked and a charge target the sun cannot fund, the inverter allocated PV as **3764 W to
the battery + 294 W to the house**, leaving the house's remaining **454 W to come from the
grid** — while the *same* house load minutes earlier in auto was fully PV-served with 60 W left
to export. So the battery simply **outbids the house for PV**, and the house buys at the full
consumer price. The money is identical to grid-charging: energy the house would have used is
diverted to the battery and an equal amount is bought at the import price. Only the physical
path changes, and this is topology rather than firmware, so expect it to hold on your unit too.

That matters because the appeal of a hardware PV-only charge is "grid funding becomes
impossible". It does not — it becomes invisible to a meter-path check, and it is worst exactly
when solar under-delivers against the plan, which is the case such a guard is wanted for. A
software guard comparing the plan's assumed funding against live solar surplus (this
controller's `skipped_solar_shortfall`, in `dispatch_loop.py`) measures the economically real
quantity and is the stronger check. **Recommendation: don't build it.** The confirmed register
behaviour is still worth having for the battery-freeze/hold case, where blocking flow is the
actual point.

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

**⚠️ WRITE-ORDER RULE for the EMS limits (50208/50209) — confirmed on the reference deployment
2026-08-07.** A *restrictive* value written to 50209 **before** the inverter is in EMS BattCtrl
(`0x303`) is **stored but never enforced**. The probe wrote `50209 = 0` in this controller's own
order (caps → priority → power → mode) and measured a full 6 kW grid-funded charge — identical
to the uncapped control — *while 50209 read back as `0`*. Written in-mode, the same value took
effect at once.

Two consequences:
- **The readback lies.** `0` in the register does not mean `0` is in force. Any check that
  infers "the cap is applied" from a readback is unsound — including `_already_set_for()` in
  `inverter_control.py`, whose fast path keys off exactly that readback.
- **The code as shipped is unaffected, because it only ever writes SYMMETRIC ±grid-cap
  values** — the full-range value is what the inverter does anyway, so a dropped write changes
  nothing. This is latent, not live. It becomes real the moment you write an asymmetric or
  restrictive cap, at which point `force_charge`/`force_discharge` must be reordered to write
  50208/50209 **after** the `0x303` mode write. The third-party doc's full recipe: working-mode
  write FIRST, then *wait for the inverter to report EMS BattCtrl* (abort if unconfirmed),
  settle ~1 s, then priority → 50208 → 50209 → 50207.

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

**…but that is a rule about idle slots, NOT a universal one (clarified 2026-08-05).** Blocking
self-consumption is a bug on a slot with solar and the entire point on a no-solar deficit slot
sitting in front of a price peak. The deliberate version is a **hold / battery-freeze**:
`50207=0` **plus** `50208=0` **plus** `50209=0` → battery untouched, grid supplies the house.
The third-party doc above reports this holding the battery close to zero power on MHT firmware
9.x, with the caveat that PV/house/grid behaviour with *both* AC limits at zero can be firmware-
and topology-dependent and must be verified live.

This controller does **not** implement it: `Action` is `charge | discharge | idle`, and `idle`
maps to `return_to_auto`, where the inverter's own self-use logic discharges the battery to
cover any house deficit. Worth knowing that the DP nonetheless *plans* a same-SoC transition in
a deficit slot as "grid covers the house, battery holds" (`gImp = gridToBattery + lr` in
`lib/optimizer.ts`), so that intent is currently unexecutable — the battery drains instead and
the next replan simply re-plans from the lower SoC. How much that costs depends entirely on your
tariff spreads and how often you get no-solar deficit slots in front of a peak; it is smallest in
summer and grows in winter. If you add a `hold` action, add the executor half too — see
`lib/__tests__/action-contract.test.ts`, which exists because that exact gap arrived once as a
TS-only change — and make sure `restore_ac_limits` (scripts/services/inverter_control.py) runs
when leaving the state, or the zeroed caps leak into the following idle slots.

**What the 2026-08-07 probe changes here:** the `50209 = 0` half of the recipe is confirmed to
do what the doc says, so the mechanism is real — but **the write-order rule above applies to it
in full.** A freeze that writes `50208=0`/`50209=0` before entering `0x303` would **read back as
frozen and not be**, which is the worst possible failure shape for a feature whose entire point
is "the battery does not move". Write the caps after mode entry, and do not trust the readback
as proof. `50208 = 0` itself is still unprobed — the probe deliberately never wrote it, so
export stayed open and the blast radius stayed small. The economic-displacement finding under
the control-register table does **not** transfer to the freeze case: it comes from a nonzero
charge target outbidding the house for PV, and a freeze commands `50207 = 0`.

**OPEN, and worth answering before shipping any restrictive-cap mode: can the inverter's own SoC
floor still act with AC input blocked?** 52502/52503 hold an on-grid floor and the inverter actively
grid-charges back up to it when below. With `50209 = 0` (PV-only charge) or `0/0` (freeze), inverter
AC input is blocked — so the floor may be unable to do that, and a freeze near the floor could
silently defeat the one protection that does not depend on this software. Note a daylight probe
almost certainly cannot answer it: it needs the battery near the floor, which will not coincide with
a sunny afternoon. **Still open after the 2026-08-07 probe, exactly as that predicts** — it ran at
42-44 % SoC, so it had no way to observe floor behaviour. Answering it needs a contrived low-SoC
test. This now only gates the **freeze/hold** case; the PV-only charge it also gated is not worth
building regardless (see the note under the control-register table).

**A second question the probe made visible and did NOT answer: is a restrictive cap enforced at
all in General/self-use mode?** The write-order result shows the limits are only *applied* while
in `0x303`. If they are likewise only *enforced* there, then a stale `50209 = 0` left behind on
the way back to General would be inert, and `restore_ac_limits`' premise — that it would cripple
self-consumption across the following idle slots — would be belt-and-braces rather than
load-bearing. The probe restored the caps before leaving `0x303` every time, so it never tested
the stale case. Keep the restore either way: it is cheap, and being wrong about this costs a
whole overnight run of idle slots.

## ⚠️ DO NOT enable live control until confirmed on-device

| Item | Why | Probe |
|---|---|---|
| ~~**Sign of 50207**~~ ✅ DONE 2026-07-02 | Probe verdict: **neg_charge** (+150→+1494 W discharge, −150→−1502 W charge). `SOLINTEG_50207_SIGN=neg_charge` set in `/opt/solinteg/solinteg.env`. | `scripts/tools/probe_50207_sign.py` |
| ~~**Setpoint persistence**~~ ✅ DONE 2026-07-02 | Probe verdict: **PERSISTS** — 63 samples / 16 min, 0 deviations (±300 W tol); battery held −1478..−1520 W vs −1500 target, 50207 and mode never changed. Once-per-slot writes suffice. | `scripts/tools/probe_setpoint_persistence.py` |
| **50208/50209 polarity** — ✅ confirmed on the reference deployment 2026-08-07 | Verdict there: **50209 is the inverter AC INPUT cap, exactly as the Pinv sign rule says.** Under a forced 6 kW charge with PV at 4.06 kW, writing `50209 = 0` in-mode drove inverter AC from **−1952 W (absorbing from grid) to +294 W** and cut grid import from 2.76 kW to 0.45 kW, while 50208 (unchanged at +1100) left export untouched. No swapped label. **Lower-risk anyway in practice:** `inverter_control.py` always writes BOTH registers to their full symmetric range on every force-charge *and* force-discharge, so it never relies on asymmetric values and a swapped label could not restrict the wrong direction. Left in this table because that is one install — if you intend to depend on an asymmetric cap on YOUR unit, run the probe there first. Note it never wrote `50208 = 0`; the output side is confirmed only in its unrestricted value. | `scripts/tools/probe_50209_pv_only.py` |
| ~~**Model / firmware**~~ ✅ DONE 2026-07-03 | PDF originally on file was for MHT-25-50; confirmed via the physical inverter nameplate + Solinteg's official "Integ M Series" datasheet (`EN-MHT-10-20-NO1.02-2026`) that the installed unit is genuinely a **MHT-20K-40**, matching CLAUDE.md's existing assumption — a real, current, documented Solinteg product (10-20kW Hybrid Inverter family: MHT-10/12/15/20K-40, one shared spec sheet, RS485/CAN comms), not a mismatched device. Confirmed by physical label, not by register read — see the abandoned attempt below. Doesn't retroactively "prove" every register address is identical across Solinteg's model lines, but the registers that actually matter for control (50207, 50000, 52502/52503, etc.) were already empirically verified by testing them on this exact device, independent of any datasheet. | Physical nameplate on the inverter, cross-checked against Solinteg's own current datasheet |
| ~~**Reg 10008 register read**~~ ❌ ABANDONED 2026-07-03 | Attempted as the original way to confirm the model (see item above, now resolved another way). `scripts/tools/read_model_register.py` tried reg 10008 (and 10105) via both FC03 (holding) and FC04 (input) — all four reads timed out with "No response received after 3 retries." Worse: the retry-heavy attempt caused a real ~70s Modbus outage on `solinteg-poller` (timeouts then `Connection refused` from 08:10:20 to 08:11:30 UTC, self-recovered via the poller's own 30s retry — no lasting harm, but a real data point that this dongle handles an unfamiliar/failing register request badly, likely by wedging its single connection slot until its own internal timeout clears). Registers in the 1xxxx block may simply not be exposed on this firmware/dongle combination. **Do not retry without a good reason** — this dongle has now twice given a reason (this outage, plus the already-known single-connection limit) to be conservative about ad hoc Modbus reads. | `scripts/tools/read_model_register.py` — kept for reference, not for routine use |
| ~~**Battery-model precondition (52500)**~~ ✅ DONE 2026-07-02 | Confirmed as a side effect of the probes: force_charge/force_discharge engaged EMS BattCtrl and controlled power correctly across both probes without 52500 ever being touched. | (observed during `probe_50207_sign.py` / `probe_setpoint_persistence.py`) |
| ~~**50207 = battery-only vs. total inverter AC (PV+battery)**~~ ✅ CONFIRMED battery-only 2026-07-13 | A third-party reverse-engineering doc (github.com/sixuniform/YOUEMS, "Solinteg EMS BattCtrl", MHT firmware 9.x, Pylontech HV battery) claims 50207 is actually a **total inverter AC output target** (PV+battery combined, allocated between them by the priority register), not a pure battery-power register — which would mean commanding a charge while PV is producing overcharges by roughly the live PV amount. Re-examined the existing 2026-07-02 setpoint-persistence probe's own logged telemetry (never previously cross-checked against concurrent PV): across 31 samples over 16 min with **PV actively producing 946–1138 W** throughout (PV priority mode), battery power held tight to target (−1487..−1521 W vs −1500 target, ±21 W) while PV+battery combined — the figure the doc's "total AC" model predicts would be the one pinned to target instead — wandered −350..−563 W, nowhere near −1500. That's the opposite of what the doc's model predicts, and confirms 50207 is battery-only on this unit/firmware, independent of concurrent PV. The doc's claim doesn't transfer to this install (different MHT sub-model/firmware point release, unclear why — not worth chasing). **No code changes needed.** **Resolved for real 2026-08-05: the doc was simply wrong, and its author has since corrected it.** Its 2026-08-02 revision now *leads* with "Most important correction: Register 50207 controls requested battery charge/discharge power, not total inverter AC power. Positive requests battery discharge; negative requests battery charge." So this was never a model/firmware difference — the 2026-07-13 re-derivation was right, and the corrected doc is now independent confirmation of it from a second install (MHT-10K-25, firmware 9.x, Pylontech Force H3). The "unclear why" above is retired. | Re-derived from existing `readings` rows, 2026-07-02, `work_mode_raw=771` — no new on-device test required |
| **50208/50209 write-order relative to mode entry** — ✅ **the doc is right**, confirmed on the reference deployment 2026-08-07 | The third-party doc claims these only take effect if written *after* 50000 enters EMS BattCtrl (`0x303`); this controller writes them *before*. Verdict: **the doc is correct.** A restrictive cap written pre-mode is stored but never enforced — `50209 = 0` in this controller's own order produced a full grid-funded 6 kW charge, indistinguishable from the uncapped control, *while the register read back as 0*. So `_already_set_for()`'s readback-keyed fast path provably cannot verify enforcement. **Not a live bug**: only symmetric ±grid-cap values are ever written, which is what the inverter does anyway, so a dropped write changes nothing — and the `50209 = 0` PV-only charge that would have been the first asymmetric case is not worth building (see the note under the control-register table). Full detail and the corrected write order are in "Control sequences". | `scripts/tools/probe_50209_pv_only.py` |

## Software-only invariants (the inverter does not enforce these for us)

- **No charge-target-SoC register exists** → the controller must stop charging in software
  when SoC reaches the target ceiling.
- **No ToU upload** → drive every 15-min slot live via 50207; there is no schedule register.
- Clamp power to `min(battery 15.36 kW, grid 11 kW)` **before** encoding.
- On crash/shutdown/timeout → always write `50000=0x101` (revert to auto).
