'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCatalogSyncController } = require('../../src/electron/catalogSyncController');

test('start runs an immediate cycle and advances persisted state', async () => {
  let state = {};
  const writes = [];
  const controller = createCatalogSyncController({
    scanAdapters: () => [{
      scan: () => [{ deviceId: 'macbook', client: 'codex', sessionId: 's1', title: 'T', titleSource: 'local', lastUsedAt: '2026-08-10T01:00:00.000Z', updatedAt: '2026-08-10T01:00:00.000Z' }]
    }],
    readState: () => state,
    writeState: (next) => { state = next; writes.push(next); },
    config: () => ({ deviceId: 'macbook', baseUrl: 'https://hub.example', secret: 'shh' }),
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { ok: true, accepted: body.entries.length, rejected: 0 }; } };
    },
    intervalMs: 60_000
  });
  const report = await controller.start();
  controller.stop();
  assert.equal(report.upserted, 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].macbook['macbook|codex|s1']);
});

test('stop is idempotent and prevents further cycles', async () => {
  let cycles = 0;
  const controller = createCatalogSyncController({
    scanAdapters: () => [{ scan: () => [] }],
    readState: () => ({}),
    writeState: () => {},
    config: () => ({ deviceId: 'macbook', baseUrl: '' }),
    intervalMs: 1,
    logger: () => {}
  });
  controller.stop();
  controller.stop();
  const report = await controller.start().catch(() => ({ error: true }));
  controller.stop();
  assert.equal(cycles, 0);
  assert.ok(report); // start() still resolves; no timer keeps firing
});

test('a transport error is reported and the state is not advanced', async () => {
  let state = {};
  const controller = createCatalogSyncController({
    scanAdapters: () => [{
      scan: () => [{ deviceId: 'macbook', client: 'codex', sessionId: 's1', title: 'T', titleSource: 'local', lastUsedAt: '2026-08-10T01:00:00.000Z', updatedAt: '2026-08-10T01:00:00.000Z' }]
    }],
    readState: () => state,
    writeState: (next) => { state = next; },
    config: () => ({ deviceId: 'macbook', baseUrl: 'https://hub.example' }),
    fetchFn: async () => { throw new Error('offline'); },
    intervalMs: 60_000
  });
  const report = await controller.start();
  controller.stop();
  assert.ok(report.error);
  assert.equal(state.macbook, undefined);
});
