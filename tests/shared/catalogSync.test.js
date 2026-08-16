'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeCatalogDelta,
  entryKey,
  keyOf,
  mergeRemoteCatalog,
  splitCatalogBatches,
  uploadCatalogDelta,
  fetchHubCatalogEntries,
  checkpointAccepted,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_KEYS
} = require('../../src/shared/catalogSync');

function entry(overrides = {}) {
  return {
    deviceId: 'macbook',
    client: 'codex',
    sessionId: 'rollout-1',
    workspaceKey: 'sha256:proj',
    workspaceLabel: 'project-a',
    title: 'Fix the build',
    titleSource: 'local',
    lastUsedAt: '2026-08-10T01:00:00.000Z',
    updatedAt: '2026-08-10T01:00:00.000Z',
    ...overrides
  };
}

test('delta uploads only new or newer entries and advances state', () => {
  const first = computeCatalogDelta({ entries: [entry()] });
  assert.equal(first.upserts.length, 1);
  assert.ok(first.nextState[entryKey(entry())]);

  // Second scan with unchanged entries → no upload.
  const second = computeCatalogDelta({ state: first.nextState, entries: [entry()] });
  assert.equal(second.upserts.length, 0);

  // Newer entry → uploaded.
  const newer = computeCatalogDelta({
    state: first.nextState,
    entries: [entry({ title: 'Updated title', updatedAt: '2026-08-10T02:00:00.000Z' })]
  });
  assert.equal(newer.upserts.length, 1);
  assert.equal(newer.upserts[0].title, 'Updated title');

  // Stale entry (older) → not uploaded.
  const stale = computeCatalogDelta({
    state: first.nextState,
    entries: [entry({ title: 'Stale', updatedAt: '2026-08-10T00:30:00.000Z' })]
  });
  assert.equal(stale.upserts.length, 0);
});

test('delta uploads same-time fallback→local title promotion', () => {
  const first = computeCatalogDelta({ entries: [entry({ title: 'Derived title', titleSource: 'fallback', updatedAt: '2026-08-10T01:00:00.000Z' })], state: {} });
  assert.equal(first.upserts.length, 1);
  // Same updatedAt, but now a local (user-set) title: must upload so the hub
  // tie-break can upgrade the stored fallback title.
  const promoted = computeCatalogDelta({
    state: first.nextState,
    entries: [entry({ title: 'User title', titleSource: 'local', updatedAt: '2026-08-10T01:00:00.000Z' })]
  });
  assert.equal(promoted.upserts.length, 1);
  assert.equal(promoted.upserts[0].title, 'User title');
  // Third scan, unchanged: no further upload.
  const unchanged = computeCatalogDelta({
    state: promoted.nextState,
    entries: [entry({ title: 'User title', titleSource: 'local', updatedAt: '2026-08-10T01:00:00.000Z' })]
  });
  assert.equal(unchanged.upserts.length, 0);
});

test('delta uploads same-time title text changes regardless of source', () => {
  const first = computeCatalogDelta({ state: {}, entries: [entry({ title: 'One', titleSource: 'local', updatedAt: '2026-08-10T01:00:00.000Z' })] });
  const changed = computeCatalogDelta({
    state: first.nextState,
    entries: [entry({ title: 'Two', titleSource: 'local', updatedAt: '2026-08-10T01:00:00.000Z' })]
  });
  assert.equal(changed.upserts.length, 1);
});

test('delta handles multiple clients/ids independently', () => {
  const entries = [
    entry({ sessionId: 'a' }),
    entry({ sessionId: 'b', client: 'cherrystudio' }),
    entry({ sessionId: 'c', client: 'dsh' })
  ];
  const first = computeCatalogDelta({ entries });
  assert.equal(first.upserts.length, 3);
  const second = computeCatalogDelta({ state: first.nextState, entries });
  assert.equal(second.upserts.length, 0);
});

test('explicit deletes become invalidate keys and tombstone local state', () => {
  const first = computeCatalogDelta({ entries: [entry()] });
  const deleted = computeCatalogDelta({
    state: first.nextState,
    entries: [],
    deletes: [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }]
  });
  assert.deepEqual(deleted.invalidateKeys, [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }]);
  assert.ok(deleted.nextState[entryKey(entry())].deletedAt);
});

test('a vanished session without an explicit delete is not invalidated', () => {
  const first = computeCatalogDelta({ entries: [entry()] });
  const later = computeCatalogDelta({ state: first.nextState, entries: [] });
  assert.equal(later.invalidateKeys.length, 0);
  assert.equal(later.upserts.length, 0);
});

test('splitCatalogBatches respects hub per-route limits', () => {
  const entries = Array.from({ length: MAX_BATCH_ENTRIES + 7 }, (_, i) => entry({ sessionId: `s${i}` }));
  const keys = Array.from({ length: MAX_BATCH_KEYS + 3 }, (_, i) => ({ deviceId: 'd', client: 'codex', sessionId: `s${i}` }));
  const { entryBatches, keyBatches } = splitCatalogBatches({ entries, keys });
  assert.equal(entryBatches.length, 2);
  assert.equal(entryBatches[0].length, MAX_BATCH_ENTRIES);
  assert.equal(entryBatches[1].length, 7);
  assert.equal(keyBatches.length, 2);
  assert.equal(keyBatches[0].length, MAX_BATCH_KEYS);
  assert.equal(keyBatches[1].length, 3);
});

