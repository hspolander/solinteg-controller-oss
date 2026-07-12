#!/bin/sh
# Installed at /etc/smartmontools/run.d/10solinteg-ntfy (see deploy/README.md's resilience
# section). smartd (running as root) invokes every executable script in that directory on a
# SMART event, with SMARTD_* env vars already set describing what happened - see
# `man smartd.conf` under -M exec. Runs as root, so it reads solinteg.env directly rather than
# needing solinteg added to any device group.
#
# Deliberately plain curl (no Python) so it has no dependency on the app venv or telemetry.db -
# this must keep working even if the rest of the stack is broken.
set -eu

ENV_FILE=/opt/solinteg/solinteg.env
[ -r "$ENV_FILE" ] || exit 0
NTFY_SERVER=$(grep -E '^NTFY_SERVER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
NTFY_TOPIC=$(grep -E '^NTFY_TOPIC=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
NTFY_SERVER=${NTFY_SERVER:-https://ntfy.sh}
[ -n "$NTFY_TOPIC" ] || exit 0

TITLE="Solinteg: SMART alert on ${SMARTD_DEVICESTRING:-disk}"
MESSAGE="${SMARTD_MESSAGE:-smartd reported a SMART event (see journalctl -u smartd for details)}"

curl -fsS --max-time 15 \
    -H "Title: ${TITLE}" \
    -H "Priority: high" \
    -H "Tags: warning" \
    -d "${MESSAGE}" \
    "${NTFY_SERVER%/}/${NTFY_TOPIC}" >/dev/null 2>&1 || true
