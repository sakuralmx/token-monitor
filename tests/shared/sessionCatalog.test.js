'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  CATALOG_CLIENTS,
  buildCatalogEntry,
  normalizeCatalogEntry,
  sanitizeTitle,
  titleFromFirstUserMessage,
  workspaceKeyFromPath,
  workspaceLabelFromPath
} = require('../../src/shared/sessionCatalog');

const deviceId = 'macbook';
const client = 'cherrystudio';
const sessionId = 'session-2026-08-17-abc';

function validRaw(overrides = {}) {
  return {
    deviceId,
    client,
    sessionId,
    workspaceKey: 'sha256:abc',
    workspaceLabel: 'token-monitor',
    title: 'Fix the flaky test',
    titleSource: 'local',
    startedAt: '2026-08-17T00:00:00.000Z',
    lastUsedAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z',
    ...overrides
  };
}

test('normalizes a valid entry to the unified wire shape', () => {
  const entry = normalizeCatalogEntry(validRaw({
    messageCount: 12,
    stats: { totalTokens: 1234, costUsd: 0.01 }
  }));
  assert.deepEqual(entry, {
    deviceId: 'macbook',
    client: 'cherrystudio',
    sessionId: 'session-2026-08-17-abc',
    workspaceKey: 'sha256:abc',
    workspaceLabel: 'token-monitor',
    title: 'Fix the flaky test',
    titleSource: 'local',
    startedAt: '2026-08-17T00:00:00.000Z',
    lastUsedAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z',
    messageCount: 12,
    stats: { totalTokens: 1234, costUsd: 0.01 }
  });
});

test('drops unknown fields, absolute paths, and raw conversation payloads', () => {
  const entry = normalizeCatalogEntry(validRaw({
    absolutePath: 'C:\\Users\\alice\\projects\\secret-project',
    home: '/Users/alice',
    body: 'Full conversation with prompt and answer',
    prompt: 'user prompt',
    credentials: { apiKey: 'sk-12345' },
    workspaceKey: 'sha256:abc'
  }));
  assert.equal(entry.absolutePath, undefined);
  assert.equal(entry.home, undefined);
  assert.equal(entry.body, undefined);
  assert.equal(entry.prompt, undefined);
  assert.equal(entry.credentials, undefined);
  assert.deepEqual(Object.keys(entry).sort(), [
    'client', 'deviceId', 'lastUsedAt', 'sessionId', 'startedAt',
    'title', 'titleSource', 'updatedAt', 'workspaceKey', 'workspaceLabel'
  ]);
});

test('rejects entries without a usable primary key or title', () => {
  assert.equal(normalizeCatalogEntry(validRaw({ deviceId: '  ' })), null);
  assert.equal(normalizeCatalogEntry(validRaw({ client: 'unknown-client' })), null);
  assert.equal(normalizeCatalogEntry(validRaw({ sessionId: '\u0000' })), null);
  assert.equal(normalizeCatalogEntry(validRaw({ title: '' })), null);
  assert.equal(normalizeCatalogEntry(validRaw({ startedAt: 'not-a-date', lastUsedAt: 'not-a-date', updatedAt: 'not-a-date' })), null);
  assert.equal(normalizeCatalogEntry(validRaw({ startedAt: '', lastUsedAt: '', updatedAt: '' })), null);
  assert.equal(normalizeCatalogEntry(null), null);
  assert.equal(normalizeCatalogEntry('string'), null);
  assert.equal(normalizeCatalogEntry([]), null);
});

test('normalizes the client id to the closed enum', () => {
  assert.equal(normalizeCatalogEntry(validRaw({ client: 'CherryStudio' })).client, 'cherrystudio');
  assert.equal(CATALOG_CLIENTS.includes('cherrystudio'), true);
  assert.equal(CATALOG_CLIENTS.includes('codex'), true);
  assert.equal(CATALOG_CLIENTS.includes('dsh'), true);
});

test('sanitizes titles: whitespace, control chars, encoding, and length', () => {
  // Whitespace collapse.
  assert.equal(sanitizeTitle('  Fix   the\nflaky test\t'), 'Fix the flaky test');
  // Control characters are stripped.
  assert.equal(sanitizeTitle('Fix\u0000the\u0007test'), 'Fix the test');
  // Unpaired surrogate is removed, paired emoji survive.
  assert.equal(sanitizeTitle('ok\ud800bad'), 'ok bad');
  assert.equal(sanitizeTitle('emoji \ud83d\ude00 end'), 'emoji 😀 end');
  // NFC normalization.
  assert.equal(sanitizeTitle('caf\u00e9'), 'café');
  // Length truncation by code point.
  assert.equal(sanitizeTitle('x'.repeat(250)).length, 200);
});

test('fallback title comes from the first valid user message, locally truncated', () => {
  assert.equal(titleFromFirstUserMessage('  Please fix the build  '), 'Please fix the build');
  assert.equal(titleFromFirstUserMessage('a'.repeat(300)).length, 200);
  assert.equal(titleFromFirstUserMessage(null), '');
  assert.equal(titleFromFirstUserMessage(undefined), '');
  assert.equal(titleFromFirstUserMessage(42), '42');
});

