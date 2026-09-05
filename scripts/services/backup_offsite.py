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

THAT CUTS BOTH WAYS: sync makes the destination match the source, deleting whatever else is
there. Two consequences, one guarded here and one that cannot be:

  * An EMPTY source directory is not "nothing to do" — it is an instruction to delete every
    offsite copy, and it would fire precisely when the offsite copy is the only one left (a
    wiped or unmounted BACKUP_DIR, or a backup.py that has been failing). So a source with no
    snapshots in it is refused. See has_snapshots.
  * If RCLONE_OFFSITE_DEST names a BUCKET ROOT, anything else stored in that bucket by any other
    tool is deleted as extraneous on the next run — permanently, given --b2-hard-delete. The
    bucket then belongs to this deployment alone. Point a second application at its own bucket
    (B2's free tier is per account, not per bucket) rather than at a prefix in this one; a prefix
    is only safe if THIS destination moves under a prefix too. That is warned about nightly
    rather than refused, so that upgrading cannot break a working backup — but syncing into a
    prefix is the better setup if you are configuring this from scratch.

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

THE OVER-CAP DEADLOCK, and RCLONE_DELETE_BEFORE
-----------------------------------------------
Once the destination is over its storage cap, this sync cannot dig itself out, and that is worth
understanding before assuming a shrinking local directory will fix a full bucket on its own.
`rclone sync` deletes at the destination only if the run was otherwise clean — over the cap,
every upload returns 403 and rclone reports `not deleting files as there were IO errors`. So the
deletions that would free space are precisely the ones it refuses to perform. Rotation, retention
changes and compression all become invisible to the remote: the bucket stays full, every night,
and the failure notification says the same thing each time. The reference deployment sat in this
state for two days after its cap alert, with a bucket still listing the pre-compression filenames
while every new .gz upload was rejected — the giveaway is a remote whose current files are the
OLD naming scheme.

`RCLONE_DELETE_BEFORE=1` breaks it by passing `--delete-before`, so obsolete remote files are
removed first and the uploads then have room. It is deliberately NOT the default: it opens a
window in which a file exists in neither its old nor its new form at the destination, and if the
upload then fails the offsite copy is thinner than it was. That is an acceptable trade only when
the LOCAL copies are known good, which makes it a deliberate, one-off recovery action rather than
a setting. Run it as a one-off without editing solinteg.env:

    sudo systemd-run --collect --wait --pipe --uid=solinteg \
      -p EnvironmentFile=/opt/solinteg/solinteg.env -E RCLONE_DELETE_BEFORE=1 \
      /opt/solinteg/app/.venv/bin/python /opt/solinteg/app/scripts/services/backup_offsite.py

(The credentials stay in the env file; only the flag is on the command line.) Pair it with
scripts/tools/compress-backup-backlog.sh, which is usually the reason the remote has obsolete
files to delete in the first place.

Environment:
  BACKUP_DIR           source directory (default /opt/solinteg/backups)
  RCLONE_OFFSITE_DEST  rclone destination, e.g. "b2:your-bucket-name" (required; skips with a
                       warning, not a failure, if unset — mirrors NTFY_TOPIC/HEALTHCHECKS_PING_URL's
                       "optional layer" convention)
  RCLONE_BIN           path to the rclone binary (default "rclone")
  RCLONE_DELETE_BEFORE "1" to delete at the destination before uploading — recovery only, see
                       above. Unset by default and must not be left set.
"""
import logging
import os
import subprocess
from pathlib import Path

import notify  # sibling module (scripts/services/) — script dir is sys.path[0]

log = logging.getLogger("solinteg.backup_offsite")

BACKUP_DIR = os.environ.get("BACKUP_DIR", "/opt/solinteg/backups")
RCLONE_OFFSITE_DEST = os.environ.get("RCLONE_OFFSITE_DEST", "")
RCLONE_BIN = os.environ.get("RCLONE_BIN", "rclone")

# RECOVERY LEVER, off by default. See the module docstring's "the over-cap deadlock" section.
DELETE_BEFORE = os.environ.get("RCLONE_DELETE_BEFORE", "").strip().lower() in ("1", "true", "yes")

# What a snapshot looks like, for the "is there anything to mirror" check below. Same pattern
# backup.py rotates on, so the two cannot disagree about what counts.
SNAPSHOT_GLOB = "telemetry-*.db*"


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


def has_snapshots(directory: str) -> bool:
    """True when the source holds at least one snapshot to mirror.

    THIS IS A DATA-LOSS GUARD, not a tidiness check. `rclone sync` makes the destination match
    the source: an empty source directory is not "nothing to do", it is an instruction to delete
    every offsite copy. That would fire in exactly the situation where the offsite copy is the
    only one left — a wiped or unmounted BACKUP_DIR, or a backup.py that has been failing.
    """
    return any(Path(directory).glob(SNAPSHOT_GLOB))


def warn_if_bucket_root(dest: str) -> bool:
    """Warn when `dest` is a bucket root rather than a path inside one. Returns True if it is.

    A warning and not a refusal, deliberately: an existing deployment may already be syncing to
    a bucket root, and breaking a working backup on upgrade is worse than the hazard. New setups
    should sync into a prefix.

    The hazard is worth restating once a night: syncing to a bucket ROOT means anything else
    stored in that bucket, by any other tool, gets deleted as "extraneous" on the next run —
    permanently, given --b2-hard-delete. So the bucket belongs to this deployment alone. A second
    application wanting offsite backups needs its own bucket, or this one has to move under a
    prefix first.
    """
    remote, sep, path = dest.partition(":")
    if not sep:
        return False
    bucket, _, prefix = path.partition("/")
    if bucket and not prefix.strip("/"):
        log.warning(
            "RCLONE_OFFSITE_DEST '%s' is a bucket ROOT — this sync deletes anything else stored "
            "in that bucket. Do not let another tool write to it.", dest,
        )
        return True
    return False


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not RCLONE_OFFSITE_DEST:
        log.warning("RCLONE_OFFSITE_DEST not set — skipping offsite sync")
        return 0

    warn_if_bucket_root(RCLONE_OFFSITE_DEST)

    if not has_snapshots(BACKUP_DIR):
        msg = (
            f"no snapshots matching {SNAPSHOT_GLOB} in {BACKUP_DIR} — refusing to sync, because "
            "that would delete the offsite copies too. Check solinteg-backup.service first."
        )
        log.error("%s", msg)
        notify.send("Solinteg: offsite backup REFUSED", msg, priority=notify.PRIORITY_HIGH)
        return 1

    # See the module docstring: without this, every rotated-out snapshot lives on as a hidden
    # version and the bucket grows without bound.
    flags = ["--b2-hard-delete"] if is_b2_dest(RCLONE_OFFSITE_DEST) else []
    if DELETE_BEFORE:
        flags.append("--delete-before")
        log.warning(
            "RCLONE_DELETE_BEFORE is set — deleting at the destination BEFORE uploading. "
            "Recovery mode; do not leave this set in solinteg.env."
        )

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
