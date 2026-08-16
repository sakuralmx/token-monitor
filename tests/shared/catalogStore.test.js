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
    assert.deepEqual(first, { accepted: 1, rejected: 0, rejectedKeys: [] });
    const second = store.upsertEntries([entry()]);
    assert.deepEqual(second, { accepted: 1, rejected: 0, rejectedKeys: [] });
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

test('stale upsert cannot resurrect a deleted session (tombstone survives)', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ updatedAt: '2026-08-10T01:00:00.000Z' })]);
    store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    // Replay an old copy whose content time (01:30) is after the original content
    // but before the delete: it must NOT clear the tombstone.
    store.upsertEntries([entry({ updatedAt: '2026-08-10T01:30:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 0); // still deleted
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1);
    assert.equal(withDeleted.entries[0].deletedAt, '2026-08-10T02:00:00.000Z');
    // A genuinely newer upsert (strictly after the delete) wins and resurrects.
    store.upsertEntries([entry({ updatedAt: '2026-08-10T03:00:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale workspace metadata does not overwrite a newer workspace', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ workspaceKey: 'sha256:new', workspaceLabel: 'new-workspace', updatedAt: '2026-08-10T02:00:00.000Z' })]);
    store.upsertEntries([entry({ workspaceKey: 'sha256:stale', workspaceLabel: 'stale-workspace', updatedAt: '2026-08-10T00:30:00.000Z' })]);
    const [row] = store.listSessions({}).entries;
    assert.equal(row.workspaceLabel, 'new-workspace');
    assert.equal(row.workspaceKey, 'sha256:new');
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
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected, 5);
    assert.equal(result.rejectedKeys.length, 5);
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
    const removed = store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    assert.equal(removed.invalidated, 1);
    assert.equal(removed.rejected, 0);
    assert.equal(store.listSessions({}).entries.length, 0);
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1);
    assert.ok(withDeleted.entries[0].deletedAt);
    // Re-upload with a strictly newer content time resurrects.
    store.upsertEntries([entry({ updatedAt: '2026-08-10T03:00:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidate normalizes the key exactly like upsert (interior whitespace does not ghost-tombstone)', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    // sanitizeId preserves interior double spaces, so the upsert stores the key
    // verbatim. invalidateKeys must derive the key the same way, not collapse it
    // through cleanText into a different key — otherwise the delete would hit a
    // nonexistent row (ghost tombstone) and leave the original entry live.
    store.upsertEntries([entry({ sessionId: 'my  session' })]);
    const inv = store.invalidateKeys([
      { deviceId: 'macbook', client: 'codex', sessionId: 'my  session', deletedAt: '2026-08-10T02:00:00.000Z' }
    ]);
    assert.equal(inv.invalidated, 1);
    assert.equal(inv.rejected, 0);
    assert.equal(store.listSessions({}).entries.length, 0); // original row tombstoned
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1); // no second ghost row
    assert.equal(withDeleted.entries[0].sessionId, 'my  session');
    assert.equal(withDeleted.entries[0].deletedAt, '2026-08-10T02:00:00.000Z');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidate normalizes the key exactly like upsert (decomposed vs composed session id)', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    // sanitizeId does not NFC-normalize, so a decomposed session id is stored
    // decomposed. invalidateKeys must not NFC-normalize either, or the composed
    // key would miss the stored row and produce a ghost tombstone.
    const decomposed = 'cafe\u0301'; // "café" as e + combining acute
    store.upsertEntries([entry({ sessionId: decomposed })]);
    const inv = store.invalidateKeys([
      { deviceId: 'macbook', client: 'codex', sessionId: decomposed, deletedAt: '2026-08-10T02:00:00.000Z' }
    ]);
    assert.equal(inv.invalidated, 1);
    assert.equal(inv.rejected, 0);
    assert.equal(store.listSessions({}).entries.length, 0);
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1);
    assert.equal(withDeleted.entries[0].sessionId, decomposed);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub re-sanitizes path-shaped workspace fields and control chars (server-side privacy)', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({
      workspaceKey: 'C:\\Users\\alice\\secret-project',
      workspaceLabel: '/Users/alice/projects/secret-project',
      title: 'Fix\u0000the\u0007build'
    })]);
    const [row] = store.listSessions({}).entries;
    assert.equal(row.workspaceKey, ''); // path-shaped key dropped, never stored
    assert.equal(row.workspaceLabel, 'secret-project'); // reduced to the basename
    assert.equal(row.title, 'Fix the build'); // control chars stripped
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsert ignores deletedAt: tombstones come only from invalidate', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ deletedAt: '2026-08-10T02:00:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 1); // still live
    assert.equal(store.listSessions({}).entries[0].deletedAt, undefined);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidating an unknown key stores a tombstone so a later stale upsert cannot resurrect it', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    // Delete arrives before the hub has ever seen the session.
    store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    // A stale upsert (content time before the delete) must not appear.
    store.upsertEntries([entry({ updatedAt: '2026-08-10T01:00:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 0);
    const withDeleted = store.listSessions({ includeDeleted: true });
    assert.equal(withDeleted.entries.length, 1);
    assert.equal(withDeleted.entries[0].deletedAt, '2026-08-10T02:00:00.000Z');
    // A genuinely newer upsert wins and resurrects (populating the tombstone row).
    store.upsertEntries([entry({ updatedAt: '2026-08-10T03:00:00.000Z' })]);
    const [row] = store.listSessions({}).entries;
    assert.equal(row.title, 'Fix the build');
    assert.equal(row.updatedAt, '2026-08-10T03:00:00.000Z');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repeating the same delete is a no-op and does not refresh the tombstone', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry()]);
    store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    const again = store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    assert.equal(again.invalidated, 0); // idempotent repeat
    const [row] = store.listSessions({ includeDeleted: true }).entries;
    assert.equal(row.deletedAt, '2026-08-10T02:00:00.000Z'); // unchanged
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a delayed retry of an older delete cannot clobber a newer resurrection', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry({ updatedAt: '2026-08-10T01:00:00.000Z' })]);
    store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    // Resurrection with strictly newer content.
    store.upsertEntries([entry({ updatedAt: '2026-08-10T03:00:00.000Z' })]);
    assert.equal(store.listSessions({}).entries.length, 1);
    // An out-of-order retry of the OLD delete (same event time) must not re-tombstone.
    store.invalidateKeys([{ deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' }]);
    assert.equal(store.listSessions({}).entries.length, 1); // still resurrected
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalidate reports malformed keys so the client does not checkpoint them', { skip: !sqliteAvailable }, () => {
  const { store, dir } = makeStore();
  try {
    store.upsertEntries([entry()]);
    const result = store.invalidateKeys([
      { deviceId: 'macbook', client: 'codex', sessionId: 'rollout-1', deletedAt: '2026-08-10T02:00:00.000Z' },
      { deviceId: 'macbook', client: 'unknown', sessionId: 'rollout-2' },
      { deviceId: '', client: 'codex', sessionId: 'rollout-3' }
    ]);
    assert.equal(result.invalidated, 1);
    assert.equal(result.rejected, 2);
    assert.equal(result.rejectedKeys.length, 2);
    assert.equal(result.rejectedKeys[0].reason, 'invalid_key');
    assert.equal(result.rejectedKeys[0].client, 'unknown');
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