test('sanitizeTitle redacts Windows absolute paths but leaves URLs and drive-letter prose', () => {
  assert.equal(sanitizeTitle('fix C:\\Users\\alice\\work\\x now'), 'fix now');
  assert.equal(sanitizeTitle('D:/work/app'), '');
  assert.equal(sanitizeTitle('see https://example.com/x'), 'see https://example.com/x');
  assert.equal(sanitizeTitle('C: drive is fine'), 'C: drive is fine');
  // A space inside the path stops the redaction at the first word; the remaining
  // "Harness" fragment is harmless prose, but the drive letter + directories are gone.
  assert.equal(sanitizeTitle('install to E:\\001\\_software\\DeepSeek Harness then continue'), 'install to Harness then continue');
});

test('workspace key is a stable one-way hash that never leaks the path', () => {
  const winPath = 'C:\\Users\\alice\\projects\\secret-project';
  const posixPath = '/Users/alice/projects/secret-project';
  const winKey = workspaceKeyFromPath(winPath, { platform: 'win32' });
  const posixKey = workspaceKeyFromPath(posixPath, { platform: 'linux' });

  // One-way: the hash never contains the username or path.
  assert.ok(winKey.startsWith('sha256:'));
  assert.ok(!winKey.includes('alice'));
  assert.ok(!winKey.includes('secret-project'));
  assert.ok(!winKey.includes('C:\\'));
  assert.ok(!posixKey.includes('alice'));

  // Stable across reboots for the same path.
  assert.equal(workspaceKeyFromPath(winPath, { platform: 'win32' }), winKey);
  assert.equal(workspaceKeyFromPath(posixPath, { platform: 'linux' }), posixKey);

  // Windows case folding: same folder, different casing → same key.
  assert.equal(
    workspaceKeyFromPath('c:\\users\\Alice\\projects\\Secret-Project', { platform: 'win32' }),
    winKey
  );

  // Empty input yields no key.
  assert.equal(workspaceKeyFromPath('', { platform: 'win32' }), '');
});

test('workspace label is the sanitized basename, never the full path', () => {
  assert.equal(workspaceLabelFromPath('/Users/alice/projects/token-monitor', { platform: 'linux' }), 'token-monitor');
  assert.equal(workspaceLabelFromPath('C:\\Users\\alice\\projects\\token-monitor', { platform: 'win32' }), 'token-monitor');
  assert.equal(workspaceLabelFromPath('C:\\Users\\alice\\projects\\bad\u0000name', { platform: 'win32' }), 'bad name');
});

test('normalizeCatalogEntry sanitizes path-shaped workspace fields (server-side trust boundary)', () => {
  const entry = normalizeCatalogEntry(validRaw({
    workspaceKey: 'C:\\Users\\alice\\projects\\secret-project',
    workspaceLabel: '/Users/alice/projects/secret-project'
  }));
  assert.equal(entry.workspaceKey, ''); // path-shaped key dropped, never stored
  assert.equal(entry.workspaceLabel, 'secret-project'); // reduced to the basename
});

test('buildCatalogEntry derives workspace fields from an absolute path', () => {
  const entry = buildCatalogEntry({
    deviceId,
    client,
    sessionId,
    absolutePath: '/Users/alice/work/project-x',
    title: 'Do the thing',
    startedAt: '2026-08-17T00:00:00.000Z',
    lastUsedAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z'
  });
  assert.equal(entry.workspaceLabel, 'project-x');
  assert.ok(entry.workspaceKey.startsWith('sha256:'));
  assert.ok(!entry.workspaceKey.includes('alice'));
  assert.equal(entry.titleSource, 'fallback');
});

test('buildCatalogEntry honors explicit workspace fields over path derivation', () => {
  const entry = buildCatalogEntry({
    deviceId,
    client,
    sessionId,
    absolutePath: '/Users/alice/work/project-x',
    workspaceKey: 'sha256:custom',
    workspaceLabel: 'Custom Label',
    title: 'Do the thing',
    lastUsedAt: '2026-08-17T01:00:00.000Z',
    updatedAt: '2026-08-17T01:00:00.000Z'
  });
  assert.equal(entry.workspaceKey, 'sha256:custom');
  assert.equal(entry.workspaceLabel, 'Custom Label');
});

test('buildCatalogEntry uses the project root basename', () => {
  // The adapter passes the project folder; the label is its basename.
  assert.equal(workspaceLabelFromPath(path.join('work', 'project-x')), 'project-x');
});

test('the wire shape is a closed whitelist with no free-form text fields', () => {
  // Privacy boundary: the catalog model has exactly the fields the protocol
  // defines. Anything an adapter might read from raw session data (bodies,
  // prompts, cookies, tokens, paths) has no field to land in and is dropped by
  // normalizeCatalogEntry, so a serialized entry cannot carry them.
  const entry = normalizeCatalogEntry(validRaw({
    body: 'sk-ant-0123456789abcdef',
    prompt: 'Bearer eyJhbGciOiJIUzI1NiJ9',
    cookie: 'session=abc',
    absolutePath: 'C:\\Users\\alice\\projects\\x',
    home: '/Users/alice'
  }));
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('sk-ant-'));
  assert.ok(!serialized.includes('eyJhbGci'));
  assert.ok(!serialized.includes('session=abc'));
  assert.ok(!serialized.includes('C:\\Users'));
  assert.ok(!serialized.includes('/Users/alice'));
});
