'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const quota = require('../../src/shared/quotaPercentageHistory');

function provider(provider, accountKey, remainingPercent, extra = {}) {
  return {
    provider,
    accountKey,
    accountLabel: provider === 'opencode' ? 'Go' : undefined,
    status: 'ok',
    windows: [{ kind: 'weekly', remainingPercent, resetsAt: '2026-09-01T00:00:00Z' }],
    ...extra
  };
}

test('records Codex and OpenCode Go as independent timestamped histories', () => {
  const record = {
    limits: {
      updatedAt: '2026-08-18T01:02:03Z',
      providers: [provider('codex', 'codex-account', 42), provider('opencode', 'go-account', 57)]
    },
    allTime: {
      clients: { codex: 1000, opencode: 5000 },
      clientCacheReads: { codex: 600 },
      clientCacheWrites: { codex: 100 },
      clientOutputs: { codex: 50 },
      providerTokens: { 'opencode-go': 600, deepseek: 4400 },
      providerCacheReads: { 'opencode-go': 400 },
      providerCacheWrites: { 'opencode-go': 50 },
      providerOutputs: { 'opencode-go': 100 }
    }
  };
  const history = quota.observeQuotaPercentages({}, record);
  assert.equal(history.codex.observations[0].remainingPercent, 42);
  assert.equal(history.codex.observations[0].at, '2026-08-18T01:02:03.000Z');
  assert.deepEqual(history.codex.observations[0].components, { input: 250, cacheRead: 600, cacheWrite: 100, output: 50 });
  assert.equal(history.opencode.observations[0].remainingPercent, 57);
  assert.deepEqual(history.opencode.observations[0].components, { input: 50, cacheRead: 400, cacheWrite: 50, output: 100 });
  assert.equal(history.opencode.observations[0].components.input, 50, 'direct DeepSeek traffic is excluded');
});

test('does not record non-Go or local-only OpenCode accounts or duplicate timestamps', () => {
  const first = quota.observeQuotaPercentages({}, {
    limits: { updatedAt: '2026-08-18T01:00:00Z', providers: [provider('codex', 'a', 50), provider('opencode', 'z', 25, { accountLabel: 'Zen' }), provider('opencode', 'local', 37, { windows: [{ kind: 'weekly', remainingPercent: 37, source: 'local' }] })] },
    allTime: {}
  });
  const second = quota.observeQuotaPercentages(first, {
    limits: { updatedAt: '2026-08-18T01:00:00Z', providers: [provider('codex', 'a', 50)] },
    allTime: {}
  });
  assert.equal(second.codex.observations.length, 1);
  assert.equal(second.opencode, undefined);
});

test('sanitizes complete synchronized histories without a record-count cap', () => {
  const observations = Array.from({ length: 520 }, (_, index) => ({
    remainingPercent: index % 101,
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    components: { input: index, secret: 'drop' },
    cookie: 'drop'
  }));
  const normalized = quota.normalizeQuotaPercentageHistory({ codex: { accountKey: 'account', observations } });
  assert.equal(normalized.codex.observations.length, 520);
  assert.deepEqual(Object.keys(normalized.codex.observations[0].components), ['input', 'cacheRead', 'cacheWrite', 'output']);
  assert.equal(normalized.codex.observations[0].cookie, undefined);
});

test('compacts an unchanged percentage run to its first and latest confirmations', () => {
  const observations = ['00:00', '00:01', '00:02', '00:03'].map((time, index) => ({
    remainingPercent: 75,
    at: `2026-08-18T${time}:00Z`,
    components: { input: index }
  }));
  const normalized = quota.normalizeQuotaPercentageHistory({ codex: { accountKey: 'account', observations } });
  assert.deepEqual(normalized.codex.observations.map((row) => row.at), [
    '2026-08-18T00:00:00.000Z',
    '2026-08-18T00:03:00.000Z'
  ]);
});

