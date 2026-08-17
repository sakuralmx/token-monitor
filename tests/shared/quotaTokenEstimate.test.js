'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const quota = require('../../src/shared/quotaTokenEstimate');
test('separates cache and output weights', () => { assert.equal(quota.equivalentTokens({ clients: { codex: 1000 }, clientCacheReads: { codex: 600 }, clientCacheWrites: { codex: 100 }, clientOutputs: { codex: 50 } }), 735); });
test('official percentage incorporates remote usage', () => { const r = quota.estimate({ provider: { windows: [{ kind: 'weekly', remainingPercent: 40 }] }, period: {}, capacity: 1e6, reservePercent: 5 }); assert.equal(r.optimisticRemaining, 400000); assert.equal(r.conservativeRemaining, 350000); });
test('does not invent tokens without official percentage', () => { assert.equal(quota.estimate({ period: {}, capacity: 1e6 }).optimisticRemaining, null); });
test('quota sync snapshots are bounded and strip unknown account data', () => {
  const observations = Array.from({ length: 520 }, (_, index) => ({
    remainingPercent: 100 - index % 100,
    localEquivalent: index * 100,
    components: { input: index, cacheRead: index * 2, secret: 'drop-me' },
    at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    resetsAt: '2026-02-01T00:00:00.000Z',
    cookie: 'drop-me'
  }));
  const snapshot = quota.normalizeSyncSnapshot({
    accountKey: 'sha256:account',
    updatedAt: observations.at(-1).at,
    calibration: { samples: Array.from({ length: 300 }, (_, index) => index + 1), observations, first: observations[0], last: observations.at(-1) }
  });
  assert.equal(snapshot.calibration.observations.length, 512);
  assert.equal(snapshot.calibration.samples.length, 256);
  assert.deepEqual(Object.keys(snapshot.calibration.last.components), ['input', 'cacheRead', 'cacheWrite', 'output']);
  assert.equal(snapshot.cookie, undefined);
});
test('quota sync follows the device that supplied the visible Codex limit across platform-specific account hashes', () => {
  const snapshot = (accountKey, updatedAt) => ({
    accountKey, updatedAt,
    calibration: { observations: [{ remainingPercent: 50, localEquivalent: 100, components: {}, at: updatedAt }], last: { remainingPercent: 50, localEquivalent: 100, components: {}, at: updatedAt } }
  });
  const selected = quota.selectSyncSnapshot([
    { deviceId: 'windows', quotaTokenEstimate: snapshot('sha256:path-hash', '2026-08-17T01:00:00Z') },
    { deviceId: 'mac', quotaTokenEstimate: snapshot('sha256:keychain-hash', '2026-08-17T00:00:00Z') }
  ], { accountKey: 'sha256:keychain-hash', sourceDeviceId: 'windows' });
  assert.equal(selected.accountKey, 'sha256:path-hash');
});
test('projects raw token capacity using the current cache mix', () => {
  const result = quota.rawTokenProjection({ capacity: 1_000_000, remainingPercent: 60, reservePercent: 5, components: { input: 100, cacheRead: 900, cacheWrite: 0, output: 0 }, weights: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 } });
  assert.equal(result.capacity, 5_263_158);
  assert.equal(result.remaining, 3_157_895);
  assert.equal(result.conservativeRemaining, 2_894_737);
  assert.equal(result.cacheHitPercent, 90);
});
test('normalizes every historical interval to the current cache mix', () => {
  const observations = [
    { remainingPercent: 80, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
    { remainingPercent: 79, components: { input: 10_000, cacheRead: 90_000, cacheWrite: 0, output: 0 } },
    { remainingPercent: 78, components: { input: 25_000, cacheRead: 185_000, cacheWrite: 0, output: 0 } },
    { remainingPercent: 77, components: { input: 225_000, cacheRead: 190_000, cacheWrite: 0, output: 0 } }
  ];
  const result = quota.rawCapacityFromObservations(observations, { input: 20_000, cacheRead: 180_000, cacheWrite: 0, output: 0 });
  assert.equal(result.capacity, 13_833_333);
  assert.equal(result.samples, 3);
  assert.equal(result.cacheHitPercent, 90);
});
test('raw capacity cannot be lower than the active cycle consumption implies', () => {
  const observations = [
    { remainingPercent: 75, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, resetsAt: 'active' },
    { remainingPercent: 24, components: { input: 7_583_169, cacheRead: 173_528_704, cacheWrite: 0, output: 442_099 }, resetsAt: 'active' }
  ];
  const result = quota.rawCapacityFromObservations(observations, { input: 100, cacheRead: 100, cacheWrite: 0, output: 0 });
  const consumed = 181_553_972;
  assert.equal(result.capacity, Math.round(consumed * 100 / 51));
  assert.ok(result.capacity > consumed);
  assert.ok(Math.round(result.capacity * 24 / 100) > 0);
});
test('learns capacity from official percentage movement and local components', () => {
  let state = quota.advanceCalibration(null, { remainingPercent: 90, localEquivalent: 1000, at: '2026-08-14T00:00:00Z', resetsAt: '2026-08-18T00:00:00Z' });
  state = quota.advanceCalibration(state, { remainingPercent: 80, localEquivalent: 101000, at: '2026-08-14T01:00:00Z', resetsAt: '2026-08-18T00:00:00Z' });
  assert.equal(state.capacity, 1000000);
  assert.equal(state.hoursLeft, 8);
});
test('remote-only consumption changes time forecast but not inferred capacity', () => {
  let state = quota.advanceCalibration(null, { remainingPercent: 90, localEquivalent: 1000, at: '2026-08-14T00:00:00Z' });
  state = quota.advanceCalibration(state, { remainingPercent: 80, localEquivalent: 1000, at: '2026-08-14T01:00:00Z' });
  assert.equal(state.capacity, null);
  assert.equal(state.samples.length, 0);
  assert.equal(state.hoursLeft, 8);
});
test('a quota reset preserves history and starts a new comparison window', () => {
  const old = { remainingPercent: 40, localEquivalent: 5000, components: { input: 1000, cacheRead: 4000 }, at: '2026-08-14T00:00:00Z', resetsAt: 'a' };
  const state = quota.advanceCalibration({ last: old, first: old, samples: [1000000], observations: [old] }, { remainingPercent: 100, localEquivalent: 6000, components: { input: 1200, cacheRead: 4800 }, at: '2026-08-14T01:00:00Z', resetsAt: 'b' });
  assert.deepEqual(state.samples, [1000000]);
  assert.equal(state.observations.length, 2);
  assert.equal(state.first.resetsAt, 'b');
});
test('raw capacity uses intervals from both sides of quota resets', () => {
  const observations = [
    { remainingPercent: 80, components: { input: 0, cacheRead: 0 }, resetsAt: 'a' },
    { remainingPercent: 79, components: { input: 10_000, cacheRead: 90_000 }, resetsAt: 'a' },
    { remainingPercent: 100, components: { input: 10_000, cacheRead: 90_000 }, resetsAt: 'b' },
    { remainingPercent: 99, components: { input: 20_000, cacheRead: 180_000 }, resetsAt: 'b' }
  ];
  const result = quota.rawCapacityFromObservations(observations, { input: 20_000, cacheRead: 180_000 });
  assert.equal(result.samples, 2);
  assert.equal(result.windows, 2);
  assert.equal(result.capacity, 10_000_000);
});
test('records token consumption separately for every reset cycle', () => {
  const observations = [
    { remainingPercent: 100, components: { input: 100, cacheRead: 900, output: 0 }, at: '2026-08-01T00:00:00Z', resetsAt: 'a' },
    { remainingPercent: 40, components: { input: 10_100, cacheRead: 90_900, output: 2_000 }, at: '2026-08-07T00:00:00Z', resetsAt: 'a' },
    { remainingPercent: 100, components: { input: 10_100, cacheRead: 90_900, output: 2_000 }, at: '2026-08-08T00:00:00Z', resetsAt: 'b' },
    { remainingPercent: 80, components: { input: 15_100, cacheRead: 120_900, output: 3_000 }, at: '2026-08-09T00:00:00Z', resetsAt: 'b' }
  ];
  const cycles = quota.cycleSummaries(observations);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].rawTokens, 102_000);
  assert.equal(cycles[0].usedPercent, 60);
  assert.equal(cycles[0].current, false);
  assert.equal(cycles[1].rawTokens, 36_000);
  assert.equal(cycles[1].current, true);
});
test('fits component weights and capacity from varied raw observations', () => {
  const trueCapacity = 20_000_000;
  const weights = [1, 0.2, 1.5, 5];
  const observations = [{ remainingPercent: 100, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, at: '2026-08-14T00:00:00Z', resetsAt: 'r' }];
  let used = 0; const totals = [0, 0, 0, 0];
  for (let i = 1; i <= 20; i += 1) {
    const delta = [20_000 + i * 700, 80_000 + (i % 4) * 25_000, 5_000 + (i % 3) * 4_000, 2_000 + (i % 5) * 900];
    delta.forEach((value, j) => { totals[j] += value; });
    used += delta.reduce((sum, value, j) => sum + value * weights[j], 0) / trueCapacity * 100;
    observations.push({ remainingPercent: 100 - used, components: { input: totals[0], cacheRead: totals[1], cacheWrite: totals[2], output: totals[3] }, at: `2026-08-14T${String(i).padStart(2, '0')}:00:00Z`, resetsAt: 'r' });
  }
  const fit = quota.fitDeductionModel(observations);
  assert.ok(Math.abs(fit.capacity - trueCapacity) / trueCapacity < 0.15);
  assert.ok(Math.abs(fit.weights.cacheRead - weights[1]) < 0.15);
  assert.ok(Math.abs(fit.weights.output - weights[3]) < 1);
});
