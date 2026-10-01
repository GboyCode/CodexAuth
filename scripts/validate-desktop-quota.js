const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { quotaFromDesktopUsage, createDesktopQuotaReader } = require("../src/quota/desktop-quota");

const NOW = 1800000000000;
const stamp = (n = 0) => new Date(NOW + n).toISOString();
const scope = { hasCurrentAuth: true, accountId: "saved-plus", since: stamp(-60000),
  account: { userId: "plus-workspace", chatgptUserId: "plus-user" }, accountPlanType: "plus" };
const bucket = (used = 100) => ({ limitId: "codex", planType: "plus",
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
  secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 } });
const usage = (used) => ({ accountId: "plus-workspace", rateLimitsByLimitId: { codex: bucket(used) },
  rateLimitResetCredits: { availableCount: 0 } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };

async function validateReader() {
  const parsed = quotaFromDesktopUsage(usage(), scope, stamp());
  assert.equal(parsed.session.usedPercent, 100);
  assert.equal(parsed.weekly.usedPercent, 16);
  assert.equal(parsed.source, "local-desktop");
  assert.equal(parsed.resetCredits.availableCount, 0);
  assert.equal(quotaFromDesktopUsage({ ...usage(), accountId: "team-workspace" }, scope, stamp()), null);
  assert.equal(quotaFromDesktopUsage({ ...usage(), rateLimitsByLimitId: { codex: { ...bucket(), planType: "business" } } }, scope, stamp()), null);
  assert.equal(quotaFromDesktopUsage(usage(), { ...scope, hasCurrentAuth: false }, stamp()), null);
  const legacy = quotaFromDesktopUsage({ accountId: "plus-workspace", rateLimits: bucket(33) }, scope, stamp());
  assert.equal(legacy.session.usedPercent, 33);
  const weekly = quotaFromDesktopUsage({ accountId: "plus-workspace", rateLimits: { ...bucket(),
    planType: "team", primary: { usedPercent: 10, windowDurationMins: 10080 }, secondary: null } },
    { ...scope, accountPlanType: "business" }, stamp());
  assert.equal(weekly.session, null);
  assert.equal(weekly.weekly.usedPercent, 10);

  let now = NOW, current = scope, calls = 0, request = deferred();
  const updates = [];
  const reader = createDesktopQuotaReader({ now: () => now, getScope: async () => current,
    getAnchor: async () => "continued-team-thread", readUsage: () => { calls++; return request.promise; },
    onUpdate: async (s, q) => updates.push({ scope: s, quota: q }) });
  assert.equal(reader.read(scope), null, "slow desktop never blocks the caller");
  reader.read(scope); await flush(); assert.equal(calls, 1, "concurrent refreshes share a request");
  request.resolve(usage(33)); await flush();
  assert.equal(reader.read(scope).session.usedPercent, 33);
  now += 29999; reader.read(scope); await flush(); assert.equal(calls, 1);
  now += 1; request = deferred(); reader.read(scope); await flush();
  request.resolve(usage(100)); await flush();
  assert.equal(reader.read(scope).session.usedPercent, 100, "refresh works without any new conversation event");
  assert.equal(updates.length, 2);
  now += 30000; request = deferred(); reader.read(scope); await flush();
  const lastAt = reader.read(scope).checkedAt;
  request.resolve({ ...usage(10), accountId: "wrong-account" }); await flush();
  assert.equal(reader.read(scope).checkedAt, lastAt, "mismatches cannot renew an old timestamp");

  now += 30000; request = deferred(); reader.read(scope); await flush();
  current = { ...scope, since: stamp(100000) };
  reader.read(current); request.resolve(usage(50)); await flush();
  assert.equal(updates.length, 3, "old request is discarded even after switching away and back to the same account");
  assert.equal(updates.at(-1).scope.since, current.since);
  assert.equal(reader.read({ ...scope, hasCurrentAuth: false }), null);

  let failures = 0;
  const unavailable = createDesktopQuotaReader({ now: () => now, getScope: async () => scope,
    getAnchor: async () => "thread", readUsage: async () => { failures++; throw new Error("offline"); },
    onUpdate: () => assert.fail("unavailable desktop must not update") });
  unavailable.read(scope); await flush(); unavailable.read(scope); await flush();
  assert.equal(failures, 1, "failed reads are throttled too");

  let resetClock = NOW, resetCalls = 0;
  const resetting = createDesktopQuotaReader({ now: () => resetClock, getScope: async () => scope,
    getAnchor: async () => "thread", readUsage: async () => {
      resetCalls++;
      const latest = usage(resetCalls === 1 ? 100 : 0);
      latest.rateLimitsByLimitId.codex.primary.resetsAt = NOW / 1000 + (resetCalls === 1 ? 5 : 18005);
      return latest;
    }, onUpdate: () => {} });
  resetting.read(scope); await flush();
  resetClock += 4999; resetting.read(scope); await flush(); assert.equal(resetCalls, 1);
  resetClock += 1; resetting.read(scope); await flush();
  assert.equal(resetCalls, 2, "the first poll at reset refreshes without waiting 30 seconds");
  assert.equal(resetting.read(scope).session.usedPercent, 0);
  assert.equal(resetting.read(scope).session.resetsAt, NOW / 1000 + 18005, "store the actual new reset returned by Codex");
  resetClock += 1; resetting.read(scope); await flush(); assert.equal(resetCalls, 2, "the old reset cannot cause repeated reads");

  current = scope; request = deferred();
  const callsBeforeManual = calls;
  const manual = reader.refresh(scope), shared = reader.refresh(scope);
  await flush(); assert.equal(calls, callsBeforeManual + 1, "manual refresh joins an in-flight query");
  request.resolve(usage(42));
  assert.equal((await manual).session.usedPercent, 42);
  assert.equal((await shared).session.usedPercent, 42);
  request = deferred();
  const forced = reader.refresh(scope);
  await flush(); assert.equal(calls, callsBeforeManual + 2, "manual refresh bypasses the normal throttle");
  request.resolve({ ...usage(20), accountId: "wrong-account" });
  assert.equal(await forced, null, "an old cached snapshot cannot count as a successful refresh");
  assert.equal(reader.read(scope).session.usedPercent, 42);
  request = deferred();
  const switched = reader.refresh(scope);
  await flush(); current = { ...scope, since: stamp(200000) };
  request.resolve(usage(30));
  assert.equal(await switched, null, "a manual refresh crossing an account switch is discarded");
  assert.equal(await unavailable.refresh(scope), null, "failed manual reads do not report stale data as fresh");
}

async function validateManualDispatch() {
  const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
  let currentCalls = 0, standbyCalls = 0, fresh = true;
  const sandbox = vm.createContext({ require: (name) => name === "electron"
    ? { app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => __dirname } }
    : name === "./quota/desktop-quota" ? { quotaFromDesktopUsage, createDesktopQuotaReader: () => ({
      refresh: async () => { currentCalls++; return fresh ? { checkedAt: stamp() } : null; },
    }) } : realRequire(name),
    process, __dirname: path.dirname(filename), console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox);
  sandbox.dashboardScope = async () => scope;
  sandbox.broadcastStateChanged = () => {};
  sandbox.getOnlineAccounts = () => ({ check: async (id, options) => {
    standbyCalls++; assert.equal(id, "standby"); assert.equal(options.force, true);
    return fresh ? { available: false, quota: { weekly: { usedPercent: 100 } } } : { available: null, reason: "offline" };
  } });
  assert.equal((await sandbox.checkAccountQuota(scope.accountId)).refreshed, true);
  assert.equal(standbyCalls, 0, "active account reads must never use standby credentials");
  const exhausted = await sandbox.checkAccountQuota("standby");
  assert.equal(exhausted.refreshed, true, "successfully reading an exhausted account still counts as refreshed");
  assert.equal(exhausted.available, false);
  fresh = false;
  assert.equal((await sandbox.checkAccountQuota(scope.accountId)).refreshed, false);
  assert.equal((await sandbox.checkAccountQuota("standby")).refreshed, false);
  assert.equal(currentCalls, 2); assert.equal(standbyCalls, 2);
  await assert.rejects(sandbox.checkAccountQuota(null), /请选择账号/);
}

async function validateIntegration() {
  const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
  let native = quotaFromDesktopUsage(usage(), scope, stamp()), clock = NOW;
  const sandbox = vm.createContext({ require: (name) => name === "electron"
    ? { app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => __dirname } }
    : name === "./quota/desktop-quota" ? { quotaFromDesktopUsage, createDesktopQuotaReader: () => ({ read: () => native }) } : realRequire(name),
    process, __dirname: path.dirname(filename), console, Buffer, Date: class extends Date { static now() { return clock; } },
    setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox);
  const old = { ...quotaFromDesktopUsage(usage(33), scope, stamp(-120000)), source: "local" };
  sandbox.readLatestLocalQuota = async () => old;
  sandbox.readLatestSqliteRateLimitQuota = async () => null;
  sandbox.readLocalRecords = async () => [];
  sandbox.readLocalResetCredits = async () => null;
  const account = { id: scope.accountId, identity: { planType: "plus" }, lastSwitchedAt: scope.since, quotaSnapshot: old };
  const index = { activeAccountId: scope.accountId, accounts: [account] };
  sandbox.mutateIndex = async (action) => (await action(index))?.value;
  const resolved = await sandbox.resolveQuotaWithMode(scope, []);
  assert.equal(resolved.session.usedPercent, 100, "desktop replaces the stuck 67% remaining snapshot");
  assert.equal(resolved.weekly.usedPercent, 16);
  assert.equal(resolved.estimate.available, false, "do not estimate without matching official samples");
  assert.equal(account.officialQuotaCalibration.latestAt, NOW, "persist the official observation for future correction");
  assert.equal(account.quotaSnapshot.session.usedPercent, 100);
  assert.equal(account.quotaSnapshot.resetCredits.availableCount, 0);
  assert.equal(await sandbox.saveAccountQuotaSnapshot(scope.accountId, old, scope.since), false, "in-flight older log cannot roll back native snapshot");
  account.lastSwitchedAt = stamp(5000);
  assert.equal(await sandbox.saveAccountQuotaSnapshot(scope.accountId, { ...native, checkedAt: stamp(10000) }, scope.since), false);
  old.checkedAt = stamp(15000);
  assert.equal((await sandbox.readBestLocalQuota(scope, [])).source, "local-desktop", "a newer local event cannot replace a fresh official baseline");
  native = { ...native, checkedAt: stamp(-120000) };
  assert.equal((await sandbox.readBestLocalQuota(scope, [])).source, "local", "newer logs take over when native snapshot is stale");
  sandbox.readLatestLocalQuota = async () => ({ ...old, limitId: "base_model_inference", planType: null,
    session: null, weekly: { usedPercent: 4, windowMinutes: 10080 } });
  assert.equal((await sandbox.readBestLocalQuota(scope, [])).session.usedPercent, 100,
    "newer old-team bucket cannot replace the Plus snapshot before any new chat is created");
  sandbox.readLatestLocalQuota = async () => old;
  native = null;
  assert.equal((await sandbox.readBestLocalQuota(scope, [])).session.usedPercent, 33, "unavailable desktop preserves log fallback");

  // The recovery probe must save the exhausted account before switching away.
  account.lastSwitchedAt = scope.since;
  account.quotaSnapshot = null;
  sandbox.dashboardScope = async () => scope;
  sandbox.broadcastStateChanged = () => {};
  const exhausted = usage(100);
  assert.equal(await sandbox.readRecoveryUsage({ readUsage: async () => exhausted }, "old-thread"), exhausted);
  assert.equal(account.quotaSnapshot.session.usedPercent, 100);
  let scopeReads = 0;
  sandbox.dashboardScope = async () => (++scopeReads === 1 ? scope : { ...scope, since: stamp(10000) });
  await sandbox.readRecoveryUsage({ readUsage: async () => usage(25) }, "old-thread");
  assert.equal(account.quotaSnapshot.session.usedPercent, 100, "a recovery response crossing a switch cannot overwrite the snapshot");

  // Exercise persisted official learning through the actual display pipeline.
  account.quotaSnapshot = null; account.officialQuotaCalibration = null;
  const record = { startedAt: stamp(), events: [] };
  sandbox.readLocalRecords = async () => [record];
  const addUsage = (ms, units) => record.events.push({ ms, key: `fixture-${ms}`, model: "model-a", serviceTier: "default",
    rates: [{ limit_id: "codex" }], tokenUsage: { totalTokens: units },
    delta: { totalTokens: units, inputTokens: units * 0.8, outputTokens: units * 0.2, cachedInputTokens: 0 }, intervalStartMs: ms - 5000 });
  for (let i = 0; i <= 3; i++) {
    clock = NOW + i * 30000;
    if (i) addUsage(clock - 5000, 2000);
    native = quotaFromDesktopUsage(usage(20 + i * 2), scope, stamp(i * 30000));
    await sandbox.resolveQuotaWithMode(scope, []);
  }
  clock += 10000; addUsage(clock - 5000, 1000);
  const interim = await sandbox.resolveQuotaWithMode(scope, []);
  assert.equal(interim.session.usedPercent, 26);
  assert.equal(interim.session.estimatedUsedPercent, 27);
  assert.equal(interim.estimate.confidence, "official-calibrated");
  assert.equal(account.quotaSnapshot.session.estimatedUsedPercent, 27, "account cards share the calibrated display");
  record.events.at(-1).intervalStartMs = NOW + 85000;
  const crossed = await sandbox.resolveQuotaWithMode(scope, []);
  assert.equal(crossed.session.estimatedUsedPercent, undefined, "a delta crossing the official reading cannot inflate account cards");
  assert.equal(crossed.session.usedPercent, 26);
  clock += 20000; native = quotaFromDesktopUsage(usage(29), scope, stamp(clock - NOW));
  const correction = await sandbox.resolveQuotaWithMode(scope, []);
  assert.equal(correction.session.usedPercent, 29);
  assert.equal(correction.session.estimatedUsedPercent, undefined, "the next official value corrects the rendered forecast");
  account.lastSwitchedAt = stamp(clock - NOW);
  const unchanged = JSON.stringify(account.officialQuotaCalibration);
  assert.equal(await sandbox.recordOfficialCalibration(scope, native, [record]), null);
  assert.equal(JSON.stringify(account.officialQuotaCalibration), unchanged, "old-account work cannot mutate calibration after switching");
}

(async () => {
  await validateReader(); await validateIntegration(); await validateManualDispatch();
  console.log("Desktop quota validation passed: resumed-thread refresh, account/plan isolation, throttle, nonblocking reads, switch races, persistence and log fallback.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
