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
  assert.equal(history.codex.accounts['codex-account'].observations[0].remainingPercent, 42);
  assert.equal(history.codex.accounts['codex-account'].observations[0].at, '2026-08-18T01:02:03.000Z');
  assert.deepEqual(history.codex.accounts['codex-account'].observations[0].components, { input: 250, cacheRead: 600, cacheWrite: 100, output: 50 });
  assert.equal(history.opencode.accounts['go-account'].observations[0].remainingPercent, 57);
  assert.deepEqual(history.opencode.accounts['go-account'].observations[0].components, { input: 50, cacheRead: 400, cacheWrite: 50, output: 100 });
  assert.equal(history.opencode.accounts['go-account'].observations[0].components.input, 50, 'direct DeepSeek traffic is excluded');
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
  assert.equal(second.codex.accounts.a.observations.length, 1);
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
  assert.equal(normalized.codex.accounts.account.observations.length, 520);
  assert.deepEqual(Object.keys(normalized.codex.accounts.account.observations[0].components), ['input', 'cacheRead', 'cacheWrite', 'output']);
  assert.equal(normalized.codex.accounts.account.observations[0].cookie, undefined);
});

test('compacts an unchanged percentage run to its first and latest confirmations', () => {
  const observations = ['00:00', '00:01', '00:02', '00:03'].map((time, index) => ({
    remainingPercent: 75,
    at: `2026-08-18T${time}:00Z`,
    components: { input: index }
  }));
  const normalized = quota.normalizeQuotaPercentageHistory({ codex: { accountKey: 'account', observations } });
  assert.deepEqual(normalized.codex.accounts.account.observations.map((row) => row.at), [
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
  assert.deepEqual(normalized.codex.accounts.account.observations.map((row) => row.remainingPercent), [75, 75, 74]);
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
  assert.deepEqual(legacy.codex.accounts['codex-account'].observations.map((row) => row.at), [
    '2026-08-18T01:00:00.000Z',
    '2026-08-18T03:00:00.000Z'
  ]);
  assert.equal(legacy.codex.accounts['codex-account'].updatedAt, '2026-08-18T03:00:00.000Z');
  assert.deepEqual(legacy.pending.opencode.map((row) => row.at), [
    '2026-08-18T01:00:00.000Z',
    '2026-08-18T03:00:00.000Z'
  ]);
});

test('uses legacy top-level account keys instead of binding known history to another account', () => {
  const migrated = quota.migrateLegacyQuotaHistory({ accountKey: 'known-a', calibration: { observations: [{ remainingPercent: 90, at: '2026-01-01T00:00:00Z', components: {} }] } });
  assert.equal(migrated.codex.accounts['known-a'].observations[0].remainingPercent, 90);
  assert.equal(migrated.pending, undefined);
});

test('migrates account-less legacy observations and binds them on the next provider refresh', () => {
  const legacy = quota.migrateLegacyQuotaHistory({
    calibration: { observations: [{ remainingPercent: 70, at: '2026-08-17T00:00:00Z', components: {} }] },
    opencodeCalibration: { observations: [{ remainingPercent: 80, at: '2026-08-17T01:00:00Z', components: {} }] }
  });
  assert.equal(legacy.pending.codex.length, 1);
  assert.equal(legacy.pending.opencode.length, 1);
  // recordQuotaPercentageHistory normalizes settings before observing the
  // freshly composed runtime record. Pending migration state must survive that
  // exact main-process order so the provider refresh can bind it to an account.
  const normalized = quota.normalizeQuotaPercentageHistory(legacy);
  assert.equal(normalized.pending.codex.length, 1);
  assert.equal(normalized.pending.opencode.length, 1);
  const bound = quota.observeQuotaPercentages(normalized, {
    limits: { updatedAt: '2026-08-18T00:00:00Z', providers: [provider('codex', 'c', 60), provider('opencode', 'o', 75)] },
    allTime: {}
  });
  assert.equal(bound.codex.accounts.c.observations.length, 2);
  assert.equal(bound.opencode.accounts.o.observations.length, 2);
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
  assert.deepEqual(merged.codex.accounts.c.observations.map((row) => row.remainingPercent), [50, 45, 40, 35]);
  assert.equal(merged.opencode.accounts.o.observations[0].remainingPercent, 60);
});

test('binds pending legacy rows even when the target account already has history', () => {
  const observation = (at, remainingPercent) => ({ at, remainingPercent, components: {} });
  const history = {
    pending: { codex: [observation('2026-01-01T00:00:00Z', 90)] },
    codex: { accounts: { acct: { accountKey: 'acct', observations: [observation('2026-02-01T00:00:00Z', 80)] } } }
  };
  const bound = quota.observeQuotaPercentages(history, { limits: { updatedAt: '2026-03-01T00:00:00Z', providers: [provider('codex', 'acct', 70)] }, allTime: {} });
  assert.deepEqual(bound.codex.accounts.acct.observations.map((row) => row.remainingPercent), [90, 80, 70]);
  assert.equal(bound.pending, undefined);
});

test('retains multiple accounts and resumes a prior account timeline', () => {
  let history = {};
  for (const [accountKey, remainingPercent, at] of [['a', 80, '2026-01-01T00:00:00Z'], ['b', 90, '2026-01-02T00:00:00Z'], ['a', 70, '2026-01-03T00:00:00Z']]) {
    history = quota.observeQuotaPercentages(history, { limits: { updatedAt: at, providers: [provider('codex', accountKey, remainingPercent)] }, allTime: {} });
  }
  assert.deepEqual(history.codex.accounts.a.observations.map((row) => row.remainingPercent), [80, 70]);
  assert.deepEqual(history.codex.accounts.b.observations.map((row) => row.remainingPercent), [90]);
});

test('quota history chunks honor a successful-upload cursor', () => {
  const observations = [1, 2, 3].map((day) => ({ remainingPercent: 100 - day, at: `2026-01-0${day}T00:00:00Z`, components: {} }));
  const history = { codex: { accounts: { a: { accountKey: 'a', observations } } } };
  assert.equal(quota.quotaHistoryChunks(history).flatMap((chunk) => chunk.observations).length, 3);
  assert.equal(quota.quotaHistoryChunks(history, { codex: { a: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'] } }).flatMap((chunk) => chunk.observations).length, 1);
  const late = quota.mergeQuotaPercentageHistory(history, { codex: { accounts: { a: { accountKey: 'a', observations: [{ remainingPercent: 95, at: '2026-01-01T12:00:00Z', components: {} }] } } } });
  assert.equal(quota.quotaHistoryChunks(late, { codex: { a: ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z'] } }).flatMap((chunk) => chunk.observations).length, 1);
});

test('records named OpenCode Go profiles and uses provider timestamps', () => {
  const history = quota.observeQuotaPercentages({}, {
    limits: { updatedAt: '2026-08-18T05:00:00Z', providers: [provider('opencode', 'go', 55, { accountLabel: 'Work', planLabel: 'Go', updatedAt: '2026-08-18T04:00:00Z' })] },
    allTime: {}
  });
  assert.equal(history.opencode.accounts.go.observations[0].at, '2026-08-18T04:00:00.000Z');
});
