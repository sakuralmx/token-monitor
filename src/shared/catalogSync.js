'use strict';

// Client-side incremental catalog sync (plan T9).
//
// The hub store (T8) already enforces the conflict rules (greater `updatedAt`
// wins; on a tie a `local` titleSource beats `fallback`) in its UPSERT, so the
// client's job is to upload only what changed and never to manufacture
// duplicates:
//
// - computeCatalogDelta compares the last-known sync state against the fresh
//   scan and returns exactly the changed entries (new, newer, and deleted).
// - A batch is capped at the hub's per-request limit and resumed with the next
//   batch; an interrupted upload retries the same batch idempotently because
//   upsert is a whole-record replace by primary key.
// - Delete is explicit (soft-delete via invalidate), never inferred from a
//   session disappearing from the local scan — a gap in collection must not
//   erase a permanent record.
//
// The local sync state is a plain object { "<deviceId>|<client>|<sessionId>":
// { updatedAt, deletedAt } } and is persisted by the caller (widget settings /
// agent state file).

const { MAX_BATCH_ENTRIES, MAX_BATCH_KEYS } = require('./catalogStore');

const CATALOG_SYNC_VERSION = 1;

function entryKey(entry) {
  return `${entry.deviceId}|${entry.client}|${entry.sessionId}`;
}

function keyOf(parts) {
  return `${parts.deviceId}|${parts.client}|${parts.sessionId}`;
}

