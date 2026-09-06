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
  const context = vm.createContext({ require: (name) => name === "electron" ? electron : realRequire(name),
    __dirname: path.dirname(filename), process, Buffer, console: { error() {} }, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context);
  for (const name of ["ensureStoreDirs", "recoverStoreIfNeeded", "ensureCodexFileCredentialStore", "migratePlaintextBackups",
    "cleanupStoreArtifacts", "cleanupMismatchedQuotaSnapshots", "startAuthWatcher", "startLocalLogWatcher", "startSessionsWatcher", "startSessionsPolling"])
    context[name] = async () => {};
  context.syncLaunchAtLoginFromSettings = async () => ({});
  context.hydrateStoredAccountMetadata = async () => { await metadata; if (fail) throw new Error("fixture startup failure"); };
  context.installNetworkGuards = () => {};
  context.createTray = () => {};
  context.shouldStartWithWidgetOnly = () => false;
  context.currentState = async () => ({ accounts: [1, 2, 3, 4, 5] });
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
  }
}

(async () => {
  await scenario("main"); await scenario("widget"); await scenario("main", true);
  console.log("Startup validation passed: early/repeated launch, delayed initialization, IPC-before-window ordering and startup failure.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
