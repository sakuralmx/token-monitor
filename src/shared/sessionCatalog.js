'use strict';

const path = require('node:path');
const { hashKey } = require('./hashKey');

// Unified session-catalog model + local privacy sanitization (plan T4).
//
// Every entry that leaves this device passes through normalizeCatalogEntry, which
// is a strict whitelist: unknown fields, absolute paths, usernames, raw
// conversation text and credentials cannot survive it. The hub (T8) re-normalizes
// on ingest, but the client is the first and main privacy boundary, so the
// sanitizers here must be treated as load-bearing, not cosmetic.

const CATALOG_CLIENTS = Object.freeze(['cherrystudio', 'codex', 'dsh']);
const TITLE_MAX_CHARS = 200;
const LABEL_MAX_CHARS = 120;
const SESSION_ID_MAX_CHARS = 200;
const DEVICE_ID_MAX_CHARS = 100;
const WORKSPACE_KEY_MAX_CHARS = 120;
const TITLE_SOURCES = Object.freeze(['local', 'fallback']);

// Replace unpaired surrogates with a space so a title built from hostile bytes
// cannot produce a lone high/low surrogate on the wire — and so a broken byte
// sequence does not glue two words together. Iterating by code point keeps
// paired surrogate characters (emoji) intact; only lone surrogates are replaced.
function removeUnpairedSurrogates(value) {
  let out = '';
  for (const char of String(value || '')) {
    const code = char.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) { out += ' '; continue; }
    out += char;
  }
  return out;
}

