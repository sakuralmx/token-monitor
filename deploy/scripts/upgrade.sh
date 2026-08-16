#!/usr/bin/env bash
# Token Monitor Hub upgrade — switch /opt/token-monitor to a target tag/branch,
# reinstall production deps, restart, and health-check. Data is untouched.
# Usage: sudo deploy/scripts/upgrade.sh <tag-or-branch> [--no-backup]
set -euo pipefail

APP_DIR="${TOKEN_MONITOR_APP_DIR:-/opt/token-monitor}"
SERVICE="${TOKEN_MONITOR_SERVICE:-token-monitor-hub}"
TARGET="${1:?usage: upgrade.sh <tag-or-branch> [--no-backup]}"

if [ "${2:-}" != "--no-backup" ]; then
  sudo "${APP_DIR}/deploy/scripts/backup.sh"
fi

cd "$APP_DIR"
git fetch --tags origin
git checkout "$TARGET"
git pull --ff-only origin "$TARGET" 2>/dev/null || true
npm ci --omit=dev

sudo systemctl restart "$SERVICE"
sleep 2
"${APP_DIR}/deploy/scripts/healthcheck.sh"
echo "upgrade complete: $(git rev-parse --short HEAD) on $TARGET"
