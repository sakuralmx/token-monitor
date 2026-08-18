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
test('OpenCode selects only its provider-keyed quota snapshot', () => {
  const observation = (at) => ({ remainingPercent: 50, localEquivalent: 100, components: {}, at });
  const snapshot = (accountKey, at) => ({ accountKey, updatedAt: at, calibration: { observations: [observation(at)], last: observation(at) } });
  const selected = quota.selectSyncSnapshot([{
    deviceId: 'machine',
    quotaTokenEstimate: snapshot('codex-account', '2026-08-17T00:00:00Z'),
    quotaTokenEstimates: { opencode: snapshot('go-account', '2026-08-18T00:00:00Z') }
  }], { provider: 'opencode', accountKey: 'go-account', sourceDeviceId: 'machine' });
  assert.equal(selected.accountKey, 'go-account');
  assert.equal(quota.selectSyncSnapshot([{
    deviceId: 'machine', quotaTokenEstimate: snapshot('codex-account', '2026-08-17T00:00:00Z')
  }], { provider: 'opencode', sourceDeviceId: 'machine' }), null);
});
test('projects raw token capacity using the current cache mix', () => {
  const result = quota.rawTokenProjection({ capacity: 1_000_000, remainingPercent: 60, reservePercent: 5, components: { input: 100, cacheRead: 900, cacheWrite: 0, output: 0 }, weights: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 } });
  assert.equal(result.capacity, 5_263_158);
  assert.equal(result.remaining, 3_157_895);
  assert.equal(result.conservativeRemaining, 2_894_737);
  assert.equal(result.cacheHitPercent, 90);
});
test('cumulative extrapolation drives capacity before any cycle closes', () => {
  const observations = [
    { remainingPercent: 80, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } },
    { remainingPercent: 79, components: { input: 10_000, cacheRead: 90_000, cacheWrite: 0, output: 0 } },
    { remainingPercent: 78, components: { input: 25_000, cacheRead: 185_000, cacheWrite: 0, output: 0 } },
    { remainingPercent: 77, components: { input: 225_000, cacheRead: 190_000, cacheWrite: 0, output: 0 } }
  ];
  const result = quota.rawCapacityFromObservations(observations, { input: 20_000, cacheRead: 180_000, cacheWrite: 0, output: 0 });
  // Whole-cycle cumulative ratio: 415000 raw tokens over a 3% burn → 13.83M.
  assert.equal(result.capacity, 13_833_333);
  assert.equal(result.sourceKind, 'cumulative');
  assert.equal(result.samples, 0);
  // The cache mix now comes from the same active quota cycle as the capacity,
  // rather than today's unrelated mix passed by the renderer.
  assert.equal(result.cacheHitPercent, 45.8);
});
test('raw capacity cannot be lower than weighted active-cycle consumption implies', () => {
  const observations = [
    { remainingPercent: 75, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, resetsAt: 'active' },
    { remainingPercent: 24, components: { input: 7_583_169, cacheRead: 173_528_704, cacheWrite: 10_000, output: 442_099 }, resetsAt: 'active' }
  ];
  const weights = { input: 1, cacheRead: 0.2, cacheWrite: 1.5, output: 6 };
  const result = quota.rawCapacityFromObservations(observations, {}, { weights });
  const rawConsumed = 7_583_169 + 173_528_704 + 10_000 + 442_099;
  const weightedConsumed = 7_583_169 + 173_528_704 * 0.2 + 10_000 * 1.5 + 442_099 * 6;
  const consumedFloor = Math.max(rawConsumed, weightedConsumed);
  assert.equal(result.capacity, Math.round(consumedFloor * 100 / 51));
  assert.ok(result.capacity > consumedFloor);
  assert.equal(result.cacheHitPercent, 95.6);
});

