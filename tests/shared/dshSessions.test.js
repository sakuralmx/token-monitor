'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  MAX_SESSION_BYTES,
  decompressZstd,
  detectBackend,
  dshEntryFromDir,
  hasZstdMagic,
  providerByModelOf,
  providerNamesOf,
  resetBackendCache,
  scanDshSessions,
  scanZstdFrames
} = require('../../src/shared/dshSessions');

const hasBuiltinZstd = typeof zlib.zstdCompressSync === 'function';

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
const SESSION_ID = 'a285da6e-73d8-484b-80c4-03693b19da91';
const SESSION_DIR = path.join(WORKSPACE_PATH, SESSION_ID);

const CREATED_AT = Date.parse('2026-08-17T03:00:00.000Z');
const FIRST_USER_TIME = Date.parse('2026-08-17T03:00:01.000Z');
const TITLE_TIME = Date.parse('2026-08-17T03:00:02.000Z');
const LAST_TIME = Date.parse('2026-08-17T03:05:01.000Z');

// A realistic DSH session stream: header line + a user message, an injected
// context message, the title event, an assistant message with usage, and the
// closing turn. Mirrors what @deepseek-ai/dsh-session-persistence-jsonl writes.
function dshJsonl({ withTitle = true } = {}) {
  const header = JSON.stringify({
    type: 'session',
    version: 0,
    id: SESSION_ID,
    createdAt: CREATED_AT,
    cwd: '/home/alice/work/token-monitor',
    agentPreset: 'standard'
  });
  const userMessage = JSON.stringify({
    type: 'user/message',
    seq: 8,
    time: FIRST_USER_TIME,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '请审查这个提交' }],
      source: { kind: 'user' },
      id: 'msg-user'
    },
    surfaceOp: 'append'
  });
  const injectedContext = JSON.stringify({
    type: 'user/message',
    seq: 9,
    time: FIRST_USER_TIME,
    data: {
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>AGENTS.md instructions</system-reminder>' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
      id: 'msg-context'
    },
    surfaceOp: 'append'
  });
  const title = withTitle
    ? JSON.stringify({
      type: 'session/title',
      seq: 12,
      time: TITLE_TIME,
      data: { title: '审查提交', messageSeqs: [8], source: { kind: 'fallback' } }
    })
    : null;
  const assistantMessage = JSON.stringify({
    type: 'assistant/message',
    seq: 1659,
    time: LAST_TIME,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50 }
    }
  });
  const turnEnd = JSON.stringify({
    type: 'turn/end',
    seq: 1663,
    time: LAST_TIME,
    data: { turn: 1, reason: { kind: 'completed' } }
  });
  return [header, userMessage, injectedContext, title, assistantMessage, turnEnd].filter(Boolean).join('\n');
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
      [path.join(SESSION_DIR, 'session.jsonl')]: dshJsonl()
    }),
    ...overrides
  };
}

test('hasZstdMagic recognizes and rejects frames', () => {
  assert.equal(hasZstdMagic(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])), true);
  assert.equal(hasZstdMagic(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), false); // gzip
  assert.equal(hasZstdMagic(Buffer.from('{}')), false);
  assert.equal(hasZstdMagic(Buffer.alloc(2)), false);
});

test('scanZstdFrames splits a multi-frame concatenation', { skip: !hasBuiltinZstd }, () => {
  const headerFrame = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"a"}\n'));
  const eventFrame = zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","seq":0}\n'));
  const frames = scanZstdFrames(Buffer.concat([headerFrame, eventFrame]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].start, 0);
  assert.equal(frames[0].end, headerFrame.length);
  assert.equal(frames[1].start, headerFrame.length);
  assert.equal(frames[1].end, headerFrame.length + eventFrame.length);
});

test('decompressZstd reconstructs a multi-frame stream via node:zlib', { skip: !hasBuiltinZstd }, () => {
  resetBackendCache();
  const jsonl = dshJsonl();
  const headerFrame = zlib.zstdCompressSync(Buffer.from(jsonl.split('\n')[0] + '\n'));
  const eventFrame = zlib.zstdCompressSync(Buffer.from(jsonl.split('\n').slice(1).join('\n') + '\n'));
  const out = decompressZstd(Buffer.concat([headerFrame, eventFrame]), {});
  assert.equal(out.toString('utf8'), jsonl + '\n');
  assert.deepEqual(providerNamesOf(out.toString('utf8').split('\n')), ['deepseek-official']);
  resetBackendCache();
});

