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

// Fingerprint of the conflict-relevant content: the title plus its source. The
// hub's tie-break rule lets a `local` title upgrade a `fallback` title at the
// same updatedAt, so a state that only records updatedAt would never upload that
// upgrade. Carrying titleSource + title lets the delta also fire on same-time
// title changes.
function contentFingerprint(entry) {
  return `${entry.titleSource || 'fallback'}\u0000${entry.title || ''}`;
}

// Which changed entries must be uploaded. `state` maps entryKey → { updatedAt,
// deletedAt?, titleSource?, title? }; `entries` is the fresh scan. Returns the
// entries to upsert (new, newer, or same-time title promotion/change), the keys
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
    // Same-time promotion/change: a fallback title that becomes local (the hub
    // tie-break upgrades it), or any title/source change at the same timestamp.
    const isSameTimeChange = !isNew && !isNewer
      && updatedAt === previous.updatedAt
      && (contentFingerprint(entry) !== `${previous.titleSource || 'fallback'}\u0000${previous.title || ''}`);
    if (isNew || isNewer || isSameTimeChange) {
      upserts.push(entry);
    }
    nextState[key] = {
      updatedAt: updatedAt || previous?.updatedAt || '',
      titleSource: entry.titleSource || 'fallback',
      title: entry.title || ''
    };
  }

  const invalidateKeys = [];
  for (const key of deletes || []) {
    const normalized = keyOf(key);
    if (!normalized || normalized.includes('|undefined')) continue;
    invalidateKeys.push(key);
    // Tombstone the local state so a later empty scan does not resurrect it.
    const prior = nextState[normalized];
    nextState[normalized] = { ...prior, updatedAt: prior?.updatedAt || '', deletedAt: new Date().toISOString() };
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

// Fetch the hub's permanent catalog with cursor pagination (used by the widget's
// Catalog view in client/host mode). Returns { entries, source, ... } where
// source is 'hub' on success and 'local' on any fallback (unreachable, no
// catalog, or a bad response) — the caller always has local data to show.
async function fetchHubCatalogEntries({ fetchFn, baseUrl = '', secret = '', logger } = {}) {
  const fetchImpl = fetchFn || fetch;
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return { entries: [], source: 'local', reason: 'no_hub' };
  const headers = { ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  const collected = [];
  let cursor = '';
  const maxPages = 50; // safety bound; a real catalog is far smaller
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: '500' });
    if (cursor) query.set('cursor', cursor);
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
    collected.push(...payload.entries);
    if (!payload.hasMore || !payload.nextCursor) break;
    cursor = payload.nextCursor;
  }
  if (typeof logger === 'function') logger(`fetched ${collected.length} catalog entries from hub`);
  return { entries: collected, source: 'hub' };
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
    if (!previous || !previous.updatedAt || (updatedAt && updatedAt >= previous.updatedAt)) {
      merged.push(entry);
      nextState[key] = {
        updatedAt: updatedAt || previous?.updatedAt || '',
        titleSource: entry.titleSource || 'fallback',
        title: entry.title || ''
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
