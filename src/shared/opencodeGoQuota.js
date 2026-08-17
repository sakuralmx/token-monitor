'use strict';

// OpenCode Go quota modelling.
//
// Go limits are denominated in USD, not tokens: $12 per 5 hours, $30 per week,
// $60 per month (https://opencode.ai/docs/zh-cn/go). The official usage API
// answers with per-window `percent` only — it deliberately omits the `used`/
// `limit` dollar values — so this module maps a percentage onto:
//   - a dollar figure: `limit × (100 - percent) / 100`, using the fixed limits;
//   - an approximate request count: `publishedRequests × (100 - percent) / 100`,
//     using the docs' per-model request estimates (which already fold in each
//     model's typical input/cache/output mix and price, including any peak/
//     off-peak tiers — we never re-derive cost from raw prices, so those tiers
//     are already resolved upstream in the published table).
//
// The request table mirrors the published docs. It is a constant (with an env
// escape hatch for the dollar limits) because neither the API nor the local DB
// returns it.

(function exposeOpenCodeGoQuota(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.opencodeGoQuota = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOpenCodeGoQuotaApi() {

const GO_LIMIT_USD = Object.freeze({ session: 12, weekly: 30, monthly: 60 });

// Published per-model request estimates for the 5h / weekly / monthly windows.
// Prices, peak/off-peak tiers, and cache-write pricing are all already baked
// into these numbers upstream, so the quota estimate avoids re-deriving cost.
const GO_MODELS = Object.freeze({
  'grok-4.5': { session: 120, weekly: 300, monthly: 600 },
  'gpt-5.6-luna': { session: 2050, weekly: 5100, monthly: 10250 },
  'glm-5.3': { session: 220, weekly: 540, monthly: 1080 },
  'glm-5.2': { session: 880, weekly: 2150, monthly: 4300 },
  'glm-5.1': { session: 880, weekly: 2150, monthly: 4300 },
  'kimi-k3': { session: 110, weekly: 250, monthly: 490 },
  'kimi-k2.7-code': { session: 1350, weekly: 3380, monthly: 6750 },
  'kimi-k2.6': { session: 1150, weekly: 2880, monthly: 5750 },
  'mimo-v2.5': { session: 30100, weekly: 75200, monthly: 150400 },
  'mimo-v2.5-pro': { session: 3250, weekly: 8150, monthly: 16300 },
  'minimax-m3': { session: 3200, weekly: 8000, monthly: 16000 },
  'minimax-m2.7': { session: 3400, weekly: 8500, monthly: 17000 },
  'qwen3.8-max': { session: 160, weekly: 400, monthly: 810 },
  'qwen3.7-max': { session: 340, weekly: 840, monthly: 1690 },
  'qwen3.7-plus': { session: 4300, weekly: 10800, monthly: 21600 },
  'qwen3.6-plus': { session: 3300, weekly: 8200, monthly: 16300 },
  'deepseek-v4-pro': { session: 1050, weekly: 2600, monthly: 5200 },
  'deepseek-v4-flash': { session: 3800, weekly: 9450, monthly: 18900 },
  'hy3': { session: 4300, weekly: 10750, monthly: 21500 }
});

// Model ids map through `opencode-go/<id>` on the wire; accept either spelling.
function normalizeModelId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  return raw.replace(/^opencode-go\//, '');
}

function goLimits(env = {}) {
  const raw = String(env.TOKEN_MONITOR_OPENCODE_GO_LIMITS || '').trim();
  if (raw) {
    const parts = raw.split(',').map((s) => Number(s.trim()));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)) {
      return { session: parts[0], weekly: parts[1], monthly: parts[2] };
    }
  }
  return { ...GO_LIMIT_USD };
}

function clampPercent(value) {
  // Reject null/empty/boolean explicitly: Number(null)===0 and Number('')===0
  // would otherwise turn "unknown" into a false "0% used / full quota" reading.
  if (value === null || value === undefined || value === '' || value === false) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function modelRequests(modelId) {
  const id = normalizeModelId(modelId);
  const entry = GO_MODELS[id] || null;
  return entry ? { ...entry } : null;
}

// Remaining spendable dollars in a window given the used percentage.
function remainingUsd(limitUsd, usedPercent) {
  const limit = Number(limitUsd) || 0;
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return Number((limit * (100 - pct) / 100).toFixed(4));
}

// Builds a per-window Go estimate. `modelId` is optional: without one (or for an
// unknown model) we still report dollars, but request counts are null — the
// dollar figure is always authoritative; requests are only shown against a model
// we actually know, never guessed from a wrong one.
function estimateGoWindows({ windows = [], modelId = '', env = {} } = {}) {
  const limits = goLimits(env);
  const kindLimit = { session: limits.session, weekly: limits.weekly, monthly: limits.monthly };
  const requests = modelId ? modelRequests(modelId) : null;
  return (Array.isArray(windows) ? windows : []).map((window) => {
    const kind = String(window?.kind || '').trim();
    const usedPercent = clampPercent(window?.usedPercent);
    const limitUsd = kindLimit[kind] ?? null;
    const remaining = limitUsd != null && usedPercent !== null
      ? remainingUsd(limitUsd, usedPercent)
      : null;
    const windowRequests = requests && requests[kind] != null ? requests[kind] : null;
    // The published request table is anchored on the official $12/$30/$60. When
    // an env override changes a dollar limit, scale the request count by the same
    // factor so the two columns stay consistent under one quota definition.
    const officialLimit = GO_LIMIT_USD[kind];
    const requestScale = limitUsd != null && officialLimit ? limitUsd / officialLimit : 1;
    const scaledRequests = windowRequests != null ? Math.round(windowRequests * requestScale) : null;
    const remainingRequests = remaining != null && scaledRequests != null
      ? Math.floor(scaledRequests * (100 - usedPercent) / 100)
      : null;
    return {
      kind,
      limitUsd,
      usedPercent,
      remainingUsd: remaining,
      remainingRequests,
      resetsAt: window?.resetsAt || null
    };
  });
}

  return {
    GO_LIMIT_USD,
    GO_MODELS,
    normalizeModelId,
    goLimits,
    modelRequests,
    remainingUsd,
    clampPercent,
    estimateGoWindows
  };

});
