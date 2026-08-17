'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashKey } = require('./hashKey');
const {
  titleFromFirstUserMessage,
  sanitizeLabel,
  buildCatalogEntry,
  workspaceKeyFromPath,
  workspaceLabelFromPath
} = require('./sessionCatalog');

// DSH (DeepSeek Harness) session adapter (plan T7).
//
// DSH persists each conversation as a concatenation of zstd frames:
//   ~/.dsh/sessions/<project-dir>/<session-dir>/session.jsonl.zstd
// <project-dir> is `projectKey(cwd)` — a flattened, URL-safe encoding of the
// working directory (`--D-700_projects-token-monitor--`), and <session-dir> is
// `encodeSegment(sessionId)`. The session id is a branded string: older
// sessions carry a `session-` prefix while newer ones are bare UUIDs, so the
// directory name must NOT be filtered on any prefix.
//
// The decoded stream is a header line followed by session events. The header
// carries the authoritative id and the exact absolute `cwd`, so the workspace
// key/label derive from `cwd` (never the lossy flattened directory name). The
// title is the latest `session/title` event (DSH's own title service writes
// it), falling back to the first real user message; event times are the `time`
// epoch-milliseconds field, not a `timestamp` string.
//
// Node has no built-in zstd before 22.15, so decompression is feature-detected:
// `node:zlib` first (multi-frame via frame scanning), then an optional `fzstd`
// npm module, then a system `zstd` binary. When none is available the adapter
// reports `zstdAvailable: false` and returns no entries — a clear, non-throwing
// state that never blocks usage collection (plan T7 acceptance).

const MAX_SESSION_BYTES = 16 * 1024 * 1024; // zstd frames bigger than this are skipped
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_MAGIC_U32 = 0xfd2fb528; // little-endian bytes 0x28 0xb5 0x2f 0xfd

function hasZstdMagic(bytes) {
  if (!bytes || bytes.length < 4) return false;
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== ZSTD_MAGIC[i]) return false;
  }
  return true;
}

// --- zstd frame scanning -----------------------------------------------------