test('decompressZstd passes plain (uncompressed) input through untouched', () => {
  const jsonl = dshJsonl();
  const out = decompressZstd(Buffer.from(jsonl, 'utf8'), {});
  assert.equal(out.toString('utf8'), jsonl);
});

test('decompressZstd returns null when no backend is available', () => {
  resetBackendCache();
  const out = decompressZstd(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]), { zlibModule: {} });
  assert.equal(out, null);
  resetBackendCache();
});

test('detectBackend reports a clear unavailable state when forced', () => {
  resetBackendCache();
  const backend = detectBackend({ zlibModule: {}, zstdPath: 'definitely-not-a-real-binary' });
  assert.equal(backend.kind, 'none');
  resetBackendCache();
});

test('providerNamesOf reads nested provider identity from assistant messages', () => {
  const lines = dshJsonl().split('\n');
  assert.deepEqual(providerNamesOf(lines), ['deepseek-official']);
  assert.deepEqual([...providerByModelOf(lines)], [['deepseek-v4-pro', 'deepseek-official']]);
});

test('providerByModelOf prefers DSH route ids such as yx over protocol families', () => {
  const lines = dshJsonl().split('\n');
  const messageIndex = lines.findIndex((line) => line.includes('assistant/message'));
  const message = JSON.parse(lines[messageIndex]);
  message.data.message.source.provider = 'yx';
  message.data.message.source.replayState = { provider: 'yx', model: 'deepseek-v4-pro' };
  lines[messageIndex] = JSON.stringify(message);
  assert.deepEqual([...providerByModelOf(lines)], [['deepseek-v4-pro', 'yx']]);
});

test('providerByModelOf drops ambiguous model routes instead of guessing', () => {
  const lines = dshJsonl().split('\n');
  const second = JSON.parse(lines.find((line) => line.includes('assistant/message')));
  second.data.message.source.provider = 'yx';
  second.data.message.source.replayState = { provider: 'yx', model: 'deepseek-v4-pro' };
  lines.push(JSON.stringify(second));
  assert.deepEqual([...providerByModelOf(lines)], []);
});

test('scanDshSessions reads the header cwd and the session/title event', () => {
  resetBackendCache();
  const entries = scanDshSessions(baseDeps()).entries;
  resetBackendCache();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.client, 'dsh');
  assert.equal(entry.sessionId, SESSION_ID);
  // Title comes from DSH's own session/title event, not the message text.
  assert.equal(entry.title, '审查提交');
  assert.equal(entry.titleSource, 'local');
  // Description is the first real user message.
  assert.equal(entry.description, '请审查这个提交');
  // Workspace derives from the exact header cwd, not the lossy dir name.
  assert.equal(entry.workspaceLabel, 'token-monitor');
  assert.ok(entry.workspaceKey.startsWith('sha256:'));
  assert.ok(!entry.workspaceKey.includes('alice'));
  assert.ok(!entry.workspaceKey.includes('token-monitor'));
  assert.equal(entry.messageCount, 3); // two user/message (real + injected) + one assistant/message
  assert.deepEqual(entry.stats, { totalTokens: 350 });
  assert.equal(entry.startedAt, '2026-08-17T03:00:00.000Z');
  assert.equal(entry.lastUsedAt, '2026-08-17T03:05:01.000Z');
});

test('scanDshSessions includes bare-UUID session dirs (no session- prefix filter)', () => {
  resetBackendCache();
  const bareId = '0127fdd4-790b-4f8c-bb84-f55df88fd000';
  const bareDir = path.join(WORKSPACE_PATH, bareId);
  const jsonl = dshJsonl().replace(new RegExp(SESSION_ID, 'g'), bareId);
  const deps = {
    deviceId: 'macbook',
    home: path.join('home', 'alice'),
    env: {},
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [bareDir]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: dshJsonl(),
      [path.join(bareDir, 'session.jsonl')]: jsonl
    })
  };
  const entries = scanDshSessions(deps).entries;
  resetBackendCache();
  assert.equal(entries.length, 2);
  const ids = entries.map((e) => e.sessionId).sort();
  assert.deepEqual(ids, [SESSION_ID, bareId].sort());
});

