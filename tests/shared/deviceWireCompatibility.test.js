'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceState } = require('../../src/shared/deviceState');
const { syncPayload } = require('../../src/shared/syncPayload');
const { mergeDeviceRecord, normalizeDeviceRecord } = require('../../src/shared/usage');
const workerUsage = require('../../worker/src/shared/usage');

function period(tokens) {
  return {
    totalTokens: tokens,
    costUsd: 0,
    clients: { codex: tokens },
    clientCosts: {},
    models: {},
    modelCosts: {}
  };
}

test('Node and Worker preserve explicit unavailable History', () => {
  const record = { deviceId: 'device-1', historyAvailable: false, history: null };

  assert.equal(normalizeDeviceRecord(record).history, null);
  assert.equal(workerUsage.normalizeDeviceRecord(record).history, null);
  assert.equal(normalizeDeviceRecord(record).historyAvailable, false);
  assert.equal(workerUsage.normalizeDeviceRecord(record).historyAvailable, false);
});

test('Node and Worker agree on provider-attribution rollups and legacy omission', () => {
  const attributed = {
    deviceId: 'device-1',
    today: {
      ...period(150),
      providerTokens: { 'OpenCode-Go': 100, DeepSeek: 50 },
      providerCosts: { 'OpenCode-Go': 0.25 },
      providerCacheReads: { 'OpenCode-Go': 60 },
      providerCacheWrites: { 'OpenCode-Go': 10 },
      providerOutputs: { 'OpenCode-Go': 20 },
      clientProviders: { OpenCode: { 'OpenCode-Go': 100, DeepSeek: 50 } }
    }
  };
  assert.deepEqual(
    workerUsage.normalizeDeviceRecord(attributed).periods.today,
    normalizeDeviceRecord(attributed).periods.today
  );
  assert.deepEqual(normalizeDeviceRecord(attributed).periods.today.providerTokens, {
    'opencode-go': 100,
    deepseek: 50
  });

  const legacy = normalizeDeviceRecord({ deviceId: 'legacy', today: period(10) });
  assert.deepEqual(legacy.periods.today.providerTokens, {});
  assert.deepEqual(workerUsage.normalizeDeviceRecord({ deviceId: 'legacy', today: period(10) }).periods.today.providerTokens, {});
});

test('composed full records remain compatible with hub normalization and merging', () => {
  const records = [];
  const state = createDeviceState({
    envelope: {
      deviceId: 'device-1',
      hostname: 'host',
      platform: 'darwin-arm64',
      agentVersion: '1.2.3'
    },
    onRecord: (record, meta) => records.push({ record, meta })
  });
  state.updateUsage({
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    historyAvailable: true,
    history: { daily: [{ date: '2026-07-21', totalTokens: 10, costUsd: 0 }] }
  });
  state.updateLimits({
    updatedAt: '2026-07-21T01:01:00.000Z',
    refreshMs: 300000,
    providers: [{
      provider: 'codex',
      status: 'unavailable',
      accountKey: 'account-1',
      windows: [{ kind: 'session', usedPercent: 40 }]
    }]
  });

  assert.equal(records.length, 2);
  assert.equal(Object.hasOwn(records[1].record, 'revision'), false);
  assert.equal(records[1].record.updatedAt, '2026-07-21T01:00:00.000Z');

  const normalized = normalizeDeviceRecord(records[1].record);
  assert.equal(normalized.periods.today.totalTokens, 10);
  assert.equal(normalized.history.daily[0].totalTokens, 10);
  assert.equal(normalized.historyAvailable, true);
  assert.equal(normalized.limits.providers[0].status, 'unavailable');
  assert.equal(normalized.limits.providers[0].windows[0].usedPercent, 40);
  assert.equal(syncPayload(records[1].record).historyAvailable, true);

  const merged = mergeDeviceRecord(records[0].record, {
    ...records[1].record,
    receivedAt: '2026-07-21T01:01:01.000Z'
  });
  assert.equal(merged.periods.today.totalTokens, 10);
  assert.equal(merged.history.daily[0].totalTokens, 10);
  assert.equal(merged.updatedAt, '2026-07-21T01:00:00.000Z');
  assert.equal(merged.receivedAt, '2026-07-21T01:01:01.000Z');
});

test('limits updates publish retained usage and history without a renderer', () => {
  const records = [];
  const state = createDeviceState({ onRecord: (record) => records.push(record) });
  state.updateUsage({
    updatedAt: '2026-08-18T00:00:00.000Z',
    today: period(7), month: period(8), allTime: period(9),
    history: { daily: [{ date: '2026-08-18', totalTokens: 7, costUsd: 0 }] }
  });
  state.updateLimits({ updatedAt: '2026-08-18T00:01:00.000Z', providers: [] });
  assert.equal(records.length, 2);
  assert.equal(records[1].today.totalTokens, 7);
  assert.equal(records[1].history.daily[0].totalTokens, 7);
  assert.equal(records[1].updatedAt, '2026-08-18T00:00:00.000Z');
  const payload = syncPayload(records[1]);
  assert.equal(payload.today.totalTokens, 7);
  assert.equal(payload.history.daily[0].totalTokens, 7);
});

test('sync payload keeps retained public status/windows and drops runtime-only provider state', () => {
  const payload = syncPayload({
    deviceId: 'device-1',
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    limits: {
      updatedAt: '2026-07-21T01:01:00.000Z',
      refreshMs: 300000,
      providers: [{
        provider: 'codex',
        status: 'unavailable',
        accountKey: 'account-1',
        windows: [{ kind: 'session', usedPercent: 40 }],
        lastAttempt: { status: 'unavailable' },
        error: 'private diagnostic',
        credentialDigest: 'private digest',
        revision: 99
      }]
    }
  });
  const provider = payload.limits.providers[0];
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.windows[0].usedPercent, 40);
  assert.equal(Object.hasOwn(provider, 'lastAttempt'), false);
  assert.equal(Object.hasOwn(provider, 'error'), false);
  assert.equal(Object.hasOwn(provider, 'credentialDigest'), false);
  assert.equal(Object.hasOwn(provider, 'revision'), false);
});
