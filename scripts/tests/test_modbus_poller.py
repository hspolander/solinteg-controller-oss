"""Tests for scripts/services/modbus_poller.py's register decoding — the pure arithmetic that
turns raw Modbus U16 pairs into every power figure the rest of the system consumes.

Why this file exists (added 2026-08-09): modbus_poller.py had ZERO coverage, and it is the
source of `readings`, which everything downstream is derived from — economics, the oracle's
hindsight scoring, the dispatch loop's live-load tracking, the chart's actual-vs-plan overlay.
s32() in particular is a hand-rolled two's-complement sign extension guarding a boundary
(0x80000000) that is exactly where this kind of function goes wrong, and its output decides
whether the house is IMPORTING or EXPORTING and whether the battery is CHARGING or
DISCHARGING. A sign bug there would not crash anything; it would silently invert the meaning of
the entire dataset, including the history already on disk.

Run: py -m unittest scripts.tests.test_modbus_poller -v   (from the repo root)
     or: py -m unittest discover -s scripts/tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

from fakes import FakeModbusClient, FakeModbusResult, install_pymodbus_stub  # noqa: E402

install_pymodbus_stub()

import modbus_poller as mp  # noqa: E402


def split32(value: int) -> tuple[int, int]:
    """A signed 32-bit value as the (high, low) U16 register pair the inverter would send."""
    raw = value & 0xFFFFFFFF
    return (raw >> 16) & 0xFFFF, raw & 0xFFFF


class S32Tests(unittest.TestCase):
    """Two U16 registers -> signed S32, big-endian, high word first."""

    def test_zero(self):
        self.assertEqual(mp.s32(0x0000, 0x0000), 0)

    def test_small_positive(self):
        self.assertEqual(mp.s32(0x0000, 0x0001), 1)

    def test_minus_one_is_all_ones(self):
        self.assertEqual(mp.s32(0xFFFF, 0xFFFF), -1)

    def test_largest_positive_is_not_sign_extended(self):
        # 0x7FFFFFFF is the last value that must stay POSITIVE. Off-by-one here (>= vs >)
        # would flip the whole top half of the range negative.
        self.assertEqual(mp.s32(0x7FFF, 0xFFFF), 0x7FFFFFFF)

    def test_sign_boundary_flips_at_0x80000000(self):
        # The first value that must go negative — the exact boundary the implementation tests.
        self.assertEqual(mp.s32(0x8000, 0x0000), -0x80000000)

    def test_realistic_export_stays_positive(self):
        # reg 11000: +ve = export. 4.38 kW exporting.
        self.assertEqual(mp.s32(*split32(4380)), 4380)

    def test_realistic_import_comes_back_negative(self):
        # -ve = import. 2.71 kW drawn from the grid.
        self.assertEqual(mp.s32(*split32(-2710)), -2710)

    def test_realistic_battery_charge_is_negative(self):
        # reg 30258: -ve = charging (MODBUS.md). Sign here decides charge vs discharge.
        self.assertEqual(mp.s32(*split32(-5000)), -5000)

    def test_round_trips_across_the_whole_range(self):
        for v in (-0x80000000, -70000, -65536, -65535, -1, 0, 1, 65535, 65536, 70000, 0x7FFFFFFF):
            with self.subTest(v=v):
                self.assertEqual(mp.s32(*split32(v)), v)


class U32Tests(unittest.TestCase):
    """PV power (reg 11028) is unsigned — it must NOT sign-extend."""

    def test_zero(self):
        self.assertEqual(mp.u32(0x0000, 0x0000), 0)

    def test_realistic_pv(self):
        self.assertEqual(mp.u32(0x0000, 6080), 6080)

    def test_high_bit_set_stays_positive(self):
        # The one behaviour that distinguishes u32 from s32: 0x80000000 is a large positive
        # number here, not -2147483648. Using s32 for PV would report a huge negative.
        self.assertEqual(mp.u32(0x8000, 0x0000), 0x80000000)

    def test_all_ones_is_max_u32(self):
        self.assertEqual(mp.u32(0xFFFF, 0xFFFF), 0xFFFFFFFF)


def seed_client(
    grid_w: int = 4380,
    inverter_ac_w: int = 6100,
    pv_w: int = 6080,
    battery_w: int = -5000,
    soc_raw: int = 9900,
    soh_raw: int = 9800,
    temp_raw: int = 290,
    work_mode_raw: int = 0x101,
) -> FakeModbusClient:
    """A fake inverter holding one consistent set of readings, addressed exactly as
    read_inverter's four block reads expect (see MODBUS.md for the register map)."""
    c = FakeModbusClient("test-host")
    c.regs[11000], c.regs[11001] = split32(grid_w)
    c.regs[11016], c.regs[11017] = split32(inverter_ac_w)
    c.regs[11028], c.regs[11029] = split32(pv_w)
    c.regs[30258], c.regs[30259] = split32(battery_w)
    c.regs[33000] = soc_raw
    c.regs[33001] = soh_raw
    c.regs[33003] = temp_raw  # 33002 is unused/reserved
    c.regs[50000] = work_mode_raw
    return c


