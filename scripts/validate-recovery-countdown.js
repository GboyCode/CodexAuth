const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { countdownBounds, normalizeCountdownPosition } = require("../src/recovery-countdown");

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const anchor = { x: 1500, y: 80, width: 340, height: 600 };
const clone = (value) => JSON.parse(JSON.stringify(value));
const filename = path.resolve(__dirname, "../src/main.js");
const realRequire = createRequire(filename);

function fixture(store) {
  const timers = new Map();
  let timerId = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = options; this.destroyed = false; }
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    getBounds() { assert.equal(this.destroyed, false); return this.bounds; }
    moveTo(x, y) { this.bounds = { ...this.bounds, x, y }; this.emit("move"); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
      on() {}, setName() {}, setAppUserModelId() {} },
    BrowserWindow: Window, Menu: { setApplicationMenu() {} },
    screen: { getDisplayMatching: () => ({ workArea: area }) },
  };
  const context = vm.createContext({ require: (name) => name === "electron" ? electron : realRequire(name),
    __dirname: path.dirname(filename), process, Buffer, console, setInterval, clearInterval,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id), initialSettings: clone(store.value.settings) });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context);
  vm.runInContext("runtimeSettings = normalizeSettings(initialSettings)", context);
  context.currentWidgetBoundsForPersistence = () => anchor;
  context.hardenWindowNavigation = () => {};
  context.appIconPath = () => "fixture.png";
  context.readIndex = async () => clone(store.value);
  context.writeIndex = async (value) => { store.value = clone(value); };
  return { open: () => context.createRecoveryCountdownWindow(),
    flush: () => context.waitForIndexMutations(), timers,
    runTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); } };
}

(async () => {
  assert.equal(normalizeCountdownPosition({ x: "12", y: 30 }), null);
  assert.equal(normalizeCountdownPosition({ x: Infinity, y: 30 }), null);
  assert.deepEqual(normalizeCountdownPosition({ x: -500.2, y: 30.6, width: 300 }), { x: -500, y: 31 });
  assert.deepEqual(countdownBounds(anchor, area), { width: 320, height: 112, x: 1168, y: 568 });
  assert.deepEqual(countdownBounds(anchor, area, { x: 0, y: 0 }), { width: 320, height: 112, x: 0, y: 0 });
  assert.deepEqual(countdownBounds(anchor, area, { x: 4000, y: 2000 }), { width: 320, height: 112, x: 1600, y: 928 });
  assert.deepEqual(countdownBounds(anchor, { ...area, x: -1920 }, { x: -1200, y: 700 }),
    { width: 320, height: 112, x: -1200, y: 700 });
  assert.equal(countdownBounds({ ...anchor, x: 0 }, area).x, 352, "use the other side when there is no room on the left");

  const store = { value: { accounts: [{ id: "fixture-account" }], settings: { autoSwitchOnLimit: true,
    autoSwitchEnabledAt: 123, widgetBounds: anchor, recoveryCountdownPosition: null } } };
  const initial = fixture(store), win = initial.open();
  assert.equal(win.options.movable, true);
  assert.equal(win.options.y, 568);
  win.moveTo(1100, 750); win.moveTo(1080, 780);
  assert.equal(initial.timers.size, 1, "save after dragging settles, not on every move");
  assert.equal(store.value.settings.recoveryCountdownPosition, null);
  win.destroy(); await initial.flush();
  assert.equal(initial.timers.size, 0);
  assert.deepEqual(store.value.settings.recoveryCountdownPosition, { x: 1080, y: 780 }, "closing before debounce still saves the last position");
  assert.equal(store.value.settings.autoSwitchOnLimit, true);
  assert.equal(store.value.settings.autoSwitchEnabledAt, 123);
  assert.deepEqual(store.value.settings.widgetBounds, anchor);
  assert.deepEqual(store.value.accounts, [{ id: "fixture-account" }]);

  const restarted = fixture(store), next = restarted.open();
  assert.equal(next.options.x, 1080); assert.equal(next.options.y, 780);
  next.moveTo(1000, 800); restarted.runTimers(); await restarted.flush();
  assert.deepEqual(store.value.settings.recoveryCountdownPosition, { x: 1000, y: 800 });
  next.destroy();
  store.value.settings.recoveryCountdownPosition = { x: -3000, y: 2000 };
  const disconnected = fixture(store).open();
  assert.equal(disconnected.options.x, 0); assert.equal(disconnected.options.y, 928);
  disconnected.destroy();
  console.log("Countdown position passed: lower placement, debounce, close flush, restart restore, settings preservation and disconnected-display clamping.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
