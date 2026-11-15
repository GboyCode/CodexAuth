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
  context.dashboardScope = unexpected;
  context.getSubscriptions = unexpected;
  context.getOnlineAccounts = unexpected;
  context.walkSessionFiles = unexpected;
  context.trayIcon();
  assert.equal(template, true, "menu bar uses native adaptive template rendering");
  for (const name of ["startLocalLogWatcher", "startSessionsWatcher", "startSessionsPolling", "startSubscriptionPolling", "scheduleLocalLogRefresh", "startAutoRecovery"]) await context[name]();
  const diagnostics = await context.localDiagnostics({ accounts: [] }, null);
  assert.equal(diagnostics.sessionFiles, 0);
  assert.equal((await context.getQuota()).quota, null);
  assert.equal((await context.getDashboard()).usage.available, false);
  assert.equal((await context.getAllAccountsQuotaSummary()).accounts.length, 0);
  assert.equal((await context.readLocalUsage()).available, false);
  assert.equal((await context.checkAccountQuota("account")).refreshed, false);
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
  console.log("macOS switcher passed: no statistics scans/queries/timers, template icon, sandboxed menu panel, anchoring, edge clamping and dismiss/toggle behavior.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
