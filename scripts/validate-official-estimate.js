// Deterministic simulated official responses and local records only.
const assert = require("node:assert/strict");
const { observeOfficialQuota, estimateOfficialQuota } = require("../src/quota/official-estimate");
const NOW = 1800000000000;
const stamp = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const scope = { accountId: "a", account: { userId: "workspace-a", subject: "person-a" },
  hasCurrentAuth: true, since: stamp(-60), accountPlanType: "plus" };
const quota = (seconds, used) => ({ source: "local-desktop", limitId: "codex", planType: "plus", checkedAt: stamp(seconds),
  session: { usedPercent: used, resetsAt: NOW / 1000 + 18000, windowMinutes: 300 },
  weekly: { usedPercent: used / 2, resetsAt: NOW / 1000 + 604800, windowMinutes: 10080 }, additional: [] });
const event = (seconds, units = 2000, extra = {}) => ({ ms: NOW + seconds * 1000, key: `event-${seconds}`,
  timestamp: stamp(seconds), model: "model-a", serviceTier: "default", rates: [{ limit_id: "codex" }],
  tokenUsage: { totalTokens: units }, delta: { totalTokens: units, inputTokens: units * 0.8, cachedInputTokens: 0, outputTokens: units * 0.2 },
  intervalStartMs: NOW + (seconds - 5) * 1000, ...extra });
const records = (events) => [{ startedAt: stamp(-30), invalidLines: 0, events }];
let history = records([]), calibration = observeOfficialQuota(null, quota(0, 10), history, scope, NOW);
for (let i = 1; i <= 6; i++) {
  history[0].events.push(event(i * 30 - 5));
  calibration = observeOfficialQuota(calibration, quota(i * 30, 10 + 2 * i), history, scope, NOW + i * 30000);
}
const learned = calibration, latest = quota(180, 22);
history[0].events.push(event(190, 1000));
const predicted = estimateOfficialQuota(latest, history, learned, scope, NOW + 195000);
assert.equal(predicted.session.usedPercent, 22, "never overwrite the actual official value");
assert.equal(predicted.session.estimatedUsedPercent, 23);
assert.equal(predicted.session.estimatedRemainingPercent, 77);
assert.equal(predicted.weekly.estimatedUsedPercent, 12);
assert.equal(predicted.estimate.confidence, "official-calibrated");
assert.ok(predicted.session.estimateSamples >= 3);

for (const intervalStartMs of [NOW + 179000, null, undefined, NOW + 191000]) {
  const crossing = records([event(190, 1000, { intervalStartMs })]);
  const result = estimateOfficialQuota(latest, crossing, learned, scope, NOW + 195000);
  assert.equal(result.estimate.available, false, "uncertain or crossing intervals cannot be assigned after the official snapshot");
  assert.equal(result.session.usedPercent, 22);
  const observed = observeOfficialQuota(learned, quota(200, 24), crossing, scope, NOW + 200000);
  assert.deepEqual(observed.groups, learned.groups, "uncertain intervals must not train coefficients either");
}
const onBoundary = records([event(190, 1000, { intervalStartMs: NOW + 180000 })]);
assert.equal(estimateOfficialQuota(latest, onBoundary, learned, scope, NOW + 195000).session.estimatedUsedPercent, 23,
  "an increment beginning exactly at the snapshot belongs to the new interval");
const firstAfterSnapshot = [{ startedAt: stamp(185), events: [event(190, 1000, { firstUsage: true, intervalStartMs: null })] }];
assert.equal(estimateOfficialQuota(latest, firstAfterSnapshot, learned, scope, NOW + 195000).session.estimatedUsedPercent, 23,
  "a new session beginning after the snapshot supplies the first increment boundary");
const legacy = { ...learned, version: 1 };
assert.equal(estimateOfficialQuota(latest, history, legacy, scope, NOW + 195000).estimate.available, false,
  "previous algorithm samples may include crossing deltas and must not be reused");
assert.equal(Object.keys(observeOfficialQuota(legacy, latest, history, scope, NOW + 195000).groups).length, 0);

const corrected = quota(200, 24);
calibration = observeOfficialQuota(learned, corrected, history, scope, NOW + 200000);
const afterCorrection = estimateOfficialQuota(corrected, history, calibration, scope, NOW + 200000);
assert.equal(afterCorrection.session.usedPercent, 24);
assert.equal(afterCorrection.session.estimatedUsedPercent, undefined, "new official data replaces the earlier prediction");
assert.equal(observeOfficialQuota(calibration, corrected, history, scope, NOW + 200000), calibration, "same response cannot train twice");
assert.equal(observeOfficialQuota(calibration, latest, history, scope, NOW + 200000), calibration, "late old responses cannot roll calibration back");
assert.equal(estimateOfficialQuota(latest, history, learned, scope, NOW + 301000).estimate.available, false, "stale official data must not produce open-ended estimates");
const localOnly = { ...latest, source: "local" };
assert.equal(observeOfficialQuota(learned, localOnly, history, scope, NOW + 200000), learned);

