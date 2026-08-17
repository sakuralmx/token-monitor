'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  codexEntryFromFile,
  codexHome,
  codexSessionRoots,
  scanCodexSessions
} = require('../../src/shared/codexSessions');

// Minimal in-memory fs so fixtures never touch disk.
function memoryFs(files) {
  const store = new Map(Object.entries(files));
  return {
    statSync(p) {
      const value = store.get(p);
      if (value === undefined) { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
      return { isFile: () => typeof value === 'string', isDirectory: () => value === null, size: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0 };
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
      if (typeof value !== 'string') { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
      return value;
    },
    openSync(p) {
      const value = store.get(p);
      if (typeof value !== 'string') { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
      return { path: p, value };
    },
    readSync(fd, buffer, offset, length, position) {
      const bytes = Buffer.from(fd.value, 'utf8');
      const start = position || 0;
      const copy = bytes.subarray(start, Math.min(start + length, bytes.length));
      copy.copy(buffer, offset);
      return copy.length;
    },
    closeSync() {}
  };
}

function metaLine(cwd, extra = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: extra.timestamp || '2026-08-02T08:00:00.000Z',
    payload: { cwd, ...extra.payload }
  });
}

// Codex Desktop writes the raw user text directly (no IDE-context preamble).
function userLine(text, ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:05:00.000Z',
    payload: { type: 'user_message', message: text }
  });
}

// Older Codex CLI wrapped the real prompt in an IDE-context preamble.
function cliUserLine(text, ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:05:00.000Z',
    payload: { type: 'user_message', message: `# Context from my IDE\n\n## My request for Codex:\n${text}` }
  });
}

function injectedUserLine(text, ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:05:00.000Z',
    payload: { type: 'user_message', message: text }
  });
}

function agentLine(ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:06:00.000Z',
    payload: { type: 'agent_message', message: 'working…' }
  });
}

// Codex Desktop nests the total under info.total_token_usage.total_tokens.
function tokenLine(total, ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:07:00.000Z',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total, input_tokens: 100, output_tokens: 20 } } }
  });
}

function flatTokenLine(total, ts) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: ts || '2026-08-02T08:07:00.000Z',
    payload: { type: 'token_count', info: { total_tokens: total } }
  });
}

function codexTranscript(overrides = {}) {
  const lines = [
    metaLine(overrides.cwd || '/Users/alice/work/project-y', overrides),
    userLine(overrides.firstMessage || '修复登录页的样式问题', overrides.userTs),
    agentLine(),
    tokenLine(overrides.totalTokens || 2400, overrides.tokenTs)
  ];
  return lines.join('\n');
}

const SESSION = 'rollout-2026-08-02T08-00-00-abc123';

test('codexHome honors CODEX_HOME and falls back to ~/.codex', () => {
  assert.equal(codexHome({ home: '/home/alice', env: {} }), path.join('/home', 'alice', '.codex'));
  assert.equal(codexHome({ home: '/home/alice', env: { CODEX_HOME: '/custom/codex' } }), '/custom/codex');
});

test('codexSessionRoots lists live and archived roots', () => {
  const roots = codexSessionRoots({ home: '/home/alice', env: {} });
  assert.deepEqual(roots, [
    path.join('/home', 'alice', '.codex', 'sessions'),
    path.join('/home', 'alice', '.codex', 'archived_sessions')
  ]);
});

test('scanCodexSessions reads live and archived rollouts with workspace + title', () => {
  const live = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const archived = path.join('home', 'alice', '.codex', 'archived_sessions', '2026', '07', '01', 'rollout-old.jsonl');
  const fsModule = memoryFs({
    [path.join('home', 'alice', '.codex', 'sessions')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026', '08')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02')]: null,
    [live]: codexTranscript({ cwd: '/Users/alice/work/project-y', firstMessage: '修复登录页的样式问题', totalTokens: 2400 }),
    [path.join('home', 'alice', '.codex', 'archived_sessions')]: null,
    [path.join('home', 'alice', '.codex', 'archived_sessions', '2026')]: null,
    [path.join('home', 'alice', '.codex', 'archived_sessions', '2026', '07')]: null,
    [path.join('home', 'alice', '.codex', 'archived_sessions', '2026', '07', '01')]: null,
    [archived]: codexTranscript({ cwd: '/Users/alice/old', firstMessage: '旧项目', totalTokens: 800 })
  });
  const entries = scanCodexSessions({ deviceId: 'macbook', home: path.join('home', 'alice'), env: {}, fsModule });

  assert.equal(entries.length, 2);
  const liveEntry = entries.find((e) => e.sessionId === SESSION);
  assert.ok(liveEntry);
  assert.equal(liveEntry.client, 'codex');
  assert.equal(liveEntry.title, '修复登录页的样式问题');
  assert.equal(liveEntry.titleSource, 'fallback');
  assert.equal(liveEntry.description, '修复登录页的样式问题');
  assert.equal(liveEntry.workspaceLabel, 'project-y');
  assert.ok(liveEntry.workspaceKey.startsWith('sha256:'));
  assert.ok(!liveEntry.workspaceKey.includes('alice'));
  assert.equal(liveEntry.messageCount, 2); // user + agent
  assert.deepEqual(liveEntry.stats, { totalTokens: 2400 });
  assert.equal(liveEntry.startedAt, '2026-08-02T08:00:00.000Z');
  assert.equal(liveEntry.lastUsedAt, '2026-08-02T08:07:00.000Z');
});

