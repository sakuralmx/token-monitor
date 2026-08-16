'use strict';

const path = require('node:path');
const {
  titleFromFirstUserMessage,
  buildCatalogEntry
} = require('./sessionCatalog');

// Codex session adapter (plan T6).
//
// Codex stores each rollout as <home>/.codex/sessions/<yyyy>/<mm>/<dd>/<id>.jsonl
// (CODEX_HOME overrides <home>/.codex; archived rollouts live under
// archived_sessions/ with the same date layout). Each JSONL contains a
// `session_meta` line carrying the working directory (payload.cwd), event_msg
// user_message lines, and timestamps — enough to build a catalog entry with a
// stable id, workspace, fallback title and activity times. Raw JSONL text is
// never uploaded; only the normalized entry leaves the device.

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const HEAD_TAIL_BYTES = 256 * 1024;

function codexHome(deps) {
  const envHome = String(deps.env?.CODEX_HOME || '').trim();
  return envHome || path.join(String(deps.home || ''), '.codex');
}

// Date-partitioned roots, same layout for live and archived sessions.
function codexSessionRoots(deps) {
  const home = codexHome(deps);
  return [
    path.join(home, 'sessions'),
    path.join(home, 'archived_sessions')
  ];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isoOf(value) {
  if (value === null || value === undefined) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function linesOf(text) {
  return String(text || '').split(/\r?\n/);
}

function firstTimestampOf(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = isoOf(obj.timestamp || obj.createdAt || obj.created_at || obj.updatedAt || obj.updated_at);
      if (ts) return ts;
    } catch (_) { /* skip partial lines */ }
  }
  return '';
}

function lastTimestampOf(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = isoOf(obj.timestamp || obj.updatedAt || obj.updated_at || obj.createdAt || obj.created_at);
      if (ts) return ts;
    } catch (_) { /* skip */ }
  }
  return '';
}

// Codex stamps the working directory on the session_meta line (payload.cwd) and
// on some user_message events (payload.cwd). Either is the exact absolute path —
// used only to derive the hashed workspace key, never uploaded.
function cwdOf(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
      const value = payload.cwd || payload.working_directory || payload.workingDirectory || payload.project_path;
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch (_) { /* skip non-JSON lines */ }
  }
  return '';
}

// Codex wraps real prompts in IDE-context preambles ("## My request for Codex:"),
// same as the usage collector; the fallback title uses the real request text.
function codexPromptText(raw) {
  const text = String(raw || '');
  const marker = '## My request for Codex:';
  const idx = text.indexOf(marker);
  return (idx >= 0 ? text.slice(idx + marker.length) : text).replace(/\s+/g, ' ').trim();
}

function firstUserMessageText(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
    if (obj.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const raw = payload.message || payload.text || '';
    const text = codexPromptText(raw);
    if (!text) continue;
    return text;
  }
  return '';
}

function messageCountOf(lines) {
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
      if (obj.type === 'event_msg' && payload.type === 'user_message') count += 1;
      if (obj.type === 'event_msg' && payload.type === 'agent_message') count += 1;
    } catch (_) { /* skip */ }
  }
  return count;
}

function tokenStatsOf(lines) {
  // The last token_count event carries the cumulative usage; total_tokens is the
  // most stable headline across Codex versions.
  let totalTokens = 0;
  let costUsd = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
      if (obj.type === 'event_msg' && payload.type === 'token_count') {
        const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
        const value = num(info.total_tokens || info.totalTokens || info.token_count);
        if (value > 0) { totalTokens = value; break; }
      }
    } catch (_) { /* skip */ }
  }
  return { totalTokens, costUsd };
}

function readTranscript(deps, filePath) {
  const fsModule = deps.fsModule || require('node:fs');
  let stat;
  try { stat = fsModule.statSync(filePath); } catch (_) { return ''; }
  if (!stat.isFile()) return '';
  if (stat.size <= MAX_TRANSCRIPT_BYTES) {
    try { return fsModule.readFileSync(filePath, 'utf8'); } catch (_) { return ''; }
  }
  let head;
  let tail;
  try {
    const fd = fsModule.openSync(filePath, 'r');
    try {
      const headBuffer = Buffer.alloc(Math.min(HEAD_TAIL_BYTES, stat.size));
      fsModule.readSync(fd, headBuffer, 0, headBuffer.length, 0);
      head = headBuffer.toString('utf8');
      const tailBuffer = Buffer.alloc(Math.min(HEAD_TAIL_BYTES, stat.size));
      fsModule.readSync(fd, tailBuffer, 0, tailBuffer.length, stat.size - tailBuffer.length);
      tail = tailBuffer.toString('utf8');
    } finally { fsModule.closeSync(fd); }
  } catch (_) { return ''; }
  return `${head}\n${tail}`;
}

// Build one catalog entry from a Codex rollout file. Returns null when the file
// is unreadable or has no usable id/title/time — never throws.
function codexEntryFromFile(deps, filePath) {
  const sessionId = path.basename(filePath).replace(/\.jsonl$/i, '');
  if (!sessionId) return null;
  const text = readTranscript(deps, filePath);
  if (!text) return null;
  const lines = linesOf(text);
  const cwd = cwdOf(lines);
  const firstMessage = firstUserMessageText(lines);
  const title = titleFromFirstUserMessage(firstMessage);
  const startedAt = firstTimestampOf(lines);
  const lastUsedAt = lastTimestampOf(lines);
  const stats = tokenStatsOf(lines);
  return buildCatalogEntry({
    deviceId: deps.deviceId,
    client: 'codex',
    sessionId,
    absolutePath: cwd,
    title,
    titleSource: 'fallback',
    startedAt,
    lastUsedAt,
    updatedAt: lastUsedAt,
    messageCount: messageCountOf(lines),
    stats: stats.totalTokens > 0 ? { totalTokens: stats.totalTokens } : undefined
  });
}

// Walk the date-partitioned session roots and build entries for every rollout.
// Per-file isolation: an unreadable or corrupt rollout is skipped, never allowed
// to abort the scan (plan T6).
function scanCodexSessions(deps = {}) {
  const fsModule = deps.fsModule || require('node:fs');
  const entries = [];
  for (const root of codexSessionRoots(deps)) {
    walkDatePartitions(fsModule, root, deps, entries);
  }
  return entries;
}

function walkDatePartitions(fsModule, root, deps, entries) {
  let years;
  try { years = fsModule.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const year of years) {
    if (!year.isDirectory()) continue;
    let months;
    try { months = fsModule.readdirSync(path.join(root, year.name), { withFileTypes: true }); } catch (_) { continue; }
    for (const month of months) {
      if (!month.isDirectory()) continue;
      let days;
      try { days = fsModule.readdirSync(path.join(root, year.name, month.name), { withFileTypes: true }); } catch (_) { continue; }
      for (const day of days) {
        if (!day.isDirectory()) continue;
        let files;
        const dayPath = path.join(root, year.name, month.name, day.name);
        try { files = fsModule.readdirSync(dayPath, { withFileTypes: true }); } catch (_) { continue; }
        for (const file of files) {
          if (!file.isFile() || !file.name.toLowerCase().endsWith('.jsonl')) continue;
          try {
            const entry = codexEntryFromFile(deps, path.join(dayPath, file.name));
            if (entry) entries.push(entry);
          } catch (_) { /* per-file isolation */ }
        }
      }
    }
  }
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  codexEntryFromFile,
  codexHome,
  codexSessionRoots,
  scanCodexSessions
};
