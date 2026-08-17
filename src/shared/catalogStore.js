'use strict';

// Hub-side permanent session catalog store (plan T8), built on Node's built-in
// node:sqlite. This module is Node-hub-only: the Cloudflare Worker does not
// implement the catalog (it returns `catalog_unavailable`), so this file is
// deliberately NOT part of the vendored worker shared closure.
//
// Store contract (docs/API.md "Session catalog"):
// - primary key (deviceId, client, sessionId)
// - whole-record replace per key on upsert
// - conflict: greater `updatedAt` wins; on a tie `local` titleSource beats
//   `fallback`
// - soft-delete tombstones (deletedAt), never physical row removal, so a
//   deleted session stays queryable with includeDeleted and cannot resurrect
// - schema versioning via PRAGMA user_version with forward-only migrations
// - durable per transaction; WAL journaling so concurrent writers never corrupt

const fs = require('node:fs');
const path = require('node:path');

const { normalizeCatalogEntry, normalizeCatalogKey } = require('./sessionCatalog');

const CATALOG_SCHEMA_VERSION = 2;

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const VALID_CLIENTS = new Set(['cherrystudio', 'codex', 'dsh']);
const MAX_BATCH_ENTRIES = 1000;
const MAX_BATCH_KEYS = 500;
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;

