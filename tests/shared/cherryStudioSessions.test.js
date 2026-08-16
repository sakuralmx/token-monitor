'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  cherryStudioEntryFromFile,
  cherryStudioRoots,
  scanCherryStudioSessions
} = require('../../src/shared/cherryStudioSessions');

// Minimal in-memory fs used by the adapter, so fixtures never touch disk.
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
    readSync(fd, buffer, offset, length) {
      const text = fd.value;
      const bytes = Buffer.from(text, 'utf8');
      const sourceOffset = 0;
      const copy = bytes.subarray(sourceOffset, sourceOffset + length);
      copy.copy(buffer, offset);
      return copy.length;
    },
    closeSync() {}
  };
}

const ROOT = path.join('home', 'alice', 'AppData', 'Roaming', 'CherryStudio', '.claude', 'projects');
const ROOT_V2 = path.join('home', 'alice', 'AppData', 'Roaming', 'CherryStudio', 'Data', 'Agents', '.claude', 'projects');

function transcriptLines(overrides = {}) {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T09:00:00.000Z', cwd: '/Users/alice/work/project-x', message: { role: 'user', content: '帮我修一下构建失败' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T09:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T09:10:00.000Z', cwd: '/Users/alice/work/project-x', message: { role: 'user', content: '现在崩在测试里' } })
  ];
  if (overrides.title !== undefined) {
    lines.push(JSON.stringify({
      type: 'summary',
      timestamp: '2026-08-01T09:10:30.000Z',
      summary: { title: overrides.title, total_tokens: 1234, cost_usd: 0.05 }
    }));
  }
  return lines.join('\n');
}

test('cherryStudioRoots resolves V2 and legacy roots per platform without duplicating', () => {
  const env = { APPDATA: path.join('home', 'alice', 'AppData', 'Roaming') };
  const roots = cherryStudioRoots({ home: path.join('home', 'alice'), env });
  // All platform variants are returned (scanning skips nonexistent dirs), V2
  // before legacy, with the Windows APPDATA pair present exactly once.
  assert.equal(roots.length, 6);
  assert.ok(roots.includes(ROOT_V2));
  assert.ok(roots.includes(ROOT));
  assert.equal(roots.filter((root) => root === ROOT).length, 1);
  assert.equal(roots.filter((root) => root === ROOT_V2).length, 1);
  assert.equal(roots[0], ROOT_V2); // V2 live transcripts come first
});

test('scanCherryStudioSessions reads V2 and legacy transcripts with local titles', () => {
  const fsModule = memoryFs({
    [ROOT]: null,
    [path.join(ROOT, '-Users-alice-work-project-x')]: null,
    [path.join(ROOT, '-Users-alice-work-project-x', 'session-1.jsonl')]: transcriptLines({ title: 'Fix the build' })
  });
  const entries = scanCherryStudioSessions({ deviceId: 'macbook', home: path.join('home', 'alice'), env: { APPDATA: path.join('home', 'alice', 'AppData', 'Roaming') }, fsModule });
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.client, 'cherrystudio');
  assert.equal(entry.sessionId, 'session-1');
  assert.equal(entry.title, 'Fix the build');
  assert.equal(entry.titleSource, 'local');
  assert.equal(entry.workspaceLabel, 'project-x');
  assert.ok(entry.workspaceKey.startsWith('sha256:'));
  assert.ok(!entry.workspaceKey.includes('alice'));
  assert.equal(entry.messageCount, 2);
  assert.deepEqual(entry.stats, { totalTokens: 1234, costUsd: 0.05 });
  assert.equal(entry.startedAt, '2026-08-01T09:00:00.000Z');
  assert.equal(entry.lastUsedAt, '2026-08-01T09:10:30.000Z');
});

test('missing summary title falls back to the first valid user message', () => {
  const filePath = path.join(ROOT, '-Users-alice-work-project-x', 'session-2.jsonl');
  const entry = cherryStudioEntryFromFile({
    deviceId: 'macbook',
    home: path.join('home', 'alice'),
    env: { APPDATA: path.join('home', 'alice', 'AppData', 'Roaming') },
    fsModule: memoryFs({ [filePath]: transcriptLines() })
  }, filePath);
  assert.equal(entry.title, '帮我修一下构建失败');
  assert.equal(entry.titleSource, 'fallback');
  // Overlong fallback is truncated by the shared sanitizer.
  const longFile = path.join(ROOT, '-Users-alice-work-project-x', 'session-3.jsonl');
  const longEntry = cherryStudioEntryFromFile({
    deviceId: 'macbook',
    home: path.join('home', 'alice'),
    env: {},
    fsModule: memoryFs({ [longFile]: transcriptLines({ longMessage: true }) })
  }, longFile);
  assert.ok(longEntry.title.length <= 200);
});

test('a corrupt transcript is skipped without breaking the scan', () => {
  const fsModule = memoryFs({
    [ROOT]: null,
    [path.join(ROOT, '-Users-alice-work-project-x')]: null,
    [path.join(ROOT, '-Users-alice-work-project-x', 'session-1.jsonl')]: transcriptLines({ title: 'Good' }),
    [path.join(ROOT, '-Users-alice-work-project-x', 'corrupt.jsonl')]: '{not json\n{{{{',
    [path.join(ROOT, '-Users-alice-work-project-x', 'unreadable.jsonl')]: undefined
  });
  const entries = scanCherryStudioSessions({ deviceId: 'macbook', home: path.join('home', 'alice'), env: {}, fsModule });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 'session-1');
});

test('V2 root wins over the legacy snapshot for the same session id', () => {
  const fsModule = memoryFs({
    [ROOT]: null,
    [ROOT_V2]: null,
    [path.join(ROOT, '-Users-alice-work-project-x')]: null,
    [path.join(ROOT, '-Users-alice-work-project-x', 'session-1.jsonl')]: transcriptLines({ title: 'Legacy title' }),
    [path.join(ROOT_V2, '-Users-alice-work-project-x')]: null,
    [path.join(ROOT_V2, '-Users-alice-work-project-x', 'session-1.jsonl')]: transcriptLines({ title: 'Live title' })
  });
  const entries = scanCherryStudioSessions({ deviceId: 'macbook', home: path.join('home', 'alice'), env: { APPDATA: path.join('home', 'alice', 'AppData', 'Roaming') }, fsModule });
  // Both transcripts surface as entries (the hub dedupes by primary key); the
  // caller merges by updatedAt. Verify both are present with their own titles.
  const byTitle = entries.map((e) => e.title);
  assert.deepEqual(byTitle.sort(), ['Legacy title', 'Live title']);
});

test('cherryStudioEntryFromFile returns null for missing/unreadable files', () => {
  const filePath = path.join(ROOT, '-Users-alice-work-project-x', 'nope.jsonl');
  const entry = cherryStudioEntryFromFile({
    deviceId: 'macbook', home: path.join('home', 'alice'), env: {}, fsModule: memoryFs({})
  }, filePath);
  assert.equal(entry, null);
});
