'use strict';

const path = require('node:path');
const {
  titleFromFirstUserMessage,
  buildCatalogEntry
} = require('./sessionCatalog');

// Cherry Studio session adapter (plan T5).
//
// Cherry Studio (Electron desktop) keeps its sessions as standard Claude Code
// transcripts — JSONL files under <appdata>/CherryStudio/.claude/projects
// (legacy) or <appdata>/CherryStudio/Data/Agents/.claude/projects (V2, live).
// Each project folder is a URL-safed slug of the absolute working directory;
// each <sessionId>.jsonl is one conversation. tokscale already scans these
// roots for usage; this adapter reads the same files for the session catalog,
// so the root resolution below is shared with the collector (T5 + AGENTS.md:
// source roots live in one place).

// Transcripts are append-only and a long session can reach tens of MB. The
// metadata this adapter needs — cwd, first user message, summary/title — sits in
// the head and tail of the file, so oversized transcripts are read as head+tail
// slices instead of loaded whole. Full-size transcripts are parsed in full.
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const HEAD_TAIL_BYTES = 256 * 1024;

// Single source of truth for Cherry Studio's transcript roots. The collector
// calls this too, so the catalog never drifts from what tokscale scans.
function cherryStudioRoots({ home, env = process.env } = {}) {
  const homeDir = String(home || '');
  if (!homeDir) return [];
  const appData = String(env.APPDATA || '').trim() || path.join(homeDir, 'AppData', 'Roaming');
  const xdgConfig = String(env.XDG_CONFIG_HOME || '').trim() || path.join(homeDir, '.config');
  const roots = [
    // V2 live transcripts.
    path.join(appData, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
    path.join(homeDir, 'Library', 'Application Support', 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
    path.join(xdgConfig, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects'),
    // Legacy snapshot.
    path.join(appData, 'CherryStudio', '.claude', 'projects'),
    path.join(homeDir, 'Library', 'Application Support', 'CherryStudio', '.claude', 'projects'),
    path.join(xdgConfig, 'CherryStudio', '.claude', 'projects')
  ];
  return Array.from(new Set(roots));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function firstTimestampOf(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const raw = obj.timestamp || obj.updatedAt || obj.updated_at;
      if (raw) {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) return new Date(ms).toISOString();
      }
    } catch (_) { /* partial or non-JSON line */ }
  }
  return '';
}

function lastTimestampOf(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const raw = obj.timestamp || obj.updatedAt || obj.updated_at;
      if (raw) {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) return new Date(ms).toISOString();
      }
    } catch (_) { /* partial or non-JSON line */ }
  }
  return '';
}

// The working directory is stamped on user turns and sometimes on the summary
// line. It is the exact absolute path — used only to derive the hashed
// workspace key, never uploaded.
function cwdOf(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const value = obj.cwd || obj.project_path || obj.workingDirectory || obj.working_directory;
      if (typeof value === 'string' && value.trim()) return value.trim();
      const summary = obj.summary;
      if (summary && typeof summary === 'object') {
        const summaryCwd = summary.cwd || summary.project_path;
        if (typeof summaryCwd === 'string' && summaryCwd.trim()) return summaryCwd.trim();
      }
    } catch (_) { /* skip non-JSON lines */ }
  }
  return '';
}

function summaryOf(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'summary' && obj.summary && typeof obj.summary === 'object') return obj.summary;
    } catch (_) { /* skip */ }
  }
  return null;
}

function userMessageCount(lines) {
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message) count += 1;
    } catch (_) { /* skip */ }
  }
  return count;
}

function textOfUserMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text);
    return texts.join(' ');
  }
  return '';
}

// First *valid* user message, skipping harness-injected lines so the fallback
// title does not become "[Request interrupted…]" or a slash-command echo.
function firstUserMessageText(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.type !== 'user' || !obj.message) continue;
    const text = textOfUserMessage(obj.message).trim();
    if (!text) continue;
    if (/^\[Request interrupted/.test(text)) continue;
    if (/^<\/?(command-name|command-message|command-args|local-command-stdout)\b/.test(text)) continue;
    if (/^Base directory for this skill:/.test(text)) continue;
    return text;
  }
  return '';
}

function readTranscript(deps, filePath) {
  const fsModule = deps.fsModule || require('node:fs');
  let stat;
  try { stat = fsModule.statSync(filePath); } catch (_) { return ''; }
  if (!stat.isFile()) return '';
  if (stat.size <= MAX_TRANSCRIPT_BYTES) {
    try { return fsModule.readFileSync(filePath, 'utf8'); } catch (_) { return ''; }
  }
  // Oversized: read the head (cwd, first message) and tail (summary, title).
  let head = '';
  let tail = '';
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
  } catch (_) { /* unreadable oversized transcript → skip */ }
  return `${head}\n${tail}`;
}

function linesOf(text) {
  return String(text || '').split(/\r?\n/);
}

// Scan one transcript file into a catalog entry. Returns null when the file is
// unreadable, lacks an id, or has no usable title/time — never throws.
function cherryStudioEntryFromFile(deps, filePath) {
  const fileName = path.basename(filePath);
  const sessionId = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName.replace(/\.jsonl$/i, '');
  if (!sessionId) return null;

  const text = readTranscript(deps, filePath);
  if (!text) return null;
  const lines = linesOf(text);
  const cwd = cwdOf(lines);
  const summary = summaryOf(lines);
  const firstMessage = firstUserMessageText(lines);
  const title = String(summary?.title || '').trim() || titleFromFirstUserMessage(firstMessage);
  const startedAt = firstTimestampOf(lines);
  const lastUsedAt = lastTimestampOf(lines);
  const messageCount = userMessageCount(lines);
  const stats = {};
  if (num(summary?.total_tokens) > 0) stats.totalTokens = num(summary.total_tokens);
  if (num(summary?.cost_usd) > 0) stats.costUsd = num(summary.cost_usd);

  const entry = buildCatalogEntry({
    deviceId: deps.deviceId,
    client: 'cherrystudio',
    sessionId,
    absolutePath: cwd,
    title,
    titleSource: String(summary?.title || '').trim() ? 'local' : 'fallback',
    startedAt,
    lastUsedAt,
    updatedAt: lastUsedAt,
    messageCount,
    stats
  });
  return entry;
}

// Scan every Cherry Studio transcript root on this machine into catalog
// entries. Per-file isolation: one corrupt or unreadable transcript is skipped,
// never allowed to abort the scan or disturb usage collection (plan T5).
function scanCherryStudioSessions(deps = {}) {
  const home = deps.home || (deps.osModule || require('node:os')).homedir();
  const fsModule = deps.fsModule || require('node:fs');
  const roots = cherryStudioRoots({ home, env: deps.env || process.env });
  const entries = [];
  for (const root of roots) {
    let projectDirs;
    try { projectDirs = fsModule.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(root, projectDir.name);
      let files;
      try { files = fsModule.readdirSync(projectPath, { withFileTypes: true }); } catch (_) { continue; }
      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.jsonl')) continue;
        try {
          const entry = cherryStudioEntryFromFile(deps, path.join(projectPath, file.name));
          if (entry) entries.push(entry);
        } catch (_) { /* per-file isolation */ }
      }
    }
  }
  return entries;
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  cherryStudioEntryFromFile,
  cherryStudioRoots,
  scanCherryStudioSessions
};
