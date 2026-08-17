'use strict';
(function init(root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.quotaTokenEstimate = api; })(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_WEIGHTS = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 });
  // Default tracked client for the Codex/GPT estimate. The estimator is
  // client-agnostic: every entry point takes an explicit client id (or carries
  // one through `options.client`) and only falls back to this default, so the
  // OpenCode Go estimate reuses the same closure against client `opencode`.
  const DEFAULT_CLIENT_ID = 'codex';
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  function clientComponents(period, client = DEFAULT_CLIENT_ID) {
    const total = Math.max(0, number(period?.clients?.[client]));
    const cacheRead = Math.min(total, Math.max(0, number(period?.clientCacheReads?.[client])));
    const cacheWrite = Math.min(total - cacheRead, Math.max(0, number(period?.clientCacheWrites?.[client])));
    const output = Math.min(total - cacheRead - cacheWrite, Math.max(0, number(period?.clientOutputs?.[client])));
    return { input: Math.max(0, total - cacheRead - cacheWrite - output), cacheRead, cacheWrite, output, total };
  }
  function equivalentTokens(period, options = {}) {
    const w = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) }; const p = clientComponents(period, options.client || DEFAULT_CLIENT_ID);
    return Math.round(p.input * number(w.input, 1) + p.cacheRead * number(w.cacheRead, 0.1) + p.cacheWrite * number(w.cacheWrite, 1.25) + p.output * number(w.output, 6));
  }
  function rawTokenProjection({ capacity, remainingPercent, reservePercent = 0, components, weights } = {}) {
    const p = components && typeof components === 'object' ? components : {};
    const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
    const rawTotal = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + Math.max(0, number(p[key])), 0);
    const weightedTotal = Math.max(0, number(p.input)) * number(w.input, 1)
      + Math.max(0, number(p.cacheRead)) * number(w.cacheRead, 0.1)
      + Math.max(0, number(p.cacheWrite)) * number(w.cacheWrite, 1.25)
      + Math.max(0, number(p.output)) * number(w.output, 6);
    const quota = Math.max(0, number(capacity));
    const pct = Math.max(0, Math.min(100, number(remainingPercent, NaN)));
    if (!(rawTotal > 0) || !(weightedTotal > 0) || !(quota > 0) || !Number.isFinite(pct)) return null;
    const rawCapacity = Math.round(quota * rawTotal / weightedTotal);
    const reserve = Math.max(0, Math.min(100, number(reservePercent)));
    return {
      capacity: rawCapacity,
      remaining: Math.round(rawCapacity * pct / 100),
      conservativeRemaining: Math.round(rawCapacity * Math.max(0, pct - reserve) / 100),
      cacheHitPercent: Number((Math.max(0, number(p.cacheRead)) / rawTotal * 100).toFixed(1))
    };
  }
  function rawCapacityFromObservations(observations, currentComponents, _options = {}) {
    const list = Array.isArray(observations) ? observations : [];
    const current = currentComponents && typeof currentComponents === 'object' ? currentComponents : {};
    const currentTotal = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + Math.max(0, number(current[key])), 0);
    const currentCacheRatio = currentTotal > 0 ? Math.max(0, number(current.cacheRead)) / currentTotal : null;

    // A quota cycle is long (typically a month), so single-refresh percentage
    // movements are tiny and cache-noise-dominated. Differencing adjacent points
    // therefore accumulates samples far too slowly and is easily dragged down by
    // one cache-heavy refresh. Instead we anchor on whole-cycle totals:
    //   capacity = cycleTokens × 100 / cycleUsedPercent
    // which uses only the first/last observation of each closed cycle (the two
    // most reliable points) and is updated only on reset — long cycles make it
    // steadier, not noisier.
    const cycles = cycleSummaries(list);
    const closedCapacities = [];
    for (const cycle of cycles) {
      if (cycle.current || cycle.partial) continue;
      if (!(cycle.usedPercent > 0) || !(cycle.rawTokens > 0)) continue;
      const mixAdjustment = 1; // closed cycles already wait for their own mix; no cross-mix squeeze
      closedCapacities.push(cycle.rawTokens * 100 / cycle.usedPercent * mixAdjustment);
    }

    // The active cycle contributes a cumulative ratio (total tokens consumed so
    // far over the percentage burned so far). This is the only live signal while
    // the first cycle is still open, and it adapts immediately to an official
    // quota shrink/expand within the current cycle.
    const currentCycle = cycles.at(-1);
    const currentCumulativeCapacity = currentCycle && currentCycle.usedPercent > 0 && currentCycle.rawTokens > 0
      ? currentCycle.rawTokens * 100 / currentCycle.usedPercent
      : 0;

    // Hard floor invariant: capacity can never be less than what the current
    // cycle's observed consumption already implies — otherwise "remaining"
    // arithmetic would claim the account has fewer tokens than it already spent.
    const observedCapacityFloor = currentCumulativeCapacity > 0
      ? currentCumulativeCapacity
      : 0;

    const wq = (values) => {
      // Weighted-ish upper-middle quantile: sort, then take the element just below
      // the maximum decile to avoid a single inflated/rounded percentage edge
      // while still preferring the upper envelope (remote use only lowers a
      // sample, so high quantiles are the honest estimate).
      if (!values.length) return null;
      const s = values.slice().sort((a, b) => a - b);
      const index = s.length < 3 ? s.length - 1 : Math.floor((s.length - 1) * 0.8);
      return s[index];
    };

    let capacity;
    let sourceKind;
    if (closedCapacities.length) {
      const historical = wq(closedCapacities) || closedCapacities[closedCapacities.length - 1];
      if (currentCumulativeCapacity > 0) {
        // Adapt to an official quota change within the current cycle: if the live
        // cumulative ratio diverges sharply from history, weight the live signal
        // strongly; otherwise blend toward the stable historical anchor.
        const divergence = historical > 0 ? Math.abs(currentCumulativeCapacity - historical) / historical : 1;
        const liveWeight = Math.min(1, Math.max(0.35, divergence * 2));
        capacity = historical * (1 - liveWeight) + currentCumulativeCapacity * liveWeight;
        sourceKind = 'hybrid';
      } else {
        capacity = historical;
        sourceKind = 'historical';
      }
    } else if (currentCumulativeCapacity > 0) {
      // No closed cycle yet: fall back to the cumulative extrapolation (honest,
      // labelled cumulative in the caller) rather than inventing a median.
      capacity = currentCumulativeCapacity;
      sourceKind = 'cumulative';
    } else {
      return null;
    }

    capacity = Math.max(capacity, observedCapacityFloor);

    const windowCount = cycles.length;
    const totalSamples = list.length;
    const confidence = closedCapacities.length >= 3 ? 'high' : closedCapacities.length >= 1 ? 'medium' : 'low';
    return {
      capacity: Math.round(capacity),
      samples: closedCapacities.length,
      windows: windowCount,
      confidence,
      sourceKind,
      cacheHitPercent: currentCacheRatio === null ? null : Number((currentCacheRatio * 100).toFixed(1)),
      observedCapacityFloor: observedCapacityFloor > 0 ? Math.round(observedCapacityFloor) : 0,
      totalSamples
    };
  }
  function cycleSummaries(observations) {
    const list = Array.isArray(observations) ? observations.filter((item) => item && typeof item === 'object') : [];
    const groups = [];
    let group = [];
    for (const item of list) {
      const previous = group[group.length - 1];
      // A quota reset is signalled by the remaining percentage recovering (the
      // server refills the window). `resetsAt` is deliberately NOT a boundary
      // signal: several providers report a rolling/relative reset timestamp that
      // advances on every refresh, so a strict `resetsAt !==` comparison would
      // shard one continuous cycle into many fake groups (the 8/17 vs 8/14 split
      // the user observed). A percentage rebound above the small-noise threshold
      // is the only reliable reset marker; `resetsAt` stays on the summary purely
      // for display. Known trade-off: a partial top-up (not a full reset) also
      // reads as a boundary here — without a reliable server reset timestamp the
      // two are indistinguishable, and a false boundary only re-anchors that one
      // cycle's anchor rather than corrupting the whole history.
      const boundary = previous && number(item.remainingPercent) > number(previous.remainingPercent) + 1;
      if (boundary) { groups.push(group); group = []; }
      group.push(item);
    }
    if (group.length) groups.push(group);
    return groups.map((items, index) => {
      const first = items[0]; const last = items[items.length - 1];
      const delta = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      for (let itemIndex = 1; itemIndex < items.length; itemIndex += 1) {
        const before = items[itemIndex - 1]; const after = items[itemIndex];
        const interval = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, number(after.components?.[key]) - number(before.components?.[key])]));
        if (Object.values(interval).some((value) => value < 0)) continue;
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) delta[key] += interval[key];
      }
      const rawTokens = delta.input + delta.cacheRead + delta.cacheWrite + delta.output;
      return {
        key: `${first.at || ''}|${last.resetsAt || ''}`,
        startedAt: first.at || null,
        endedAt: last.at || null,
        resetsAt: last.resetsAt || null,
        startRemainingPercent: number(first.remainingPercent, null),
        endRemainingPercent: number(last.remainingPercent, null),
        usedPercent: Math.max(0, number(first.remainingPercent) - number(last.remainingPercent)),
        rawTokens: Math.round(rawTokens),
        components: delta,
        observations: items.length,
        partial: number(first.remainingPercent) < 99,
        current: index === groups.length - 1
      };
    });
  }
  function estimate({ provider, period, capacity, reservePercent = 0, weights } = {}) {
    const windows = Array.isArray(provider?.windows) ? provider.windows : [];
    const window = windows.find((x) => x?.kind === 'weekly' && Number.isFinite(Number(x?.remainingPercent))) || windows.find((x) => Number.isFinite(Number(x?.remainingPercent))) || null;
    const quota = Math.max(0, number(capacity)); const pct = window ? Math.max(0, Math.min(100, number(window.remainingPercent))) : null;
    const remaining = quota && pct !== null ? Math.round(quota * pct / 100) : null; const reserve = Math.max(0, Math.min(100, number(reservePercent)));
    return { officialRemainingPercent: pct, windowKind: window?.kind || '', resetsAt: window?.resetsAt || null, localEquivalentUsed: equivalentTokens(period, { weights }), capacity: quota, optimisticRemaining: remaining, conservativeRemaining: remaining === null ? null : Math.max(0, Math.round(remaining - quota * reserve / 100)), confidence: pct === null ? 'local-only' : 'official-percent' };
  }

  function normalizeCalibration(value) {
    const source = value && typeof value === 'object' ? value : {};
    const samples = Array.isArray(source.samples) ? source.samples.map(Number).filter((x) => Number.isFinite(x) && x > 0) : [];
    const observations = Array.isArray(source.observations)
      ? source.observations.filter((x) => x && typeof x === 'object')
      : [];
    return { version: 3, last: source.last && typeof source.last === 'object' ? source.last : null, first: source.first && typeof source.first === 'object' ? source.first : null, samples, observations };
  }

  const SYNC_SAMPLE_LIMIT = 256;
  const SYNC_OBSERVATION_LIMIT = 512;
  function syncObservation(value) {
    if (!value || typeof value !== 'object') return null;
    const remainingPercent = Number(value.remainingPercent);
    const localEquivalent = Number(value.localEquivalent);
    const atMs = Date.parse(value.at || '');
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100
      || !Number.isFinite(localEquivalent) || localEquivalent < 0 || !Number.isFinite(atMs)) return null;
    const components = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, Math.max(0, number(value.components?.[key]))]));
    const resetsAtMs = value.resetsAt ? Date.parse(value.resetsAt) : NaN;
    return {
      remainingPercent,
      localEquivalent,
      components,
      at: new Date(atMs).toISOString(),
      resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null
    };
  }
  function normalizeSyncSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    const accountKey = String(value.accountKey || '').trim().slice(0, 256);
    const updatedAtMs = Date.parse(value.updatedAt || '');
    if (!accountKey || !Number.isFinite(updatedAtMs)) return null;
    const source = normalizeCalibration(value.calibration);
    const observations = source.observations.map(syncObservation).filter(Boolean).slice(-SYNC_OBSERVATION_LIMIT);
    const samples = source.samples.slice(-SYNC_SAMPLE_LIMIT);
    const last = syncObservation(source.last) || observations.at(-1) || null;
    const first = syncObservation(source.first) || observations[0] || null;
    if (!last || observations.length === 0) return null;
    const weights = Object.fromEntries(Object.entries({ ...DEFAULT_WEIGHTS, ...(value.weights || {}) }).map(([key, fallback]) => [key, Math.max(0, number(value.weights?.[key], fallback))]));
    return {
      version: 1,
      accountKey,
      updatedAt: new Date(updatedAtMs).toISOString(),
      capacity: Math.max(0, number(value.capacity)),
      reservePercent: Math.max(0, Math.min(100, number(value.reservePercent))),
      weights,
      calibration: { version: 3, last, first, samples, observations }
    };
  }
  function selectSyncSnapshot(devices, provider) {
    const accountKey = String(provider?.accountKey || '').trim();
    const sourceDeviceId = String(provider?.sourceDeviceId || '').trim();
    const candidates = (Array.isArray(devices) ? devices : []).map((device) => ({
      deviceId: String(device?.deviceId || ''),
      snapshot: normalizeSyncSnapshot(device?.quotaTokenEstimate)
    })).filter((item) => item.snapshot && (
      (sourceDeviceId && item.deviceId === sourceDeviceId)
      || (accountKey && item.snapshot.accountKey === accountKey)
    ));
    candidates.sort((a, b) => Number(b.deviceId === sourceDeviceId) - Number(a.deviceId === sourceDeviceId)
      || Date.parse(b.snapshot.updatedAt) - Date.parse(a.snapshot.updatedAt)
      || b.snapshot.calibration.observations.length - a.snapshot.calibration.observations.length
      || a.deviceId.localeCompare(b.deviceId));
    return candidates[0]?.snapshot || null;
  }

  function inferredCapacity(samples) {
    const clean = samples.map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    if (!clean.length) return null;
    // Remote/unobserved use only pushes a sample downward. A high quantile is
    // therefore more useful than the median, while avoiding a single maximum
    // that may be inflated by percentage rounding or delayed provider updates.
    const index = clean.length < 3 ? clean.length - 1 : Math.floor((clean.length - 1) * 0.8);
    return Math.round(clean[index]);
  }

  function advanceCalibration(value, observation) {
    const state = normalizeCalibration(value);
    const pct = Math.max(0, Math.min(100, number(observation?.remainingPercent, NaN)));
    const local = Math.max(0, number(observation?.localEquivalent, NaN));
    const at = new Date(observation?.at || Date.now()).toISOString();
    const resetsAt = observation?.resetsAt || null;
    if (!Number.isFinite(pct) || !Number.isFinite(local)) return { ...state, changed: false, capacity: inferredCapacity(state.samples) };
    const rawComponents = observation?.components && typeof observation.components === 'object' ? observation.components : {};
    const components = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, Math.max(0, number(rawComponents[key]))]));
    const current = { remainingPercent: pct, localEquivalent: local, components, at, resetsAt };
    const last = state.last;
    // A reset is signalled by a percentage rebound (server refill) or a local
    // counter rollback (data archive rebuild). `resetsAt` is not a reset marker:
    // rolling/relative reset timestamps advance on every refresh and would split
    // one continuous cycle into many fake ones. See cycleSummaries for the longer
    // rationale.
    const reset = last && (pct > number(last.remainingPercent) + 1 || local < number(last.localEquivalent));
    if (!last) return { version: 3, last: current, first: current, samples: state.samples, observations: [...state.observations, current], changed: true, capacity: inferredCapacity(state.samples), hoursLeft: null, fit: null };
    if (reset) {
      const observations = [...state.observations, current];
      return { version: 3, last: current, first: current, samples: state.samples, observations, changed: true, capacity: inferredCapacity(state.samples), hoursLeft: null, fit: fitDeductionModel(observations) };
    }
    if (pct === number(last.remainingPercent)) return { ...state, changed: false, capacity: inferredCapacity(state.samples), hoursLeft: projectedHoursLeft(state.first, { ...current, localEquivalent: last.localEquivalent }) };
    const deltaPct = number(last.remainingPercent) - pct;
    const deltaLocal = local - number(last.localEquivalent);
    const samples = [...state.samples];
    // Ignore tiny percentage movements and remote-only movements. The latter
    // still affect the official remaining percentage and time projection, but
    // contain no information about tokens-per-percentage-point.
    if (deltaPct >= 0.2 && deltaLocal >= 100) samples.push(deltaLocal * 100 / deltaPct);
    const observationBase = state.observations.length ? state.observations : [last];
    const next = { version: 3, last: current, first: state.first || current, samples, observations: [...observationBase, current] };
    const fit = fitDeductionModel(next.observations);
    return { ...next, changed: true, capacity: fit?.capacity || inferredCapacity(next.samples), hoursLeft: projectedHoursLeft(next.first, current), fit };
  }

  function projectedHoursLeft(first, current) {
    if (!first || !current) return null;
    const elapsed = (Date.parse(current.at) - Date.parse(first.at)) / 3600000;
    const burned = number(first.remainingPercent) - number(current.remainingPercent);
    return elapsed > 0 && burned > 0 ? Number((number(current.remainingPercent) / (burned / elapsed)).toFixed(1)) : null;
  }

  function intervalRows(observations, priorWeights = DEFAULT_WEIGHTS) {
    const rows = [];
    let remoteOnly = 0;
    for (let i = 1; i < observations.length; i += 1) {
      const before = observations[i - 1]; const after = observations[i];
      // Same rationale as cycleSummaries: a percentage rebound, not a resetsAt
      // string comparison, marks a reset boundary across which intervals must
      // not be differenced.
      if (number(after.remainingPercent) > number(before.remainingPercent)) continue;
      const used = (number(before.remainingPercent) - number(after.remainingPercent)) / 100;
      if (!(used > 0)) continue;
      const x = ['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => Math.max(0, number(after.components?.[key]) - number(before.components?.[key])));
      const local = x.reduce((sum, item) => sum + item, 0);
      if (local < 100) { remoteOnly += 1; continue; }
      const priorEquivalent = x[0] * priorWeights.input + x[1] * priorWeights.cacheRead + x[2] * priorWeights.cacheWrite + x[3] * priorWeights.output;
      rows.push({ x, y: used, priorCapacity: priorEquivalent / used });
    }
    return { rows, remoteOnly };
  }

  function fitDeductionModel(observations, options = {}) {
    const priorWeights = { ...DEFAULT_WEIGHTS, ...(options.priorWeights || {}) };
    const { rows, remoteOnly } = intervalRows(observations || [], priorWeights);
    if (rows.length < 6) return null;
    const ranked = [...rows].sort((a, b) => a.priorCapacity - b.priorCapacity);
    // Mixed remote use lowers implied capacity. Keep the upper-middle envelope,
    // but discard the noisiest maximum decile caused by integer-percent edges.
    const low = Math.floor(ranked.length * 0.4); const high = Math.max(low + 4, Math.ceil(ranked.length * 0.9));
    const kept = ranked.slice(low, high);
    const scales = [0, 1, 2, 3].map((j) => Math.max(1, kept.reduce((sum, row) => sum + row.x[j], 0) / kept.length));
    const baseline = inferredCapacity(kept.map((row) => row.priorCapacity)) || 1;
    const priorZ = scales.map((scale, j) => scale * [priorWeights.input, priorWeights.cacheRead, priorWeights.cacheWrite, priorWeights.output][j] / baseline);
    const z = [...priorZ];
    for (let pass = 0; pass < 400; pass += 1) {
      for (let j = 0; j < 4; j += 1) {
        let numerator = 0; let denominator = 0;
        for (const row of kept) {
          const xs = row.x.map((item, index) => item / scales[index]);
          let other = 0; for (let k = 0; k < 4; k += 1) if (k !== j) other += xs[k] * z[k];
          numerator += xs[j] * (row.y - other); denominator += xs[j] * xs[j];
        }
        const ridge = denominator * 0.03;
        z[j] = Math.max(0, (numerator + ridge * priorZ[j]) / Math.max(1e-18, denominator + ridge));
      }
    }
    const beta = z.map((item, j) => item / scales[j]);
    if (!(beta[0] > 0)) return null;
    const capacity = 1 / beta[0];
    const bounds = [1, 2, 4, 20];
    const weights = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key, j) => [key, Number(Math.max(0, Math.min(bounds[j], beta[j] / beta[0])).toFixed(4))]));
    const errors = kept.map((row) => Math.abs(row.x.reduce((sum, item, j) => sum + item * beta[j], 0) - row.y) / row.y);
    const meanErrorPercent = Number((errors.reduce((a, b) => a + b, 0) / errors.length * 100).toFixed(2));
    return { capacity: Math.round(capacity), weights, intervals: rows.length, retainedIntervals: kept.length, remoteOrOutlierIntervals: remoteOnly + rows.length - kept.length, meanErrorPercent, confidence: rows.length >= 25 && meanErrorPercent < 15 ? 'high' : rows.length >= 12 && meanErrorPercent < 25 ? 'medium' : 'low' };
  }

  return { DEFAULT_CLIENT_ID, DEFAULT_WEIGHTS, clientComponents, equivalentTokens, rawTokenProjection, rawCapacityFromObservations, cycleSummaries, estimate, normalizeCalibration, normalizeSyncSnapshot, selectSyncSnapshot, inferredCapacity, advanceCalibration, projectedHoursLeft, intervalRows, fitDeductionModel };
});
