'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashKey } = require('./hashKey');
const {
  titleFromFirstUserMessage,
  sanitizeLabel,
  buildCatalogEntry
} = require('./sessionCatalog');

// DSH (DeepSeek Harness) session adapter (plan T7).
//
// DSH persists each conversation as a zstd-compressed JSONL:
//   ~/.dsh/sessions/<workspace-dir>/<sessionId>/session.jsonl.zstd
// where <workspace-dir> is a flattened, URL-safe encoding of the working
// directory (e.g. `--D-700_projects-token-monitor--` for `D:\700_projects\
// token-monitor`) and <sessionId> is a `session-<uuid>` directory. The session
// JSONL holds user/assistant turns with timestamps.
//
// The workspace dir name is a lossy flattened encoding (a `-` stands for both a
// path separator and a literal dash), so it cannot be reliably decoded back to
// the original absolute path. The catalog therefore keys and labels the
// workspace from the dir name itself: stable across reboots, and free of any
// username/home/path leakage.
//
// Node has no built-in zstd, so decompression is feature-detected rather than
// assumed: a system `zstd` binary first, then an optional `fzstd` npm module if
// present. When neither is available the adapter reports `zstdAvailable: false`
// and returns no entries — a clear, non-throwing state that never blocks usage
// collection (plan T7 acceptance).

const MAX_SESSION_BYTES = 16 * 1024 * 1024; // zstd frames bigger than this are skipped
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function hasZstdMagic(bytes) {
  if (!bytes || bytes.length < 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== ZSTD_MAGIC[i]) return false;
  }
  return true;
}

// --- decompression backends (feature-detected) ---------------------------------

let cachedBackend = null;

function detectBackend(deps = {}) {
  if (cachedBackend) return cachedBackend;
  // 1. Optional pure-JS fzstd module (not a hard dependency).
  try {
    if (deps.fzstdModule) {
      cachedBackend = { kind: 'fzstd', module: deps.fzstdModule };
      return cachedBackend;
    }
    const fzstd = require('fzstd');
    if (fzstd && typeof fzstd.decompress === 'function') {
      cachedBackend = { kind: 'fzstd', module: fzstd };
      return cachedBackend;
    }
  } catch (_) { /* not installed */ }
  // 2. System zstd CLI.
  const zstdPath = deps.zstdPath || process.env.ZSTD_PATH || 'zstd';
  try {
    const probe = spawnSync(zstdPath, ['--version'], { timeout: 2000, stdio: 'ignore' });
    if (probe.status === 0) {
      cachedBackend = { kind: 'cli', command: zstdPath };
      return cachedBackend;
    }
  } catch (_) { /* not on PATH */ }
  cachedBackend = { kind: 'none' };
  return cachedBackend;
}

// Reset for tests.
function resetBackendCache() {
  cachedBackend = null;
}

function decompressViaFzstd(module, bytes) {
  const out = module.decompress(bytes);
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function decompressViaCli(command, bytes, deps) {
  const fsModule = deps.fsModule || require('node:fs');
  const osModule = deps.osModule || require('node:os');
  const tempFile = path.join(osModule.tmpdir(), `dsh-session-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.zst`);
  fsModule.writeFileSync(tempFile, bytes);
  try {
    const result = spawnSync(command, ['-d', '-c', tempFile], { timeout: 10_000, maxBuffer: MAX_SESSION_BYTES * 2 });
    if (result.status !== 0) return null;
    return result.stdout;
  } finally {
    try { fsModule.unlinkSync(tempFile); } catch (_) { /* best-effort */ }
  }
}

function decompressZstd(bytes, deps = {}) {
  if (!hasZstdMagic(bytes)) return bytes; // not compressed; plain JSONL
  const backend = detectBackend(deps);
  if (backend.kind === 'fzstd') {
    try { return decompressViaFzstd(backend.module, bytes); } catch (_) { return null; }
  }
  if (backend.kind === 'cli') {
    try { return decompressViaCli(backend.command, bytes, deps); } catch (_) { return null; }
  }
  return null;
}

// --- workspace encoding --------------------------------------------------------

// DSH flattens the absolute working directory into the folder name: each path
// separator becomes `-` and non-alphanumeric chars are percent-encoded. The
// `--`-wrapped shape (e.g. `--D-700_projects-token-monitor--`) decodes back to
// the original path. Decoding is best-effort; unknown shapes yield ''.
function workspacePathFromDirName(dirName) {
  const raw = String(dirName || '');
  if (!(raw.startsWith('--') && raw.endsWith('--') && raw.length > 4)) return '';
  const inner = raw.slice(2, -2);
  if (!inner) return '';
  try {
    // The encoding used by DSH for its workspace dir name.
    return decodeURIComponent(inner.replace(/-/g, '/'));
  } catch (_) {
    return '';
  }
}

// Stable, privacy-safe identity from the workspace dir name. The flattened
// encoding is lossy (a `-` is both a separator and a literal dash) and contains
// no username/home, so we key the hash and label directly from the dir name —
// never attempting to reconstruct an absolute path.
function workspaceIdentityFromDirName(dirName) {
  const raw = String(dirName || '').trim();
  if (!raw) return { workspaceKey: '', workspaceLabel: '' };
  const label = raw.replace(/^--/, '').replace(/--$/, '') || raw;
  return {
    workspaceKey: hashKey('dsh-workspace', raw),
    workspaceLabel: sanitizeLabel(label)
  };
}

// --- entry parsing -------------------------------------------------------------

function linesOf(text) {
  return String(text || '').split(/\r?\n/);
}

function isoOf(value) {
  if (value === null || value === undefined) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function firstTimestampOf(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = isoOf(obj.timestamp || obj.createdAt || obj.created_at || obj.updatedAt || obj.updated_at);
      if (ts) return ts;
    } catch (_) { /* skip */ }
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

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part) => part && (part.type === 'text' || part.type === 'content') && typeof part.text === 'string')
      .map((part) => part.text);
    return texts.join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function firstUserMessageText(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    // Accept common shapes: {type:'user', content}, {role:'user', content},
    // {message:{role:'user', content}}.
    const message = obj.message && typeof obj.message === 'object' ? obj.message : obj;
    if (message.role !== 'user' && obj.type !== 'user' && obj.type !== 'user_message') continue;
    const text = textOfContent(message.content).trim();
    if (!text) continue;
    if (/^\[Request interrupted/.test(text)) continue;
    if (/^Base directory for this skill:/.test(text)) continue;
    if (/^<\/?(command-name|command-message|command-args|local-command-stdout)\b/.test(text)) continue;
    return text;
  }
  return '';
}

