'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clientLabel,
  dedupe,
  groupByWorkspace,
  rowsForCatalog
} = require('../../src/electron/renderer/catalogRows');

function entry(overrides = {}) {
  return {
    deviceId: 'macbook',
    client: 'codex',
    sessionId: 'rollout-1',
    workspaceKey: 'sha256:proj',
    workspaceLabel: 'project-a',
    title: 'Fix the build',
    titleSource: 'local',
    lastUsedAt: '2026-08-10T01:00:00.000Z',
    updatedAt: '2026-08-10T01:00:00.000Z',
    ...overrides
  };
}

test('groups entries by workspace with counts and lastUsedAt-desc order', () => {
  const entries = [
    entry({ sessionId: 'old', lastUsedAt: '2026-08-09T01:00:00.000Z' }),
    entry({ sessionId: 'new', lastUsedAt: '2026-08-11T01:00:00.000Z' }),
    entry({ sessionId: 'other', workspaceKey: 'sha256:other', workspaceLabel: 'project-b', lastUsedAt: '2026-08-12T01:00:00.000Z' })
  ];
  const model = groupByWorkspace(entries);
  assert.equal(model.total, 3);
  assert.equal(model.workspaceGroups.length, 2);
  // Most-recently-active group first.
  assert.equal(model.workspaceGroups[0].label, 'project-b');
  assert.equal(model.workspaceGroups[0].count, 1);
  assert.equal(model.workspaceGroups[1].count, 2);
  // Within the group, newest session first.
  assert.equal(model.workspaceGroups[1].sessions[0].sessionId, 'new');
  assert.equal(model.allSessions.count, 3);
});

test('dedupes by the full primary key, never merging across devices', () => {
  const entries = [
    entry({ deviceId: 'macbook', lastUsedAt: '2026-08-10T01:00:00.000Z', updatedAt: '2026-08-10T01:00:00.000Z', title: 'old copy' }),
    entry({ deviceId: 'desktop', lastUsedAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z', title: 'new copy' })
  ];
  const deduped = dedupe(entries);
  // Different deviceId → distinct primary keys → both kept (protocol has no
  // cross-device stable identity to merge on).
  assert.equal(deduped.length, 2);
  // Duplicate exact primary key keeps the newer copy.
  const dup = dedupe([
    entry({ deviceId: 'macbook', lastUsedAt: '2026-08-10T01:00:00.000Z', updatedAt: '2026-08-10T01:00:00.000Z', title: 'old' }),
    entry({ deviceId: 'macbook', lastUsedAt: '2026-08-11T01:00:00.000Z', updatedAt: '2026-08-11T01:00:00.000Z', title: 'new' })
  ]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].title, 'new');
});

test('client filter narrows groups; unknown workspace label falls back', () => {
  const entries = [
    entry({ client: 'codex' }),
    entry({ client: 'cherrystudio', sessionId: 'cs-1', workspaceKey: 'sha256:cs', workspaceLabel: 'cs-proj' }),
    entry({ client: 'dsh', sessionId: 'dsh-1', workspaceKey: '', workspaceLabel: '' })
  ];
  const codexOnly = groupByWorkspace(entries, { filterClient: 'codex' });
  assert.equal(codexOnly.total, 1);
  const dsh = groupByWorkspace(entries, { filterClient: 'dsh' });
  assert.equal(dsh.workspaceGroups[0].label, 'No workspace');
  assert.equal(clientLabel('cherrystudio'), 'Cherry Studio');
  assert.equal(clientLabel('codex'), 'Codex');
  assert.equal(clientLabel('dsh'), 'DSH');
  assert.equal(clientLabel('mystery'), 'mystery');
});

test('collapsed groups hide their sessions in rows', () => {
  const entries = [
    entry({ sessionId: 'a', lastUsedAt: '2026-08-11T01:00:00.000Z' }),
    entry({ sessionId: 'b', lastUsedAt: '2026-08-10T01:00:00.000Z' }),
    entry({ sessionId: 'c', workspaceKey: 'sha256:other', workspaceLabel: 'project-b', lastUsedAt: '2026-08-12T01:00:00.000Z' })
  ];
  const model = groupByWorkspace(entries, { collapsed: { 'sha256:proj': true } });
  const rows = rowsForCatalog(model);
  const kinds = rows.map((row) => row.kind);
  // Group headers: project-b, project-a (collapsed → no sessions), all.
  assert.equal(kinds.filter((k) => k === 'group').length, 3);
  const sessionKinds = rows.filter((row) => row.kind === 'session');
  // project-a's own sessions hidden; project-b's session and the all-sessions
  // group (a + b + c) still list sessions → 1 + 3.
  assert.equal(sessionKinds.length, 4); // c + (a + b + c in all)
});

test('rowsForCatalog emits group headers with counts and client labels', () => {
  const entries = [entry(), entry({ client: 'dsh', sessionId: 'dsh-1', workspaceKey: 'sha256:proj', lastUsedAt: '2026-08-10T02:00:00.000Z' })];
  const model = groupByWorkspace(entries, { allSessions: false });
  const rows = rowsForCatalog(model, { clientLabels: { codex: 'Codex', dsh: 'DSH' } });
  assert.equal(rows.length, 3); // 1 group + 2 sessions
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[1].clientLabel, 'DSH');
});
