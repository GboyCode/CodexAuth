const path = require("node:path");

function messageOptions(options) {
  const buttons = options.buttons?.length ? options.buttons.map(String) : ["知道了"];
  const valid = (id) => Number.isInteger(id) && id >= 0 && id < buttons.length;
  const defaultId = valid(options.defaultId) ? options.defaultId : 0;
  return {
    title: String(options.title ?? "CodexAuth"), message: String(options.message ?? ""),
    detail: String(options.detail ?? ""), type: options.type === "warning" ? "warning" : "info",
    buttons, defaultId, cancelId: valid(options.cancelId) ? options.cancelId : buttons.length - 1,
    primaryId: valid(options.primaryId) ? options.primaryId : defaultId,
    compact: options.compact === true,
  };
}

function createMessageDialogs({ BrowserWindow, ipcMain, screen, hardenWindow, icon,
  schedule = setTimeout, unschedule = clearTimeout }) {
  const entries = new Map();
  ipcMain.handle("message-dialog:ready", (event) => entries.get(event.sender)?.options ?? null);
  ipcMain.on("message-dialog:present", (event, height) => {
    const entry = entries.get(event.sender);
    if (!entry || entry.presented || !Number.isFinite(height)) return;
    const { win, area, anchor } = entry;
    const width = win.getBounds().width;
    const nextHeight = Math.min(Math.max(120, Math.ceil(height)), area.height - 24);
    win.setBounds({ width, height: nextHeight,
      x: Math.round(Math.max(area.x, Math.min(anchor.x + (anchor.width - width) / 2, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(anchor.y + (anchor.height - nextHeight) / 2, area.y + area.height - nextHeight))) });
    entry.presented = true;
    unschedule(entry.timer);
    win.show();
    win.focus();
  });
  ipcMain.on("message-dialog:choose", (event, response) => {
    const entry = entries.get(event.sender);
    if (entry?.presented && Number.isInteger(response) && response >= 0 && response < entry.options.buttons.length) entry.finish(response);
  });
  // Use the same screen-coordinate approach as the widget resize handles:
  // native draggable regions do not reliably move transparent modal windows.
  ipcMain.on("message-dialog:drag", (event, phase, cursor) => {
    const entry = entries.get(event.sender);
    if (!entry?.presented) return;
    if (phase === "end") { entry.drag = null; return; }
    if (!cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;
    if (phase === "start") {
      entry.drag = { bounds: entry.win.getBounds(), cursor };
    } else if (phase === "move" && entry.drag) {
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      const { bounds, cursor: start } = entry.drag;
      entry.win.setPosition(
        Math.round(Math.max(area.x, Math.min(bounds.x + cursor.x - start.x, area.x + area.width - bounds.width))),
        Math.round(Math.max(area.y, Math.min(bounds.y + cursor.y - start.y, area.y + area.height - bounds.height))));
    }
  });

  function show(parent, options) {
    const data = messageOptions(options);
    if (parent?.isDestroyed()) return Promise.resolve({ response: data.cancelId });
    return new Promise((resolve) => {
      const anchor = parent?.getBounds() ?? screen.getPrimaryDisplay().workArea;
      const area = screen.getDisplayMatching(anchor).workArea;
      const entry = { options: data, anchor, area, presented: false, win: null };
      let done = false;
      entry.finish = (response = data.cancelId) => {
        if (done) return;
        done = true;
        unschedule(entry.timer);
        parent?.removeListener("closed", cancel);
        parent?.removeListener("hide", cancel);
        if (entry.sender) entries.delete(entry.sender);
        if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
        resolve({ response });
      };
      const cancel = () => entry.finish();
      try {
        const win = entry.win = new BrowserWindow({
          width: Math.min(data.compact ? Math.min(304, anchor.width) : 380, area.width - 24), height: Math.min(480, area.height - 24),
          parent: parent ?? undefined, modal: !!parent, show: false, frame: false, transparent: true,
          resizable: false, movable: true, hasShadow: false, minimizable: false, maximizable: false, skipTaskbar: true,
          alwaysOnTop: parent?.isAlwaysOnTop() ?? false, title: data.title, icon,
          webPreferences: { preload: path.join(__dirname, "message-dialog-preload.js"),
            contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
        });
        entry.sender = win.webContents;
        entries.set(entry.sender, entry);
        hardenWindow(win);
        win.setMenuBarVisibility(false);
        win.once("closed", cancel);
        win.once("unresponsive", cancel);
        win.on("blur", () => { entry.drag = null; });
        win.webContents.once("render-process-gone", cancel);
        win.webContents.once("did-fail-load", cancel);
        win.webContents.on("before-input-event", (event, input) => {
          if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); cancel(); }
        });
        parent?.once("closed", cancel);
        parent?.once("hide", cancel);
        entry.timer = schedule(cancel, 10000);
        entry.timer?.unref?.();
        win.loadFile(path.join(__dirname, "ui", "message-dialog.html")).catch(cancel);
      } catch { cancel(); }
    });
  }
  return { show };
}

module.exports = { messageOptions, createMessageDialogs };
