#!/usr/bin/env bash
# Token Monitor Hub backup — devices.json (device records + subscriptions) plus
# the SQLite session catalog. The catalog is backed up with SQLite's VACUUM INTO
# (a consistent snapshot even under WAL), never by copying db/wal/shm files
# separately. The catalog path is resolved the same way the hub does: the
# TOKEN_MONITOR_CATALOG_FILE env var when set, otherwise
# <data-file basename>-catalog.db next to the data file. Keeps the newest N
# archives locally; sync them off-host (rclone/rsync/OSS) yourself.
set -euo pipefail

APP_DIR="${TOKEN_MONITOR_APP_DIR:-/opt/token-monitor}"
DATA_DIR="${TOKEN_MONITOR_DATA_DIR:-/var/lib/token-monitor}"
DATA_FILE="${TOKEN_MONITOR_DATA_FILE:-${DATA_DIR}/devices.json}"
# Same default derivation as src/hub/server.js createHub().
CATALOG_FILE="${TOKEN_MONITOR_CATALOG_FILE:-${DATA_DIR}/$(basename "${DATA_FILE%.*}")-catalog.db}"
BACKUP_DIR="${DATA_DIR}/backups"
KEEP="${TOKEN_MONITOR_BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
archive="${BACKUP_DIR}/token-monitor-${STAMP}.tar.gz"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

# devices.json: plain JSON, copy the live file (atomic rename makes this safe).
if [ -f "$DATA_FILE" ]; then
  cp -p "$DATA_FILE" "$staging/devices.json"
else
  echo "ERROR: devices.json not found at $DATA_FILE" >&2
  exit 1
fi

# Session catalog: consistent SQLite snapshot via VACUUM INTO (safe under WAL).
# Run from the app dir so node resolves the project's node_modules.
if [ -f "$CATALOG_FILE" ]; then
  (cd "$APP_DIR" && node -e '
    const { createCatalogStore } = require("./src/shared/catalogStore");
    const [file, dest] = process.argv.slice(1);
    const store = createCatalogStore({ file, logger: { log() {} } });
    store.backup(dest);
    store.close();
  ' "$CATALOG_FILE" "$staging/devices-catalog.db")
  # Verify the snapshot is a valid SQLite database.
  if ! (cd "$APP_DIR" && node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("PRAGMA quick_check").get();
    db.close();
    process.exit(row.quick_check === "ok" ? 0 : 1);
  ' "$staging/devices-catalog.db"); then
    echo "ERROR: catalog snapshot failed quick_check" >&2
    exit 1
  fi
else
  echo "WARNING: catalog file not found at $CATALOG_FILE; backing up devices.json only" >&2
fi

tar -czf "$archive" -C "$staging" .
rm -f "$archive.tmp"

# Prune old archives.
ls -1t "${BACKUP_DIR}"/token-monitor-*.tar.gz 2>/dev/null \
  | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

echo "backup written: $archive"
echo "off-host sync (edit to taste): rclone copy '$archive' remote:token-monitor-backups/"