function isoOf(value) {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A strictly-later ISO timestamp than `reference`, for manufacturing a
// resurrection event time the hub's tombstone guard will accept. Uses the wall
// clock, and only falls back to reference+1ms when the clock is behind or equal,
// so the resurrection always beats the delete it is undoing.
function monotonicAfter(reference) {
  const base = Date.parse(String(reference || ''));
  const now = Date.now();
  const ms = Number.isFinite(base) ? Math.max(now, base + 1) : now;
  return new Date(ms).toISOString();
}

// Fingerprint of the conflict-relevant content: title metadata and workspace
// metadata. The hub permits same-time enrichment (for example, a later scan
// discovering a previously blank workspace), so updatedAt alone is insufficient.
function contentFingerprint(entry) {
  return `${entry.titleSource || 'fallback'}\u0000${entry.title || ''}\u0000${entry.description || ''}`
    + `\u0000${entry.workspaceKey || ''}\u0000${entry.workspaceLabel || ''}`;
}

// Which changed entries must be uploaded. `state` maps entryKey → { updatedAt,
// deletedAt?, titleSource?, title? }; `entries` is the fresh scan. Returns the
// entries to upsert (new, newer, or same-time metadata enrichment/change), the keys
// to invalidate (explicit deletes), and the next state.
function computeCatalogDelta({ state = {}, entries = [], deletes = [] } = {}) {
  const nextState = { ...state };
  const upserts = [];
  const seen = new Set();

  for (const entry of entries || []) {
    if (!entry) continue;
    const key = entryKey(entry);
    seen.add(key);
    const previous = state[key];
    const updatedAt = isoOf(entry.updatedAt) || isoOf(entry.lastUsedAt) || '';
    const isNew = !previous || !previous.updatedAt;
    const isNewer = !isNew && updatedAt && updatedAt > previous.updatedAt;
    // Same-time promotion/change: title improvements and workspace enrichment
    // must reach the hub even when the source log timestamp did not move.
    const isSameTimeChange = !isNew && !isNewer
      && updatedAt === previous.updatedAt
      && (contentFingerprint(entry) !== contentFingerprint(previous));
    // Explicit resurrection: the client previously soft-deleted this entry and it
    // has now reappeared. The hub's tombstone guard (catalogStore `winnerExpr`)
    // refuses any upsert whose updated_at is not strictly newer than deleted_at,
    // so whenever the raw content time does not beat the delete we manufacture a
    // strictly-later event time and upload that instead. This must NOT be gated
    // on !isNewer: a content time that is newer than the last-seen content but
    // still not later than the delete would otherwise be uploaded raw, the hub
    // would refuse it as a silent no-op (it reports the row as accepted), and
    // nextState would clear deletedAt locally — a permanent divergence where the
    // client believes the entry is live while the hub keeps it deleted.
    const isResurrection = Boolean(previous?.deletedAt)
      && !(updatedAt && updatedAt > previous.deletedAt);
    const effectiveUpdatedAt = isResurrection ? monotonicAfter(previous.deletedAt) : updatedAt;
    if (isNew || isNewer || isSameTimeChange || isResurrection) {
      upserts.push(isResurrection ? { ...entry, updatedAt: effectiveUpdatedAt } : entry);
    }
    nextState[key] = {
      updatedAt: effectiveUpdatedAt || previous?.updatedAt || '',
      titleSource: entry.titleSource || 'fallback',
      title: entry.title || '',
      description: entry.description || '',
      workspaceKey: entry.workspaceKey || '',
      workspaceLabel: entry.workspaceLabel || ''
    };
  }

  const invalidateKeys = [];
  for (const key of deletes || []) {
    const normalized = keyOf(key);
    if (!normalized || normalized.includes('|undefined')) continue;
    // A delete carries a stable event time: reuse the caller's, else the state's
    // prior tombstone time, else the wall clock — so an idempotent retry sends the
    // SAME event time and the hub treats the repeat as a no-op.
    const prior = nextState[normalized];
    const eventTime = isoOf(key.deletedAt) || prior?.deletedAt || new Date().toISOString();
    invalidateKeys.push({ ...key, deletedAt: eventTime });
    // Tombstone the local state so a later empty scan does not resurrect it.
    nextState[normalized] = { ...prior, updatedAt: prior?.updatedAt || '', deletedAt: eventTime };
  }

  return { upserts, invalidateKeys, nextState };
}

// Split entries/keys into hub-bounded batches. `maxEntries` and `maxKeys` mirror
// the store limits so a batch is always accepted.
function splitCatalogBatches({ entries = [], keys = [] } = {}) {
  const entryBatches = [];
  for (let i = 0; i < entries.length; i += MAX_BATCH_ENTRIES) {
    entryBatches.push(entries.slice(i, i + MAX_BATCH_ENTRIES));
  }
  const keyBatches = [];
  for (let i = 0; i < keys.length; i += MAX_BATCH_KEYS) {
    keyBatches.push(keys.slice(i, i + MAX_BATCH_KEYS));
  }
  return { entryBatches, keyBatches };
}

// Upload one delta through the hub HTTP API. Returns a summary of accepted /
// invalidated counts plus the keys the hub rejected, so the runtime can avoid
// checkpointing entries the hub refused (they would otherwise never retry).
// Throws on transport failure so the caller can retry the same delta
// (idempotent).
async function uploadCatalogDelta({ upserts = [], invalidateKeys = [], fetchFn, baseUrl, secret, logger } = {}) {
  const fetchImpl = fetchFn || fetch;
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('catalog sync requires a hub URL');
  const headers = {
    'content-type': 'application/json',
    ...(secret ? { authorization: `Bearer ${secret}` } : {})
  };
  const { entryBatches, keyBatches } = splitCatalogBatches({ entries: upserts, keys: invalidateKeys });
  let accepted = 0;
  let invalidated = 0;
  const rejectedKeys = [];

  for (const batch of entryBatches) {
    const response = await fetchImpl(`${base}/api/catalog/v1/upsert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entries: batch })
    });
    if (response.status === 404) {
      const payload = await response.json().catch(() => ({}));
      if (payload.error === 'catalog_unavailable') {
        // Documented downgrade: the hub does not implement the catalog. Stop
        // syncing silently; do not treat it as a transient failure.
        if (typeof logger === 'function') logger('catalog unavailable on hub; skipping catalog sync');
        return { accepted, invalidated, rejectedKeys, unavailable: true, catalogVersion: 0 };
      }
      throw new Error(`catalog upsert 404: ${payload.error || 'not_found'}`);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(`catalog upsert ${response.status}: ${payload.error || ''}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    accepted += Number(payload.accepted || 0);
    if (Array.isArray(payload.rejectedKeys)) {
      rejectedKeys.push(...payload.rejectedKeys);
    } else if (Number(payload.rejected || 0) > 0) {
      // Older hub that only reports a rejected count: conservatively mark every
      // entry in this batch as rejected so none of them are checkpointed.
      rejectedKeys.push(...batch.map((entry) => ({ deviceId: entry.deviceId, client: entry.client, sessionId: entry.sessionId })));
    }
  }

  for (const batch of keyBatches) {
    const response = await fetchImpl(`${base}/api/catalog/v1/invalidate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keys: batch })
    });
    if (response.status === 404) {
      const payload = await response.json().catch(() => ({}));
      if (payload.error === 'catalog_unavailable') return { accepted, invalidated, rejectedKeys, unavailable: true, catalogVersion: 0 };
      throw new Error(`catalog invalidate 404: ${payload.error || 'not_found'}`);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(`catalog invalidate ${response.status}: ${payload.error || ''}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    invalidated += Number(payload.invalidated || 0);
    if (Array.isArray(payload.rejectedKeys)) {
      rejectedKeys.push(...payload.rejectedKeys);
    } else if (Number(payload.rejected || 0) > 0) {
      // Older hub that only reports a rejected count: conservatively mark every
      // key in this batch as rejected so none of them are checkpointed.
      rejectedKeys.push(...batch.map((key) => ({ deviceId: key.deviceId, client: key.client, sessionId: key.sessionId })));
    }
  }

  return { accepted, invalidated, rejectedKeys, unavailable: false, catalogVersion: 1 };
}

// Remove the entries the hub rejected from a would-be next state, so a rejected
// entry keeps its previous state and is retried on the next cycle instead of
// being silently dropped forever.
function checkpointAccepted({ nextState, rejectedKeys = [] } = {}) {
  if (!Array.isArray(rejectedKeys) || rejectedKeys.length === 0) return nextState;
  const rejected = new Set(rejectedKeys.map((key) => keyOf(key)).filter(Boolean));
  const out = {};
  for (const [key, value] of Object.entries(nextState || {})) {
    if (!rejected.has(key)) out[key] = value;
  }
  return out;
}

// Fetch one bounded page from the hub's permanent catalog (used by the widget's
// Session view in client/host mode). Returns { entries, source, ... } where
// source is 'hub' on success and 'local' on any fallback (unreachable, no
// catalog, or a bad response) — the caller always has local data to show.
async function fetchHubCatalogEntries({ fetchFn, baseUrl = '', secret = '', logger, limit = 200 } = {}) {
  const fetchImpl = fetchFn || fetch;
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return { entries: [], source: 'local', reason: 'no_hub' };
  const headers = { ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  const pageSize = Math.min(500, Math.max(1, Math.round(Number(limit)) || 200));
  const query = new URLSearchParams({ limit: String(pageSize) });
  let response;
  try {
    response = await fetchImpl(`${base}/api/catalog/v1/sessions?${query}`, { headers });
  } catch (_) {
    return { entries: [], source: 'local', reason: 'unreachable' };
  }
  if (response.status === 404) return { entries: [], source: 'local', reason: 'catalog_unavailable' };
  if (!response.ok) return { entries: [], source: 'local', reason: `http_${response.status}` };
  const payload = await response.json().catch(() => null);
  if (!payload || !Array.isArray(payload.entries)) return { entries: [], source: 'local', reason: 'bad_response' };
  const entries = payload.entries.slice(0, pageSize);
  if (typeof logger === 'function') logger(`fetched ${entries.length} recent catalog entries from hub`);
  return {
    entries,
    source: 'hub',
    hasMore: payload.hasMore === true,
    nextCursor: payload.hasMore === true ? String(payload.nextCursor || '') : ''
  };
}

// Unified whole-record conflict comparator shared by the client merge path; it
// mirrors the hub store's SQL winner expression (catalogStore.js `winnerExpr`):
//   - no local baseline → remote wins
//   - remote strictly newer → wins
//   - remote tie + `local` title over a stored `fallback` → wins
//   - a tombstoned local entry is only replaced by a strictly newer remote time
function remoteEntryWins(remote, local) {
  if (!local || !local.updatedAt) return true;
  const remoteUpdated = remote.updatedAt || '';
  const localUpdated = local.updatedAt || '';
  const remoteSource = remote.titleSource === 'local' ? 'local' : 'fallback';
  const localSource = local.titleSource === 'local' ? 'local' : 'fallback';
  const workspaceEnrichment = !local.workspaceLabel && Boolean(remote.workspaceLabel);
  const contentWin = remoteUpdated > localUpdated
    || (remoteUpdated === localUpdated && (
      (remoteSource === 'local' && localSource !== 'local') || workspaceEnrichment
    ));
  if (!contentWin) return false;
  if (local.deletedAt && !(remoteUpdated > local.deletedAt)) return false;
  return true;
}

// Merge a remote catalog read into the local sync state without uploading:
// remote entries newer than the local state win locally (used by host-mode
// widgets / offline reads). Returns { mergedEntries, nextState }.
function mergeRemoteCatalog({ state = {}, entries = [] } = {}) {
  const nextState = { ...state };
  const merged = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    const key = entryKey(entry);
    const previous = state[key];
    const updatedAt = isoOf(entry.updatedAt) || isoOf(entry.lastUsedAt) || '';
    const remoteDeletedAt = isoOf(entry.deletedAt);
    if (remoteDeletedAt) {
      // A remote tombstone must tombstone the local state (never merge as live),
      // but only under the hub's own invalidate guard (catalogStore.js
      // `tombstoneStmt`): an alive entry is tombstoned iff the delete event time
      // is not older than its content time, and an already-deleted entry only
      // refreshes on a strictly newer delete. Mirroring both halves here stops an
      // old remote tombstone from clobbering a locally-more-recent live entry.
      const prior = nextState[key];
      const wins = !prior?.deletedAt
        ? (!prior?.updatedAt || remoteDeletedAt >= prior.updatedAt)
        : remoteDeletedAt > prior.deletedAt;
      if (wins) {
        nextState[key] = { ...prior, updatedAt: prior?.updatedAt || '', deletedAt: remoteDeletedAt };
      }
      continue;
    }
    if (remoteEntryWins({
      updatedAt,
      titleSource: entry.titleSource,
      workspaceLabel: entry.workspaceLabel
    }, previous)) {
      merged.push(entry);
      nextState[key] = {
        updatedAt: updatedAt || previous?.updatedAt || '',
        titleSource: entry.titleSource || 'fallback',
        title: entry.title || '',
        description: entry.description || '',
        workspaceKey: entry.workspaceKey || '',
        workspaceLabel: entry.workspaceLabel || ''
      };
    }
  }
  return { mergedEntries: merged, nextState };
}

module.exports = {
  CATALOG_SYNC_VERSION,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_KEYS,
  checkpointAccepted,
  computeCatalogDelta,
  contentFingerprint,
  entryKey,
  fetchHubCatalogEntries,
  keyOf,
  mergeRemoteCatalog,
  splitCatalogBatches,
  uploadCatalogDelta
};
