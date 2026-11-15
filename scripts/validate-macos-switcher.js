const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { createMacTrayPanel, panelBounds } = require("../src/mac-tray-panel");

async function run() {
  const filename = path.resolve(__dirname, "../src/main.js");
  const realRequire = createRequire(filename);
  const unexpected = () => { throw new Error("macOS switcher must not scan usage or create a desktop widget"); };
  const handlers = new Map();
  let template = false;
  const context = vm.createContext({
    require: name => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getVersion: () => "test" },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      nativeImage: { createFromPath: file => { assert.match(file, /codex-trayTemplate\.png$/); return { setTemplateImage: value => { template = value; } }; } },
      BrowserWindow: unexpected,
    } : name === "node:fs/promises" ? { readFile: async file => { assert.match(file, /config\.toml$/); return ""; } }
      : name === "node:fs" ? { watch: unexpected } : realRequire(name),
    __dirname: path.dirname(filename), process: { ...process, platform: "darwin", env: {} },
    Buffer, console, setTimeout: unexpected, setInterval: unexpected, clearTimeout() {}, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context);
  context.getSubscriptions = unexpected;
  context.getOnlineAccounts = unexpected;
  context.walkSessionFiles = unexpected;
  context.trayIcon();
  assert.equal(template, true, "menu bar uses native adaptive template rendering");
  for (const name of ["startLocalLogWatcher", "startSessionsWatcher", "startSessionsPolling", "startSubscriptionPolling", "scheduleLocalLogRefresh", "startAutoRecovery"]) await context[name]();
  const diagnostics = await context.localDiagnostics({ accounts: [] }, null);
  assert.equal(diagnostics.sessionFiles, 0);
  const identity = { userId: "account", subject: "user", planType: "plus" };
  let scope = { hasCurrentAuth: true, accountId: "account", account: identity, accountPlanType: "plus", since: "2026-11-15T00:00:00Z" };
  const quota = { source: "local", checkedAt: "2026-11-15T01:00:00Z", planType: "plus", session: { usedPercent: 20 }, weekly: { usedPercent: 40 } };
  let quotaReads = 0, saved = 0, onlineReads = 0;
  context.dashboardScope = async () => scope;
  context.readLatestSqliteRateLimitQuota = async () => { quotaReads++; return quota; };
  context.readLatestLocalQuota = unexpected;
  context.readLocalRecords = unexpected;
  context.saveAccountQuotaSnapshot = async () => { saved++; };
  assert.equal((await context.getQuota()).quota.session.usedPercent, 20);
  await context.getQuota();
  assert.equal(quotaReads, 1, "repeated view requests reuse quota snapshots for 60 seconds");
  await context.getQuota({ force: true });
  assert.equal(quotaReads, 2, "manual refresh bypasses the quota cache");
  assert.equal(saved, 2);
  assert.equal((await context.getDashboard()).usage.available, false);
  context.readIndex = async () => ({ activeAccountId: "account", accounts: [{ id: "account", identity, quotaSnapshot: quota }] });
  context.readCurrentAuth = async () => ({ identity });
  assert.equal((await context.getAllAccountsQuotaSummary()).accounts.length, 1);
  assert.equal((await context.readLocalUsage()).available, false);
  context.broadcastStateChanged = () => {};
  assert.equal((await context.checkAccountQuota("account")).refreshed, true);
  context.getOnlineAccounts = () => ({ check: async id => { assert.equal(id, "standby"); onlineReads++; return { quota, available: true }; } });
  context.getSubscriptions = () => ({ check: async () => {} });
  assert.equal((await context.checkAccountQuota("standby")).refreshed, true);
  assert.equal(onlineReads, 1, "standby quota refresh remains available");
  context.readLatestSqliteRateLimitQuota = async () => null;
  context.walkSessionFiles = async () => Array.from({ length: 12 }, (_, i) => ({ path: `fixture-${i}` }));
  context.readLatestLocalQuota = async options => { assert.equal(options.files.length, 5); return quota; };
  await context.getQuota({ force: true });
  scope = { ...scope, accountId: "other-account" };
  context.readLatestSqliteRateLimitQuota = async () => { quotaReads++; return quota; };
  const beforeSwitch = quotaReads;
  await context.getQuota();
  assert.equal(quotaReads, beforeSwitch + 1, "switching account cannot reuse the previous account's cached response");
  assert.throws(() => context.createWidgetWindow(), /menu bar/);
  context.registerIpc();
  assert.equal((await handlers.get("dashboard:all-usage")()).available, false);

  let anchor = { x: 980, y: 0, width: 24, height: 24 };
  let point = { x: 200, y: 200 };
  let window;
  let windowCount = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); window = this; windowCount++; this.options = options; this.visible = false; this.webContents = { send() {} }; }
    isDestroyed() { return false; }
    loadFile(file) { assert.match(file, /mac-tray\.html$/); return Promise.resolve(); }
    setBounds(value) { this.bounds = value; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
  }
  const workArea = { x: 0, y: 24, width: 1024, height: 744 };
  const panel = createMacTrayPanel({ BrowserWindow: Window,
    screen: { getCursorScreenPoint: () => point, getDisplayMatching: () => ({ workArea }) },
    tray: { getBounds: () => anchor }, hardenWindow: win => { win.hardened = true; } });
  await panel.show();
  assert.equal(window.visible, true);
  assert.equal(window.hardened, true);
  assert.equal(window.options.movable, false);
  assert.equal(window.options.resizable, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.bounds.x + window.bounds.width, 1024, "panel stays on screen at the right edge");
  assert.equal(window.bounds.y, 30, "panel is anchored beneath the menu bar");
  point = { x: 990, y: 10 };
  window.emit("blur");
  assert.equal(window.visible, true, "tray click must be handled by toggle, not blur");
  await panel.toggle();
  assert.equal(window.visible, false);
  anchor = { x: 10, y: 0, width: 24, height: 24 };
  await panel.toggle();
  assert.equal(windowCount, 1);
  assert.equal(window.bounds.x, 0, "reopening follows the status item's current position");
  point = { x: 800, y: 600 };
  window.emit("blur");
  assert.equal(window.visible, false);
  const secondary = panelBounds({ x: -1300, y: -500, width: 24, height: 24 }, { x: -1440, y: -476, width: 1440, height: 876 });
  assert.ok(secondary.x >= -1440 && secondary.x + secondary.width <= 0);
  assert.ok(secondary.y >= -476);
  console.log("macOS switcher passed: quota display/refresh/cache, bounded fallback, no token statistics or idle polling, template icon and anchored menu panel.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
