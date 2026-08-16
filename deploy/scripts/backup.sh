#!/usr/bin/env bash
# Token Monitor Hub backup — devices.json (device records + subscriptions) plus
# the SQLite session catalog (devices-catalog.db by default; override with
# TOKEN_MONITOR_CATALOG_FILE). Keeps the newest N archives locally; sync them
# off-host (rclone/rsync/OSS) yourself.
set -euo pipefail

DATA_DIR="${TOKEN_MONITOR_DATA_DIR:-/var/lib/token-monitor}"
BACKUP_DIR="${DATA_DIR}/backups"
KEEP="${TOKEN_MONITOR_BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
archive="${BACKUP_DIR}/token-monitor-${STAMP}.tar.gz"

# Copy the live store to a temp file first so the tar never sees a half-written
# rename (writeJsonAtomic / SQLite WAL are atomic per-file, but tarring the live
# dir directly can race a rename).
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for f in devices.json catalog.db catalog.db-wal catalog.db-shm; do
  if [ -f "${DATA_DIR}/${f}" ]; then
    cp -p "${DATA_DIR}/${f}" "${staging}/${f}"
  fi
done

tar -czf "$archive" -C "$staging" .
rm -f "$archive.tmp"

# Prune old archives.
ls -1t "${BACKUP_DIR}"/token-monitor-*.tar.gz 2>/dev/null \
  | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

echo "backup written: $archive"
echo "off-host sync (edit to taste): rclone copy '$archive' remote:token-monitor-backups/"
