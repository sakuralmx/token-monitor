'use strict';

// OpenCode Go quota modelling.
//
// Go limits are denominated in USD, not tokens: $12 per 5 hours, $30 per week,
// $60 per month (https://opencode.ai/docs/zh-cn/go). The official usage API
// answers with per-window `percent` only — it deliberately omits the `used`/
// `limit` dollar values — so this module turns a percentage + a model's declared
// pricing into a dollar figure and an approximate request count, exactly what
// the GPT quota card needs for the Go equivalent.
//
// The tables below mirror the published docs. They are constants (with an env
// escape hatch) because the API does not return them and the local DB records
// only `cost` per message, not per model — there is no other source of truth.

const GO_LIMIT_USD = Object.freeze({ session: 12, weekly: 30, monthly: 60 });

// Per-model pricing (USD per 1M tokens) + docs' typical per-request token mix.
// `allowanceUsd` is the published monthly usage allowance behind the $60 cap's
// 6x value multiplier (informational; the hard limits are GO_LIMIT_USD).
const GO_MODELS = Object.freeze({
  'grok-4.5': { input: 2.0, output: 6.0, cacheRead: 0.3, cacheWrite: 0, inputPerReq: 1100, cachePerReq: 71500, outputPerReq: 220, allowanceUsd: 15 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, inputPerReq: 1000, cachePerReq: 50000, outputPerReq: 220, allowanceUsd: 15 },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, inputPerReq: 700, cachePerReq: 52000, outputPerReq: 150, allowanceUsd: 15 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, inputPerReq: 700, cachePerReq: 52000, outputPerReq: 150, allowanceUsd: 60 },
  'glm-5.1': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, inputPerReq: 700, cachePerReq: 52000, outputPerReq: 150, allowanceUsd: 60 },
  'kimi-k3': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0, inputPerReq: 1050, cachePerReq: 76500, outputPerReq: 300, allowanceUsd: 15 },
  'kimi-k2.7-code': { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0, inputPerReq: 870, cachePerReq: 55000, outputPerReq: 200, allowanceUsd: 60 },
  'kimi-k2.6': { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0, inputPerReq: 870, cachePerReq: 55000, outputPerReq: 200, allowanceUsd: 60 },
  'mimo-v2.5': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0, inputPerReq: 830, cachePerReq: 71500, outputPerReq: 295, allowanceUsd: 60 },
  'mimo-v2.5-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0, inputPerReq: 790, cachePerReq: 86000, outputPerReq: 305, allowanceUsd: 15 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0, inputPerReq: 510, cachePerReq: 56000, outputPerReq: 190, allowanceUsd: 60 },
  'minimax-m2.7': { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375, inputPerReq: 300, cachePerReq: 55000, outputPerReq: 125, allowanceUsd: 60 },
  'qwen3.8-max': { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5, inputPerReq: 420, cachePerReq: 66000, outputPerReq: 200, allowanceUsd: 15 },
  'qwen3.7-max': { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125, inputPerReq: 420, cachePerReq: 66000, outputPerReq: 200, allowanceUsd: 60 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5, inputPerReq: 500, cachePerReq: 57000, outputPerReq: 190, allowanceUsd: 60 },
  'qwen3.6-plus': { input: 0.5, output: 3.0, cacheRead: 0.05, cacheWrite: 0.625, inputPerReq: 500, cachePerReq: 57000, outputPerReq: 190, allowanceUsd: 60 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0, inputPerReq: 750, cachePerReq: 82000, outputPerReq: 290, allowanceUsd: 15 },
  'deepseek-v4-flash': { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0, inputPerReq: 410, cachePerReq: 71300, outputPerReq: 310, allowanceUsd: 15 },
  'hy3': { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0, inputPerReq: 830, cachePerReq: 71500, outputPerReq: 295, allowanceUsd: 60 }
});

// Model ids map through `opencode-go/<id>` on the wire; accept either spelling.
function normalizeModelId(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  return raw.replace(/^opencode-go\//, '');
}

function goLimits(env = {}) {
  // Mirror opencodeLimits.goLimits but stay dependency-free for the Worker.
  const raw = String(env.TOKEN_MONITOR_OPENCODE_GO_LIMITS || '').trim();
  if (raw) {
    const parts = raw.split(',').map((s) => Number(s.trim()));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)) {
      return { session: parts[0], weekly: parts[1], monthly: parts[2] };
    }
  }
  return { ...GO_LIMIT_USD };
}

function modelPricing(modelId) {
  const id = normalizeModelId(modelId);
  const entry = GO_MODELS[id] || null;
  if (!entry) return null;
  return entry;
}

// Dollar cost of one "typical" request for a model, using the docs' per-request
// token mix against the per-1M-token prices.
function requestCostUsd(modelId) {
  const p = modelPricing(modelId);
  if (!p) return null;
  const cost = (p.inputPerReq / 1e6) * p.input
    + (p.cachePerReq / 1e6) * p.cacheRead
    + (p.outputPerReq / 1e6) * p.output;
  return Number(cost.toFixed(8));
}

// Remaining spendable dollars in a window given the used percentage.
function remainingUsd(limitUsd, usedPercent) {
  const limit = Number(limitUsd) || 0;
  const pct = Math.max(0, Math.min(100, Number(usedPercent) || 0));
  return Number((limit * (100 - pct) / 100).toFixed(4));
}

// Builds a per-window Go estimate. `modelId` is optional: without one we still
// report dollars, but request counts are null (never guessed from a wrong model).
function estimateGoWindows({ windows = [], modelId = '', env = {} } = {}) {
  const limits = goLimits(env);
  const kindLimit = { session: limits.session, weekly: limits.weekly, monthly: limits.monthly };
  return (Array.isArray(windows) ? windows : []).map((window) => {
    const kind = String(window?.kind || '').trim();
    const usedPercent = window?.usedPercent;
    const limitUsd = kindLimit[kind];
    const remaining = limitUsd != null && Number.isFinite(Number(usedPercent))
      ? remainingUsd(limitUsd, usedPercent)
      : null;
    const perRequest = requestCostUsd(modelId);
    const remainingRequests = remaining != null && perRequest && perRequest > 0
      ? Math.floor(remaining / perRequest)
      : null;
    return {
      kind,
      limitUsd: limitUsd ?? null,
      usedPercent: Number.isFinite(Number(usedPercent)) ? Number(usedPercent) : null,
      remainingUsd: remaining,
      remainingRequests,
      resetsAt: window?.resetsAt || null
    };
  });
}

module.exports = {
  GO_LIMIT_USD,
  GO_MODELS,
  normalizeModelId,
  goLimits,
  modelPricing,
  requestCostUsd,
  remainingUsd,
  estimateGoWindows
};