class ReadInverterTests(unittest.TestCase):
    """The register -> field mapping as a whole. A block read at the wrong offset, or two
    fields swapped, decodes into plausible-looking numbers — nothing downstream would reject
    them — so the mapping itself is worth pinning, not just the arithmetic under it."""

    def test_decodes_every_field(self):
        data = mp.read_inverter(seed_client())
        self.assertEqual(data["grid_w"], 4380)
        self.assertEqual(data["inverter_ac_w"], 6100)
        self.assertEqual(data["pv_w"], 6080)
        self.assertEqual(data["battery_w"], -5000)
        self.assertEqual(data["work_mode_raw"], 0x101)

    def test_scaling_of_soc_soh_and_temperature(self):
        data = mp.read_inverter(seed_client(soc_raw=9900, soh_raw=9800, temp_raw=290))
        self.assertEqual(data["soc_pct"], 99.0)   # raw * 0.01
        self.assertEqual(data["soh_pct"], 98.0)   # raw * 0.01
        self.assertEqual(data["battery_temp_c"], 29.0)  # raw * 0.1

    def test_soc_kwh_is_derived_from_the_configured_capacity(self):
        data = mp.read_inverter(seed_client(soc_raw=5000))  # 50%
        self.assertAlmostEqual(data["soc_kwh"], mp.BATTERY_KWH * 0.5, places=3)

    def test_house_load_is_derived_not_read(self):
        # house_load = inverter AC output - meter power. There is no register for it; getting
        # this subtraction backwards would invert the house's apparent consumption.
        data = mp.read_inverter(seed_client(grid_w=4380, inverter_ac_w=6100))
        self.assertEqual(data["house_load_w"], 6100 - 4380)

    def test_house_load_while_importing(self):
        # Importing (grid_w negative) must ADD to the house load, not subtract.
        data = mp.read_inverter(seed_client(grid_w=-2710, inverter_ac_w=0))
        self.assertEqual(data["house_load_w"], 2710)

    def test_known_work_mode_is_named(self):
        data = mp.read_inverter(seed_client(work_mode_raw=0x303))
        self.assertEqual(data["work_mode"], "EMS BattCtrl")

    def test_unknown_work_mode_falls_back_to_hex_rather_than_dropping_it(self):
        # An unrecognised mode must stay visible (and greppable) instead of becoming None —
        # the raw value is the only clue if the inverter ever reports something undocumented.
        data = mp.read_inverter(seed_client(work_mode_raw=0x999))
        self.assertEqual(data["work_mode"], "Unknown(0x999)")
        self.assertEqual(data["work_mode_raw"], 0x999)

    def test_timestamp_is_utc_iso(self):
        data = mp.read_inverter(seed_client())
        self.assertTrue(data["timestamp"].endswith("+00:00"), data["timestamp"])

    def test_a_failed_block_read_raises_rather_than_logging_a_partial_row(self):
        # Every block is checked with isError(). A silently-partial reading would be written
        # to `readings` as if it were real and pollute every derived figure after it.
        for failing_addr in (11000, 30258, 33000, 50000):
            with self.subTest(addr=failing_addr):
                c = seed_client()
                real_read = c.read_holding_registers

                def read(addr, count=1, device_id=1, _fail=failing_addr, _real=real_read):
                    if addr == _fail:
                        return FakeModbusResult(error=True)
                    return _real(addr, count=count, device_id=device_id)

                c.read_holding_registers = read
                with self.assertRaises(IOError):
                    mp.read_inverter(c)


if __name__ == "__main__":
    unittest.main()
