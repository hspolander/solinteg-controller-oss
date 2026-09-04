#!/usr/bin/env python3
"""
Nightly local backup of telemetry.db and solinteg.env, with rotation. Snapshots are gzipped.

Uses sqlite3's built-in online backup API (Connection.backup()) rather than shelling out to
`sqlite3 .backup` or copying the file directly — it's the one method that's safe to run against
a live WAL-mode database with other processes writing to it concurrently (the poller and web app
never stop), matching the "concurrent access" comment already on the WAL pragma in
lib/telemetry/.

Snapshots are written as `telemetry-<stamp>.db.gz` (compression added 2026-09-03, when the
offsite mirror hit Backblaze's free storage cap). Telemetry rows compress to roughly a quarter
of their size, which cuts both this directory and the offsite bill by the same factor. To
restore:

    gunzip -c telemetry-20260903-031500.db.gz > telemetry.db

Rotation matches `telemetry-*.db*`, so uncompressed snapshots written before that change are
still rotated out normally rather than sitting there forever beside the new ones.

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
import gzip
import logging
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import notify  # sibling module (scripts/services/) — script dir is sys.path[0]

log = logging.getLogger("solinteg.backup")

DB_PATH = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/opt/solinteg/backups"))
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "21"))
ENV_PATH = Path("/opt/solinteg/solinteg.env")


def clear_partials() -> int:
    """Remove intermediates left by a crashed run.

    They can never be mistaken for a snapshot — the prune glob requires the `telemetry-` prefix
    and these do not have it — but a backup that crashed the same way every night would quietly
    fill the disk with them, which is the failure this prevents.
    """
    stale = list(BACKUP_DIR.glob("partial-*.db"))
    for path in stale:
        path.unlink(missing_ok=True)
    return len(stale)


def backup_database(stamp: str) -> tuple[Path, int]:
    """Online-backup the live DB and gzip it. Returns (compressed path, uncompressed bytes).

    Two steps, because sqlite3's backup API needs a real file to write into — it cannot stream
    into a compressor. The intermediate is named `partial-*` rather than `telemetry-*` so that a
    crash mid-run cannot leave something rotation counts as a snapshot (see clear_partials).

    Compression is worth the extra step: telemetry rows are highly repetitive and gzip takes them
    to roughly a quarter of their size, which is a 4x cut in both the local backup directory and
    whatever the offsite mirror is billing for.
    """
    partial = BACKUP_DIR / f"partial-{stamp}.db"
    dest = BACKUP_DIR / f"telemetry-{stamp}.db.gz"
    try:
        src = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        try:
            dst = sqlite3.connect(str(partial))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        raw_bytes = partial.stat().st_size
        # mtime=0 keeps the gzip header free of a timestamp, so identical input gives an identical
        # file. Nothing depends on that today; it costs nothing and makes the output reproducible.
        with open(partial, "rb") as f_in:
            with gzip.GzipFile(dest, "wb", compresslevel=6, mtime=0) as f_out:
                shutil.copyfileobj(f_in, f_out)
    finally:
        partial.unlink(missing_ok=True)
    return dest, raw_bytes


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
    orphaned = clear_partials()

    try:
        db_dest, raw_bytes = backup_database(stamp)
        env_dest = backup_env(stamp)
    except (OSError, sqlite3.Error) as exc:
        log.error("backup failed: %s", exc)
        notify.send("Solinteg: nightly backup FAILED", str(exc), priority=notify.PRIORITY_HIGH)
        return 1

    # `telemetry-*.db*` matches BOTH the old uncompressed snapshots and the new .db.gz ones, so
    # rotation keeps the newest BACKUP_KEEP across the changeover instead of letting one naming
    # scheme accumulate untouched beside the other. Filenames start with the timestamp, so a
    # lexical sort is chronological regardless of extension.
    removed_db = prune("telemetry-*.db*", BACKUP_KEEP)
    removed_env = prune("solinteg.env-*.bak", BACKUP_KEEP)

    size_mb = db_dest.stat().st_size / 1e6
    ratio = db_dest.stat().st_size / raw_bytes if raw_bytes else 0
    log.info(
        "backup ok: %s (%.1f MB, %.0f%% of %.1f MB raw)%s; pruned %d old db + %d old env%s",
        db_dest.name, size_mb, ratio * 100, raw_bytes / 1e6,
        "" if env_dest else " (no solinteg.env found)",
        removed_db, removed_env,
        f"; cleared {orphaned} orphaned partial(s)" if orphaned else "",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