// DSH appends each durable batch as an independently decodable zstd frame, so
// the artifact is a concatenation of frames. Node's one-shot zstdDecompressSync
// decodes only the FIRST frame, so the adapter scans frame boundaries and
// decodes each frame. `scanZstdFrames` is a structural parse of the public zstd
// frame format (magic, frame header, block headers, optional checksum); a torn
// final frame (crash mid-append) is dropped rather than corrupting the read.
function scanZstdFrames(bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes.length - offset < 4) return frames; // torn magic
    if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC_U32) return frames;
    offset += 4;
    if (bytes.length - offset < 1) return frames;
    const descriptor = bytes.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (bytes.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;
    for (;;) {
      if (bytes.length - offset < 3) return frames;
      const blockHeader = bytes.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return frames; // reserved block type → corrupt
      const payloadBytes = blockType === 1 ? 1 : blockSize; // RLE block carries one byte
      if (bytes.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (bytes.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decompressFrames(bytes, decompressFrame) {
  const frames = scanZstdFrames(bytes);
  if (frames.length === 0) throw new Error('no complete zstd frames');
  const parts = frames.map((frame) => decompressFrame(bytes.subarray(frame.start, frame.end)));
  return Buffer.concat(parts);
}

// --- decompression backends (feature-detected) ---------------------------------

let cachedBackend = null;

function safeZlib() {
  try { return require('node:zlib'); } catch (_) { return null; }
}

function detectBackend(deps = {}) {
  if (cachedBackend) return cachedBackend;
  // 1. Node built-in zstd (node:zlib, Node >= 22.15). Multi-frame via scan.
  const zlibModule = deps.zlibModule || safeZlib();
  if (zlibModule && typeof zlibModule.zstdDecompressSync === 'function') {
    cachedBackend = { kind: 'zlib', module: zlibModule };
    return cachedBackend;
  }
  // 2. Optional pure-JS fzstd module (not a hard dependency).
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
  // 3. System zstd CLI.
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

function decompressViaCli(command, bytes, deps) {
  const fsModule = deps.fsModule || require('node:fs');
  const osModule = deps.osModule || require('node:os');
  const tempFile = path.join(osModule.tmpdir(), `dsh-session-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.zst`);
  fsModule.writeFileSync(tempFile, bytes);
  try {
    // `zstd -d` decodes the whole concatenated-frame stream natively.
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
  if (backend.kind === 'zlib') {
    try { return decompressFrames(bytes, (frame) => backend.module.zstdDecompressSync(frame)); } catch (_) { return null; }
  }
  if (backend.kind === 'fzstd') {
    try { return decompressFrames(bytes, (frame) => backend.module.decompress(frame)); } catch (_) { return null; }
  }
  if (backend.kind === 'cli') {
    try { return decompressViaCli(backend.command, bytes, deps); } catch (_) { return null; }
  }
  return null;
}

// --- workspace helpers ---------------------------------------------------------

// Stable, privacy-safe fallback identity from the flattened workspace dir name.
// Kept only for sessions whose header has no `cwd`; the primary path derives the
// workspace from the exact header `cwd` (see dshEntryFromDir).
function workspaceIdentityFromDirName(dirName) {
  const raw = String(dirName || '').trim();
  if (!raw || raw === '_no-cwd') return { workspaceKey: '', workspaceLabel: '' };
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

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Event times are epoch-millisecond numbers; accept numeric and string forms.
function isoOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : '';
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function parseEventLine(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch (_) { return null; }
}

// The header line is `{ type: 'session', version, id, createdAt, cwd, ... }`.
function parseHeaderLine(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return null; }
    if (obj && obj.type === 'session' && typeof obj.id === 'string') return obj;
    return null;
  }
  return null;
}

function eventTimeMs(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Verbose events carry `time`; packed chunk rows carry `time0`.
  for (const key of ['time', 'time0', 'timestamp']) {
    const value = obj[key];
    if (value === null || value === undefined) continue;
    const iso = isoOf(value);
    if (iso) return Date.parse(iso);
  }
  return null;
}

function textOfContentBlocks(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((block) => block && (block.type === 'text' || block.type === 'content') && typeof block.text === 'string')
      .map((block) => block.text);
    return texts.join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// A real human prompt has `data.source.kind === 'user'`; injected context
// (AGENTS.md, skill catalog, runtime snapshots, subagent delegation) is never a
// title source. A missing source is tolerated for older logs.
function isRealUserMessage(obj) {
  if (!obj || obj.type !== 'user/message') return false;
  const data = obj.data;
  if (!data || typeof data !== 'object') return false;
  const source = data.source && typeof data.source === 'object' ? data.source : null;
  if (source && source.kind !== undefined && source.kind !== 'user') return false;
  return true;
}

function firstUserMessageText(lines) {
  for (const line of lines) {
    const obj = parseEventLine(line);
    if (!isRealUserMessage(obj)) continue;
    const text = textOfContentBlocks(obj.data.content).trim();
    if (!text) continue;
    if (/^\[Request interrupted/.test(text)) continue;
    if (/^<\/?(command-name|command-message|command-args|local-command-stdout)\b/.test(text)) continue;
    if (/^Base directory for this skill:/.test(text)) continue;
    return text;
  }
  return '';
}

// DSH's title service persists the current title as a `session/title` event
// (last-wins). Fall back to the first user message when no title was logged.
function latestTitleOf(lines) {
  let title = '';
  for (const line of lines) {
    const obj = parseEventLine(line);
    if (!obj || obj.type !== 'session/title') continue;
    const data = obj.data;
    if (data && typeof data === 'object' && typeof data.title === 'string' && data.title.trim()) {
      title = data.title.trim();
    }
  }
  return title;
}

function firstTimeMs(lines) {
  for (const line of lines) {
    const ms = eventTimeMs(parseEventLine(line));
    if (ms !== null) return ms;
  }
  return null;
}

function lastTimeMs(lines) {
  let latest = null;
  for (const line of lines) {
    const ms = eventTimeMs(parseEventLine(line));
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

function messageCountOf(lines) {
  let count = 0;
  for (const line of lines) {
    const obj = parseEventLine(line);
    if (!obj) continue;
    if (obj.type === 'user/message' || obj.type === 'assistant/message') count += 1;
  }
  return count;
}

function tokenStatsOf(lines) {
  // Sum the disjoint usage across every step's assistant/message event.
  let totalTokens = 0;
  for (const line of lines) {
    const obj = parseEventLine(line);
    if (!obj || obj.type !== 'assistant/message') continue;
    const usage = obj.data && typeof obj.data === 'object' ? obj.data.usage : null;
    if (!usage || typeof usage !== 'object') continue;
    totalTokens += num(usage.inputTokens) + num(usage.outputTokens)
      + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
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
  const fsModule = deps.fsModule || require('node:fs');
  const zstdPath = path.join(sessionDirPath, 'session.jsonl.zstd');
  const plainPath = path.join(sessionDirPath, 'session.jsonl');
  const filePath = fsModule.existsSync
    ? (fsModule.existsSync(zstdPath) ? zstdPath : fsModule.existsSync(plainPath) ? plainPath : '')
    : zstdPath;
  if (!filePath) return null;

  const bytes = readSessionBytes(deps, filePath);
  if (!bytes) return null;
  const text = decompressZstd(bytes, deps);
  if (text === null) return null; // compressed but no backend / corrupt
  const lines = linesOf(text);

  const header = parseHeaderLine(lines);
  const sessionId = header && header.id ? header.id : path.basename(sessionDirPath);
  if (!sessionId) return null;

  // Workspace from the exact header `cwd`; fall back to the dir-name identity
  // only when the session has no recorded working directory.
  const cwd = header && typeof header.cwd === 'string' ? header.cwd.trim() : '';
  let workspaceKey = '';
  let workspaceLabel = '';
  if (cwd) {
    workspaceKey = workspaceKeyFromPath(cwd, { platform: deps.platform });
    workspaceLabel = workspaceLabelFromPath(cwd, { platform: deps.platform });
  }
  if (!workspaceKey && !workspaceLabel) {
    const fallback = workspaceIdentityFromDirName(workspaceDirName);
    workspaceKey = fallback.workspaceKey;
    workspaceLabel = fallback.workspaceLabel;
  }

  const loggedTitle = latestTitleOf(lines);
  const firstMessage = firstUserMessageText(lines);
  const title = loggedTitle || titleFromFirstUserMessage(firstMessage);
  const createdAtMs = header ? header.createdAt : null;
  const startedAt = isoOf(createdAtMs) || isoOf(firstTimeMs(lines));
  const lastUsedAt = isoOf(lastTimeMs(lines)) || startedAt;
  const stats = tokenStatsOf(lines);

  return buildCatalogEntry({
    deviceId: deps.deviceId,
    client: 'dsh',
    sessionId,
    workspaceKey,
    workspaceLabel,
    title,
    titleSource: loggedTitle ? 'local' : 'fallback',
    startedAt,
    lastUsedAt,
    updatedAt: lastUsedAt,
    messageCount: messageCountOf(lines),
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
      // Session dirs are `encodeSegment(sessionId)` — bare UUIDs and
      // `session-`-prefixed ids alike, so no prefix filter; the entry builder
      // skips anything that is not actually a session artifact.
      if (!sessionDir.isDirectory()) continue;
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
  decompressZstd,
  detectBackend,
  dshEntryFromDir,
  hasZstdMagic,
  resetBackendCache,
  scanDshSessions,
  scanZstdFrames,
  workspaceIdentityFromDirName
};
