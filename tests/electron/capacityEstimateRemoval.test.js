'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');

test('renderer exposes no GPT or OpenCode Go capacity estimate cards or settings', () => {
  const app = read('src/electron/renderer/app.js');
  const html = read('src/electron/renderer/index.html');
  const styles = read('src/electron/renderer/styles.css');
  const source = `${app}\n${html}\n${styles}`;

  assert.doesNotMatch(source, /GPT 额度趋势|OpenCode Go 额度趋势/);
  assert.doesNotMatch(source, /预估总容量|预估剩余 Token|预计还能使用/);
  assert.doesNotMatch(source, /quotaEstimate|quota-token|备用容量|安全预留/);
});

test('runtime has no reachable capacity estimate settings, snapshots, or calculation module', () => {
  const main = read('src/electron/main.js');
  const usage = read('src/shared/usage.js');
  const manifest = read('scripts/hub-build-manifest.js');

  assert.doesNotMatch(`${main}\n${usage}\n${manifest}`, /quotaTokenEstimates/);
  assert.doesNotMatch(`${main}\n${usage}\n${manifest}`, /rawCapacityFromObservations|fitDeductionModel|optimisticRemaining|conservativeRemaining/);
  // The singular legacy key may appear only at the settings migration boundary;
  // it is consumed and deleted rather than exposed as a current setting/wire API.
  assert.match(main, /migrateLegacyQuotaHistory\(\s*saved\.quotaTokenEstimate/);
  assert.match(main, /delete merged\.quotaTokenEstimate/);
  assert.equal(fs.existsSync(path.join(__dirname, '../../src/shared/quotaTokenEstimate.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '../../worker/src/shared/quotaTokenEstimate.js')), false);
});
