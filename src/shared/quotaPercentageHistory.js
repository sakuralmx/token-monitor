'use strict';

const PROVIDERS = Object.freeze(['codex', 'opencode']);

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function tokenComponents(period, { client, provider } = {}) {
  const id = String(provider || client || '').trim().toLowerCase();
  const prefix = provider ? 'provider' : 'client';
  const total = Math.max(0, number(period?.[`${prefix}Tokens`]?.[id] ?? period?.clients?.[id]));
  const cacheRead = Math.min(total, Math.max(0, number(period?.[`${prefix}CacheReads`]?.[id])));
  const cacheWrite = Math.min(total - cacheRead, Math.max(0, number(period?.[`${prefix}CacheWrites`]?.[id])));
  const output = Math.min(total - cacheRead - cacheWrite, Math.max(0, number(period?.[`${prefix}Outputs`]?.[id])));
  return { input: Math.max(0, total - cacheRead - cacheWrite - output), cacheRead, cacheWrite, output };
}

function normalizeObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const remainingPercent = Number(value.remainingPercent);
  const atMs = Date.parse(value.at || '');
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100 || !Number.isFinite(atMs)) return null;
  const resetsAtMs = value.resetsAt ? Date.parse(value.resetsAt) : NaN;
  const sourceComponents = value.components && typeof value.components === 'object' ? value.components : {};
  return {
    remainingPercent,
    at: new Date(atMs).toISOString(),
    resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
    components: Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output']
      .map((key) => [key, Math.max(0, number(sourceComponents[key]))]))
  };
}

function compactObservations(values) {
  const sorted = [...new Map(values.map((row) => [row.at, row])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length < 3) return sorted;
  const compacted = [sorted[0]];
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const next = sorted[index + 1];
    // A run of an unchanged official percentage needs only its first and last
    // confirmation. Keeping both bounds preserves when the plateau began and
    // how long it was last known to continue, while discarding redundant polls.
    if (previous.remainingPercent === current.remainingPercent
      && current.remainingPercent === next.remainingPercent) continue;
    compacted.push(current);
  }
  compacted.push(sorted.at(-1));
  return compacted;
}

function normalizeProviderHistory(value) {
  if (!value || typeof value !== 'object') return null;
  const accountKey = String(value.accountKey || '').trim().slice(0, 256);
  const observations = compactObservations((Array.isArray(value.observations) ? value.observations : [])
    .map(normalizeObservation).filter(Boolean));
  if (!accountKey || observations.length === 0) return null;
  return {
    version: 1,
    accountKey,
    updatedAt: observations.at(-1).at,
    observations
  };
}

function normalizeQuotaPercentageHistory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};
  const pending = {};
  for (const provider of PROVIDERS) {
    const history = normalizeProviderHistory(source[provider]);
    if (history) normalized[provider] = history;
    const observations = compactObservations((Array.isArray(source.pending?.[provider]) ? source.pending[provider] : [])
      .map(normalizeObservation).filter(Boolean));
    if (observations.length) pending[provider] = observations;
  }
  if (Object.keys(pending).length) normalized.pending = pending;
  return normalized;
}

function migrateLegacyQuotaHistory(value, existing = {}) {
  const legacy = value && typeof value === 'object' ? value : {};
  const migrated = { ...normalizeQuotaPercentageHistory(existing) };
  const pending = existing?.pending && typeof existing.pending === 'object' ? { ...existing.pending } : {};
  const pairs = [
    ['codex', legacy.calibration, legacy.accountKey],
    ['opencode', legacy.opencodeCalibration, legacy.opencodeAccountKey]
  ];
  for (const [provider, calibration, fallbackAccountKey] of pairs) {
    if (migrated[provider] || !calibration || typeof calibration !== 'object') continue;
    const observations = compactObservations((Array.isArray(calibration.observations) ? calibration.observations : [])
      .map(normalizeObservation).filter(Boolean));
    const accountKey = String(calibration.accountKey || fallbackAccountKey || '').trim().slice(0, 256);
    if (accountKey && observations.length) migrated[provider] = { version: 1, accountKey, updatedAt: observations.at(-1).at, observations };
    else if (observations.length) pending[provider] = observations;
  }
  if (Object.keys(pending).length) migrated.pending = pending;
  return migrated;
}

