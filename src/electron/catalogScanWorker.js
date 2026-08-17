'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { scanCherryStudioSessions } = require('../shared/cherryStudioSessions');
const { scanCodexSessions } = require('../shared/codexSessions');
const { scanDshSessions } = require('../shared/dshSessions');

function scan() {
  const deps = {
    deviceId: workerData.deviceId,
    home: workerData.home,
    env: process.env,
    platform: workerData.platform
  };
  const entries = [];
  try { entries.push(...scanCherryStudioSessions(deps)); } catch (_) {}
  try { entries.push(...scanCodexSessions(deps)); } catch (_) {}
  let dshResult = { entries: [] };
  try { dshResult = scanDshSessions(deps); } catch (_) {}
  entries.push(...dshResult.entries);
  entries.sort((left, right) => Date.parse(right?.lastUsedAt || right?.updatedAt || 0)
    - Date.parse(left?.lastUsedAt || left?.updatedAt || 0));
  return { entries, zstdAvailable: dshResult.zstdAvailable !== false };
}

try {
  parentPort.postMessage({ ok: true, result: scan() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || String(error) });
}
