const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMessageDialogs } = require("../src/message-dialog");

async function main() {
  const windows = [], timers = new Set(), ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = options; this.webContents = new EventEmitter();
      windows.push(this);
    }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
    setMenuBarVisibility() {}
    loadFile() { return Promise.resolve(); }
    show() { this.shown = true; }
    focus() {}
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const area = { x: 1920, y: 0, width: 1920, height: 1080 };
  let cursor = { x: 3000, y: 500 };
  const parent = new EventEmitter();
  parent.getBounds = () => ({ x: 3720, y: 900, width: 400, height: 400 });
  parent.isDestroyed = () => false; parent.isAlwaysOnTop = () => true;
  const dialogs = createMessageDialogs({ BrowserWindow: Window, ipcMain,
    screen: { getDisplayMatching: () => ({ workArea: area }), getPrimaryDisplay: () => ({ workArea: area }),
      getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: area }) },
    hardenWindow() {}, schedule: (fn) => { timers.add(fn); return fn; }, unschedule: (fn) => timers.delete(fn) });
  const options = { title: "确认", message: "更新凭证？", buttons: ["取消", "更新凭证"], defaultId: 0, cancelId: 0, primaryId: 1 };
  const ready = (win) => handlers.get("message-dialog:ready")({ sender: win.webContents });
  const present = (win) => ipcMain.emit("message-dialog:present", { sender: win.webContents }, 260);
  const choose = (win, response) => ipcMain.emit("message-dialog:choose", { sender: win.webContents }, response);

  let result = dialogs.show(parent, options), win = windows.at(-1);
  assert.equal(ready(win).defaultId, 0);
  assert.equal(handlers.get("message-dialog:ready")({ sender: {} }), null, "other renderers cannot read a dialog");
  choose(win, 1); assert.ok(!win.destroyed, "ignore choices until rendered");
  present(win); assert.ok(win.shown); assert.equal(timers.size, 0);
  assert.ok(win.bounds.x >= area.x && win.bounds.x + win.bounds.width <= area.x + area.width);
  assert.ok(win.bounds.y + win.bounds.height <= area.y + area.height);
  const startBounds = { ...win.bounds };
  ipcMain.emit("message-dialog:drag", { sender: win.webContents }, "start", cursor);
  cursor = { x: cursor.x - 100, y: cursor.y - 50 };
  ipcMain.emit("message-dialog:drag", { sender: {} }, "move", cursor);
  assert.deepEqual(win.bounds, startBounds, "other renderers cannot move a dialog");
  ipcMain.emit("message-dialog:drag", { sender: win.webContents }, "move", cursor);
  assert.equal(win.bounds.x, startBounds.x - 100); assert.equal(win.bounds.y, startBounds.y - 50);
  ipcMain.emit("message-dialog:drag", { sender: win.webContents }, "end");
  cursor = { x: 2000, y: 100 };
  ipcMain.emit("message-dialog:drag", { sender: win.webContents }, "move", cursor);
  assert.equal(win.bounds.x, startBounds.x - 100, "moving after release has no effect");
  ipcMain.emit("message-dialog:choose", { sender: {} }, 1);
  choose(win, -1); choose(win, 5); choose(win, "1"); assert.ok(!win.destroyed);
  choose(win, 1); assert.deepEqual(await result, { response: 1 });
  assert.equal(ready(win), null); assert.equal(parent.listenerCount("closed"), 0);
  assert.equal(parent.listenerCount("hide"), 0);

  for (const close of [
    (w) => w.destroy(), (w) => w.webContents.emit("render-process-gone"),
    (w) => w.webContents.emit("did-fail-load"), () => parent.emit("closed"), () => parent.emit("hide"),
    (w) => w.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" }),
  ]) {
    result = dialogs.show(parent, options); win = windows.at(-1); present(win); close(win);
    assert.deepEqual(await result, { response: 0 }, "closing or renderer failure must cancel credential overwrite");
    assert.ok(win.destroyed); assert.equal(timers.size, 0);
  }
  result = dialogs.show(parent, options); win = windows.at(-1);
  [...timers][0](); assert.deepEqual(await result, { response: 0 }, "a stalled renderer must cancel");
  assert.ok(win.destroyed);
  result = dialogs.show(parent, { ...options, compact: true });
  win = windows.at(-1); assert.ok(win.options.width <= 304);
  assert.equal(win.options.hasShadow, false); present(win); choose(win, 0); await result;
  result = dialogs.show(null, { buttons: ["下载", "说明", "稍后"], cancelId: 2 });
  win = windows.at(-1); present(win); win.destroy(); assert.deepEqual(await result, { response: 2 });
  console.log("Message dialogs: sender isolation, dragging, compact sizing, response mapping, cancel and failure recovery passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