test('capacity inference responds to weights that charge above raw token count', () => {
  const observations = [
    { remainingPercent: 80, components: { input: 0, cacheRead: 0, output: 0 } },
    { remainingPercent: 60, components: { input: 9_000, cacheRead: 0, output: 1_000 } }
  ];
  const cheapOutput = quota.rawCapacityFromObservations(observations, {}, { weights: { output: 1 } });
  const chargedOutput = quota.rawCapacityFromObservations(observations, {}, { weights: { output: 6 } });
  assert.equal(cheapOutput.capacity, 50_000);
  assert.equal(chargedOutput.capacity, 75_000);
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
test('a closed cycle contributes a strong capacity anchor', () => {
  // One closed full cycle (100 → 40 over 60%) followed by the start of the next.
  const observations = [
    { remainingPercent: 100, components: { input: 0, cacheRead: 0 }, at: '2026-08-01T00:00:00Z', resetsAt: 'a' },
    { remainingPercent: 40, components: { input: 60_000, cacheRead: 540_000 }, at: '2026-08-07T00:00:00Z', resetsAt: 'a' },
    { remainingPercent: 100, components: { input: 60_000, cacheRead: 540_000 }, at: '2026-08-08T00:00:00Z', resetsAt: 'b' },
    { remainingPercent: 90, components: { input: 70_000, cacheRead: 630_000 }, at: '2026-08-09T00:00:00Z', resetsAt: 'b' }
  ];
  const result = quota.rawCapacityFromObservations(observations, { input: 0, cacheRead: 0 });
  // Closed cycle: 600000 tokens over 60% → 1,000,000 capacity.
  assert.equal(result.samples, 1);
  assert.equal(result.windows, 2);
  assert.equal(result.sourceKind, 'hybrid');
  assert.ok(result.capacity >= 1_000_000);
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

test('a rolling resetsAt that advances every refresh does not shard one cycle', () => {
  // A provider may report a relative/rolling reset timestamp that changes on
  // every refresh (e.g. "resets 5h from now") while the remaining percentage is
  // still monotonically decreasing within one continuous cycle. Each observation
  // carries a different resetsAt value — the old strict `resetsAt !==` boundary
  // check split this single cycle into four fake groups.
  const observations = [
    { remainingPercent: 75, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, at: '2026-08-14T00:00:00Z', resetsAt: 't1' },
    { remainingPercent: 50, components: { input: 1000, cacheRead: 4000, cacheWrite: 0, output: 0 }, at: '2026-08-15T00:00:00Z', resetsAt: 't2' },
    { remainingPercent: 25, components: { input: 2000, cacheRead: 8000, cacheWrite: 0, output: 0 }, at: '2026-08-16T00:00:00Z', resetsAt: 't3' },
    { remainingPercent: 10, components: { input: 3000, cacheRead: 12000, cacheWrite: 0, output: 0 }, at: '2026-08-17T00:00:00Z', resetsAt: 't4' }
  ];
  const cycles = quota.cycleSummaries(observations);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].startRemainingPercent, 75);
  assert.equal(cycles[0].endRemainingPercent, 10);
  assert.equal(cycles[0].usedPercent, 65);
  assert.equal(cycles[0].rawTokens, 15000);
});

test('low-water reconciliation keeps Aug 14 and Aug 17 inside one quota cycle', () => {
  const observations = [
    { remainingPercent: 75, components: { input: 0 }, at: '2026-08-14T00:00:00Z', resetsAt: 't1' },
    { remainingPercent: 1, components: { input: 740_000 }, at: '2026-08-14T23:00:00Z', resetsAt: 't2' },
    { remainingPercent: 5, components: { input: 750_000 }, at: '2026-08-17T00:00:00Z', resetsAt: 't3' },
    { remainingPercent: 1, components: { input: 790_000 }, at: '2026-08-17T12:00:00Z', resetsAt: 't4' }
  ];
  const cycles = quota.cycleSummaries(observations);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].startRemainingPercent, 75);
  assert.equal(cycles[0].endRemainingPercent, 1);
  assert.equal(cycles[0].rawTokens, 790_000);
});

test('a material refill below half still closes a cycle when sampling is late', () => {
  const observations = [
    { remainingPercent: 75, components: { input: 0 }, at: '2026-08-14T00:00:00Z' },
    { remainingPercent: 1, components: { input: 740 }, at: '2026-08-14T23:00:00Z' },
    { remainingPercent: 45, components: { input: 800 }, at: '2026-08-17T00:00:00Z' },
    { remainingPercent: 1, components: { input: 1_240 }, at: '2026-08-17T12:00:00Z' }
  ];
  assert.equal(quota.cycleSummaries(observations).length, 2);
});

