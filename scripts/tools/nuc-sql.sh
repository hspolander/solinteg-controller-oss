#!/usr/bin/env bash
# Run one read-only SELECT against the host's telemetry.db through the passwordless
# `solinteg-telemetry-ro sql` wrapper, from a file or stdin. Exists because long queries
# don't survive being quoted through ssh + the remote shell + the wrapper's own argument,
# and because the wrapper's rejections are easy to hit and easy to miss.
#
#   scripts/tools/nuc-sql.sh query.sql
#   scripts/tools/nuc-sql.sh - <<'EOF'
#   SELECT date(timestamp,'+2 hours') AS d, COUNT(*) FROM readings GROUP BY d
#   EOF
#
# The wrapper's rules, checked here first so a rejection names its cause:
#   - the query must START with SELECT (no WITH: use subqueries);
#   - the keyword filter matches SUBSTRINGS anywhere, aliases included: pragma, attach, detach,
#     load_extension, vacuum, insert, update, delete, drop, alter, create (so `n_drops`,
#     `before_drop`, `created_at AS ...` are all rejected);
#   - no `;` except one trailing one.
# Also remember: if the host clock is UTC (the usual server default), 'localtime' is UTC; add
# your own offset for local-day buckets. And `solinteg-telemetry-ro logs` only accepts `-N days`.
set -euo pipefail
NUC="${NUC:?set NUC=user@host for the box running telemetry.db}"
src="${1:?usage: nuc-sql.sh <file.sql | ->}"
if [ "$src" = "-" ]; then sql=$(cat); else sql=$(cat "$src"); fi

trimmed=$(printf '%s' "$sql" | sed -e 's/[[:space:]]*;[[:space:]]*$//')
lower=$(printf '%s' "$trimmed" | tr '[:upper:]' '[:lower:]')
first=$(printf '%s' "$lower" | tr -s '[:space:]' ' ' | sed -e 's/^ //' | cut -d' ' -f1)
if [ "$first" != "select" ]; then
  echo "nuc-sql: the wrapper only accepts queries starting with SELECT (got '$first'); rewrite WITH as a subquery" >&2
  exit 2
fi
if [[ "$trimmed" == *";"* ]]; then
  echo "nuc-sql: only one statement allowed (found ';' before the end)" >&2
  exit 2
fi
hit=$(printf '%s' "$lower" | grep -o -E 'pragma|attach|detach|load_extension|vacuum|insert|update|delete|drop|alter|create' | sort -u | tr '\n' ' ' || true)
if [ -n "$hit" ]; then
  echo "nuc-sql: the wrapper would reject this — forbidden substring(s): $hit(check aliases and column names too)" >&2
  exit 2
fi

remote="/tmp/nuc-sql-$$.sql"
printf '%s\n' "$trimmed" | ssh -o BatchMode=yes "$NUC" "cat > $remote"
# "$(cat file)" is expanded by the remote shell inside double quotes, so the SQL reaches the
# wrapper as ONE argument with no further word-splitting or quote processing.
ssh -o BatchMode=yes "$NUC" "sudo solinteg-telemetry-ro sql \"\$(cat $remote)\"; rc=\$?; rm -f $remote; exit \$rc"