function quotaWindow(provider) {
  const windows = (Array.isArray(provider?.windows) ? provider.windows : [])
    .filter((window) => window?.source !== 'local' && Number.isFinite(Number(window?.remainingPercent)));
  return windows.find((window) => window?.kind === 'weekly') || windows[0] || null;
}

function appendObservation(history, providerId, provider, period, at) {
  const window = quotaWindow(provider);
  const accountKey = String(provider?.accountKey || '').trim().slice(0, 256);
  const atMs = Date.parse(at || '');
  if (!window || !accountKey || !Number.isFinite(atMs)) return history;
  const previous = normalizeProviderHistory(history?.[providerId]);
  const pending = (Array.isArray(history?.pending?.[providerId]) ? history.pending[providerId] : [])
    .map(normalizeObservation).filter(Boolean);
  const observation = normalizeObservation({
    remainingPercent: window.remainingPercent,
    at: new Date(atMs).toISOString(),
    resetsAt: window.resetsAt,
    components: providerId === 'opencode'
      ? tokenComponents(period, { provider: 'opencode-go' })
      : tokenComponents(period, { client: 'codex' })
  });
  if (!observation) return history;
  const prior = previous?.accountKey === accountKey ? previous.observations : pending;
  const last = prior.at(-1);
  if (last?.at === observation.at && previous?.accountKey === accountKey) return history;
  const observations = compactObservations(last?.at === observation.at ? prior : [...prior, observation]);
  const next = { ...history, [providerId]: { version: 1, accountKey, updatedAt: observations.at(-1).at, observations } };
  if (next.pending) {
    next.pending = { ...next.pending };
    delete next.pending[providerId];
    if (!Object.keys(next.pending).length) delete next.pending;
  }
  return next;
}

function observeQuotaPercentages(history, record) {
  let next = normalizeQuotaPercentageHistory(history);
  if (history?.pending && typeof history.pending === 'object') next.pending = { ...history.pending };
  const providers = Array.isArray(record?.limits?.providers) ? record.limits.providers : [];
  const period = record?.allTime || record?.periods?.allTime || {};
  const fallbackAt = record?.limits?.updatedAt || record?.updatedAt || new Date().toISOString();
  const codex = providers.find((provider) => provider?.provider === 'codex' && provider?.status === 'ok');
  const opencode = providers.find((provider) => provider?.provider === 'opencode' && provider?.status === 'ok'
    && (provider?.accountLabel === 'Go' || provider?.planLabel === 'Go'));
  if (codex) next = appendObservation(next, 'codex', codex, period, codex.updatedAt || fallbackAt);
  if (opencode) next = appendObservation(next, 'opencode', opencode, period, opencode.updatedAt || fallbackAt);
  return next;
}

function mergeQuotaPercentageHistory(existing, incoming) {
  const left = normalizeQuotaPercentageHistory(existing);
  const right = normalizeQuotaPercentageHistory(incoming);
  const merged = { ...left };
  for (const provider of PROVIDERS) {
    if (!right[provider]) continue;
    if (!left[provider] || left[provider].accountKey !== right[provider].accountKey) {
      if (!left[provider] || Date.parse(right[provider].updatedAt) >= Date.parse(left[provider].updatedAt)) merged[provider] = right[provider];
      continue;
    }
    const byTimestamp = new Map(left[provider].observations.map((row) => [row.at, row]));
    for (const row of right[provider].observations) byTimestamp.set(row.at, row);
    const observations = compactObservations([...byTimestamp.values()]);
    merged[provider] = { version: 1, accountKey: left[provider].accountKey, updatedAt: observations.at(-1).at, observations };
  }
  return merged;
}

module.exports = {
  appendObservation,
  compactObservations,
  mergeQuotaPercentageHistory,
  migrateLegacyQuotaHistory,
  normalizeObservation,
  normalizeProviderHistory,
  normalizeQuotaPercentageHistory,
  observeQuotaPercentages,
  tokenComponents
};