test('a small refill closes a cycle after a known reset deadline', () => {
  const observations = [
    { remainingPercent: 5, components: { input: 0 }, at: '2026-08-14T00:00:00Z', resetsAt: '2026-08-15T00:00:00Z' },
    { remainingPercent: 19, components: { input: 100 }, at: '2026-08-15T00:01:00Z', resetsAt: '2026-08-22T00:00:00Z' }
  ];
  assert.equal(quota.cycleSummaries(observations).length, 2);
});

test('a real percentage rebound still closes a cycle without a resetsAt change', () => {
  const observations = [
    { remainingPercent: 60, components: { input: 0, cacheRead: 0 }, at: '2026-08-14T00:00:00Z', resetsAt: 'same' },
    { remainingPercent: 30, components: { input: 1000, cacheRead: 4000 }, at: '2026-08-15T00:00:00Z', resetsAt: 'same' },
    { remainingPercent: 90, components: { input: 1000, cacheRead: 4000 }, at: '2026-08-16T00:00:00Z', resetsAt: 'same' },
    { remainingPercent: 80, components: { input: 1200, cacheRead: 4800 }, at: '2026-08-17T00:00:00Z', resetsAt: 'same' }
  ];
  const cycles = quota.cycleSummaries(observations);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].endRemainingPercent, 30);
  assert.equal(cycles[1].startRemainingPercent, 90);
});

test('one component rollback preserves positive consumption in the same interval', () => {
  const cycles = quota.cycleSummaries([
    { remainingPercent: 100, components: { input: 100, cacheRead: 100, output: 0 } },
    { remainingPercent: 50, components: { input: 90, cacheRead: 300, output: 100 } }
  ]);
  assert.equal(cycles[0].components.input, 0);
  assert.equal(cycles[0].components.cacheRead, 200);
  assert.equal(cycles[0].components.output, 100);
  assert.equal(cycles[0].rawTokens, 300);
});

test('a local counter rollback re-baselines tokens without claiming a provider reset', () => {
  const first = { remainingPercent: 60, localEquivalent: 10_000, components: { input: 10_000 }, at: '2026-08-14T00:00:00Z' };
  let state = quota.advanceCalibration(null, first);
  state = quota.advanceCalibration(state, { remainingPercent: 55, localEquivalent: 1_000, components: { input: 1_000 }, at: '2026-08-15T00:00:00Z' });
  assert.equal(quota.cycleSummaries(state.observations).length, 1);
  assert.equal(state.first.at, new Date(first.at).toISOString());
});

test('clientComponents extracts a non-codex client when given its id', () => {
  const period = {
    clients: { opencode: 5_000 },
    clientCacheReads: { opencode: 3_000 },
    clientCacheWrites: { opencode: 500 },
    clientOutputs: { opencode: 1_000 }
  };
  const components = quota.clientComponents(period, 'opencode');
  assert.equal(components.total, 5000);
  assert.equal(components.cacheRead, 3000);
  assert.equal(components.cacheWrite, 500);
  assert.equal(components.output, 1000);
  assert.equal(components.input, 500);
});

test('cycleSummaries reuses whole-cycle anchoring for a dollar-denominated provider', () => {
  // OpenCode Go meters in dollars ($12/$30/$60), not tokens. The shared cycle
  // machinery only needs a monotonic `remainingPercent` plus a cumulative
  // components value: putting the dollar total in `input` (rest zero) lets
  // `cycleSummaries.rawTokens` read as dollars and feed the same capacity math.
  const observations = [
    { remainingPercent: 100, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, at: '2026-08-01T00:00:00Z' },
    { remainingPercent: 50, components: { input: 6, cacheRead: 0, cacheWrite: 0, output: 0 }, at: '2026-08-07T00:00:00Z' }
  ];
  const cycles = quota.cycleSummaries(observations);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].rawTokens, 6);
  assert.equal(cycles[0].usedPercent, 50);
  // 6 dollars over 50% → a $12 full-window capacity, matching the published $12/5h.
  assert.equal(quota.rawCapacityFromObservations(observations, {}).capacity, 12);
});
