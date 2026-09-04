#!/usr/bin/env bash
# Exercises telemetry-ro.sh's validation without root and without touching the NUC.
# Real script, rewritten paths (sed) + stubbed binaries (PATH) — same approach as
# test-deploy-wrapper.sh. Nothing here weakens the shipped script; its paths stay hardcoded.
#
# Written 2026-09-04, when solinteg-backup/-offsite were added to ALLOWED_UNITS. Until then this
# wrapper had NO tests at all, which is the wrong state for the one program the sudoers rule
# lets run passwordlessly as root: the sudoers grant restricts only WHICH PROGRAM runs, never
# its arguments, so every guard that keeps the surface read-only lives in this script and
# nowhere else. The SQL validator in particular is the whole boundary between "read-only
# telemetry checks" and arbitrary root SQL.
#
# Run: bash scripts/tests/test-telemetry-ro.sh
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/services/telemetry-ro.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/stub" "$T/opt"
DB="$T/opt/telemetry.db"
HEARTBEAT="$T/opt/dispatch-heartbeat.json"
ENV_FILE="$T/opt/solinteg.env"
: > "$DB"
echo '{"ok":true}' > "$HEARTBEAT"
printf 'SOLINTEG_CONTROL_ARMED=1\n' > "$ENV_FILE"

# sqlite3/journalctl are exec'd, so a PATH stub is enough to see what they were asked to do.
for cmd in sqlite3 journalctl; do
  cat > "$T/stub/$cmd" <<EOF
#!/usr/bin/env bash
echo "$cmd \$*"
exit 0
EOF
  chmod +x "$T/stub/$cmd"
done

SUT="$T/ro.sh"
sed -e "s#^DB=.*#DB=$DB#" \
    -e "s#^HEARTBEAT=.*#HEARTBEAT=$HEARTBEAT#" \
    -e "s#^ENV_FILE=.*#ENV_FILE=$ENV_FILE#" \
    "$SRC" > "$SUT"
chmod +x "$SUT"

run() { PATH="$T/stub:$PATH" bash "$SUT" "$@" >"$T/out" 2>"$T/err"; echo $?; }

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; pass=$((pass+1));
          else echo "FAIL  $1 (expected '$2', got '$3')"; fail=$((fail+1)); fi; }
outHas() { grep -q "$1" "$T/out" 2>/dev/null && echo yes || echo no; }

echo "--- argument validation ---"
check "no args exits 2"                 2 "$(run)"
check "unknown subcommand exits 2"      2 "$(run frobnicate)"
check "sql with no query exits 2"       2 "$(run sql)"
check "logs with no since exits 2"      2 "$(run logs solinteg-backup)"
check "heartbeat takes no args"         2 "$(run heartbeat extra)"

echo "--- logs: the unit allowlist ---"
# The two added 2026-09-04. These are the regression guard for the change itself.
check "solinteg-backup allowed"         0 "$(run logs solinteg-backup '-2 days')"
check "solinteg-backup-offsite allowed" 0 "$(run logs solinteg-backup-offsite '-2 days')"
check "solinteg-dispatch still allowed" 0 "$(run logs solinteg-dispatch '-1 hours')"
check "unknown unit rejected"           1 "$(run logs solinteg-nope '-2 days')"
# Not an allowlist bypass: journalctl takes -u, so a non-solinteg unit must not slip through.
check "unrelated system unit rejected"  1 "$(run logs ssh '-2 days')"
check "empty unit rejected"             1 "$(run logs '' '-2 days')"

echo "--- logs: the since format ---"
check "'-30 days' accepted"             0 "$(run logs solinteg-backup '-30 days')"
check "'-5 minutes' accepted"           0 "$(run logs solinteg-backup '-5 minutes')"
check "'yesterday' rejected"            1 "$(run logs solinteg-backup 'yesterday')"
check "unanchored '-2' rejected"        1 "$(run logs solinteg-backup '-2')"
# The shape that bit us over ssh: PowerShell ate the quotes and journalctl saw a bare 'min'.
check "'-40 min' rejected (not minutes)" 1 "$(run logs solinteg-backup '-40 min')"

echo "--- sql: the read-only boundary ---"
check "plain SELECT accepted"            0 "$(run sql 'SELECT 1')"
check "lowercase select accepted"        0 "$(run sql 'select soc_pct from readings limit 1')"
check "one trailing ; tolerated"         0 "$(run sql 'SELECT 1;')"
check "chained statement rejected"       1 "$(run sql 'SELECT 1; DROP TABLE readings')"
check "DELETE rejected"                  1 "$(run sql 'DELETE FROM readings')"
check "UPDATE rejected"                  1 "$(run sql 'UPDATE readings SET soc_pct=0')"
check "INSERT rejected"                  1 "$(run sql 'INSERT INTO readings VALUES (1)')"
check "ATTACH rejected"                  1 "$(run sql 'SELECT 1 FROM x; ATTACH DATABASE (1)')"
# load_extension runs arbitrary code as root — the single worst thing on this list. Held in a
# variable because the single quotes inside it cannot be nested through $( ) directly.
LOADEXT="SELECT load_extension('/tmp/x.so')"
check "load_extension rejected"          1 "$(run sql "$LOADEXT")"
check "PRAGMA rejected"                  1 "$(run sql 'PRAGMA journal_mode')"
check "VACUUM rejected"                  1 "$(run sql 'VACUUM')"
check "dot-command rejected"             1 "$(run sql '.tables')"
check "non-SELECT rejected"              1 "$(run sql 'WITH x AS (SELECT 1) SELECT * FROM x')"
run sql 'SELECT 1' >/dev/null
check "sqlite3 invoked read-only"        yes "$(outHas 'readonly')"

# KNOWN over-rejection, pinned deliberately rather than fixed: the keyword check is a substring
# match on the whole query, so a column whose NAME contains a banned word is refused too. Over-
# rejecting is the safe direction for a program running as root passwordlessly — if you hit it,
# project a different column rather than loosening the guard.
check "column named created_at over-rejected" 1 "$(run sql 'SELECT created_at FROM oracle_daily')"

echo "--- heartbeat ---"
check "heartbeat reads the file"         0 "$(run heartbeat)"
check "heartbeat content returned"       yes "$(outHas '"ok":true')"
# No `armed` subcommand in this wrapper — reading SOLINTEG_CONTROL_ARMED is documented as a
# direct `sudo grep` in CLAUDE.md instead, so there is nothing here to test for it.
check "armed is not a subcommand"        2 "$(run armed)"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
