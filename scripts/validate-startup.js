const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const filename = path.resolve(__dirname, "../src/main.js");
const realRequire = createRequire(filename);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function scenario(target, fail = false) {
  const events = new Map(), handlers = new Map(), windows = [], results = [];
  const onlineChecks = [], intervals = new Set();
  let failOnlineShutdown = false, onlineResumes = 0;
  const online = {
    check: async (id, options) => { onlineChecks.push({ id, force: options?.force }); return { quota: {}, available: true }; },
    flushPending: async () => {},
    shutdown: async () => { if (failOnlineShutdown) throw new Error("fixture storage failure"); },
    resume: () => { onlineResumes++; },
  };
  let ready, finishMetadata, quit = false, errorShown = false;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const metadata = new Promise((resolve) => { finishMetadata = resolve; });
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => readyPromise,
      on: (name, fn) => events.set(name, fn), setName() {}, setAppUserModelId() {},
      quit: () => { quit = true; } },
    Menu: { setApplicationMenu() {} },
    ipcMain: { handle: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); } },
    dialog: { showErrorBox: () => { errorShown = true; } },
  };
  const context = vm.createContext({ require: (name) => name === "electron" ? electron
    : name === "./quota/online-accounts" ? { ...realRequire(name), createOnlineAccounts: () => online } : realRequire(name),
    __dirname: path.dirname(filename), process, Buffer, console: { error() {} }, setTimeout, clearTimeout,
    setInterval: (callback) => { const timer = { callback, unref() {} }; intervals.add(timer); return timer; },
    clearInterval: (timer) => intervals.delete(timer) });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context);
  assert.equal(context.normalizeSettings({ autoResetBusiness: true }).autoResetOnWeeklyLimit, false,
    "legacy Team-only opt-in must not silently authorize Plus resets");
  assert.equal(context.normalizeSettings({ autoResetOnWeeklyLimit: true }).autoResetOnWeeklyLimit, true);
  for (const name of ["ensureStoreDirs", "cleanupLoginSessions", "recoverStoreIfNeeded", "ensureCodexFileCredentialStore", "migratePlaintextBackups",
    "cleanupStoreArtifacts", "cleanupMismatchedQuotaSnapshots", "startAuthWatcher", "startLocalLogWatcher", "startSessionsWatcher", "startSessionsPolling", "startAutoRecovery"])
    context[name] = async () => {};
  context.syncLaunchAtLoginFromSettings = async () => ({});
  context.hydrateStoredAccountMetadata = async () => { await metadata; if (fail) throw new Error("fixture startup failure"); };
  context.installNetworkGuards = () => {};
  context.createTray = () => {};
  context.shouldStartWithWidgetOnly = () => false;
  context.currentState = async () => ({ accounts: [1, 2, 3, 4, 5] });
  context.readIndex = async () => ({ activeAccountId: "active", accounts: [{ id: "active" }, { id: "standby" }] });
  context.dashboardScope = async () => ({ hasCurrentAuth: false });
  context.broadcastStateChanged = () => {};
  const open = (type) => {
    assert.ok(handlers.has("state:get"), "a window must never precede IPC registration");
    windows.push(type); results.push(handlers.get("state:get")());
  };
  context.createWindow = () => open("main");
  context.showMainWindow = () => open("main");
  context.showWidgetWindow = () => open("widget");
  const argv = target === "widget" ? ["app", "--codexauth-startup"] : ["app"];
  events.get("second-instance")({}, argv);
  assert.equal(windows.length, 0, "launch before Electron ready is queued");
  ready(); await tick();
  events.get("second-instance")({}, argv);
  assert.equal(windows.length, 0, "launch during slow credential hydration is queued");
  finishMetadata(); await tick(); await tick();
  if (fail) {
    assert.equal(windows.length, 0); assert.equal(quit, true); assert.equal(errorShown, true);
  } else {
    assert.deepEqual(windows, [target]);
    assert.equal((await results[0]).accounts.length, 5);
    events.get("second-instance")({}, argv);
    assert.deepEqual(windows, [target, target]);
    assert.equal(errorShown, false);
    for (const timer of intervals) await timer.callback();
    await tick();
    assert.equal(onlineChecks.length, 0, "launching and leaving the switcher idle must not query or renew standby accounts");
    const manual = await handlers.get("account:check-quota")({}, "standby");
    assert.equal(manual.refreshed, true, "manual refresh remains available without a running Codex");
    assert.deepEqual(onlineChecks, [{ id: "standby", force: true }]);
    failOnlineShutdown = true;
    events.get("before-quit")({ preventDefault() {} });
    await tick(); await tick();
    assert.equal(quit, false); assert.equal(errorShown, true); assert.equal(onlineResumes, 1);
    for (const timer of intervals) await timer.callback();
    await tick();
    assert.equal(onlineChecks.length, 1, "recovering from a failed credential save must not start background quota queries");
    failOnlineShutdown = false; errorShown = false;
    let finishLogin, busy = true, shutdowns = 0, prevented = 0;
    context.loginFixture = {
      isBusy: () => busy,
      shutdown: () => { shutdowns++; return new Promise((resolve) => { finishLogin = () => { busy = false; resolve(); }; }); },
    };
    vm.runInContext("accountLogin = loginFixture", context);
    events.get("before-quit")({ preventDefault: () => prevented++ });
    events.get("before-quit")({ preventDefault: () => prevented++ });
    assert.equal(prevented, 2, "repeated quit must wait for temporary-login cleanup");
    assert.equal(shutdowns, 1); assert.equal(quit, false);
    finishLogin(); await tick();
    assert.equal(quit, true);
  }
}

(async () => {
  await scenario("main"); await scenario("widget"); await scenario("main", true);
  console.log("Startup validation passed: launch ordering, initialization failure, no background quota queries, manual refresh and safe exit recovery.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
