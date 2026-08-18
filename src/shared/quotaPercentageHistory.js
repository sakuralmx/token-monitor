'use strict';

const PROVIDERS = Object.freeze(['codex', 'opencode']);
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function tokenComponents(period, { client, provider } = {}) {
  const id = String(provider || client || '').trim().toLowerCase();
  const prefix = provider ? 'provider' : 'client';
  const total = Math.max(0, num(period?.[`${prefix}Tokens`]?.[id] ?? period?.clients?.[id]));
  const cacheRead = Math.min(total, Math.max(0, num(period?.[`${prefix}CacheReads`]?.[id])));
  const cacheWrite = Math.min(total - cacheRead, Math.max(0, num(period?.[`${prefix}CacheWrites`]?.[id])));
  const output = Math.min(total - cacheRead - cacheWrite, Math.max(0, num(period?.[`${prefix}Outputs`]?.[id])));
  return { input: Math.max(0, total - cacheRead - cacheWrite - output), cacheRead, cacheWrite, output };
}

function normalizeObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const remainingPercent = Number(value.remainingPercent);
  const atMs = Date.parse(value.at || '');
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100 || !Number.isFinite(atMs)) return null;
  const resetMs = value.resetsAt ? Date.parse(value.resetsAt) : NaN;
  const source = value.components && typeof value.components === 'object' ? value.components : {};
  return {
    remainingPercent,
    at: new Date(atMs).toISOString(),
    resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    components: Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, Math.max(0, num(source[key]))]))
  };
}

function compactObservations(values) {
  const sorted = [...new Map(values.map((row) => [row.at, row])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length < 3) return sorted;
  const compacted = [sorted[0]];
  for (let i = 1; i < sorted.length - 1; i += 1) {
    if (sorted[i - 1].remainingPercent === sorted[i].remainingPercent && sorted[i].remainingPercent === sorted[i + 1].remainingPercent) continue;
    compacted.push(sorted[i]);
  }
  compacted.push(sorted.at(-1));
  return compacted;
}

function normalizeAccount(value, fallbackKey = '') {
  const accountKey = String(value?.accountKey || fallbackKey || '').trim().slice(0, 256);
  const observations = compactObservations((Array.isArray(value?.observations) ? value.observations : []).map(normalizeObservation).filter(Boolean));
  return accountKey && observations.length ? { version: 1, accountKey, updatedAt: observations.at(-1).at, observations } : null;
}

function normalizeQuotaPercentageHistory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const provider of PROVIDERS) {
    const accounts = {};
    if (source[provider]?.accounts && typeof source[provider].accounts === 'object') {
      for (const [key, raw] of Object.entries(source[provider].accounts)) {
        const account = normalizeAccount(raw, key);
        if (account) accounts[account.accountKey] = account;
      }
    } else {
      const account = normalizeAccount(source[provider]);
      if (account) accounts[account.accountKey] = account;
    }
    if (Object.keys(accounts).length) out[provider] = { accounts };
  }
  const pending = {};
  for (const provider of PROVIDERS) {
    const rows = compactObservations((Array.isArray(source.pending?.[provider]) ? source.pending[provider] : []).map(normalizeObservation).filter(Boolean));
    if (rows.length) pending[provider] = rows;
  }
  if (Object.keys(pending).length) out.pending = pending;
  return out;
}

function mergeQuotaPercentageHistory(existing, incoming) {
  const left = normalizeQuotaPercentageHistory(existing);
  const right = normalizeQuotaPercentageHistory(incoming);
  const out = normalizeQuotaPercentageHistory(left);
  for (const provider of PROVIDERS) {
    const accounts = { ...(out[provider]?.accounts || {}) };
    for (const [key, account] of Object.entries(right[provider]?.accounts || {})) {
      const observations = compactObservations([...(accounts[key]?.observations || []), ...account.observations]);
      accounts[key] = { version: 1, accountKey: key, updatedAt: observations.at(-1).at, observations };
    }
    if (Object.keys(accounts).length) out[provider] = { accounts };
  }
  const pending = {};
  for (const provider of PROVIDERS) {
    const rows = compactObservations([...(left.pending?.[provider] || []), ...(right.pending?.[provider] || [])]);
    if (rows.length) pending[provider] = rows;
  }
  if (Object.keys(pending).length) out.pending = pending;
  else delete out.pending;
  return out;
}