function userMessageCount(lines) {
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const message = obj.message && typeof obj.message === 'object' ? obj.message : obj;
      if (message.role === 'user' || obj.type === 'user' || obj.type === 'user_message') count += 1;
    } catch (_) { /* skip */ }
  }
  return count;
}

function tokenStatsOf(lines) {
  // Best-effort cumulative usage from usage-bearing lines; DSH writes usage in
  // several shapes, so we scan for the largest total seen.
  let totalTokens = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const usage = obj.usage || obj.tokenUsage || obj.usageMetadata;
      if (!usage || typeof usage !== 'object') continue;
      const total = Number(usage.total_tokens ?? usage.totalTokens ?? usage.total);
      if (Number.isFinite(total) && total > totalTokens) totalTokens = total;
    } catch (_) { /* skip */ }
  }
  return { totalTokens, costUsd: 0 };
}

function readSessionBytes(deps, filePath) {
  const fsModule = deps.fsModule || require('node:fs');
  let stat;
  try { stat = fsModule.statSync(filePath); } catch (_) { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_SESSION_BYTES) return null; // size boundary
  try { return fsModule.readFileSync(filePath); } catch (_) { return null; }
}

// Build one catalog entry from a DSH session directory. Returns null when the
// session is unreadable, too large, undecompressable, or has no usable
// id/title/time — never throws.
function dshEntryFromDir(deps, workspaceDirName, sessionDirPath) {
  const sessionId = path.basename(sessionDirPath);
  if (!sessionId) return null;
  const zstdPath = path.join(sessionDirPath, 'session.jsonl.zstd');
  const plainPath = path.join(sessionDirPath, 'session.jsonl');
  const fsModule = deps.fsModule || require('node:fs');
  const filePath = fsModule.existsSync ? (fsModule.existsSync(zstdPath) ? zstdPath : fsModule.existsSync(plainPath) ? plainPath : '') : zstdPath;
  if (!filePath) return null;

  const bytes = readSessionBytes(deps, filePath);
  if (!bytes) return null;
  const text = decompressZstd(bytes, deps);
  if (text === null) return null; // compressed but no backend / corrupt
  const lines = linesOf(text);
  const workspace = workspaceIdentityFromDirName(workspaceDirName);
  const firstMessage = firstUserMessageText(lines);
  const title = titleFromFirstUserMessage(firstMessage);
  const startedAt = firstTimestampOf(lines);
  const lastUsedAt = lastTimestampOf(lines);
  const stats = tokenStatsOf(lines);
  return buildCatalogEntry({
    deviceId: deps.deviceId,
    client: 'dsh',
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspaceLabel: workspace.workspaceLabel,
    title,
    titleSource: 'fallback',
    startedAt,
    lastUsedAt,
    updatedAt: lastUsedAt,
    messageCount: userMessageCount(lines),
    stats: stats.totalTokens > 0 ? { totalTokens: stats.totalTokens } : undefined
  });
}

// Scan ~/.dsh/sessions into catalog entries. Returns { entries, zstdAvailable }
// so the caller can surface an explicit "DSH sessions present but zstd
// unavailable" state instead of silently showing nothing.
function scanDshSessions(deps = {}) {
  const home = deps.home || (deps.osModule || require('node:os')).homedir();
  const fsModule = deps.fsModule || require('node:fs');
  const root = deps.root || path.join(home, '.dsh', 'sessions');
  const backend = detectBackend(deps);
  const zstdAvailable = backend.kind !== 'none';
  const entries = [];

  let workspaces;
  try { workspaces = fsModule.readdirSync(root, { withFileTypes: true }); } catch (_) {
    return { entries, zstdAvailable };
  }
  for (const workspaceDir of workspaces) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(root, workspaceDir.name);
    let sessionDirs;
    try { sessionDirs = fsModule.readdirSync(workspacePath, { withFileTypes: true }); } catch (_) { continue; }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      if (!sessionDir.name.startsWith('session-')) continue;
      try {
        const entry = dshEntryFromDir(deps, workspaceDir.name, path.join(workspacePath, sessionDir.name));
        if (entry) entries.push(entry);
      } catch (_) { /* per-session isolation */ }
    }
  }
  return { entries, zstdAvailable };
}

module.exports = {
  MAX_SESSION_BYTES,
  dshEntryFromDir,
  decompressZstd,
  detectBackend,
  hasZstdMagic,
  resetBackendCache,
  scanDshSessions,
  workspaceIdentityFromDirName,
  workspacePathFromDirName
};
