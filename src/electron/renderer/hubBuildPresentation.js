'use strict';

(function initHubBuildPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHubBuildPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createHubBuildPresentation() {
  function targetKey(runtime) {
    if (runtime === 'cloudflare-worker') return 'settings.sync.hubBuild.targetWorker';
    if (runtime === 'node-hub') return 'settings.sync.hubBuild.targetNode';
    return 'settings.sync.hubBuild.targetHub';
  }

  const VERSION_STATUS_KEYS = {
    current: 'settings.sync.hubBuild.current',
    updateAvailable: 'settings.sync.hubBuild.updateAvailable',
    legacy: 'settings.sync.hubBuild.updateAvailable',
    remoteNewer: 'settings.sync.hubBuild.remoteNewer',
    unknown: 'settings.sync.hubBuild.unknown'
  };

  // The periodic row shows build/version facts and actionable config states
  // (wrong or missing secret). Transport failures stay out of this row — the
  // stream status row owns connectivity — so unavailable remains hidden here.
  function presentation(result) {
    const status = result?.status;
    if (!status || ['notConfigured', 'unavailable'].includes(status)) return null;
    const keyByStatus = {
      ...VERSION_STATUS_KEYS,
      unauthorized: 'settings.sync.hubBuild.unauthorized',
      needsSecret: 'settings.sync.hubBuild.needsSecret'
    };
    const key = keyByStatus[status];
    if (!key) return null;
    const tone = status === 'current' ? 'ok'
      : ['updateAvailable', 'legacy'].includes(status) ? 'warning'
        : ['unauthorized', 'needsSecret'].includes(status) ? 'error'
          : '';
    return { key, targetKey: targetKey(result.runtime), tone };
  }

  // Full diagnosis for the explicit "Test connection" button: every outcome is
  // classified, including transport reasons the periodic row deliberately
  // hides. Reuses the offline.* reason strings so stream and test wording agree.
  const REASON_KEYS = {
    network: 'settings.sync.offline.network',
    certificate: 'settings.sync.offline.certificate',
    refused: 'settings.sync.offline.refused',
    timeout: 'settings.sync.offline.timeout',
    dns: 'settings.sync.offline.dns',
    unreachable: 'settings.sync.offline.unreachable',
    http: 'settings.sync.offline.serverError',
    notHub: 'settings.sync.offline.notHub'
  };

  function testPresentation(result) {
    const status = result?.status;
    if (!status || status === 'notConfigured') return null;
    if (VERSION_STATUS_KEYS[status]) {
      return { key: VERSION_STATUS_KEYS[status], targetKey: targetKey(result.runtime), tone: status === 'current' ? 'ok' : ['updateAvailable', 'legacy'].includes(status) ? 'warning' : '' };
    }
    if (status === 'unauthorized') return { key: 'settings.sync.hubBuild.unauthorized', tone: 'error' };
    if (status === 'needsSecret') return { key: 'settings.sync.hubBuild.needsSecret', tone: 'error' };
    if (status === 'unavailable') {
      const key = REASON_KEYS[result.reason];
      if (!key) return null;
      return { key, tone: 'error', detail: result.detail ? String(result.detail) : '' };
    }
    return null;
  }

  return { presentation, targetKey, testPresentation };
});
