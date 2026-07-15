#!/usr/bin/env python3
"""
Offsite mirror of the local nightly backup, via rclone to a cloud remote (e.g. Backblaze B2).

backup.py's own local rotation only protects against DB corruption or a bad deploy — not disk
or hardware failure, since it writes to the same disk. This script closes that gap by mirroring
BACKUP_DIR to a remote rclone destination on the same nightly cadence.

rclone needs no config file here: its remote credentials are supplied entirely via
RCLONE_CONFIG_<REMOTE>_* environment variables (rclone's own supported mechanism), read from
solinteg.env (600-permissioned, already the home for every other secret in this deployment) via
systemd's EnvironmentFile=. E.g. for a remote named "b2" referenced as RCLONE_OFFSITE_DEST=b2:my-bucket:
  RCLONE_CONFIG_B2_TYPE=b2
  RCLONE_CONFIG_B2_ACCOUNT=<application key id>
  RCLONE_CONFIG_B2_KEY=<application key>

Uses `rclone sync` (not `copy`), so the remote mirrors BACKUP_DIR's own rotation — nothing
accumulates offsite beyond what's already kept locally.

Environment:
  BACKUP_DIR           source directory (default /opt/solinteg/backups)
  RCLONE_OFFSITE_DEST  rclone destination, e.g. "b2:your-bucket-name" (required; skips with a
                       warning, not a failure, if unset — mirrors NTFY_TOPIC/HEALTHCHECKS_PING_URL's
                       "optional layer" convention)
  RCLONE_BIN           path to the rclone binary (default "rclone")
"""
import logging
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify  # noqa: E402

log = logging.getLogger("solinteg.backup_offsite")

BACKUP_DIR = os.environ.get("BACKUP_DIR", "/opt/solinteg/backups")
RCLONE_OFFSITE_DEST = os.environ.get("RCLONE_OFFSITE_DEST", "")
RCLONE_BIN = os.environ.get("RCLONE_BIN", "rclone")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not RCLONE_OFFSITE_DEST:
        log.warning("RCLONE_OFFSITE_DEST not set — skipping offsite sync")
        return 0

    try:
        result = subprocess.run(
            [RCLONE_BIN, "sync", BACKUP_DIR, RCLONE_OFFSITE_DEST],
            capture_output=True, text=True, timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.error("offsite sync failed to run: %s", exc)
        notify.send("Solinteg: offsite backup FAILED", str(exc), priority=notify.PRIORITY_HIGH)
        return 1

    if result.returncode != 0:
        log.error("rclone sync failed (exit %d): %s", result.returncode, result.stderr.strip())
        notify.send(
            "Solinteg: offsite backup FAILED",
            f"rclone exit {result.returncode}: {result.stderr.strip()[:500]}",
            priority=notify.PRIORITY_HIGH,
        )
        return 1

    log.info("offsite sync ok: %s -> %s", BACKUP_DIR, RCLONE_OFFSITE_DEST)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
