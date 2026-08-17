'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  catalogStateForDevice,
  mergeCatalogState,
  runCatalogSync
} = require('../../src/shared/catalogSyncRuntime');

function adapterWith(entries, error = null) {
  return {
    scan() {
      if (error) throw new Error(error);
      return entries;
    }
  };
}

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

test('first cycle uploads everything and returns an advanced nextState', async () => {
  const adapters = [adapterWith([entry(), entry({ sessionId: 'b', client: 'dsh' })])];
  const report = await runCatalogSync({
    deviceId: 'macbook',
    state: {},
    adapters,
    baseUrl: 'https://hub.example',
    secret: 'shh',
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries.length, rejected: 0 }; } };
    }
  });
  assert.equal(report.scanned, 2);
  assert.equal(report.upserted, 2);
  assert.equal(report.skipped, false);
  assert.ok(report.nextState.macbook);
  assert.ok(report.nextState.macbook['macbook|codex|rollout-1']);
});

test('second cycle with unchanged data skips the upload', async () => {
  const adapters = [adapterWith([entry()])];
  const first = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters,
    baseUrl: 'https://hub.example', fetchFn: async () => ({ ok: true, status: 200, async json() { return { ok: true, accepted: 0, rejected: 0 }; } })
  });
  let uploadCalls = 0;
  const second = await runCatalogSync({
    deviceId: 'macbook', state: first.nextState, adapters,
    baseUrl: 'https://hub.example',
    fetchFn: async () => { uploadCalls += 1; return { ok: true, status: 200, async json() { return { ok: true, accepted: 0, rejected: 0 }; } }; }
  });
  assert.equal(second.skipped, true);
  assert.equal(second.upserted, 0);
  assert.equal(uploadCalls, 0);
});

test('transport failure keeps the state untouched so the same delta retries', async () => {
  const adapters = [adapterWith([entry()])];
  const failed = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters,
    baseUrl: 'https://hub.example',
    fetchFn: async () => { throw new Error('offline'); }
  });
  assert.ok(failed.error);
  assert.equal(failed.nextState, undefined);

  // Next tick, network back: the same delta uploads once.
  const retried = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters,
    baseUrl: 'https://hub.example',
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries.length, rejected: 0 }; } };
    }
  });
  assert.equal(retried.upserted, 1);
});

test('no hub configured keeps the delta pending without erroring', async () => {
  const report = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters: [adapterWith([entry()])], baseUrl: ''
  });
  assert.equal(report.offline, true);
  assert.equal(report.skipped, true);
  assert.equal(report.error, null);
});

test('catalog_unavailable downgrades silently and does not advance state', async () => {
  const report = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters: [adapterWith([entry()])],
    baseUrl: 'https://hub.example',
    fetchFn: async () => ({ ok: false, status: 404, async json() { return { error: 'catalog_unavailable' }; } })
  });
  assert.equal(report.unavailable, true);
  assert.equal(report.nextState, undefined);
});

test('a failing adapter is isolated and does not abort the cycle', async () => {
  const report = await runCatalogSync({
    deviceId: 'macbook', state: {},
    adapters: [adapterWith([], 'boom'), adapterWith([entry()])],
    baseUrl: 'https://hub.example',
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries.length, rejected: 0 }; } };
    }
  });
  assert.equal(report.scanned, 1);
  assert.equal(report.upserted, 1);
});

test('an asynchronous scan adapter is awaited before delta upload', async () => {
  let uploaded = 0;
  const report = await runCatalogSync({
    deviceId: 'macbook', state: {},
    adapters: [{ async scan() { return [entry()]; } }],
    baseUrl: 'https://hub.example',
    fetchFn: async (_url, options) => {
      uploaded += JSON.parse(options.body).entries?.length || 0;
      return { ok: true, status: 200, async json() { return { ok: true, accepted: uploaded, rejected: 0 }; } };
    }
  });
  assert.equal(report.scanned, 1);
  assert.equal(uploaded, 1);
});

test('an adapter returning explicit deletes forwards them to the hub', async () => {
  let invalidateBody = null;
  const adapter = {
    scan: () => ({
      entries: [entry()],
      deletes: [{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }]
    })
  };
  const report = await runCatalogSync({
    deviceId: 'macbook', state: {}, adapters: [adapter],
    baseUrl: 'https://hub.example',
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/invalidate')) invalidateBody = body;
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries?.length || 0, invalidated: body.keys?.length || 0 }; } };
    }
  });
  assert.equal(report.invalidated, 1);
  assert.equal(invalidateBody.keys.length, 1);
  assert.equal(invalidateBody.keys[0].deviceId, 'macbook');
  assert.equal(invalidateBody.keys[0].client, 'codex');
  assert.equal(invalidateBody.keys[0].sessionId, 'rollout-1');
  assert.ok(invalidateBody.keys[0].deletedAt); // carries a client event time
});

test('device-scoped state helpers round-trip', () => {
  assert.deepEqual(catalogStateForDevice({}, 'macbook'), {});
  assert.deepEqual(catalogStateForDevice({ macbook: { k: 1 } }, 'macbook'), { k: 1 });
  const merged = mergeCatalogState({ macbook: { old: true } }, 'macbook', { new: true });
  assert.deepEqual(merged, { macbook: { new: true } });
  assert.deepEqual(catalogStateForDevice({ desktop: { k: 2 } }, 'macbook'), {});
});

test('no deviceId skips the cycle entirely', async () => {
  const report = await runCatalogSync({ deviceId: '', state: {}, adapters: [adapterWith([entry()])] });
  assert.equal(report.skipped, true);
  assert.equal(report.scanned, 0);
});
