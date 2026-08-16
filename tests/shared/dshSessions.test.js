'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_SESSION_BYTES,
  decompressZstd,
  detectBackend,
  dshEntryFromDir,
  hasZstdMagic,
  resetBackendCache,
  scanDshSessions,
  workspaceIdentityFromDirName,
  workspacePathFromDirName
} = require('../../src/shared/dshSessions');

// Minimal in-memory fs so fixtures never touch disk.
function memoryFs(files) {
  const store = new Map(Object.entries(files));
  return {
    existsSync(p) {
      return store.has(p);
    },
    statSync(p) {
      const value = store.get(p);
      if (value === undefined) { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
      const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : (value && value.length);
      return { isFile: () => typeof value !== 'undefined' && typeof value !== 'boolean', isDirectory: () => value === null, size };
    },
    readdirSync(dir, opts) {
      const entries = [];
      for (const [name, value] of store) {
        if (!name.startsWith(dir === '/' ? '/' : `${dir}${path.sep}`)) continue;
        const rest = name.slice(dir.length).replace(/^[/\\]+/, '');
        if (!rest || rest.includes(path.sep)) continue;
        entries.push({ name: rest, isFile: () => typeof value === 'string', isDirectory: () => value === null });
      }
      if (opts && opts.withFileTypes) return entries;
      return entries.map((e) => e.name);
    },
    readFileSync(p) {
      const value = store.get(p);
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
      return value;
    },
    writeFileSync() {},
    unlinkSync() {}
  };
}

const SESSION_ROOT = path.join('home', 'alice', '.dsh', 'sessions');
const WORKSPACE_DIR = '--D-700_projects-token-monitor--';
const WORKSPACE_PATH = path.join(SESSION_ROOT, WORKSPACE_DIR);
const SESSION_ID = 'session-2a0a942a-6532-466e-911b-8e5685b26dd1';
const SESSION_DIR = path.join(WORKSPACE_PATH, SESSION_ID);

// A tiny fake zstd "compressor": magic bytes + the payload bytes.
function fakeZstd(jsonl) {
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from(jsonl, 'utf8')]);
}

function fakeFzstdModule() {
  return {
    decompress(bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      assert.ok(hasZstdMagic(buf), 'fake fzstd only handles zstd-framed input');
      return buf.subarray(4);
    }
  };
}

function dshJsonl() {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00.000Z', content: '请审查这个提交' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-03T10:01:00.000Z', content: '好的，我看一下', usage: { total_tokens: 1500 } })
  ];
  return lines.join('\n');
}

function baseDeps(overrides = {}) {
  return {
    deviceId: 'macbook',
    home: path.join('home', 'alice'),
    env: {},
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl.zstd')]: fakeZstd(dshJsonl())
    }),
    fzstdModule: fakeFzstdModule(),
    ...overrides
  };
}

test('zstd magic detection recognizes and rejects frames', () => {
  assert.equal(hasZstdMagic(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])), true);
  assert.equal(hasZstdMagic(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), false); // gzip
  assert.equal(hasZstdMagic(Buffer.from('{}')), false);
  assert.equal(hasZstdMagic(Buffer.alloc(2)), false);
});

test('decompressZstd prefers the fzstd module and falls back to plain bytes', () => {
  resetBackendCache();
  const jsonl = dshJsonl();
  const deps = { fzstdModule: fakeFzstdModule() };
  const out = decompressZstd(fakeZstd(jsonl), deps);
  assert.equal(out.toString('utf8'), jsonl);
  // Plain (uncompressed) input passes through untouched.
  const plain = decompressZstd(Buffer.from(jsonl, 'utf8'), deps);
  assert.equal(plain.toString('utf8'), jsonl);
  resetBackendCache();
});

test('decompressZstd returns null when no backend is available', () => {
  resetBackendCache();
  const out = decompressZstd(fakeZstd(dshJsonl()), {});
  assert.equal(out, null);
  resetBackendCache();
});

test('detectBackend reports a clear unavailable state without a backend', () => {
  resetBackendCache();
  const backend = detectBackend({ zstdPath: 'definitely-not-a-real-binary' });
  assert.equal(backend.kind, 'none');
  resetBackendCache();
});

test('scanDshSessions decodes the workspace dir and builds a catalog entry', () => {
  resetBackendCache();
  const entries = scanDshSessions(baseDeps()).entries;
  resetBackendCache();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.client, 'dsh');
  assert.equal(entry.sessionId, SESSION_ID);
  assert.equal(entry.title, '请审查这个提交');
  assert.equal(entry.titleSource, 'fallback');
  assert.equal(entry.workspaceLabel, 'D-700_projects-token-monitor');
  assert.ok(entry.workspaceKey.startsWith('sha256:'));
  assert.ok(!entry.workspaceKey.includes('alice'));
  assert.ok(!entry.workspaceKey.includes('700_projects'));
  assert.equal(entry.messageCount, 1);
  assert.deepEqual(entry.stats, { totalTokens: 1500 });
  assert.equal(entry.startedAt, '2026-08-03T10:00:00.000Z');
  assert.equal(entry.lastUsedAt, '2026-08-03T10:01:00.000Z');
});

test('zstdAvailable is false with no backend, and the scan still returns cleanly', () => {
  resetBackendCache();
  const result = scanDshSessions({
    deviceId: 'macbook',
    home: path.join('home', 'alice'),
    env: {},
    fsModule: baseDeps().fsModule,
    zstdPath: 'definitely-not-a-real-binary'
  });
  assert.equal(result.zstdAvailable, false);
  assert.deepEqual(result.entries, []);
  resetBackendCache();
});

test('sessions without a user message are skipped', () => {
  resetBackendCache();
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl.zstd')]: fakeZstd(JSON.stringify({ type: 'assistant', timestamp: '2026-08-03T10:01:00.000Z' }))
    })
  });
  assert.deepEqual(scanDshSessions(deps).entries, []);
  resetBackendCache();
});

test('oversized sessions are skipped (size boundary)', () => {
  resetBackendCache();
  const big = fakeZstd(`{"type":"user","content":"${'x'.repeat(MAX_SESSION_BYTES)}"}`);
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl.zstd')]: big
    })
  });
  assert.deepEqual(scanDshSessions(deps).entries, []);
});

test('workspacePathFromDirName decodes DSH flattened path encodings (best-effort)', () => {
  assert.equal(workspacePathFromDirName('--D-700_projects-token-monitor--'), 'D/700_projects/token/monitor');
  assert.equal(workspacePathFromDirName('plain-dir'), '');
  assert.equal(workspacePathFromDirName('--'), '');
  assert.equal(workspacePathFromDirName(''), '');
});

test('workspaceIdentityFromDirName is stable, labeled, and leaks no path', () => {
  const a = workspaceIdentityFromDirName('--D-700_projects-token-monitor--');
  const b = workspaceIdentityFromDirName('--D-700_projects-token-monitor--');
  assert.deepEqual(a, b); // stable across reboots
  assert.equal(a.workspaceLabel, 'D-700_projects-token-monitor');
  assert.ok(a.workspaceKey.startsWith('sha256:'));
  assert.ok(!a.workspaceKey.includes('alice'));
  assert.ok(!a.workspaceKey.includes('D-700_projects'));
  assert.deepEqual(workspaceIdentityFromDirName(''), { workspaceKey: '', workspaceLabel: '' });
});

test('dshEntryFromDir returns null for missing or unreadable sessions', () => {
  const missing = dshEntryFromDir(baseDeps(), WORKSPACE_DIR, path.join(WORKSPACE_PATH, 'session-nope'));
  assert.equal(missing, null);
});
