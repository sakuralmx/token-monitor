#!/usr/bin/env bash
# Token Monitor Hub rollback — return code to a previous tag/branch. Data is
# NEVER rolled back: devices.json and catalog.db stay as-is (schema migrations
# are forward-only; see docs/API.md).
# Usage: sudo deploy/scripts/rollback.sh <previous-tag-or-branch>
set -euo pipefail

APP_DIR="${TOKEN_MONITOR_APP_DIR:-/opt/token-monitor}"
SERVICE="${TOKEN_MONITOR_SERVICE:-token-monitor-hub}"
TARGET="${1:?usage: rollback.sh <previous-tag-or-branch>}"

cd "$APP_DIR"
git fetch --tags origin
git checkout "$TARGET"
npm ci --omit=dev

sudo systemctl restart "$SERVICE"
sleep 2
"${APP_DIR}/deploy/scripts/healthcheck.sh"
echo "rollback complete: $(git rev-parse --short HEAD) on $TARGET (data untouched)"
