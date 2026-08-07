#!/usr/bin/env python3
"""
Shared helpers for the runtime services in this directory (scripts/services/).

Services import siblings bare (`import common`) — when a script is run by path, its own
directory is sys.path[0], which is exactly how these units are started
(ExecStart=... python .../scripts/services/<name>.py). No sys.path manipulation is needed or
wanted; six services carried a redundant `sys.path.insert(...)` (plus the `# noqa: E402` it
forced on every import below it) until 2026-08-07.
"""
import json
import os
import sqlite3
from pathlib import Path


def telemetry_connect(path) -> sqlite3.Connection:
    """Open the shared telemetry.db the way every writer must: parent dir ensured, WAL
    (concurrent access across the pollers, dispatch loop, and the Next.js app) and a 5 s
    busy timeout. Callers create their own table(s) with CREATE TABLE IF NOT EXISTS after
    connecting — the canonical schema for every table is deploy/schema.sql, and
    lib/__tests__/schema-cross-writer.test.ts fails if an inline definition drifts from it."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(p), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    return con


# ── Small JSON file primitives ───────────────────────────────────────────────────────────────
#
# Several services keep a tiny JSON file on disk that another process reads: the dispatch and
# heating heartbeats (watchdog.py / heating_watchdog.py watch them), the poller's live.json (the
# dispatch loop's live-load tracking reads it), and the two watchdogs' own alert-dedup state.
# Every one of them was independently reimplementing the same two functions — six copies of the
# temp-file-then-rename write, four of the read-or-default — which is exactly the silent-drift
# risk heating_state.py already consolidated for the heating pair. Hoisted here 2026-08-07 so
# the battery-side services share one implementation too.


def read_json(path):
    """Parsed JSON from `path`, or None if it is missing, unreadable, or malformed.

    Deliberately returns None rather than raising: every caller here is reading a file that
    legitimately may not exist yet (a heartbeat before its writer's first tick, a state file
    before the first alert), and treating that as an error would make startup noisy. Callers
    wanting a dict either way write `read_json(p) or {}`.
    """
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, data, indent=None) -> None:
    """Write JSON via temp-file-then-rename, so a reader never sees a half-written file.

    os.replace is atomic within a filesystem, which every caller satisfies (the temp file is a
    sibling of the target). The temp name APPENDS `.tmp` rather than replacing the extension —
    modbus_poller.py used to produce `live.tmp` via Path.with_suffix, which could in principle
    collide with a real file; `live.json.tmp` cannot.

    Raises on failure. Callers that must not die on a write error (dispatch_loop's heartbeat)
    catch OSError themselves — the decision to swallow or propagate belongs to them, not here.
    """
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=indent)
    os.replace(tmp, path)


def mtime(path):
    """Modification time of `path`, or None if it doesn't exist — the heating pair's staleness
    signal for files whose content it doesn't need to parse."""
    try:
        return os.path.getmtime(path)
    except OSError:
        return None
