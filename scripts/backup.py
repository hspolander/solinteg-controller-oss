#!/usr/bin/env python3
"""
Nightly local backup of telemetry.db and solinteg.env, with rotation.

Uses sqlite3's built-in online backup API (Connection.backup()) rather than shelling out to
`sqlite3 .backup` or copying the file directly — it's the one method that's safe to run against
a live WAL-mode database with other processes writing to it concurrently (the poller and web app
never stop), matching the "concurrent access" comment already on the WAL pragma in
lib/telemetry.ts.

This is LOCAL-only rotation (protects against DB corruption, a bad deploy, or a botched query —
not against disk/hardware failure). For offsite protection, periodically pull BACKUP_DIR over
Tailscale to another machine — see deploy/README.md's resilience section; that step needs
your own destination/credentials, so it isn't automated here.

Run nightly via deploy/solinteg-backup.timer (Persistent=true, so a backup missed because the
NUC was powered off catches up on the next boot instead of silently skipping a night).

Environment:
  TELEMETRY_DB_PATH   source DB (default /opt/solinteg/telemetry.db)
  BACKUP_DIR           destination directory (default /opt/solinteg/backups)
  BACKUP_KEEP           how many nightly snapshots to retain (default 21 - about 3 weeks)
"""
import logging
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify  # noqa: E402

log = logging.getLogger("solinteg.backup")

DB_PATH = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/opt/solinteg/backups"))
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "21"))
ENV_PATH = Path("/opt/solinteg/solinteg.env")


def backup_database(stamp: str) -> Path:
    dest = BACKUP_DIR / f"telemetry-{stamp}.db"
    src = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return dest


def backup_env(stamp: str) -> Path | None:
    if not ENV_PATH.exists():
        return None
    dest = BACKUP_DIR / f"solinteg.env-{stamp}.bak"
    shutil.copy2(ENV_PATH, dest)
    os.chmod(dest, 0o600)
    return dest


def prune(pattern: str, keep: int) -> int:
    matches = sorted(BACKUP_DIR.glob(pattern))
    stale = matches[:-keep] if keep > 0 else matches
    for path in stale:
        path.unlink()
    return len(stale)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    try:
        db_dest = backup_database(stamp)
        env_dest = backup_env(stamp)
    except (OSError, sqlite3.Error) as exc:
        log.error("backup failed: %s", exc)
        notify.send("Solinteg: nightly backup FAILED", str(exc), priority=notify.PRIORITY_HIGH)
        return 1

    removed_db = prune("telemetry-*.db", BACKUP_KEEP)
    removed_env = prune("solinteg.env-*.bak", BACKUP_KEEP)

    size_mb = db_dest.stat().st_size / 1e6
    log.info(
        "backup ok: %s (%.1f MB)%s; pruned %d old db + %d old env backups",
        db_dest.name, size_mb, "" if env_dest else " (no solinteg.env found)",
        removed_db, removed_env,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
