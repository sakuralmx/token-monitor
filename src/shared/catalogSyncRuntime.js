'use strict';

// Catalog sync runtime shared by the widget and the headless agent (plan T9).
//
// Orchestrates: scan local client adapters (T5/T6/T7) → computeCatalogDelta
// (only new/newer/explicit-delete) → uploadCatalogDelta (batched, idempotent)
// → persist the advanced sync state. Transport failures keep the delta in the
// pending state so the next tick retries the *same* delta — never a duplicate,
// because upsert is a whole-record replace by primary key.
//
// All IO is injected (fs/os/adapters/fetch/state store) so tests run in memory.

const { computeCatalogDelta, uploadCatalogDelta } = require('./catalogSync');

function catalogStateForDevice(state = {}, deviceId = '') {
  if (!deviceId) return state || {};
  return state[deviceId] || {};
}

function mergeCatalogState(state = {}, deviceId = '', next = {}) {
  return { ...(state || {}), [deviceId]: next };
}

// Run one catalog sync cycle. Returns a report for logging/tests:
//   { scanned, upserted, invalidated, unavailable, skipped, error }
async function runCatalogSync({
  state = {},
  deviceId = '',
  adapters = [],
  fetchFn,
  baseUrl = '',
  secret = '',
  logger
} = {}) {
  if (!deviceId) return { scanned: 0, upserted: 0, invalidated: 0, unavailable: false, skipped: true, error: null };
  const deviceState = catalogStateForDevice(state, deviceId);

  // Scan each adapter; a failing adapter is isolated (never aborts the cycle).
  const entries = [];
  for (const adapter of adapters || []) {
    if (typeof adapter.scan !== 'function') continue;
    try {
      const result = adapter.scan();
      const list = Array.isArray(result) ? result : (result?.entries || []);
      entries.push(...list);
    } catch (error) {
      if (typeof logger === 'function') logger(`[catalog] adapter scan failed: ${error.message}`);
    }
  }

  const delta = computeCatalogDelta({ state: deviceState, entries });
  if (delta.upserts.length === 0 && delta.invalidateKeys.length === 0) {
    return {
      scanned: entries.length,
      upserted: 0,
      invalidated: 0,
      unavailable: false,
      skipped: true,
      error: null
    };
  }

  // No hub configured (local mode) → keep the delta pending but do not error.
  if (!baseUrl) {
    return {
      scanned: entries.length,
      upserted: 0,
      invalidated: 0,
      unavailable: false,
      skipped: true,
      offline: true,
      error: null
    };
  }

  try {
    const result = await uploadCatalogDelta({
      upserts: delta.upserts,
      invalidateKeys: delta.invalidateKeys,
      fetchFn,
      baseUrl,
      secret,
      logger
    });
    if (result.unavailable) {
      return {
        scanned: entries.length,
        upserted: 0,
        invalidated: 0,
        unavailable: true,
        skipped: true,
        error: null
      };
    }
    // Only advance the state after the upload was accepted; a transport error
    // below leaves it untouched so the same delta retries next tick.
    return {
      scanned: entries.length,
      upserted: result.accepted,
      invalidated: result.invalidated,
      unavailable: false,
      skipped: false,
      error: null,
      nextState: mergeCatalogState(state, deviceId, delta.nextState)
    };
  } catch (error) {
    return {
      scanned: entries.length,
      upserted: 0,
      invalidated: 0,
      unavailable: false,
      skipped: true,
      error: error.message || String(error)
    };
  }
}

module.exports = {
  catalogStateForDevice,
  mergeCatalogState,
  runCatalogSync
};
