'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const quota = require('../../src/shared/quotaTokenEstimate');
test('separates cache and output weights', () => { assert.equal(quota.equivalentTokens({ clients: { codex: 1000 }, clientCacheReads: { codex: 600 }, clientCacheWrites: { codex: 100 }, clientOutputs: { codex: 50 } }), 735); });
test('official percentage incorporates remote usage', () => { const r = quota.estimate({ provider: { windows: [{ kind: 'weekly', remainingPercent: 40 }] }, period: {}, capacity: 1e6, reservePercent: 5 }); assert.equal(r.optimisticRemaining, 400000); assert.equal(r.conservativeRemaining, 350000); });
test('does not invent tokens without official percentage', () => { assert.equal(quota.estimate({ period: {}, capacity: 1e6 }).optimisticRemaining, null); });
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
  assert.equal(result.capacity, 12_894_737);
  assert.equal(result.samples, 3);
  assert.equal(result.cacheHitPercent, 90);
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
