'use strict';

// Widget-side catalog sync controller (plan T9 wiring).
//
// Drives runCatalogSync on an interval in client/host modes: scans the local
// adapters, uploads the delta, and persists the advanced sync state back into
// the widget settings. Stop is idempotent and clears the timer so a mode switch
// cannot leave a second loop running.

const { runCatalogSync } = require('../shared/catalogSyncRuntime');

const DEFAULT_CATALOG_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const MIN_CATALOG_SYNC_INTERVAL_MS = 60 * 1000;

function createCatalogSyncController(options = {}) {
  const scanAdapters = typeof options.scanAdapters === 'function' ? options.scanAdapters : () => [];
  const readState = typeof options.readState === 'function' ? options.readState : () => ({});
  const writeState = typeof options.writeState === 'function' ? options.writeState : () => {};
  const fetchImpl = options.fetchFn || fetch;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const logger = typeof options.logger === 'function' ? options.logger : null;
  const intervalMs = Math.max(MIN_CATALOG_SYNC_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_CATALOG_SYNC_INTERVAL_MS);

  let timer = null;
  let running = false;
  let stopped = false;

  function scheduleNext() {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      cycle().catch((error) => {
        if (onError) onError(error);
      });
    }, intervalMs);
  }

  async function cycle() {
    if (stopped || running) return;
    running = true;
    try {
      const config = options.config ? options.config() : {};
      const { deviceId = '', baseUrl = '', secret = '' } = config;
      const adapters = scanAdapters();
      const report = await runCatalogSync({
        state: readState(),
        deviceId,
        adapters,
        fetchFn: fetchImpl,
        baseUrl,
        secret,
        logger
      });
      if (report.nextState) writeState(report.nextState);
      if (logger && report.skipped && report.scanned > 0 && !report.offline && !report.unavailable) {
        logger(`[catalog] nothing to sync (${report.scanned} scanned)`);
      }
      return report;
    } finally {
      running = false;
      if (!stopped) scheduleNext();
    }
  }

  async function start() {
    stopped = false;
    // First cycle runs immediately; subsequent ones on the interval.
    return cycle();
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
  }

  return { cycle, start, stop };
}

module.exports = {
  DEFAULT_CATALOG_SYNC_INTERVAL_MS,
  MIN_CATALOG_SYNC_INTERVAL_MS,
  createCatalogSyncController
};
