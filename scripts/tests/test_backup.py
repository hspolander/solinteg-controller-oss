"""Tests for scripts/services/backup.py and backup_offsite.py.

Both were changed 2026-09-03 after the offsite mirror hit 100% of Backblaze's free 10 GB storage
cap while the bucket listed only 21 files. B2 is versioned and rclone's B2 backend HIDES a
deleted file rather than removing it, so the nightly rotation was propagating deletes that B2
kept billing for — one whole snapshot per night, forever.

Two things are pinned here, because both are the kind of quiet mistake that only shows up as a
bill or a missing backup months later:

  1. The rotation glob. Compression renamed snapshots from `.db` to `.db.gz`, and the old glob
     (`telemetry-*.db`) would not have matched the new names — rotation would have silently
     stopped, growing the directory without bound while reporting success. The pair of naming
     schemes must rotate as one list across the changeover.

  2. is_b2_dest(). It decides whether `--b2-hard-delete` is passed. Wrong in one direction the
     accumulation bug comes back; wrong in the other, rclone gets a B2 flag for a non-B2 remote.

Run: py -m unittest scripts.tests.test_backup -v   (from the repo root)
"""
import gzip
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services"))

import backup  # noqa: E402
import backup_offsite  # noqa: E402


class PruneTests(unittest.TestCase):
    """The rotation glob, across the .db -> .db.gz changeover."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.object(backup, "BACKUP_DIR", self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def touch(self, *names):
        for n in names:
            (self.dir / n).write_bytes(b"x")

    def names(self):
        return sorted(p.name for p in self.dir.iterdir())

    def test_keeps_newest_across_both_naming_schemes(self):
        # Filenames lead with the timestamp, so a lexical sort is chronological even though the
        # extensions differ. Keeping 2 must keep the two NEWEST, not the two gzipped ones.
        self.touch(
            "telemetry-20260901-031500.db",
            "telemetry-20260902-031500.db",
            "telemetry-20260903-031500.db.gz",
            "telemetry-20260904-031500.db.gz",
        )
        removed = backup.prune("telemetry-*.db*", 2)
        self.assertEqual(removed, 2)
        self.assertEqual(
            self.names(),
            ["telemetry-20260903-031500.db.gz", "telemetry-20260904-031500.db.gz"],
        )

    def test_old_uncompressed_snapshots_are_rotated_out_not_stranded(self):
        # The regression the glob change exists to prevent: with `telemetry-*.db` these four .gz
        # files would never have matched, and nothing would ever have been deleted.
        self.touch(*[f"telemetry-2026090{i}-031500.db.gz" for i in range(1, 5)])
        self.touch("telemetry-20260801-031500.db")
        removed = backup.prune("telemetry-*.db*", 2)
        self.assertEqual(removed, 3)
        self.assertNotIn("telemetry-20260801-031500.db", self.names())

    def test_partials_are_never_treated_as_snapshots(self):
        self.touch("telemetry-20260903-031500.db.gz", "partial-20260904-031500.db")
        backup.prune("telemetry-*.db*", 1)
        self.assertIn("partial-20260904-031500.db", self.names())

    def test_clear_partials_removes_crash_leftovers(self):
        self.touch("partial-1.db", "partial-2.db", "telemetry-20260903-031500.db.gz")
        self.assertEqual(backup.clear_partials(), 2)
        self.assertEqual(self.names(), ["telemetry-20260903-031500.db.gz"])

    def test_keep_zero_removes_everything(self):
        self.touch("telemetry-20260901-031500.db.gz", "telemetry-20260902-031500.db.gz")
        self.assertEqual(backup.prune("telemetry-*.db*", 0), 2)
        self.assertEqual(self.names(), [])


class BackupDatabaseTests(unittest.TestCase):
    """The snapshot is a real gzip containing a real, readable database."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

        self.db = self.dir / "source.db"
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE readings (id INTEGER PRIMARY KEY, note TEXT)")
        con.executemany("INSERT INTO readings (note) VALUES (?)", [(f"row {i}",) for i in range(500)])
        con.commit()
        con.close()

        for target, value in (("BACKUP_DIR", self.dir), ("DB_PATH", str(self.db))):
            patcher = mock.patch.object(backup, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_produces_a_gzipped_restorable_database(self):
        dest, raw_bytes = backup.backup_database("20260903-031500")
        self.assertEqual(dest.name, "telemetry-20260903-031500.db.gz")
        self.assertGreater(raw_bytes, 0)

        restored = self.dir / "restored.db"
        with gzip.open(dest, "rb") as f_in:
            restored.write_bytes(f_in.read())
        con = sqlite3.connect(restored)
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM readings").fetchone()[0], 500)
        finally:
            con.close()

    def test_leaves_no_partial_behind(self):
        backup.backup_database("20260903-031500")
        self.assertEqual(list(self.dir.glob("partial-*")), [])

    def test_compression_actually_saves_space(self):
        # If this ever fails the feature is pointless — the whole justification for the extra
        # step is that telemetry rows are repetitive enough to compress well.
        dest, raw_bytes = backup.backup_database("20260903-031500")
        self.assertLess(dest.stat().st_size, raw_bytes / 2)


class IsB2DestTests(unittest.TestCase):
    """Whether --b2-hard-delete gets passed."""

    def check(self, dest, env):
        with mock.patch.dict(os.environ, env, clear=False):
            return backup_offsite.is_b2_dest(dest)

    def test_true_for_a_configured_b2_remote(self):
        self.assertTrue(self.check("b2:my-bucket", {"RCLONE_CONFIG_B2_TYPE": "b2"}))

    def test_remote_name_need_not_be_b2(self):
        # The remote can be called anything; its TYPE is what matters.
        self.assertTrue(self.check("offsite:bucket/path", {"RCLONE_CONFIG_OFFSITE_TYPE": "b2"}))

    def test_false_for_a_non_b2_backend(self):
        self.assertFalse(self.check("gdrive:backups", {"RCLONE_CONFIG_GDRIVE_TYPE": "drive"}))

    def test_false_for_a_local_path(self):
        self.assertFalse(self.check("/mnt/nas/backups", {}))

    def test_false_when_the_remote_type_is_not_configured(self):
        # Missing config is not an assumption of B2 — passing the flag blindly is what we avoid.
        self.assertFalse(self.check("b2:my-bucket", {}))

    def test_tolerates_case_and_whitespace_in_the_type(self):
        self.assertTrue(self.check("b2:bucket", {"RCLONE_CONFIG_B2_TYPE": " B2 "}))


if __name__ == "__main__":
    unittest.main()
