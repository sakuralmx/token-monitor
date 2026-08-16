'use strict';

const { compareHubBuild } = require('../shared/hubBuildComparison');
const { normalizeRuntime } = require('../shared/hubBuildIdentity');

function healthRuntime(payload) {
  return normalizeRuntime(payload?.hubBuild?.runtime || payload?.runtime || '');
}

// Classify a transport failure into a stable machine reason. Node/undici fetch
// failures surface errno codes on error.cause, and TLS verification failures
// carry their own recognizable codes/messages; the renderer maps the reason to
// a localized string. Kept pure and dependency-free so it is trivially testable.
function probeErrorReason(error) {
  const name = error?.name;
  if (name === 'AbortError' || error?.code === 'ABORT_ERR') return 'timeout';
  const cause = error?.cause;
  const code = String(cause?.code || error?.code || '').toUpperCase();
  const message = String(cause?.message || error?.message || '');
  const combined = `${code} ${message}`;
  if (/cert|ssl|tls|self[- ]?signed|unable to verify/i.test(combined)) return 'certificate';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  return 'network';
}

function classifiedFailure(reason, extra = {}) {
  return { status: 'unavailable', reason, runtime: '', hubUrl: '', ...extra };
}

async function probeHubBuild(hubUrl, options = {}) {
  const base = String(hubUrl || '').trim().replace(/\/$/, '');
  if (!base) return { status: 'notConfigured', runtime: '', hubUrl: '' };
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 5000);
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}/api/health`, { signal });
  } catch (error) {
    return classifiedFailure(probeErrorReason(error), { hubUrl: base });
  }
  if (!response.ok) {
    return classifiedFailure('http', { detail: response.status, hubUrl: base });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return classifiedFailure('http', { detail: 'invalid_json', hubUrl: base });
  }
  if (payload?.role !== 'hub') {
    return classifiedFailure('notHub', { hubUrl: base });
  }
  const runtime = healthRuntime(payload);
  const secret = String(options.secret || '').trim();
  if (secret) {
    // Health answers without authentication; verifying the secret needs an
    // authenticated route. A wrong secret must not read as "hub unreachable".
    try {
      const authResponse = await fetchImpl(`${base}/api/devices`, {
        signal,
        headers: { authorization: `Bearer ${secret}` }
      });
      if (authResponse.status === 401 || authResponse.status === 403) {
        return { status: 'unauthorized', runtime, hubUrl: base };
      }
      if (!authResponse.ok) {
        return classifiedFailure('http', { detail: authResponse.status, runtime, hubUrl: base });
      }
    } catch (error) {
      return classifiedFailure(probeErrorReason(error), { runtime, hubUrl: base });
    }
  } else if (payload.secretRequired === true) {
    // The hub told us it requires a secret, and none was provided. Distinct
    // from a wrong secret: the fix is to fill the field, not to change it.
    return { status: 'needsSecret', runtime, hubUrl: base };
  }
  const compared = compareHubBuild(payload?.hubBuild);
  if (compared.status === 'legacy') {
    return { ...compared, runtime, hubUrl: base };
  }
  return { ...compared, hubUrl: base };
}

module.exports = { healthRuntime, probeErrorReason, probeHubBuild };