test('falls back to the first real user message when no title was logged', () => {
  resetBackendCache();
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: dshJsonl({ withTitle: false })
    })
  });
  const entry = scanDshSessions(deps).entries[0];
  resetBackendCache();
  assert.equal(entry.title, '请审查这个提交');
  assert.equal(entry.titleSource, 'fallback');
});

test('injected context is never a title source', () => {
  resetBackendCache();
  // Only an injected (plugin) user/message and no title → nothing to show.
  const injectedOnly = [
    JSON.stringify({ type: 'session', version: 0, id: SESSION_ID, createdAt: CREATED_AT, cwd: '/home/alice/work/token-monitor' }),
    JSON.stringify({
      type: 'user/message', seq: 9, time: FIRST_USER_TIME,
      data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>…</system-reminder>' }], source: { kind: 'plugin' } },
      surfaceOp: 'append'
    })
  ].join('\n');
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: injectedOnly
    })
  });
  assert.deepEqual(scanDshSessions(deps).entries, []);
  resetBackendCache();
});

test('sessions without any user message or title are skipped', () => {
  resetBackendCache();
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: JSON.stringify({ type: 'assistant/message', seq: 1, time: CREATED_AT, data: { message: {} } })
    })
  });
  assert.deepEqual(scanDshSessions(deps).entries, []);
  resetBackendCache();
});

test('oversized sessions are skipped (size boundary)', () => {
  resetBackendCache();
  const big = dshJsonl() + '\n' + JSON.stringify({ type: 'turn/end', seq: 999, time: LAST_TIME, data: { turn: 2, reason: { kind: 'completed' }, pad: 'x'.repeat(MAX_SESSION_BYTES) } });
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: big
    })
  });
  assert.deepEqual(scanDshSessions(deps).entries, []);
  resetBackendCache();
});

test('a session without a header cwd has no workspace (no flattened-path label)', () => {
  resetBackendCache();
  // Header with no cwd → the entry must not invent a workspace label from the
  // lossy flattened directory name (which could leak a drive letter / username).
  const jsonl = [
    JSON.stringify({ type: 'session', version: 0, id: SESSION_ID, createdAt: CREATED_AT }),
    JSON.stringify({ type: 'user/message', seq: 0, time: FIRST_USER_TIME, data: { role: 'user', content: [{ type: 'text', text: '无工作区的会话' }], source: { kind: 'user' } } })
  ].join('\n');
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl')]: jsonl
    })
  });
  const entry = scanDshSessions(deps).entries[0];
  resetBackendCache();
  assert.ok(entry);
  assert.equal(entry.workspaceKey, '');
  assert.equal(entry.workspaceLabel, '');
});

test('dshEntryFromDir returns null for missing or unreadable sessions', () => {
  const missing = dshEntryFromDir(baseDeps(), WORKSPACE_DIR, path.join(WORKSPACE_PATH, 'session-nope'));
  assert.equal(missing, null);
});

test('dshEntryFromDir reads a real zstd artifact end-to-end', { skip: !hasBuiltinZstd }, () => {
  resetBackendCache();
  const jsonl = dshJsonl();
  const headerFrame = zlib.zstdCompressSync(Buffer.from(jsonl.split('\n')[0] + '\n'));
  const eventFrame = zlib.zstdCompressSync(Buffer.from(jsonl.split('\n').slice(1).join('\n') + '\n'));
  const compressed = Buffer.concat([headerFrame, eventFrame]);
  const deps = baseDeps({
    fsModule: memoryFs({
      [SESSION_ROOT]: null,
      [WORKSPACE_PATH]: null,
      [SESSION_DIR]: null,
      [path.join(SESSION_DIR, 'session.jsonl.zstd')]: compressed
    })
  });
  const entry = dshEntryFromDir(deps, WORKSPACE_DIR, SESSION_DIR);
  resetBackendCache();
  assert.ok(entry);
  assert.equal(entry.title, '审查提交');
  assert.equal(entry.workspaceLabel, 'token-monitor');
  assert.equal(entry.sessionId, SESSION_ID);
});