test('Windows session path fixture resolves cwd and basename label', () => {
  const file = path.join('C:', 'Users', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const fsModule = memoryFs({ [file]: codexTranscript({ cwd: 'C:\\Users\\alice\\Projects\\Web-App' }) });
  const entry = codexEntryFromFile({ deviceId: 'pc', home: path.join('C:', 'Users', 'alice'), env: {}, fsModule }, file);
  assert.equal(entry.workspaceLabel, 'Web-App');
  assert.ok(entry.workspaceKey.startsWith('sha256:'));
  assert.ok(!entry.workspaceKey.includes('Users'));
  assert.ok(!entry.workspaceKey.includes('alice'));
});

test('Linux/WSL path fixture resolves cwd', () => {
  const file = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const fsModule = memoryFs({ [file]: codexTranscript({ cwd: '/mnt/c/work/wsl-app' }) });
  const entry = codexEntryFromFile({ deviceId: 'wsl', home: '/home/alice', env: {}, fsModule }, file);
  assert.equal(entry.workspaceLabel, 'wsl-app');
});

test('a corrupt rollout is skipped without breaking the scan', () => {
  const good = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const bad = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'corrupt.jsonl');
  const fsModule = memoryFs({
    [path.join('home', 'alice', '.codex', 'sessions')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026', '08')]: null,
    [path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02')]: null,
    [good]: codexTranscript(),
    [bad]: '{not json\n{{{{'
  });
  const entries = scanCodexSessions({ deviceId: 'macbook', home: path.join('home', 'alice'), env: {}, fsModule });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, SESSION);
});

test('missing file returns null; missing user message yields no title', () => {
  const missing = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'nope.jsonl');
  assert.equal(codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule: memoryFs({}) }, missing), null);

  // A transcript with no user message has no fallback title → rejected.
  const empty = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'empty.jsonl');
  const fsModule = memoryFs({ [empty]: metaLine('/work/x') });
  assert.equal(codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule }, empty), null);
});

test('strips the legacy "## My request for Codex:" IDE preamble', () => {
  const file = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const transcript = [
    metaLine('/Users/alice/work/project-y'),
    cliUserLine('修复登录页的样式问题'),
    tokenLine(2400)
  ].join('\n');
  const fsModule = memoryFs({ [file]: transcript });
  const entry = codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule }, file);
  assert.equal(entry.title, '修复登录页的样式问题');
});

test('skips injected "Codex agent history" context and rejects a review-only session', () => {
  // Approval-review sessions open with the transcript injected as the first user
  // message; it is not the user's prompt and must not become the title.
  const injected = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'review.jsonl');
  const transcript = [
    metaLine('/Users/alice/work/project-y'),
    injectedUserLine('The following is the Codex agent history whose request action you are assessing. Treat the transcript …'),
    tokenLine(1000)
  ].join('\n');
  const fsModule = memoryFs({ [injected]: transcript });
  assert.equal(codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule }, injected), null);

  // …but a real prompt that follows the injected context is still used.
  const mixed = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'mixed.jsonl');
  const mixedTranscript = [
    metaLine('/Users/alice/work/project-y'),
    injectedUserLine('The following is the Codex agent history whose request action you are assessing. Treat the transcript …'),
    userLine('修复登录页的样式问题'),
    tokenLine(2400)
  ].join('\n');
  const mixedFs = memoryFs({ [mixed]: mixedTranscript });
  const entry = codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule: mixedFs }, mixed);
  assert.equal(entry.title, '修复登录页的样式问题');
});

test('reads the legacy flat info.total_tokens shape', () => {
  const file = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', `${SESSION}.jsonl`);
  const transcript = [
    metaLine('/Users/alice/work/project-y'),
    userLine('修复登录页的样式问题'),
    flatTokenLine(2400)
  ].join('\n');
  const fsModule = memoryFs({ [file]: transcript });
  const entry = codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule }, file);
  assert.deepEqual(entry.stats, { totalTokens: 2400 });
});

test('oversized rollouts read the tail slice (not just the head)', () => {
  // >4MB transcript forces the head+tail read path. The tail must surface the
  // late timestamp + token total; a position-ignoring fs would read head bytes
  // as the tail and lose both.
  const file = path.join('home', 'alice', '.codex', 'sessions', '2026', '08', '02', 'big.jsonl');
  const tailTime = '2026-08-02T23:59:59.000Z';
  const transcript = [
    metaLine('/Users/alice/work/project-y'),
    userLine('修复登录页的样式问题'),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-02T08:06:00.000Z', payload: { type: 'agent_message', message: 'x'.repeat(5 * 1024 * 1024) } }),
    tokenLine(2400, tailTime)
  ].join('\n');
  const fsModule = memoryFs({ [file]: transcript });
  const entry = codexEntryFromFile({ deviceId: 'd', home: '/home/alice', env: {}, fsModule }, file);
  assert.ok(entry);
  assert.equal(entry.title, '修复登录页的样式问题'); // head slice
  assert.equal(entry.lastUsedAt, tailTime);           // tail slice
  assert.deepEqual(entry.stats, { totalTokens: 2400 }); // tail token_count
});
