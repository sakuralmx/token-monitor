'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCatalogStore, CATALOG_SCHEMA_VERSION } = require('../../src/shared/catalogStore');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const sqliteAvailable = Boolean(sqlite);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-catalog-'));
}

function makeStore(overrides = {}) {
  const dir = tempDir();
  const file = path.join(dir, 'catalog.db');
  const store = createCatalogStore({ file, logger: { log() {} }, ...overrides });
  return { store, file, dir };
}

function entry(overrides = {}) {
  return {
    deviceId: 'macbook',
    client: 'codex',
    sessionId: 'rollout-1',
    workspaceKey: 'sha256:proj',
    workspaceLabel: 'project-a',
    title: 'Fix the build',
    titleSource: 'local',
    startedAt: '2026-08-10T00:00:00.000Z',
    lastUsedAt: '2026-08-10T01:00:00.000Z',
    updatedAt: '2026-08-10T01:00:00.000Z',
    ...overrides
  };
}

test('upsert is idempotent: same key + same data does not duplicate or error', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    const first = store.upsertEntries([entry()]);
    assert.deepEqual(first, { accepted: 1, rejected: 0 });
    const second = store.upsertEntries([entry()]);
    assert.deepEqual(second, { accepted: 1, rejected: 0 });
    const listed = store.listSessions({});
    assert.equal(listed.entries.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conflict: newer updatedAt wins; stale data cannot overwrite a newer title', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ title: 'Newer title', updatedAt: '2026-08-10T02:00:00.000Z' })]);
    store.upsertEntries([entry({ title: 'Stale title', updatedAt: '2026-08-10T00:30:00.000Z' })]);
    const [row] = store.listSessions({}).entries;
    assert.equal(row.title, 'Newer title');
    assert.equal(row.updatedAt, '2026-08-10T02:00:00.000Z');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conflict tie: local titleSource beats fallback', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ title: 'Fallback title', titleSource: 'fallback', updatedAt: '2026-08-10T01:00:00.000Z' })]);
    store.upsertEntries([entry({ title: 'Local title', titleSource: 'local', updatedAt: '2026-08-10T01:00:00.000Z' })]);
    const [row] = store.listSessions({}).entries;
    assert.equal(row.title, 'Local title');
    assert.equal(row.titleSource, 'local');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid entries are rejected individually, valid ones accepted', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    const result = store.upsertEntries([
      entry(),
      entry({ client: 'unknown-client' }),
      entry({ sessionId: '' }),
      entry({ title: '' }),
      null,
      'junk'
    ]);
    assert.deepEqual(result, { accepted: 1, rejected: 5 });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batch size limits return batch_too_large', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    const many = Array.from({ length: 1001 }, (_, i) => entry({ sessionId: `s${i}` }));
    assert.throws(() => store.upsertEntries(many), (error) => error.code === 'batch_too_large');
    const manyKeys = Array.from({ length: 501 }, (_, i) => ({ deviceId: 'd', client: 'codex', sessionId: `s${i}` }));
    assert.throws(() => store.invalidateKeys(manyKeys), (error) => error.code === 'batch_too_large');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('soft delete tombstones and hides by default, resurrect on re-upload', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry()]);
    const removed = store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1' }]);
    assert.equal(removed.invalidated, 1);
    assert.equal(store.listSessions({}).entries.length, 0);
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1);
    assert.ok(withDeleted.entries[0].deletedAt);
    // Re-upload without deletedAt resurrects.
    store.upsertEntries([entry()]);
    assert.equal(store.listSessions({}).entries.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pagination: cursor walks all pages in stable order', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    const entries = Array.from({ length: 25 }, (_, i) => entry({
      sessionId: `s${String(i).padStart(2, '0')}`,
      updatedAt: `2026-08-10T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      lastUsedAt: `2026-08-10T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
    }));
    store.upsertEntries(entries);

    const seen = [];
    let cursor = '';
    let pages = 0;
    for (;;) {
      const page = store.listSessions({ limit: 10, cursor });
      seen.push(...page.entries);
      pages += 1;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 25);
    assert.ok(pages >= 3);
    assert.equal(new Set(seen.map((e) => e.sessionId)).size, 25);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filters: deviceId, client, workspace, since', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([
      entry({ sessionId: 'a', client: 'codex', workspaceKey: 'sha256:x', updatedAt: '2026-08-10T01:00:00.000Z' }),
      entry({ sessionId: 'b', client: 'cherrystudio', workspaceKey: 'sha256:y', updatedAt: '2026-08-11T01:00:00.000Z' }),
      entry({ sessionId: 'c', client: 'dsh', workspaceKey: 'sha256:x', updatedAt: '2026-08-12T01:00:00.000Z' })
    ]);
    assert.equal(store.listSessions({ client: 'codex' }).entries.length, 1);
    assert.equal(store.listSessions({ workspace: 'sha256:x' }).entries.length, 2);
    assert.equal(store.listSessions({ since: '2026-08-11T00:00:00.000Z' }).entries.length, 2);
    assert.equal(store.listSessions({ deviceId: 'other' }).entries.length, 0);
    assert.equal(store.listSessions({ client: 'bogus' }).entries.length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema version and migration run on open; records survive reopen', { skip: !sqliteAvailable }, () => {
  const { store, file, dir } = makeStore();
  try {
    assert.equal(store.schemaVersion, CATALOG_SCHEMA_VERSION);
    store.upsertEntries([entry()]);
    store.close();
    // Reopen the same file: data must persist (device offline / hub restart).
    const reopened = createCatalogStore({ file, logger: { log() {} } });
    try {
      assert.equal(reopened.listSessions({}).entries.length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backup writes a consistent snapshot that restores on a fresh store', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ sessionId: 's1' }), entry({ sessionId: 's2', client: 'dsh' })]);
    const backupPath = path.join(dir, 'catalog-backup.db');
    store.backup(backupPath);
    assert.ok(fs.existsSync(backupPath));

    // "Fresh host" restore: open the backup file as a new store.
    const restored = createCatalogStore({ file: backupPath, logger: { log() {} } });
    try {
      const listed = restored.listSessions({});
      assert.equal(listed.entries.length, 2);
      assert.deepEqual(new Set(listed.entries.map((e) => e.sessionId)), new Set(['s1', 's2']));
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('newer schema than this build refuses to open', { skip: !sqliteAvailable }, () => {
  const { store, file, dir } = makeStore();
  try {
    store.close();
    const db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();
    assert.throws(() => createCatalogStore({ file, logger: { log() {} } }), /newer than this build/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
