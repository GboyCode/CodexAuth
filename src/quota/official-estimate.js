const { tokenUsageTotal, median, normalizePlanType } = require("./token-math");
const { limitId } = require("./local-records");

const VERSION = 2;
const MAX_SAMPLE_AGE = 7 * 86400000;
const MAX_INTERVAL = 30 * 60000;
const MAX_PREDICTION_AGE = 2 * 60000;
const OFFICIAL_SOURCES = new Set(["local-desktop", "online-account"]);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const buckets = (quota) => [quota, ...(quota?.additional ?? [])].filter(Boolean);
const validWindow = (w, at) => w && finite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
  && finite(w.resetsAt) && w.resetsAt * 1000 > at && finite(w.windowMinutes) && w.windowMinutes > 0;
const sameWindow = (a, b) => a.resetsAt === b.resetsAt && a.windowMinutes === b.windowMinutes;
const scopeKey = (scope, quota) => scope?.hasCurrentAuth && scope.accountId && Number.isFinite(Date.parse(scope.since))
  ? JSON.stringify([scope.accountId, scope.account?.userId, scope.account?.subject, normalizePlanType(quota?.planType ?? scope.accountPlanType)]) : null;
const groupKey = (id, model, tier, kind, minutes) => JSON.stringify([id, model, tier, kind, minutes]);

// Aggregate only observed local increments. Copied/forked events are deduped;
// unknown model, bucket, scope boundary or a missing baseline blocks use.
// An unrecorded speed tier may learn only inside the same thread and turn.
function intervalUsage(records, start, end, id, since) {
  if (records.complete === false || records.some((r) => r.invalidLines > 0)) return null;
  const seen = new Set(), contexts = new Map();
  for (const record of records) for (const event of record.events ?? []) {
    if (!finite(event.ms) || event.ms <= start || event.ms > end || !event.tokenUsage) continue;
    if (event.counterReset || event.missingBaseline) return null;
    const units = event.delta ? tokenUsageTotal(event.delta) : 0;
    if (units <= 0) continue;
    if (!event.key) return null;
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    if (!event.model) return null;
    const tier = event.serviceTier && event.serviceTier !== "unknown" ? event.serviceTier
      : record.id && event.turnId ? `unrecorded:${JSON.stringify([record.id, event.turnId])}` : null;
    if (!tier) return null;
    const ids = new Set((event.rates ?? []).map(limitId));
    if (!ids.size) return null;
    if (!ids.has(id)) continue;
    // The end timestamp alone cannot place a cumulative delta after a snapshot.
    // Reject crossing/unknown intervals rather than counting already observed usage.
    const deltaStart = event.firstUsage ? Date.parse(record.startedAt) : event.intervalStartMs;
    if (!finite(deltaStart) || deltaStart < Math.max(start, since) || deltaStart > event.ms) return null;
    const key = JSON.stringify([event.model, tier]);
    const group = contexts.get(key) ?? { model: event.model, tier, units: 0, input: 0, cached: 0, output: 0 };
    group.units += units;
    group.input += event.delta.inputTokens ?? 0;
    group.cached += event.delta.cachedInputTokens ?? 0;
    group.output += event.delta.outputTokens ?? 0;
    contexts.set(key, group);
  }
  return [...contexts.values()].map((g) => ({ ...g,
    inputShare: g.input / Math.max(1, g.input + g.output), cacheShare: g.cached / Math.max(1, g.input) }));
}

function observeOfficialQuota(previous, quota, records, scope, now = Date.now()) {
  const key = scopeKey(scope, quota), at = Date.parse(quota?.checkedAt), since = Date.parse(scope?.since);
  if (!key || !OFFICIAL_SOURCES.has(quota?.source) || !Number.isFinite(at) || at < since || at > now) return previous ?? null;
  const compatible = previous?.version === VERSION && previous.scopeKey === key;
  const sameEpoch = compatible && previous.since === scope.since;
  if (sameEpoch && at <= previous.latestAt) return previous;
  const groups = Object.fromEntries(Object.entries(compatible ? previous.groups ?? {} : {}).slice(-64)
    .map(([k, samples]) => [k, samples.filter((s) => finite(s.coefficient) && s.coefficient > 0
      && s.ms > now - MAX_SAMPLE_AGE && s.ms <= now).slice(-30)]));
  const next = { version: VERSION, scopeKey: key, since: scope.since, latestAt: at, anchors: {}, groups };
  for (const bucket of buckets(quota).slice(0, 32)) for (const kind of ["session", "weekly"]) {
    const w = bucket[kind], id = bucket.limitId;
    if (!id || !validWindow(w, at)) continue;
    const slot = JSON.stringify([id, kind]);
    const old = sameEpoch ? previous.anchors?.[slot] : null;
    const point = { at, usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowMinutes: w.windowMinutes };
    next.anchors[slot] = point;
    if (!old || !sameWindow(old, w) || at - old.at > MAX_INTERVAL || at <= old.at || w.usedPercent < old.usedPercent) continue;
    const percent = w.usedPercent - old.usedPercent;
    const usage = intervalUsage(records, old.at, at, id, since);
    if (!usage || usage.length > 1) continue; // Never fit one rate to mixed models/tiers.
    if (percent < 2) {
      // Accumulate sub-percent/rounded readings before fitting a coefficient.
      next.anchors[slot] = old;
      continue;
    }
    if (percent > 20 || usage.length !== 1 || usage[0].units < 1000) continue;
    const group = usage[0];
    const sampleKey = groupKey(id, group.model, group.tier, kind, w.windowMinutes);
    const sample = { ms: at, coefficient: percent / group.units, units: group.units, percent,
      inputShare: group.inputShare, cacheShare: group.cacheShare };
    next.groups[sampleKey] = [...(next.groups[sampleKey] ?? []), sample].slice(-30);
  }
  next.groups = Object.fromEntries(Object.entries(next.groups).slice(-64));
  return next;
}