function cleanText(value, maxChars = 200) {
  const text = String(value || '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, maxChars).join('');
}

function isoOf(value) {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cursorEncode(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function cursorDecode(raw) {
  try {
    const payload = JSON.parse(Buffer.from(String(raw || ''), 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
}

// The hub re-normalizes every entry through the shared client whitelist
// (normalizeCatalogEntry) so a broken/malicious client cannot bypass the privacy
// sanitization. normalizedToRow then maps the closed wire shape to snake_case
// SQL columns; deletes are NOT settable here — tombstones come only from
// invalidateKeys, so an upsert can never carry its own deletedAt.
function normalizedToRow(normalized) {
  return {
    deviceId: normalized.deviceId,
    client: normalized.client,
    sessionId: normalized.sessionId,
    workspaceKey: normalized.workspaceKey,
    workspaceLabel: normalized.workspaceLabel,
    title: normalized.title,
    titleSource: normalized.titleSource === 'local' ? 'local' : 'fallback',
    description: normalized.description || '',
    startedAt: normalized.startedAt || null,
    lastUsedAt: normalized.lastUsedAt,
    messageCount: Number.isInteger(normalized.messageCount) ? normalized.messageCount : 0,
    totalTokens: Math.max(0, Math.round(normalized.stats?.totalTokens ?? 0)),
    costUsd: Math.max(0, normalized.stats?.costUsd ?? 0),
    updatedAt: normalized.updatedAt || normalized.lastUsedAt,
    deletedAt: null
  };
}

function rowToEntry(row) {
  const entry = {
    deviceId: row.device_id,
    client: row.client,
    sessionId: row.session_id,
    workspaceKey: row.workspace_key,
    workspaceLabel: row.workspace_label,
    title: row.title,
    titleSource: row.title_source,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at
  };
  if (row.description) entry.description = row.description;
  if (row.started_at) entry.startedAt = row.started_at;
  if (row.message_count > 0) entry.messageCount = row.message_count;
  const stats = {};
  if (row.total_tokens > 0) stats.totalTokens = row.total_tokens;
  if (row.cost_usd > 0) stats.costUsd = row.cost_usd;
  if (Object.keys(stats).length > 0) entry.stats = stats;
  if (row.deleted_at) entry.deletedAt = row.deleted_at;
  return entry;
}

function migrations() {
  return [
    // v1: initial schema.
    `
    CREATE TABLE catalog_entries (
      device_id       TEXT NOT NULL,
      client          TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      workspace_key   TEXT NOT NULL DEFAULT '',
      workspace_label TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL,
      title_source    TEXT NOT NULL DEFAULT 'fallback',
      started_at      TEXT,
      last_used_at    TEXT,
      message_count   INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT,
      PRIMARY KEY (device_id, client, session_id)
    );
    CREATE INDEX catalog_entries_last_used ON catalog_entries (last_used_at DESC);
    CREATE INDEX catalog_entries_workspace ON catalog_entries (workspace_key);
    CREATE INDEX catalog_entries_updated ON catalog_entries (updated_at);
    `,
    // v2: add the first-line description.
    `
    ALTER TABLE catalog_entries ADD COLUMN description TEXT NOT NULL DEFAULT '';
    `
  ];
}

function createCatalogStore({ file, logger = console } = {}) {
  if (!sqlite) {
    throw new Error('node:sqlite is unavailable on this Node runtime; catalog store requires Node 22.5+/24');
  }
  if (!file) throw new Error('catalog store requires a file path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  let version;
  try {
    version = db.prepare('PRAGMA user_version').get().user_version || 0;
  } catch (_) { version = 0; }
  const applied = migrations();
  if (version > applied.length) {
    db.close();
    throw new Error(`catalog store schema v${version} is newer than this build supports (max v${applied.length})`);
  }
  for (let v = version; v < applied.length; v += 1) {
    db.exec('BEGIN');
    try {
      db.exec(applied[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      if (logger?.log) logger.log(`[catalog] migrated schema v${v} → v${v + 1}`);
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }

  // Whole-record winner rule. Every field — including workspace metadata and the
  // soft-delete tombstone — follows the same conflict rule as the title: the
  // incoming row wins when its updated_at is strictly newer, or when it ties on
  // updated_at and is a `local` titleSource upgrading an existing `fallback`.
  // A tombstone additionally refuses any incoming row whose updated_at is not
  // strictly newer than deleted_at, so a stale re-upload (or an out-of-order
  // replay of an old copy) can never clear a delete. Explicit resurrection
  // remains possible, but only from a row that is strictly newer than the delete.
  const winnerExpr = `(
    (
      excluded.updated_at > catalog_entries.updated_at
      OR (
        excluded.updated_at = catalog_entries.updated_at
        AND excluded.title_source = 'local'
        AND catalog_entries.title_source != 'local'
      )
    )
    AND (
      catalog_entries.deleted_at IS NULL
      OR excluded.updated_at > catalog_entries.deleted_at
    )
  )`;
  const upsertStmt = db.prepare(`
    INSERT INTO catalog_entries
      (device_id, client, session_id, workspace_key, workspace_label, title,
       title_source, description, started_at, last_used_at, message_count,
       total_tokens, cost_usd, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, client, session_id) DO UPDATE SET
      workspace_key   = CASE WHEN ${winnerExpr} THEN excluded.workspace_key ELSE catalog_entries.workspace_key END,
      workspace_label = CASE WHEN ${winnerExpr} THEN excluded.workspace_label ELSE catalog_entries.workspace_label END,
      title           = CASE WHEN ${winnerExpr} THEN excluded.title ELSE catalog_entries.title END,
      title_source    = CASE WHEN ${winnerExpr} THEN excluded.title_source ELSE catalog_entries.title_source END,
      description     = CASE WHEN ${winnerExpr} THEN excluded.description ELSE catalog_entries.description END,
      started_at      = CASE WHEN ${winnerExpr} THEN excluded.started_at ELSE catalog_entries.started_at END,
      last_used_at    = CASE WHEN ${winnerExpr} THEN excluded.last_used_at ELSE catalog_entries.last_used_at END,
      message_count   = CASE WHEN ${winnerExpr} THEN excluded.message_count ELSE catalog_entries.message_count END,
      total_tokens    = CASE WHEN ${winnerExpr} THEN excluded.total_tokens ELSE catalog_entries.total_tokens END,
      cost_usd        = CASE WHEN ${winnerExpr} THEN excluded.cost_usd ELSE catalog_entries.cost_usd END,
      updated_at      = CASE WHEN ${winnerExpr} THEN excluded.updated_at ELSE catalog_entries.updated_at END,
      deleted_at      = CASE WHEN ${winnerExpr} THEN excluded.deleted_at ELSE catalog_entries.deleted_at END
  `);

  // Per-key normalization gate: the shared client whitelist (normalizeCatalogEntry)
  // is the final trust boundary on the hub. It enforces the closed client enum,
  // required identity/title/lastUsedAt, control-char/length sanitization, and
  // path-shape safety for workspace fields — a broken/malicious client cannot
  // bypass it.
  function upsertEntries(entries) {
    if (!Array.isArray(entries)) {
      const error = new Error('entries must be an array');
      error.code = 'bad_catalog';
      throw error;
    }
    if (entries.length > MAX_BATCH_ENTRIES) {
      const error = new Error(`batch exceeds ${MAX_BATCH_ENTRIES} entries`);
      error.code = 'batch_too_large';
      throw error;
    }
    let accepted = 0;
    let rejected = 0;
    const rejectedKeys = [];
    db.exec('BEGIN');
    try {
      for (const raw of entries) {
        const normalized = normalizeCatalogEntry(raw);
        if (!normalized) {
          rejected += 1;
          rejectedKeys.push({
            deviceId: String(raw?.deviceId || '').trim(),
            client: String(raw?.client || '').toLowerCase(),
            sessionId: String(raw?.sessionId || '').trim(),
            reason: 'invalid_entry'
          });
          continue;
        }
        const row = normalizedToRow(normalized);
        upsertStmt.run(
          row.deviceId, row.client, row.sessionId, row.workspaceKey, row.workspaceLabel,
          row.title, row.titleSource, row.description, row.startedAt, row.lastUsedAt,
          row.messageCount, row.totalTokens, row.costUsd, row.updatedAt, row.deletedAt
        );
        accepted += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { accepted, rejected, rejectedKeys };
  }

  function listSessions({
    deviceId = '',
    client = '',
    workspace = '',
    since = '',
    includeDeleted = false,
    limit = DEFAULT_PAGE_SIZE,
    cursor = ''
  } = {}) {
    const pageSize = Math.min(Math.max(1, Math.round(limit) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const clauses = [];
    const params = [];
    if (deviceId) { clauses.push('device_id = ?'); params.push(cleanText(deviceId, 100)); }
    if (client) {
      const clientId = String(client).toLowerCase();
      if (!VALID_CLIENTS.has(clientId)) return { entries: [], nextCursor: '', hasMore: false };
      clauses.push('client = ?');
      params.push(clientId);
    }
    if (workspace) { clauses.push('workspace_key = ?'); params.push(cleanText(workspace, 120)); }
    if (since) {
      const sinceIso = isoOf(since);
      // Incremental reads converge on either a content update (updated_at) or a
      // soft-delete tombstone (deleted_at). The tombstone leaves updated_at at
      // the entry's last content time, so since-based readers still observe a
      // delete that happened after their last read.
      if (sinceIso) {
        clauses.push('(updated_at > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))');
        params.push(sinceIso, sinceIso);
      }
    }
    if (!includeDeleted) clauses.push('deleted_at IS NULL');

    // Cursor encodes (updatedAt, deviceId, client, sessionId) as an opaque
    // token; order is updated_at DESC, then device_id/client/session_id for a
    // stable total order across pages.
    let cursorClause = '';
    if (cursor) {
      const c = cursorDecode(cursor);
      if (c && c.updatedAt) {
        cursorClause = `
          AND (
            updated_at < ? OR
            (updated_at = ? AND (
              device_id > ? OR
              (device_id = ? AND (client > ? OR (client = ? AND session_id > ?)))
            ))
          )`;
        params.push(c.updatedAt, c.updatedAt, c.deviceId, c.deviceId, c.client, c.client, c.sessionId);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT * FROM catalog_entries
      ${where} ${cursorClause}
      ORDER BY updated_at DESC, device_id ASC, client ASC, session_id ASC
      LIMIT ${pageSize + 1}
    `).all(...params);

    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize).map(rowToEntry);
    let nextCursor = '';
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = cursorEncode({
        updatedAt: last.updatedAt,
        deviceId: last.deviceId,
        client: last.client,
        sessionId: last.sessionId
      });
    }
    return { entries: page, nextCursor, hasMore };
  }

  function invalidateKeys(keys) {
    if (!Array.isArray(keys)) {
      const error = new Error('keys must be an array');
      error.code = 'bad_catalog';
      throw error;
    }
    if (keys.length > MAX_BATCH_KEYS) {
      const error = new Error(`batch exceeds ${MAX_BATCH_KEYS} keys`);
      error.code = 'batch_too_large';
      throw error;
    }
    const now = new Date().toISOString();
    // Tombstone with event-time ordering. A delete carries the client's event
    // time (`deletedAt`, defaulting to server now) so an out-of-order retry of an
    // older delete cannot clobber a newer resurrection, and an idempotent repeat
    // is a no-op. The INSERT/ON CONFLICT clause creates a tombstone for an
    // unknown key (delete-before-upsert ordering) and only refreshes an existing
    // row when the incoming event time is strictly newer than the current state:
    //   - alive row:   tombstone iff eventTime >= updated_at (delete not stale)
    //   - deleted row: refresh iff eventTime > deleted_at (repeats are no-ops)
    // `updated_at` is deliberately NOT bumped for a known row, so the entry keeps
    // its last content time and the tombstone's own time lives in deleted_at; the
    // upsert winner reads that deleted_at to reject stale re-uploads.
    const tombstoneStmt = db.prepare(`
      INSERT INTO catalog_entries
        (device_id, client, session_id, workspace_key, workspace_label, title,
         title_source, description, started_at, last_used_at, message_count,
         total_tokens, cost_usd, updated_at, deleted_at)
      VALUES (?, ?, ?, '', '', '', 'fallback', '', NULL, ?, 0, 0, 0, ?, ?)
      ON CONFLICT(device_id, client, session_id) DO UPDATE SET
        deleted_at = excluded.deleted_at
      WHERE (
        (catalog_entries.deleted_at IS NULL AND catalog_entries.updated_at <= excluded.deleted_at)
        OR
        (catalog_entries.deleted_at IS NOT NULL AND catalog_entries.deleted_at < excluded.deleted_at)
      )
    `);
    let invalidated = 0;
    let rejected = 0;
    const rejectedKeys = [];
    db.exec('BEGIN');
    try {
      for (const key of keys || []) {
        // Normalize the key with the same function the upsert path uses
        // (normalizeCatalogEntry → normalizeCatalogKey). Using cleanText here
        // collapsed whitespace / NFC-normalized, which produced a different key
        // than the row the upsert stored — the delete then hit a nonexistent row
        // (creating a ghost tombstone) and left the original entry live.
        const normalized = normalizeCatalogKey(key);
        if (!normalized) {
          rejected += 1;
          rejectedKeys.push({
            deviceId: String(key?.deviceId || '').trim(),
            client: String(key?.client || '').toLowerCase(),
            sessionId: String(key?.sessionId || '').trim(),
            reason: 'invalid_key'
          });
          continue;
        }
        const eventTime = isoOf(key.deletedAt) || now;
        const result = tombstoneStmt.run(
          normalized.deviceId,
          normalized.client,
          normalized.sessionId,
          eventTime,
          eventTime,
          eventTime
        );
        invalidated += result.changes;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { invalidated, rejected, rejectedKeys };
  }

  function backup(destPath) {
    // SQLite's VACUUM INTO writes a consistent snapshot even under WAL.
    db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
    return destPath;
  }

  function close() {
    try { db.close(); } catch (_) { /* already closed */ }
  }

  return {
    backup,
    close,
    invalidateKeys,
    listSessions,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    upsertEntries
  };
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_KEYS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  VALID_CLIENTS,
  createCatalogStore
};
