#!/usr/bin/env bash
# Root-owned, read-only wrapper for routine telemetry health checks. Installed at
# /usr/local/bin/solinteg-telemetry-ro (see deploy/solinteg-telemetry-ro.sudoers) so your own
# login user can run passwordless `sudo solinteg-telemetry-ro ...` for routine health checks
# without a general NOPASSWD sudo grant. Runs as root (not the solinteg user) so it can read
# telemetry.db/the heartbeat file without ever touching solinteg's other files (env secrets).
#
# Every subcommand is a fixed, validated shape — no arbitrary SQL, no arbitrary journalctl
# unit/args — because the sudoers rule that invokes this only restricts WHICH PROGRAM runs
# passwordlessly, not its arguments (see the .sudoers file's comment). This script is what
# actually keeps the passwordless surface to "read-only telemetry checks".
set -euo pipefail

DB=/opt/solinteg/telemetry.db
HEARTBEAT=/opt/solinteg/dispatch-heartbeat.json
ALLOWED_UNITS="solinteg-dispatch solinteg-poller solinteg-weather solinteg-web solinteg-watchdog solinteg-healthcheck solinteg-heartbeat-ping solinteg-oracle"

usage() {
  echo "usage: $(basename "$0") sql <SELECT ...>" >&2
  echo "       $(basename "$0") logs <unit> <since>   (since like '-30 days')" >&2
  echo "       $(basename "$0") heartbeat" >&2
  exit 2
}

[ $# -ge 1 ] || usage

case "$1" in
  sql)
    [ $# -eq 2 ] || usage
    query=$2
    # Strip one harmless trailing terminator (";" plus surrounding whitespace) before checking
    # for a second, chained statement — a bare trailing ";" is normal SQL, not an attack.
    query=$(printf '%s' "$query" | sed -e 's/[[:space:]]*;[[:space:]]*$//')
    # Single SELECT statement only. Reject anything that could write, attach another file,
    # load an extension (arbitrary code as root), or chain a second statement.
    lower=$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')
    if [[ "$query" == *";"* ]] || [[ "$lower" == .* ]] || \
       [[ "$lower" =~ (pragma|attach|detach|load_extension|vacuum|insert|update|delete|drop|alter|create) ]]; then
      echo "rejected: only a single read-only SELECT statement is allowed" >&2
      exit 1
    fi
    if [[ ! "$lower" =~ ^[[:space:]]*select ]]; then
      echo "rejected: query must start with SELECT" >&2
      exit 1
    fi
    exec sqlite3 -readonly -header -column "$DB" "$query"
    ;;
  logs)
    [ $# -eq 3 ] || usage
    unit=$2
    since=$3
    match=0
    for u in $ALLOWED_UNITS; do [ "$unit" = "$u" ] && match=1 && break; done
    [ "$match" -eq 1 ] || { echo "rejected: unit '$unit' not in the solinteg-* allowlist" >&2; exit 1; }
    if [[ ! "$since" =~ ^-[0-9]+\ (minute|minutes|hour|hours|day|days)$ ]]; then
      echo "rejected: since must look like '-30 days'" >&2
      exit 1
    fi
    exec journalctl -u "$unit" --since "$since" --no-pager
    ;;
  heartbeat)
    [ $# -eq 1 ] || usage
    exec cat "$HEARTBEAT"
    ;;
  *)
    usage
    ;;
esac