test('keeps both plateau bounds and the first changed percentage', () => {
  const observation = (at, remainingPercent) => ({ at, remainingPercent, components: {} });
  const normalized = quota.normalizeQuotaPercentageHistory({ codex: { accountKey: 'account', observations: [
    observation('2026-08-18T00:00:00Z', 75),
    observation('2026-08-18T00:01:00Z', 75),
    observation('2026-08-18T00:02:00Z', 75),
    observation('2026-08-18T00:03:00Z', 74)
  ] } });
  assert.deepEqual(normalized.codex.observations.map((row) => row.remainingPercent), [75, 75, 74]);
});

test('sorts, deduplicates, and compacts legacy observations before deriving migration state', () => {
  const observation = (at, remainingPercent) => ({ at, remainingPercent, components: {} });
  const legacy = quota.migrateLegacyQuotaHistory({
    calibration: { accountKey: 'codex-account', observations: [
      observation('2026-08-18T03:00:00Z', 75),
      observation('2026-08-18T01:00:00Z', 75),
      observation('2026-08-18T02:00:00Z', 75),
      observation('2026-08-18T01:00:00Z', 75)
    ] },
    opencodeCalibration: { observations: [
      observation('2026-08-18T03:00:00Z', 80),
      observation('2026-08-18T01:00:00Z', 80),
      observation('2026-08-18T02:00:00Z', 80)
    ] }
  });
  assert.deepEqual(legacy.codex.observations.map((row) => row.at), [
    '2026-08-18T01:00:00.000Z',
    '2026-08-18T03:00:00.000Z'
  ]);
  assert.equal(legacy.codex.updatedAt, '2026-08-18T03:00:00.000Z');
  assert.deepEqual(legacy.pending.opencode.map((row) => row.at), [
    '2026-08-18T01:00:00.000Z',
    '2026-08-18T03:00:00.000Z'
  ]);
});

test('migrates account-less legacy observations and binds them on the next provider refresh', () => {
  const legacy = quota.migrateLegacyQuotaHistory({
    calibration: { observations: [{ remainingPercent: 70, at: '2026-08-17T00:00:00Z', components: {} }] },
    opencodeCalibration: { observations: [{ remainingPercent: 80, at: '2026-08-17T01:00:00Z', components: {} }] }
  });
  assert.equal(legacy.pending.codex.length, 1);
  assert.equal(legacy.pending.opencode.length, 1);
  const bound = quota.observeQuotaPercentages(legacy, {
    limits: { updatedAt: '2026-08-18T00:00:00Z', providers: [provider('codex', 'c', 60), provider('opencode', 'o', 75)] },
    allTime: {}
  });
  assert.equal(bound.codex.observations.length, 2);
  assert.equal(bound.opencode.observations.length, 2);
  assert.equal(bound.pending, undefined);
});

test('merges interleaved observations by timestamp and preserves providers independently', () => {
  const observation = (at, remainingPercent) => ({ at, remainingPercent, components: {} });
  const existing = {
    codex: { accountKey: 'c', observations: [observation('2026-08-18T00:00:00Z', 50), observation('2026-08-18T02:00:00Z', 40)] },
    opencode: { accountKey: 'o', observations: [observation('2026-08-18T01:00:00Z', 60)] }
  };
  const incoming = { codex: { accountKey: 'c', observations: [observation('2026-08-18T01:00:00Z', 45), observation('2026-08-18T03:00:00Z', 35)] } };
  const merged = quota.mergeQuotaPercentageHistory(existing, incoming);
  assert.deepEqual(merged.codex.observations.map((row) => row.remainingPercent), [50, 45, 40, 35]);
  assert.equal(merged.opencode.observations[0].remainingPercent, 60);
});

test('records named OpenCode Go profiles and uses provider timestamps', () => {
  const history = quota.observeQuotaPercentages({}, {
    limits: { updatedAt: '2026-08-18T05:00:00Z', providers: [provider('opencode', 'go', 55, { accountLabel: 'Work', planLabel: 'Go', updatedAt: '2026-08-18T04:00:00Z' })] },
    allTime: {}
  });
  assert.equal(history.opencode.observations[0].at, '2026-08-18T04:00:00.000Z');
});
