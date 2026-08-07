#!/usr/bin/env python3
"""
Shared helpers for the offline analysis tools in this directory (scripts/tools/).

Tools import this bare (`import common`) — a script run by path has its own directory as
sys.path[0], same convention as scripts/services/common.py. (Note these are two different
modules with the same name; whichever directory the running script lives in wins, which is
exactly what each one wants. A tool that ALSO needs a service module inserts ../services on
sys.path explicitly — see the probe_* scripts.)

Added 2026-08-07. Seven tools had independently reimplemented the read-only connect and four
the Stockholm ZoneInfo, which was tolerable; the `--db` default had drifted apart, which was
not. Three tools read TELEMETRY_DB_PATH and four ignored it, so pointing the env var at a
copied database silently worked for some analyses and silently didn't for others — and since
both paths produce plausible numbers, nothing announced which one you'd got.
"""
import os
import sqlite3
from zoneinfo import ZoneInfo

STOCKHOLM = ZoneInfo("Europe/Stockholm")
UTC = ZoneInfo("UTC")

DEFAULT_DB = os.environ.get("TELEMETRY_DB_PATH", "/opt/solinteg/telemetry.db")


def connect_ro(path) -> sqlite3.Connection:
    """Open telemetry.db READ-ONLY.

    Every tool in this directory analyses; none of them write. `mode=ro` makes that a property
    of the connection rather than of the author's care — a stray INSERT raises instead of
    mutating the live database the dispatch loop is reading from. It also means these can be
    run against the production DB on the NUC while everything is live, which is the normal
    case: the alternative (copy it off first) risks analysing a stale copy.
    """
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def add_db_arg(parser) -> None:
    """Add the standard `--db` option, defaulting to TELEMETRY_DB_PATH then the NUC's path."""
    parser.add_argument(
        "--db",
        default=DEFAULT_DB,
        help=f"telemetry.db path (default: $TELEMETRY_DB_PATH, else {DEFAULT_DB})",
    )
