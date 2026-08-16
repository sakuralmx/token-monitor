'use strict';

(function exposeCatalogRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCatalogRows = api;
})(typeof window !== 'undefined' ? window : null, function createCatalogRowsApi() {
  // Pure grouping/presentation for the session-catalog view (plan T10).
  // Input: normalized catalog entries (docs/API.md "The unified entry").
  // Output: workspace groups (label, count, sessions sorted by lastUsedAt
  // desc), all-sessions bucket, client filter, collapsed-state application.
  // No raw conversation text ever reaches these rows — titles only.

  function clientLabel(client, labels) {
    if (labels && labels[client]) return labels[client];
    const byId = { cherrystudio: 'Cherry Studio', codex: 'Codex', dsh: 'DSH' };
    return byId[client] || client;
  }

  function lastUsedAtMs(entry) {
    const value = entry?.lastUsedAt || entry?.startedAt;
    const ms = value ? Date.parse(value) : 0;
    return Number.isFinite(ms) ? ms : 0;
  }

  function entryKey(entry) {
    return `${entry.deviceId}|${entry.client}|${entry.sessionId}`;
  }

  // Dedupe by the full protocol primary key (deviceId + client + sessionId).
  // Collapsing on client+sessionId alone would wrongly merge two devices that
  // independently generated the same sessionId, hiding a real session. The
  // protocol has no cross-device stable identity, so dedupe must not invent one.
  function dedupe(entries) {
    const byKey = new Map();
    for (const entry of entries || []) {
      if (!entry || !entry.sessionId || !entry.client) continue;
      const key = entryKey(entry);
      const existing = byKey.get(key);
      if (!existing || lastUsedAtMs(entry) > lastUsedAtMs(existing)) byKey.set(key, entry);
    }
    return Array.from(byKey.values());
  }

  function workspaceKeyOf(entry) {
    return entry?.workspaceKey || 'workspace:none';
  }

  function workspaceLabelOf(entry) {
    return entry?.workspaceLabel || 'No workspace';
  }

  function sortSessions(a, b) {
    return lastUsedAtMs(b) - lastUsedAtMs(a) || entryKey(a).localeCompare(entryKey(b));
  }

  // Group entries by workspace. `filterClient` narrows to one client;
  // `allSessions` adds an "all sessions" group listing every session.
  function groupByWorkspace(entries, options = {}) {
    const { filterClient = '', allSessions = true, collapsed = {} } = options;
    const seen = dedupe(entries);
    const filtered = filterClient ? seen.filter((entry) => entry.client === filterClient) : seen;
    const groups = new Map();
    const all = [];
    for (const entry of filtered) {
      const key = workspaceKeyOf(entry);
      if (!groups.has(key)) groups.set(key, { key, label: workspaceLabelOf(entry), sessions: [] });
      groups.get(key).sessions.push(entry);
      all.push(entry);
    }
    const workspaceGroups = Array.from(groups.values())
      .map((group) => {
        group.sessions.sort(sortSessions);
        group.count = group.sessions.length;
        group.collapsed = collapsed[group.key] === true;
        return group;
      })
      .sort((a, b) => {
        // Groups with activity first, then alphabetical by label.
        const aLatest = lastUsedAtMs(a.sessions[0]);
        const bLatest = lastUsedAtMs(b.sessions[0]);
        if (aLatest !== bLatest) return bLatest - aLatest;
        return a.label.localeCompare(b.label);
      });
    const result = { workspaceGroups, total: filtered.length };
    if (allSessions) {
      all.sort(sortSessions);
      result.allSessions = { key: 'all', label: 'All sessions', sessions: all, count: all.length, collapsed: collapsed.all === true };
    }
    return result;
  }

  // Build the flat list of rows for rendering: workspace groups (when not
  // collapsed) then the all-sessions group (when not collapsed).
  function rowsForCatalog(model, options = {}) {
    const rows = [];
    const groupLabel = options.groupLabel || ((group) => group.label);
    for (const group of model?.workspaceGroups || []) {
      rows.push({ kind: 'group', key: group.key, label: groupLabel(group), count: group.count, collapsed: group.collapsed });
      if (!group.collapsed) {
        for (const entry of group.sessions) {
          rows.push({ kind: 'session', entry, clientLabel: clientLabel(entry.client, options.clientLabels) });
        }
      }
    }
    if (model?.allSessions) {
      rows.push({ kind: 'group', key: 'all', label: groupLabel(model.allSessions), count: model.allSessions.count, collapsed: model.allSessions.collapsed });
      if (!model.allSessions.collapsed) {
        for (const entry of model.allSessions.sessions) {
          rows.push({ kind: 'session', entry, clientLabel: clientLabel(entry.client, options.clientLabels) });
        }
      }
    }
    return rows;
  }

  return { clientLabel, dedupe, entryKey, groupByWorkspace, lastUsedAtMs, rowsForCatalog, sortSessions, workspaceKeyOf, workspaceLabelOf };
});
