#!/usr/bin/env python3
"""
Sends one ntfy push notification per boot, so a NUC that lost power and came back on its
own (BIOS "power on after AC loss") is visible instead of silent. Also the simplest possible
proof the auto-reboot config (deploy/README.md's resilience section) actually completed.

Run once per boot via deploy/solinteg-boot-notify.service (WantedBy=multi-user.target, no
timer — systemd runs oneshot services with no [Install] timer exactly once per boot).
"""
import platform
import socket
import sys
from datetime import datetime, timezone

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import notify  # noqa: E402


def main() -> int:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    host = socket.gethostname()
    kernel = platform.release()
    notify.send(
        "Solinteg: NUC booted",
        f"{host} came up at {now} (kernel {kernel}). If this wasn't a planned reboot, the "
        f"box recovered from a power loss or crash on its own.",
        priority=notify.PRIORITY_DEFAULT,
        tags=["arrows_counterclockwise"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
