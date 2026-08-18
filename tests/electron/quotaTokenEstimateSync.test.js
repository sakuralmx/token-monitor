'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

test('Electron adds sanitized quota calibration to local, client, and host device records', () => {
  assert.match(main, /function summaryWithQuotaTokenEstimate\(summary\)/);
  assert.equal((main.match(/summaryWithQuotaTokenEstimate\(summary\)/g) || []).length, 3);
  assert.match(main, /Object\.assign\(visibleSummary, summaryWithQuotaTokenEstimate\(visibleSummary\)\)/);
  assert.match(main, /normalizeSyncQuotaSnapshot\(\{/);
  assert.match(main, /quotaTokenEstimates:/);
  assert.match(main, /snapshotFor\('opencode', config\?\.opencodeCalibration\)/);
  assert.match(main, /\{ \.\.\.settings\.quotaTokenEstimate, \.\.\.patch\.quotaTokenEstimate \}/);
});

test('quota rendering adopts the synced snapshot and labels aggregate usage as multi-device', () => {
  assert.match(app, /selectSyncSnapshot\(state\.stats\?\.devices, provider\)/);
  assert.match(app, /advanceCalibration\(estimateConfig\.calibration/);
  assert.match(app, /多设备今日 Codex Token/);
  assert.doesNotMatch(app, /本机今日 Codex Token/);
});

test('quota cards persist provider calibration as partial settings patches', () => {
  assert.match(app, /saveSettings\(\{ quotaTokenEstimate: \{ calibration \} \}\)/);
  assert.match(app, /saveSettings\(\{ quotaTokenEstimate: \{ opencodeCalibration: next \} \}\)/);
});

test('quota card drops the redundant all-tools token, confidence, and filler copy', () => {
  // Q3: the home page already shows today's all-tools token, confidence is
  // meaningless to the user, and the trailing explanatory sentence was noise.
  assert.doesNotMatch(app, /多设备今日全部工具 Token/);
  assert.doesNotMatch(app, /估算可信度/);
  assert.doesNotMatch(app, /历史容量样本/);
  assert.doesNotMatch(app, /已覆盖额度周期/);
  assert.doesNotMatch(app, /已采集时间点/);
  assert.doesNotMatch(app, /估算使用所有已保存的历史区间/);
});

test('OpenCode Go renders a sibling quota card mirroring the GPT token capacity', () => {
  // The OpenCode Go card reuses the exact same token-capacity estimation as the
  // GPT card —预估总容量 / 预估剩余 Token / cycle history — rather than a
  // dollar/request figure, and keeps its calibration in a separate field so the
  // two providers never cross-pollinate observations.
  assert.match(app, /function quotaOpenCodeEstimateCard/);
  assert.match(app, /OpenCode Go 额度趋势/);
  assert.match(app, /预估总容量/);
  assert.match(app, /预估剩余 Token/);
  assert.doesNotMatch(app, /多设备今日 OpenCode Token/);
  assert.match(app, /opencodeCalibration/);
  assert.match(app, /const calibration = estimateConfig\.opencodeCalibration \|\| null/);
  assert.doesNotMatch(app, /estimateConfig\.opencodeCalibration \|\| estimateConfig\.calibration/);
  assert.match(app, /clientComponents\(state\.stats\?\.periods\?\.allTime, 'opencode'\)/);
});