test('uploadCatalogDelta posts batches and aggregates counts', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    if (url.endsWith('/upsert')) {
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries.length, rejected: 0 }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, invalidated: body.keys.length }; } };
  };
  const result = await uploadCatalogDelta({
    upserts: [entry(), entry({ sessionId: 'b' })],
    invalidateKeys: [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }],
    fetchFn: fetchImpl,
    baseUrl: 'https://hub.example/',
    secret: 'shh'
  });
  assert.deepEqual(result, { accepted: 2, invalidated: 1, rejectedKeys: [], unavailable: false, catalogVersion: 1 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/api/catalog/v1/upsert'));
  assert.equal(calls[0].options.headers.authorization, 'Bearer shh');
  assert.ok(calls[1].url.endsWith('/api/catalog/v1/invalidate'));
});

test('uploadCatalogDelta treats catalog_unavailable as a silent downgrade, not a failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async json() { return { error: 'catalog_unavailable' }; } });
  const result = await uploadCatalogDelta({
    upserts: [entry()],
    fetchFn: fetchImpl,
    baseUrl: 'https://hub.example'
  });
  assert.deepEqual(result, { accepted: 0, invalidated: 0, rejectedKeys: [], unavailable: true, catalogVersion: 0 });
});

test('uploadCatalogDelta surfaces hub-rejected keys so they are not checkpointed', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        accepted: 1,
        rejected: 1,
        rejectedKeys: [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', reason: 'invalid_entry' }]
      };
    }
  });
  const result = await uploadCatalogDelta({
    upserts: [entry(), entry({ sessionId: 'bad', client: 'unknown' })],
    fetchFn: fetchImpl,
    baseUrl: 'https://hub.example'
  });
  assert.equal(result.accepted, 1);
  assert.deepEqual(result.rejectedKeys, [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', reason: 'invalid_entry' }]);
});

test('uploadCatalogDelta throws on transport errors for caller retry', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(
    () => uploadCatalogDelta({ upserts: [entry()], fetchFn: fetchImpl, baseUrl: 'https://hub.example' }),
    /offline/
  );
});

test('uploadCatalogDelta throws on non-catalog 404s', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async json() { return { error: 'not_found' }; } });
  await assert.rejects(
    () => uploadCatalogDelta({ upserts: [entry()], fetchFn: fetchImpl, baseUrl: 'https://hub.example' }),
    /catalog upsert 404/
  );
});

test('mergeRemoteCatalog folds remote entries into local state (host/offline read)', () => {
  const local = computeCatalogDelta({ entries: [entry({ updatedAt: '2026-08-10T01:00:00.000Z' })] });
  const remote = [
    entry({ sessionId: 'from-other-device', deviceId: 'desktop', updatedAt: '2026-08-10T03:00:00.000Z' }),
    entry({ title: 'Stale remote', updatedAt: '2026-08-10T00:00:00.000Z' })
  ];
  const { mergedEntries, nextState } = mergeRemoteCatalog({ state: local.nextState, entries: remote });
  assert.equal(mergedEntries.length, 1); // only the new device's entry; stale same-key is not merged
  assert.equal(mergedEntries[0].sessionId, 'from-other-device');
  assert.ok(nextState[entryKey(entry({ sessionId: 'from-other-device', deviceId: 'desktop' }))]);
  // The stale same-key entry did not regress the local state.
  assert.equal(nextState[entryKey(entry())].updatedAt, '2026-08-10T01:00:00.000Z');
});

test('entryKey and keyOf round-trip and reject undefined parts', () => {
  assert.equal(entryKey(entry()), 'macbook|codex|rollout-1');
  assert.equal(keyOf({ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }), 'macbook|codex|rollout-1');
  const bad = computeCatalogDelta({ deletes: [{ deviceId: 'd', client: 'codex' }] });
  assert.equal(bad.invalidateKeys.length, 0);
});

test('fetchHubCatalogEntries walks cursor pagination and aggregates entries', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('cursor=next')) {
      return { ok: true, status: 200, async json() { return { entries: [entry({ sessionId: 'b' })], hasMore: false, nextCursor: '' }; } };
    }
    return { ok: true, status: 200, async json() { return { entries: [entry({ sessionId: 'a' })], hasMore: true, nextCursor: 'next' }; } };
  };
  const result = await fetchHubCatalogEntries({ fetchFn: fetchImpl, baseUrl: 'https://hub.example', secret: 'shh' });
  assert.equal(result.source, 'hub');
  assert.equal(result.entries.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('limit=500'));
});

test('fetchHubCatalogEntries falls back to local on unreachable / no-catalog / bad response', async () => {
  assert.equal((await fetchHubCatalogEntries({ fetchFn: async () => { throw new Error('offline'); }, baseUrl: 'https://hub.example' })).source, 'local');
  assert.equal((await fetchHubCatalogEntries({ fetchFn: async () => ({ ok: false, status: 404, async json() { return { error: 'catalog_unavailable' }; } }), baseUrl: 'https://hub.example' })).source, 'local');
  assert.equal((await fetchHubCatalogEntries({ fetchFn: async () => ({ ok: true, status: 200, async json() { return { entries: 'not-an-array' }; } }), baseUrl: 'https://hub.example' })).source, 'local');
  assert.equal((await fetchHubCatalogEntries({ fetchFn: async () => ({ ok: false, status: 401, async json() { return {}; } }), baseUrl: 'https://hub.example' })).reason, 'http_401');
});

test('checkpointAccepted removes hub-rejected keys so they retry next cycle', () => {
  const nextState = {
    'macbook|codex|rollout-1': { updatedAt: '2026-08-10T01:00:00.000Z', title: 'T', titleSource: 'local' },
    'macbook|codex|rollout-2': { updatedAt: '2026-08-10T01:00:00.000Z', title: 'T', titleSource: 'local' }
  };
  const out = checkpointAccepted({
    nextState,
    rejectedKeys: [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }]
  });
  assert.deepEqual(Object.keys(out), ['macbook|codex|rollout-2']);
  assert.deepEqual(checkpointAccepted({ nextState, rejectedKeys: [] }), nextState);
});
