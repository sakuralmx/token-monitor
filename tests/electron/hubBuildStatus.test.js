'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { currentHubBuild } = require('../../src/shared/hubBuildIdentity');
const { healthRuntime, probeErrorReason, probeHubBuild } = require('../../src/electron/hubBuildStatus');

function response(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status ?? (options.ok === false ? 500 : 200),
    async json() { return payload; }
  };
}

test('remote Hub probe recognizes the exact current Worker build', async () => {
  let requested = '';
  const result = await probeHubBuild('https://hub.example/', {
    fetchImpl: async (url) => {
      requested = url;
      return response({ role: 'hub', hubBuild: currentHubBuild('cloudflare-worker') });
    }
  });
  assert.equal(requested, 'https://hub.example/api/health');
  assert.deepEqual(result, {
    status: 'current',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('remote Hub probe identifies legacy health responses without guessing an update direction', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({ ok: true, role: 'hub', runtime: 'cloudflare-worker', version: 1 })
  });
  assert.deepEqual(result, {
    status: 'legacy',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('remote Hub probe treats present but malformed build metadata as unknown', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({
      role: 'hub',
      runtime: 'cloudflare-worker',
      hubBuild: { runtime: 'cloudflare-worker', schemaVersion: 0 }
    })
  });
  assert.deepEqual(result, {
    status: 'unknown',
    runtime: 'cloudflare-worker',
    hubUrl: 'https://hub.example'
  });
});

test('remote Hub probe rejects a successful response from a non-Hub service', async () => {
  const result = await probeHubBuild('https://example.com', {
    fetchImpl: async () => response({ ok: true })
  });
  assert.deepEqual(result, {
    status: 'unavailable',
    reason: 'notHub',
    runtime: '',
    hubUrl: 'https://example.com'
  });
});

test('remote Hub probe suppresses transport failures so stream status remains authoritative', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'network');
});

test('transport failures classify into stable machine reasons', () => {
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'refused');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'dns');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'EAI_AGAIN' } })), 'dns');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })), 'timeout');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'EHOSTUNREACH' } })), 'unreachable');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'EPIPE' } })), 'network');
});

test('TLS verification failures classify as certificate, not network', () => {
  assert.equal(
    probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' } })),
    'certificate'
  );
  assert.equal(probeErrorReason(new Error('unable to verify the first certificate')), 'certificate');
  assert.equal(probeErrorReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })), 'certificate');
  assert.equal(probeErrorReason({ name: 'AbortError' }), 'timeout');
});

test('a health 4xx/5xx classifies as an HTTP failure with its status', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({ ok: false }, { ok: false, status: 502 })
  });
  assert.deepEqual(result, {
    status: 'unavailable',
    reason: 'http',
    detail: 502,
    runtime: '',
    hubUrl: 'https://hub.example'
  });
});

test('a wrong secret is unauthorized, not a reachability failure', async () => {
  let authUrl = '';
  const result = await probeHubBuild('https://hub.example', {
    secret: 'wrong',
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/health')) return response({ ok: true, role: 'hub', runtime: 'node-hub', secretRequired: true });
      authUrl = url;
      assert.equal(options.headers.authorization, 'Bearer wrong');
      return response({ ok: false }, { ok: false, status: 401 });
    }
  });
  assert.equal(authUrl, 'https://hub.example/api/devices');
  assert.deepEqual(result, { status: 'unauthorized', runtime: 'node-hub', hubUrl: 'https://hub.example' });
});

test('a correct secret passes the authenticated probe and returns the version verdict', async () => {
  const result = await probeHubBuild('https://hub.example', {
    secret: 'right',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/health')) return response({ ok: true, role: 'hub', hubBuild: currentHubBuild('node-hub') });
      return response({ devices: [] });
    }
  });
  assert.deepEqual(result, { status: 'current', runtime: 'node-hub', hubUrl: 'https://hub.example' });
});

test('a hub that requires a secret and received none reports needsSecret', async () => {
  const result = await probeHubBuild('https://hub.example', {
    fetchImpl: async () => response({ ok: true, role: 'hub', runtime: 'node-hub', secretRequired: true })
  });
  assert.deepEqual(result, { status: 'needsSecret', runtime: 'node-hub', hubUrl: 'https://hub.example' });
});

test('health runtime normalizes both Hub runtime spellings', () => {
  assert.equal(healthRuntime({ runtime: 'worker' }), 'cloudflare-worker');
  assert.equal(healthRuntime({ hubBuild: { runtime: 'node-hub' } }), 'node-hub');
});
