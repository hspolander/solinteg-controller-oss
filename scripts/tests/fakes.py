"""Test-only fakes. `pymodbus` is a NUC-only runtime dependency (see scripts/requirements.txt)
and isn't expected to be installed in a plain dev environment — inverter_control.py hard-exits
at import time if it's missing (see its own module docstring). install_pymodbus_stub() injects
a minimal fake into sys.modules so inverter_control.py (and anything importing it, e.g.
dispatch_loop.py) can be imported and exercised without the real dependency. Must be called
before the first `import inverter_control` / `import dispatch_loop` in any test process.
"""
import sys
import types


class FakeModbusResult:
    def __init__(self, registers=None, error=False):
        self.registers = registers or []
        self._error = error

    def isError(self):
        return self._error


class FakeModbusClient:
    """Records every read/write so tests can assert on call order and register state
    without a real inverter. `regs` maps address -> raw u16 (two's-complement already
    applied, matching what write_u16 actually sends over the wire)."""

    def __init__(self, host, port=502, timeout=5):
        self.host = host
        self.port = port
        self.connected = False
        self.regs: dict[int, int] = {}
        self.calls: list[tuple] = []

    def connect(self):
        self.connected = True
        return True

    def close(self):
        self.connected = False

    def read_holding_registers(self, addr, count=1, device_id=1):
        self.calls.append(("read", addr, count))
        return FakeModbusResult([self.regs.get(addr + i, 0) for i in range(count)])

    def write_register(self, addr, value, device_id=1):
        self.calls.append(("write", addr, value))
        self.regs[addr] = value & 0xFFFF
        return FakeModbusResult()

    def write_calls(self):
        """Just the (addr, value) pairs actually written, in order — the shape most
        tests care about."""
        return [(addr, value) for kind, addr, value in self.calls if kind == "write"]


def install_pymodbus_stub() -> None:
    if getattr(sys.modules.get("pymodbus"), "_is_test_stub", False):
        return  # already installed this process

    pymodbus_mod = types.ModuleType("pymodbus")
    pymodbus_mod._is_test_stub = True
    client_mod = types.ModuleType("pymodbus.client")
    exceptions_mod = types.ModuleType("pymodbus.exceptions")

    class ModbusException(Exception):
        pass

    client_mod.ModbusTcpClient = FakeModbusClient
    exceptions_mod.ModbusException = ModbusException

    sys.modules["pymodbus"] = pymodbus_mod
    sys.modules["pymodbus.client"] = client_mod
    sys.modules["pymodbus.exceptions"] = exceptions_mod
