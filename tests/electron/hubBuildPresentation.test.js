'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { presentation, targetKey, testPresentation } = require('../../src/electron/renderer/hubBuildPresentation');

test('Hub build presentation uses restrained semantic tones', () => {
  assert.deepEqual(presentation({ status: 'current', runtime: 'cloudflare-worker' }), {
    key: 'settings.sync.hubBuild.current',
    targetKey: 'settings.sync.hubBuild.targetWorker',
    tone: 'ok'
  });
  assert.equal(presentation({ status: 'updateAvailable', runtime: 'node-hub' }).tone, 'warning');
  assert.deepEqual(presentation({ status: 'legacy', runtime: 'cloudflare-worker' }), {
    key: 'settings.sync.hubBuild.updateAvailable',
    targetKey: 'settings.sync.hubBuild.targetWorker',
    tone: 'warning'
  });
  assert.equal(presentation({ status: 'remoteNewer', runtime: 'node-hub' }).tone, '');
  assert.equal(presentation({ status: 'unavailable', runtime: '' }), null);
});

test('Hub build presentation surfaces secret problems as config errors', () => {
  assert.deepEqual(presentation({ status: 'unauthorized', runtime: 'node-hub' }), {
    key: 'settings.sync.hubBuild.unauthorized',
    targetKey: 'settings.sync.hubBuild.targetNode',
    tone: 'error'
  });
  assert.deepEqual(presentation({ status: 'needsSecret', runtime: 'cloudflare-worker' }), {
    key: 'settings.sync.hubBuild.needsSecret',
    targetKey: 'settings.sync.hubBuild.targetWorker',
    tone: 'error'
  });
});

test('connection test presentation classifies every transport outcome', () => {
  assert.deepEqual(testPresentation({ status: 'current', runtime: 'node-hub' }), {
    key: 'settings.sync.hubBuild.current',
    targetKey: 'settings.sync.hubBuild.targetNode',
    tone: 'ok'
  });
  assert.deepEqual(testPresentation({ status: 'unauthorized' }), {
    key: 'settings.sync.hubBuild.unauthorized',
    tone: 'error'
  });
  assert.deepEqual(testPresentation({ status: 'needsSecret' }), {
    key: 'settings.sync.hubBuild.needsSecret',
    tone: 'error'
  });
  assert.deepEqual(testPresentation({ status: 'unavailable', reason: 'certificate' }), {
    key: 'settings.sync.offline.certificate',
    tone: 'error',
    detail: ''
  });
  assert.deepEqual(testPresentation({ status: 'unavailable', reason: 'http', detail: 502 }), {
    key: 'settings.sync.offline.serverError',
    tone: 'error',
    detail: '502'
  });
  assert.equal(testPresentation({ status: 'unavailable', reason: 'unknown-reason' }), null);
  assert.equal(testPresentation({ status: 'notConfigured' }), null);
});

test('Hub build presentation labels Worker, Node, and unknown Hub runtimes', () => {
  assert.equal(targetKey('cloudflare-worker'), 'settings.sync.hubBuild.targetWorker');
  assert.equal(targetKey('node-hub'), 'settings.sync.hubBuild.targetNode');
  assert.equal(targetKey('custom'), 'settings.sync.hubBuild.targetHub');
});