function fittedRate(samples, usage, now) {
  const matching = (samples ?? []).filter((s) => s.ms > now - MAX_SAMPLE_AGE && s.ms <= now
    && finite(s.coefficient) && s.coefficient > 0
    && Math.abs(s.inputShare - usage.inputShare) <= 0.2 && Math.abs(s.cacheShare - usage.cacheShare) <= 0.2);
  if (matching.length < 3) return null;
  const center = median(matching.map((s) => s.coefficient));
  const stable = matching.filter((s) => s.coefficient >= center / 2 && s.coefficient <= center * 2);
  // Unstable or mostly unmatched observations are not evidence of precision.
  if (stable.length < 3 || stable.length < matching.length * 0.75) return null;
  const values = stable.map((s) => s.coefficient);
  if (Math.max(...values) / Math.min(...values) > 2) return null;
  return { coefficient: median(values), samples: stable.length };
}

function withoutEstimate(window) {
  if (!window) return window;
  const result = { ...window };
  for (const key of Object.keys(result)) if (key.startsWith("estimate")) delete result[key];
  return result;
}

function estimateOfficialQuota(quota, records, calibration, scope, now = Date.now()) {
  if (!quota) return quota;
  const key = scopeKey(scope, quota), since = Date.parse(scope?.since), at = Date.parse(quota.checkedAt);
  const eligible = OFFICIAL_SOURCES.has(quota.source) && calibration?.version === VERSION
    && calibration.scopeKey === key && calibration.since === scope.since && calibration.latestAt === at
    && at >= since && at <= now && now - at <= MAX_PREDICTION_AGE;
  const apply = (bucket) => {
    const next = { ...bucket, session: withoutEstimate(bucket.session), weekly: withoutEstimate(bucket.weekly) };
    delete next.estimate;
    let available = false, reason = "等待本账号、模型和速度档的官方校准样本";
    if (!eligible) reason = "等待新的官方快照";
    if (eligible) for (const kind of ["session", "weekly"]) {
      const w = next[kind];
      if (!validWindow(w, now) || w.usedPercent >= 100) continue;
      const usage = intervalUsage(records, at, now, bucket.limitId, since);
      if (!usage) { reason = "本地记录不完整，保留官方值"; continue; }
      if (!usage.length) { reason = "等待官方快照后的本地消耗"; continue; }
      let delta = 0, samples = Infinity, units = 0, supported = true;
      for (const group of usage) {
        const fit = fittedRate(calibration.groups[groupKey(bucket.limitId, group.model, group.tier, kind, w.windowMinutes)], group, now);
        if (!fit) { supported = false; break; }
        delta += fit.coefficient * group.units; units += group.units; samples = Math.min(samples, fit.samples);
      }
      if (!supported) continue;
      if (delta > 5) { reason = "消耗变化较大，等待官方确认"; continue; }
      if (delta < 0.25) continue;
      const used = Math.min(100, w.usedPercent + delta);
      next[kind] = { ...w, estimatedUsedPercent: Math.ceil(used), estimatedRemainingPercent: Math.floor(100 - used),
        estimatedDeltaPercent: Math.round((used - w.usedPercent) * 10) / 10,
        estimatedWeightedTokens: units, estimateSamples: samples };
      available = true;
    }
    next.estimate = { source: "official-calibrated", algorithm: 4, available, confidence: "official-calibrated",
      reason: available ? null : reason };
    return next;
  };
  const { additional, ...main } = quota;
  return { ...apply(main), additional: (additional ?? []).map(apply) };
}

module.exports = { observeOfficialQuota, estimateOfficialQuota, intervalUsage, OFFICIAL_SOURCES, VERSION };
