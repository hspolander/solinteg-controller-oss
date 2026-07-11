#!/usr/bin/env bash
# Deploys the current working tree to the solinteg NUC and restarts solinteg-web.
#
# Usage:
#   ./deploy/to-nuc.sh
#
# What it does: packs the working tree (excluding node_modules/.next/.venv/secrets/local
# data), copies it to the NUC's /tmp, rsyncs it into a persistent staging dir
# (<app>-staging), builds there as the `solinteg` user, and only on a successful build
# swaps the staged tree into /opt/solinteg/app and restarts the services — a broken build
# never touches the running deployment. Same steps as CLAUDE.md's "Deployment & operations"
# section, just as one command instead of the usual multi-step dance.
#
# Needs the NUC's sudo password for the privileged steps (copying into /opt/solinteg/app,
# rebuilding as `solinteg`, restarting the service) — passwordless sudo was deliberately
# removed on that box. Prompts for it with hidden input unless SOLINTEG_SUDO_PASSWORD is
# already set in the environment. Never echoed, never written to disk.
#
# NUC_HOST/NUC_USER have no default — this is a shared script, not tied to any one
# installation, so you must set both for your own box, e.g.:
#   NUC_HOST=192.168.1.50 NUC_USER=myuser ./deploy/to-nuc.sh
set -euo pipefail

: "${NUC_HOST:?Set NUC_HOST to your NUC's address, e.g. NUC_HOST=192.168.1.50 ./deploy/to-nuc.sh}"
: "${NUC_USER:?Set NUC_USER to your NUC's SSH login, e.g. NUC_USER=myuser ./deploy/to-nuc.sh}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/solinteg/app}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${SOLINTEG_SUDO_PASSWORD:-}" ]; then
  read -r -s -p "NUC sudo password for ${NUC_USER}@${NUC_HOST}: " SOLINTEG_SUDO_PASSWORD
  echo
fi

TMP_TAR="$(mktemp -t solinteg-deploy-XXXXXX).tar.gz"
trap 'rm -f "$TMP_TAR"' EXIT

echo "==> Packing working tree..."
tar czf "$TMP_TAR" \
  --exclude='node_modules' --exclude='.next' --exclude='.venv' --exclude='.git' \
  --exclude='.env.local' --exclude='.env' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  --exclude='live.json' --exclude='coverage' --exclude='dashboard-update' \
  --exclude='dashboard-card-redesign' --exclude='dispatch-card-update' --exclude='files' \
  --exclude='*.tsbuildinfo' --exclude='next-env.d.ts' \
  .

echo "==> Copying to ${NUC_HOST}:/tmp..."
scp -q "$TMP_TAR" "${NUC_USER}@${NUC_HOST}:/tmp/solinteg-deploy.tar.gz"

echo "==> Staging on the NUC..."
ssh "${NUC_USER}@${NUC_HOST}" \
  "rm -rf /tmp/solinteg-deploy && mkdir -p /tmp/solinteg-deploy && tar xzf /tmp/solinteg-deploy.tar.gz -C /tmp/solinteg-deploy && rm /tmp/solinteg-deploy.tar.gz"

echo "==> Deploying (stage + build first, swap into place only if the build passes)..."
# The password crosses into the remote script base64-encoded: its alphabet ([A-Za-z0-9+/=])
# can't break out of the quoting, unlike the old raw single-quote wrapping, which broke on
# (or worse, silently mangled) passwords containing quotes/backslashes/$.
SOLPW_B64="$(printf '%s' "$SOLINTEG_SUDO_PASSWORD" | base64 | tr -d '\n')"
STAGING_DIR="${REMOTE_APP_DIR}-staging"
ssh "${NUC_USER}@${NUC_HOST}" bash -s <<REMOTE_EOF
set -e
SOLPW="\$(printf '%s' '${SOLPW_B64}' | base64 -d)"

# Stage and build BEFORE touching the live tree — a failed build must leave the running
# deployment untouched (the old in-place rsync left live sources and the running build out
# of sync whenever the rebuild failed). The staging dir persists between deploys so
# node_modules/.next build caches carry over and rebuilds stay fast.
echo "\$SOLPW" | sudo -S mkdir -p '${STAGING_DIR}'
echo "\$SOLPW" | sudo -S rsync -a --delete \
  --exclude 'node_modules' --exclude '.next' --exclude '.venv' \
  /tmp/solinteg-deploy/ '${STAGING_DIR}/'

echo "\$SOLPW" | sudo -S chown -R solinteg:solinteg '${STAGING_DIR}'

# Source solinteg.env before building — some config (pricing/site constants in
# lib/constants.ts) is read via Next's 'use cache' + Partial Prerendering, so it gets baked
# into the build output at build time, not read fresh per-request at runtime. Building without
# these set means the build sees only the hardcoded fallback defaults even if the deployed env
# file overrides them, silently diverging from what the running service's OTHER (non-cached)
# code paths see.
echo "\$SOLPW" | sudo -S -u solinteg env HOME=/opt/solinteg bash -lc "cd '${STAGING_DIR}' && set -a && source /opt/solinteg/solinteg.env && set +a && npm ci && npm run build"

# Build validated — swap the staged tree (INCLUDING node_modules and the fresh .next) into
# place. .venv is live-only (the Python services' venv, never staged) and must survive.
echo "\$SOLPW" | sudo -S rsync -a --delete --exclude '.venv' \
  '${STAGING_DIR}/' '${REMOTE_APP_DIR}/'

echo "\$SOLPW" | sudo -S chown -R solinteg:solinteg '${REMOTE_APP_DIR}'

echo "\$SOLPW" | sudo -S systemctl restart solinteg-web
sleep 2
echo "\$SOLPW" | sudo -S systemctl is-active solinteg-web

# dispatch_loop.py is a long-running Python process, not hot-reloaded by the rsync above —
# needs its own restart whenever scripts/dispatch_loop.py (or anything it imports) changes.
echo "\$SOLPW" | sudo -S systemctl restart solinteg-dispatch
sleep 2
echo "\$SOLPW" | sudo -S systemctl is-active solinteg-dispatch

rm -rf /tmp/solinteg-deploy
curl -s -o /dev/null -w "local curl on NUC: %{http_code}\n" http://localhost:3000/
unset SOLPW
REMOTE_EOF

echo "==> Verifying from here..."
curl -s -o /dev/null -w "curl from this machine: %{http_code}\n" "http://${NUC_HOST}:3000/"
echo "==> Done."