function migrateLegacyQuotaHistory(value, existing = {}) {
  let out = normalizeQuotaPercentageHistory(existing);
  for (const [provider, calibration, fallbackKey] of [['codex', value?.calibration, value?.accountKey], ['opencode', value?.opencodeCalibration, value?.opencodeAccountKey]]) {
    if (!calibration || typeof calibration !== 'object') continue;
    const observations = compactObservations((Array.isArray(calibration.observations) ? calibration.observations : []).map(normalizeObservation).filter(Boolean));
    if (!observations.length) continue;
    const accountKey = String(calibration.accountKey || fallbackKey || '').trim().slice(0, 256);
    if (accountKey) out = mergeQuotaPercentageHistory(out, { [provider]: { accounts: { [accountKey]: { accountKey, observations } } } });
    else {
      out.pending = out.pending || {};
      out.pending[provider] = compactObservations([...(out.pending[provider] || []), ...observations]);
    }
  }
  return out;
}

function quotaWindow(provider) {
  const windows = (Array.isArray(provider?.windows) ? provider.windows : []).filter((row) => row?.source !== 'local' && Number.isFinite(Number(row?.remainingPercent)));
  return windows.find((row) => row.kind === 'weekly') || windows[0] || null;
}

function appendObservation(history, providerId, provider, period, at) {
  const window = quotaWindow(provider);
  const accountKey = String(provider?.accountKey || '').trim().slice(0, 256);
  const atMs = Date.parse(at || '');
  if (!window || !accountKey || !Number.isFinite(atMs)) return normalizeQuotaPercentageHistory(history);
  const out = normalizeQuotaPercentageHistory(history);
  const accounts = { ...(out[providerId]?.accounts || {}) };
  const observation = normalizeObservation({ remainingPercent: window.remainingPercent, at: new Date(atMs).toISOString(), resetsAt: window.resetsAt,
    components: providerId === 'opencode' ? tokenComponents(period, { provider: 'opencode-go' }) : tokenComponents(period, { client: 'codex' }) });
  const observations = compactObservations([...(accounts[accountKey]?.observations || []), ...(out.pending?.[providerId] || []), observation]);
  accounts[accountKey] = { version: 1, accountKey, updatedAt: observations.at(-1).at, observations };
  out[providerId] = { accounts };
  if (out.pending?.[providerId]) { delete out.pending[providerId]; if (!Object.keys(out.pending).length) delete out.pending; }
  return out;
}

function observeQuotaPercentages(history, record) {
  let out = normalizeQuotaPercentageHistory(history);
  const period = record?.allTime || record?.periods?.allTime || {};
  const fallbackAt = record?.limits?.updatedAt || record?.updatedAt || new Date().toISOString();
  for (const provider of record?.limits?.providers || []) {
    if (provider?.status !== 'ok') continue;
    if (provider.provider === 'codex') out = appendObservation(out, 'codex', provider, period, provider.updatedAt || fallbackAt);
    if (provider.provider === 'opencode' && (provider.accountLabel === 'Go' || provider.planLabel === 'Go')) out = appendObservation(out, 'opencode', provider, period, provider.updatedAt || fallbackAt);
  }
  return out;
}

function quotaHistoryChunks(history, cursor = {}, chunkSize = 200) {
  const chunks = [];
  const normalized = normalizeQuotaPercentageHistory(history);
  for (const provider of PROVIDERS) for (const [accountKey, account] of Object.entries(normalized[provider]?.accounts || {})) {
    const sent = new Set(Array.isArray(cursor?.[provider]?.[accountKey]) ? cursor[provider][accountKey] : []);
    const rows = account.observations.filter((row) => !sent.has(row.at));
    for (let i = 0; i < rows.length; i += chunkSize) chunks.push({ provider, accountKey, observations: rows.slice(i, i + chunkSize) });
  }
  return chunks;
}

module.exports = { appendObservation, compactObservations, mergeQuotaPercentageHistory, migrateLegacyQuotaHistory, normalizeObservation, normalizeQuotaPercentageHistory, observeQuotaPercentages, quotaHistoryChunks, tokenComponents };
