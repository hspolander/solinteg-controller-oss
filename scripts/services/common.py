#!/usr/bin/env python3
"""
Shared helpers for the runtime services in this directory (scripts/services/).

Services import siblings bare (`import common`) — when a script is run by path, its own
directory is sys.path[0], which is exactly how these units are started
(ExecStart=... python .../scripts/services/<name>.py).
"""
import sqlite3
from pathlib import Path


def telemetry_connect(path) -> sqlite3.Connection:
    """Open the shared telemetry.db the way every writer must: parent dir ensured, WAL
    (concurrent access across the pollers, dispatch loop, and the Next.js app) and a 5 s
    busy timeout. Callers create their own table(s) with CREATE TABLE IF NOT EXISTS after
    connecting — the canonical schema for every table is deploy/schema.sql."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(p), check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    return con
