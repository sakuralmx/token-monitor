'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../../src/shared/opencodeGoQuota');

test('go limits default to the published $12/$30/$60 and honor the env override', () => {
  assert.deepEqual(quota.goLimits({}), { session: 12, weekly: 30, monthly: 60 });
  assert.deepEqual(quota.goLimits({ TOKEN_MONITOR_OPENCODE_GO_LIMITS: '12,30,60' }), { session: 12, weekly: 30, monthly: 60 });
  assert.deepEqual(quota.goLimits({ TOKEN_MONITOR_OPENCODE_GO_LIMITS: '10,25,50' }), { session: 10, weekly: 25, monthly: 50 });
  // Malformed input falls back to the defaults rather than NaN.
  assert.deepEqual(quota.goLimits({ TOKEN_MONITOR_OPENCODE_GO_LIMITS: 'oops' }), { session: 12, weekly: 30, monthly: 60 });
});

test('model pricing accepts bare and opencode-go/-prefixed ids', () => {
  assert.equal(quota.modelPricing('kimi-k3').input, 3.0);
  assert.equal(quota.modelPricing('opencode-go/kimi-k3').output, 15.0);
  assert.equal(quota.modelPricing('does-not-exist'), null);
});

test('request cost derives from the published per-request token mix', () => {
  // deepseek-v4-pro: 750 in / 82000 cache / 290 out at $0.66/$0.022/$1.98 per 1M.
  const cost = quota.requestCostUsd('deepseek-v4-pro');
  const expected = (750 / 1e6) * 0.66 + (82000 / 1e6) * 0.022 + (290 / 1e6) * 1.98;
  assert.equal(cost, Number(expected.toFixed(8)));
});

test('remaining dollars scale linearly with the window limit', () => {
  assert.equal(quota.remainingUsd(30, 0), 30);
  assert.equal(quota.remainingUsd(30, 50), 15);
  assert.equal(quota.remainingUsd(12, 100), 0);
});

test('estimateGoWindows reports dollars and request counts per window', () => {
  const windows = [
    { kind: 'session', usedPercent: 50, resetsAt: '2026-08-17T00:00:00Z' },
    { kind: 'weekly', usedPercent: 20, resetsAt: null },
    { kind: 'monthly', usedPercent: 10, resetsAt: null }
  ];
  const rows = quota.estimateGoWindows({ windows, modelId: 'gpt-5.6-luna' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].remainingUsd, 6);
  assert.equal(rows[1].remainingUsd, 24);
  assert.equal(rows[2].remainingUsd, 54);
  // Remaining requests are floor(remaining / per-request cost), never negative.
  assert.ok(rows.every((row) => row.remainingRequests === null || row.remainingRequests >= 0));
});

test('estimateGoWindows degrades to dollars-only without a model', () => {
  const rows = quota.estimateGoWindows({ windows: [{ kind: 'weekly', usedPercent: 40 }] });
  assert.equal(rows[0].remainingUsd, 18);
  assert.equal(rows[0].remainingRequests, null);
});

test('estimateGoWindows is null-safe for unknown windows', () => {
  const rows = quota.estimateGoWindows({ windows: [{ kind: 'nonsense', usedPercent: 10 }] });
  assert.equal(rows[0].limitUsd, null);
  assert.equal(rows[0].remainingUsd, null);
  assert.equal(rows[0].remainingRequests, null);
});
