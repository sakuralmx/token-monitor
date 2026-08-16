'use strict';
(function init(root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.quotaTokenEstimate = api; })(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_WEIGHTS = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 });
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  function clientComponents(period, client = 'codex') {
    const total = Math.max(0, number(period?.clients?.[client]));
    const cacheRead = Math.min(total, Math.max(0, number(period?.clientCacheReads?.[client])));
    const cacheWrite = Math.min(total - cacheRead, Math.max(0, number(period?.clientCacheWrites?.[client])));
    const output = Math.min(total - cacheRead - cacheWrite, Math.max(0, number(period?.clientOutputs?.[client])));
    return { input: Math.max(0, total - cacheRead - cacheWrite - output), cacheRead, cacheWrite, output, total };
  }
  function equivalentTokens(period, options = {}) {
    const w = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) }; const p = clientComponents(period, options.client || 'codex');
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
  function rawCapacityFromObservations(observations, currentComponents, options = {}) {
    const list = Array.isArray(observations) ? observations : [];
    const current = currentComponents && typeof currentComponents === 'object' ? currentComponents : {};
    const currentTotal = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + Math.max(0, number(current[key])), 0);
    const currentCacheRatio = currentTotal > 0 ? Math.max(0, number(current.cacheRead)) / currentTotal : null;
    const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    const currentWeighted = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + Math.max(0, number(current[key])) * number(weights[key], 1), 0);
    const currentAverageWeight = currentTotal > 0 ? currentWeighted / currentTotal : null;
    const samples = [];
    const windows = new Set();
    for (let i = 1; i < list.length; i += 1) {
      const before = list[i - 1]; const after = list[i];
      if (!before?.components || !after?.components) continue;
      if (before.resetsAt && after.resetsAt && before.resetsAt !== after.resetsAt) continue;
      const deltaPercent = number(before.remainingPercent) - number(after.remainingPercent);
      if (!(deltaPercent > 0)) continue;
      const rawDelta = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((key) => [key, number(after.components[key]) - number(before.components[key])]));
      // A decrease means the local counter changed scope (for example a data
      // archive was rebuilt). Treat it as a boundary instead of fabricating a
      // partial interval from only the components that stayed positive.
      if (Object.values(rawDelta).some((value) => value < 0)) continue;
      const delta = rawDelta;
      const raw = delta.input + delta.cacheRead + delta.cacheWrite + delta.output;
      if (raw < 100) continue;
      const intervalWeighted = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + delta[key] * number(weights[key], 1), 0);
      const intervalAverageWeight = intervalWeighted / raw;
      // Normalize every historical interval to the current usage mix. This lets
      // cache-heavy and cache-light periods contribute without pretending that
      // they have the same raw-token capacity.
      const mixAdjustment = currentAverageWeight > 0 ? intervalAverageWeight / currentAverageWeight : 1;
      samples.push(raw * 100 / deltaPercent * mixAdjustment);
      windows.add(after.resetsAt || before.resetsAt || 'unknown');
    }
    if (!samples.length) return null;
    samples.sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const capacity = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
    const windowCount = windows.size;
    const confidence = windowCount >= 3 && samples.length >= 25 ? 'high' : windowCount >= 2 && samples.length >= 12 ? 'medium' : 'low';
    return { capacity: Math.round(capacity), samples: samples.length, windows: windowCount, confidence, cacheHitPercent: currentCacheRatio === null ? null : Number((currentCacheRatio * 100).toFixed(1)) };
  }
  function cycleSummaries(observations) {
    const list = Array.isArray(observations) ? observations.filter((item) => item && typeof item === 'object') : [];
    const groups = [];
    let group = [];
    for (const item of list) {
      const previous = group[group.length - 1];
      const boundary = previous && (
        (previous.resetsAt && item.resetsAt && previous.resetsAt !== item.resetsAt)
        || number(item.remainingPercent) > number(previous.remainingPercent) + 1
      );
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
    const reset = last && ((last.resetsAt && resetsAt && last.resetsAt !== resetsAt) || pct > number(last.remainingPercent) + 1 || local < number(last.localEquivalent));
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
      if (before.resetsAt && after.resetsAt && before.resetsAt !== after.resetsAt) continue;
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

  return { DEFAULT_WEIGHTS, clientComponents, equivalentTokens, rawTokenProjection, rawCapacityFromObservations, cycleSummaries, estimate, normalizeCalibration, inferredCapacity, advanceCalibration, projectedHoursLeft, intervalRows, fitDeductionModel };
});