// Control characters (Cc) and format characters (Cf, which includes zero-width
// joiners and RTL marks) are never meaningful in a title/label and can be used
// for spoofing. Replace each with a space first so a NUL or bell buried between
// two words does not silently glue them together; collapseWhitespace folds the
// result. C0/C1 control bytes from binary source files land here too.
function removeControlAndFormatChars(value) {
  return String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function truncateByCodePoint(value, maxChars) {
  const chars = Array.from(String(value || ''));
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

// Unified text pipeline for every user-visible free-text field. Order matters:
// normalize first so NFC-compound glyphs are single code points before truncation
// (otherwise a composed char split by the limit could render as two glyphs);
// control chars become spaces before whitespace collapse so words never merge.
function sanitizeText(value, maxChars) {
  return truncateByCodePoint(
    collapseWhitespace(removeControlAndFormatChars(removeUnpairedSurrogates(String(value || '').normalize('NFC')))),
    maxChars
  );
}

// A title is built from the user's own prompt, which may embed an absolute
// path. Strip unambiguous Windows absolute-path spans (drive-letter and UNC)
// before upload so no workspace path rides the wire — the workspace key/label
// are sanitized separately, but a title must not re-leak them. POSIX paths are
// deliberately left alone: `/` also opens URLs, fractions and prose, so a
// scheme-agnostic redaction there would mangle real titles.
function redactAbsolutePaths(value) {
  return String(value || '')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '')
    .replace(/\\\\[^\s"'<>|]+/g, '');
}

function sanitizeTitle(value) {
  return sanitizeText(redactAbsolutePaths(value), TITLE_MAX_CHARS);
}

function sanitizeLabel(value) {
  return sanitizeText(value, LABEL_MAX_CHARS);
}

// A workspace key is a stable one-way hash (see workspaceKeyFromPath), never a
// path. Re-normalization must not let an absolute or relative path through, so
// any key that still looks path-shaped after id sanitization is dropped. The
// client derives keys as `sha256:` digests; the hub re-applies the same rule so
// a broken/malicious client cannot persist a path.
function sanitizeWorkspaceKey(value) {
  const id = sanitizeId(value, WORKSPACE_KEY_MAX_CHARS);
  if (!id || /[\\/]/.test(id)) return '';
  return id;
}

// A workspace label is a display name, never a path. A path-shaped label is
// reduced to its final segment (the same basename guarantee as
// workspaceLabelFromPath) so no directory structure or home path can leak.
function sanitizeWorkspaceLabel(value) {
  const label = sanitizeLabel(value);
  if (!label) return '';
  const segments = label.split(/[\\/]+/).filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : label;
}

// Stable, privacy-safe workspace identity (plan T4 / docs API.md).
//
// workspaceKey: one-way hash of the *normalized absolute path*. The hash hides
// the path (no username, no drive letters, no home directory), while
// normalization + case folding on Windows make the same folder produce the same
// key across reboots. This is the exact-key field; cross-device grouping by
// display name uses workspaceLabel instead.
function workspaceKeyFromPath(absolutePath, options = {}) {
  const platform = options.platform || process.platform;
  let normalized = String(absolutePath || '').trim();
  if (!normalized) return '';
  try {
    normalized = path.normalize(normalized);
  } catch (_) { /* keep raw on malformed input */ }
  if (normalized === '.' || normalized === '') return '';
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return hashKey(normalized);
}

// Display label: the folder basename, sanitized. Never the full path.
function workspaceLabelFromPath(absolutePath, options = {}) {
  const platform = options.platform || process.platform;
  const winPath = platform === 'win32'
    ? String(absolutePath || '').replace(/\//g, '\\')
    : String(absolutePath || '');
  const base = path.basename(winPath.replace(/[\\/]+$/, '')) || winPath;
  return sanitizeLabel(base);
}

// Fallback title from the first valid user message (plan T4). Strictly local:
// no AI generation, just truncation + the same sanitize pipeline. `titleSource`
// becomes 'fallback' so a later explicit client title can win on merge.
function titleFromFirstUserMessage(raw) {
  if (raw === null || raw === undefined) return '';
  const text = typeof raw === 'string' ? raw : String(raw);
  return sanitizeTitle(text);
}

function validIsoTimestamp(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function validPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function sanitizeId(value, maxChars) {
  const text = removeControlAndFormatChars(removeUnpairedSurrogates(String(value || '').trim()));
  return truncateByCodePoint(text, maxChars).trim();
}

// Normalize the primary key (deviceId, client, sessionId) into its single
// canonical form. Every path that addresses a catalog row by key — the upsert
// (via normalizeCatalogEntry) and the tombstone (via the hub's invalidateKeys) —
// must derive the key through this one function, or a delete can land on a
// differently-normalized key (e.g. collapsed whitespace), leaving the original
// row live while creating a ghost tombstone. Note that sanitizeId deliberately
// does NOT collapse whitespace or NFC-normalize, so this function is the only
// thing that can keep the two write paths agreeing on key shape.
function normalizeCatalogKey(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const deviceId = sanitizeId(raw.deviceId, DEVICE_ID_MAX_CHARS);
  const client = String(raw.client || '').trim().toLowerCase();
  const sessionId = sanitizeId(raw.sessionId, SESSION_ID_MAX_CHARS);
  if (!deviceId || !CATALOG_CLIENTS.includes(client) || !sessionId) return null;
  return { deviceId, client, sessionId };
}

// Whitelist-normalize one raw entry into the wire shape. Unknown fields are
// dropped; malformed fields are dropped per-field (never invented). Returns null
// when the entry has no usable primary key.
function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = normalizeCatalogKey(raw);
  if (!key) return null;
  const { deviceId, client, sessionId } = key;

  const entry = {
    deviceId,
    client,
    sessionId,
    workspaceKey: sanitizeWorkspaceKey(raw.workspaceKey),
    workspaceLabel: sanitizeWorkspaceLabel(raw.workspaceLabel),
    title: sanitizeTitle(raw.title),
    titleSource: TITLE_SOURCES.includes(raw.titleSource) ? raw.titleSource : '',
    lastUsedAt: validIsoTimestamp(raw.lastUsedAt) || validIsoTimestamp(raw.startedAt),
    updatedAt: validIsoTimestamp(raw.updatedAt)
  };
  const startedAt = validIsoTimestamp(raw.startedAt);
  if (startedAt) entry.startedAt = startedAt;
  const messageCount = validNonNegativeInteger(raw.messageCount);
  if (messageCount !== null) entry.messageCount = messageCount;
  if (raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) {
    const stats = {};
    const totalTokens = validPositiveNumber(raw.stats.totalTokens);
    const costUsd = validPositiveNumber(raw.stats.costUsd);
    if (totalTokens !== null) stats.totalTokens = totalTokens;
    if (costUsd !== null) stats.costUsd = costUsd;
    if (Object.keys(stats).length > 0) entry.stats = stats;
  }
  const deletedAt = validIsoTimestamp(raw.deletedAt);
  if (deletedAt) entry.deletedAt = deletedAt;

  // A title is required for the entry to be useful in the catalog. Entries with
  // nothing to show stay local.
  if (!entry.title) return null;
  // Without a last-activity time there is no sort key; refuse rather than invent.
  if (!entry.lastUsedAt) return null;
  return entry;
}

// Convenience builder for adapters (T5/T6/T7): normalize + derive workspace
// fields from a local absolute path in one call.
function buildCatalogEntry({
  deviceId,
  client,
  sessionId,
  absolutePath = '',
  workspaceKey = '',
  workspaceLabel = '',
  title,
  titleSource = 'fallback',
  startedAt,
  lastUsedAt,
  updatedAt,
  messageCount,
  stats,
  deletedAt
}) {
  return normalizeCatalogEntry({
    deviceId,
    client,
    sessionId,
    workspaceKey: workspaceKey || workspaceKeyFromPath(absolutePath),
    workspaceLabel: workspaceLabel || workspaceLabelFromPath(absolutePath),
    title,
    titleSource,
    startedAt,
    lastUsedAt,
    updatedAt,
    messageCount,
    stats,
    deletedAt
  });
}

module.exports = {
  CATALOG_CLIENTS,
  TITLE_MAX_CHARS,
  LABEL_MAX_CHARS,
  buildCatalogEntry,
  normalizeCatalogEntry,
  normalizeCatalogKey,
  sanitizeLabel,
  sanitizeText,
  sanitizeTitle,
  sanitizeWorkspaceKey,
  sanitizeWorkspaceLabel,
  titleFromFirstUserMessage,
  workspaceKeyFromPath,
  workspaceLabelFromPath
};
