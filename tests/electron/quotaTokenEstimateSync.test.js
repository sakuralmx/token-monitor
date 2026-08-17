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
});

test('quota rendering adopts the synced snapshot and labels aggregate usage as multi-device', () => {
  assert.match(app, /selectSyncSnapshot\(state\.stats\?\.devices, provider\)/);
  assert.match(app, /advanceCalibration\(estimateConfig\.calibration/);
  assert.match(app, /多设备今日 Codex Token/);
  assert.doesNotMatch(app, /本机今日 Codex Token/);
});
