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

Uses `rclone sync` (not `copy`), so the remote mirrors BACKUP_DIR's own rotation.

ON BACKBLAZE B2 THAT IS NOT ENOUGH BY ITSELF, and this file used to claim otherwise. B2 buckets
are versioned, and rclone's B2 backend HIDES a deleted file rather than removing it — the bytes
stay, and stay billable, forever. So the nightly rotation looked like a steady 21 files while the
bucket actually grew by one whole snapshot every night. The reference deployment hit 100 % of the
free 10 GB storage cap on 2026-09-03 this way, with a bucket that listed 21 files.

Two things are needed, and only together:

  1. `--b2-hard-delete` below, so rclone deletes versions instead of hiding them. Stops the
     growth, but does nothing about versions already accumulated.
  2. A LIFECYCLE RULE on the bucket — "Keep only the last version of the file" in the B2
     console. This is what actually reclaims the backlog, and it cannot be set from here: the
     credentials live in solinteg.env and are root-only by design. See deploy/README.md §12d.

The flag is applied only when the destination really is a B2 remote, so this file stays honest
for the other backends rclone supports.

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

import notify  # sibling module (scripts/services/) — script dir is sys.path[0]

log = logging.getLogger("solinteg.backup_offsite")

BACKUP_DIR = os.environ.get("BACKUP_DIR", "/opt/solinteg/backups")
RCLONE_OFFSITE_DEST = os.environ.get("RCLONE_OFFSITE_DEST", "")
RCLONE_BIN = os.environ.get("RCLONE_BIN", "rclone")


def is_b2_dest(dest: str) -> bool:
    """True when `dest` names an rclone remote configured as type b2.

    The remote's type comes from the same RCLONE_CONFIG_<NAME>_TYPE variable rclone itself reads,
    so this cannot disagree with what rclone will actually do. A bare local path (no colon, or a
    remote with no configured type) is not B2.
    """
    remote, _, _ = dest.partition(":")
    if not remote or ":" not in dest:
        return False
    return os.environ.get(f"RCLONE_CONFIG_{remote.upper()}_TYPE", "").strip().lower() == "b2"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not RCLONE_OFFSITE_DEST:
        log.warning("RCLONE_OFFSITE_DEST not set — skipping offsite sync")
        return 0

    # See the module docstring: without this, every rotated-out snapshot lives on as a hidden
    # version and the bucket grows without bound.
    flags = ["--b2-hard-delete"] if is_b2_dest(RCLONE_OFFSITE_DEST) else []

    try:
        result = subprocess.run(
            [RCLONE_BIN, "sync", *flags, BACKUP_DIR, RCLONE_OFFSITE_DEST],
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

    log.info(
        "offsite sync ok: %s -> %s%s",
        BACKUP_DIR, RCLONE_OFFSITE_DEST, " (hard-delete)" if flags else "",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