const first = observeOfficialQuota(null, quota(0, 10), [], scope, NOW);
const one = observeOfficialQuota(first, quota(30, 12), records([event(25)]), scope, NOW + 30000);
assert.equal(estimateOfficialQuota(quota(30, 12), records([event(40, 1000)]), one, scope, NOW + 45000).estimate.available, false, "one sample cannot imply precision");
const mixed = records([event(10, 1000), event(20, 1000, { model: "model-b" })]);
const mixedResult = observeOfficialQuota(first, quota(30, 12), mixed, scope, NOW + 30000);
assert.equal(Object.keys(mixedResult.groups).length, 0, "mixed models cannot train a single coefficient");
for (const changed of [{ model: "other" }, { serviceTier: "priority" }, { rates: [{ limit_id: "other-pool" }] }]) {
  assert.equal(estimateOfficialQuota(latest, records([event(190, 1000, changed)]), learned, scope, NOW + 195000).estimate.available, false);
}
const otherAccount = { ...scope, accountId: "b" };
assert.equal(estimateOfficialQuota(latest, history, learned, otherAccount, NOW + 195000).estimate.available, false);
const switched = { ...scope, since: stamp(185) };
assert.equal(estimateOfficialQuota(latest, history, learned, switched, NOW + 195000).estimate.available, false);
const newEpoch = observeOfficialQuota(learned, quota(190, 22), records([]), switched, NOW + 190000);
assert.ok(Object.keys(newEpoch.groups).length, "same-account history remains useful after returning, without joining intervals");
assert.equal(Object.values(newEpoch.anchors)[0].at, NOW + 190000);
const newPlan = { ...latest, planType: "business" };
assert.equal(Object.keys(observeOfficialQuota(learned, newPlan, history, scope, NOW + 195000).groups).length, 0, "changed plans cannot reuse old cost samples");
const reset = quota(210, 0); reset.session.resetsAt += 18000;
const resetState = observeOfficialQuota(learned, reset, history, scope, NOW + 210000);
assert.equal(resetState.groups[Object.keys(learned.groups)[0]].length, learned.groups[Object.keys(learned.groups)[0]].length);
assert.equal(Object.values(resetState.anchors)[0].usedPercent, 0);

for (const broken of [{ counterReset: true }, { missingBaseline: true }, { intervalStartMs: NOW - 120000 },
  { firstUsage: true }, { rates: [] }, { serviceTier: "unknown" }]) {
  const data = records([event(190, 1000, broken)]);
  assert.equal(estimateOfficialQuota(latest, data, learned, scope, NOW + 195000).estimate.available, false);
  assert.equal(Object.keys(observeOfficialQuota(first, quota(200, 12), data, scope, NOW + 200000).groups).length, 0);
}
const incomplete = records([event(190, 1000)]); incomplete.complete = false;
assert.equal(estimateOfficialQuota(latest, incomplete, learned, scope, NOW + 195000).estimate.available, false);
const copied = [...history, history[0]];
assert.equal(estimateOfficialQuota(latest, copied, learned, scope, NOW + 195000).session.estimatedUsedPercent, 23, "copied events must not double-count prediction");
assert.equal(estimateOfficialQuota(latest, records([event(190, 20000)]), learned, scope, NOW + 195000).estimate.available, false, "large unconfirmed changes are left to the service");
const cacheHeavy = event(190, 1000, { delta: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 800, outputTokens: 200 } });
assert.equal(estimateOfficialQuota(latest, records([cacheHeavy]), learned, scope, NOW + 195000).estimate.available, false, "a different cache mix needs its own matching observations");
const noisy = JSON.parse(JSON.stringify(learned));
for (const samples of Object.values(noisy.groups)) samples.forEach((sample, i) => { sample.coefficient *= i % 2 ? 10 : 1; });
assert.equal(estimateOfficialQuota(latest, history, noisy, scope, NOW + 195000).estimate.available, false, "unstable official/local relationships do not train a confident estimate");
const unrecorded = [{ id: "thread-a", startedAt: stamp(-30), events: [] }];
let unrecordedState = observeOfficialQuota(null, quota(0, 10), unrecorded, scope, NOW);
for (let i = 1; i <= 6; i++) {
  unrecorded[0].events.push(event(i * 30 - 5, 2000, { serviceTier: "unknown", turnId: "turn-a" }));
  unrecordedState = observeOfficialQuota(unrecordedState, quota(i * 30, 10 + i * 2), unrecorded, scope, NOW + i * 30000);
}
unrecorded[0].events.push(event(190, 1000, { serviceTier: "unknown", turnId: "turn-a" }));
assert.equal(estimateOfficialQuota(latest, unrecorded, unrecordedState, scope, NOW + 195000).session.estimatedUsedPercent, 23);
unrecorded[0].events.at(-1).turnId = "turn-b";
assert.equal(estimateOfficialQuota(latest, unrecorded, unrecordedState, scope, NOW + 195000).estimate.available, false,
  "unrecorded speed settings must not carry samples into another turn");
unrecorded[0].events.at(-1).turnId = "turn-a"; unrecorded[0].id = "thread-b";
assert.equal(estimateOfficialQuota(latest, unrecorded, unrecordedState, scope, NOW + 195000).estimate.available, false,
  "unrecorded settings must not carry samples into another thread");
console.log("Official calibration passed: observed correction, per-account/model/tier/pool isolation, rounded samples, deduplication, reset/switch boundaries, missing logs and conservative predictions.");
