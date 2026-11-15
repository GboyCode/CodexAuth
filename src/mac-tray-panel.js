const path = require("node:path");

function panelBounds(anchor, workArea, contentHeight = 400) {
  const width = Math.min(320, workArea.width);
  const y = Math.min(workArea.y + workArea.height - 1, Math.max(workArea.y, anchor.y + anchor.height + 6));
  const height = Math.max(1, Math.min(contentHeight, workArea.y + workArea.height - y - 8));
  return {
    x: Math.round(Math.max(workArea.x, Math.min(anchor.x + anchor.width / 2 - width / 2, workArea.x + workArea.width - width))),
    y: Math.round(y),
    width, height,
  };
}

function createMacTrayPanel({ BrowserWindow, screen, tray, hardenWindow, prefersReducedMotion = () => false, activate = () => {} }) {
  let win = null;
  let loaded = null;
  let requested = false;
  let contentHeight = 400;
  let hideTimer = null;
  function fitHeight(height) {
    if (!Number.isFinite(height) || height < 200 || height > 100000) return;
    contentHeight = Math.ceil(height);
    if (!win || win.isDestroyed()) return;
    const anchor = tray.getBounds();
    const bounds = panelBounds(anchor, screen.getDisplayMatching(anchor).workArea, contentHeight);
    win.setBounds(bounds);
    return bounds;
  }
  function hide() {
    requested = false;
    if (!win || win.isDestroyed() || hideTimer) return;
    win.webContents.send("mac-panel:visibility", { visible: false });
    if (prefersReducedMotion()) { win.hide(); return; }
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!requested && win && !win.isDestroyed()) win.hide();
    }, 140);
    hideTimer.unref?.();
  }
  async function show() {
    requested = true;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 320, height: contentHeight, show: false, frame: false,
        movable: false, resizable: false, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true,
        // A nonactivating NSPanel may never acquire the key-window focus needed
        // for blur dismissal. Use a focusable transient window instead.
        focusable: true, alwaysOnTop: true, transparent: true, hasShadow: false,
        // Match the v0.1.88 transparent widget; don't add a second native white
        // material behind the CSS background controlled by the opacity slider.
        backgroundColor: "#00000000",
        webPreferences: { preload: path.join(__dirname, "preload.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
      });
      hardenWindow(win);
      win.on("blur", () => {
        // Clicking the status item also blurs the panel. Let its click handler
        // toggle it, otherwise that click would immediately reopen the panel.
        const point = screen.getCursorScreenPoint();
        const anchor = tray.getBounds();
        if (point.x >= anchor.x && point.x < anchor.x + anchor.width
          && point.y >= anchor.y && point.y < anchor.y + anchor.height) return;
        hide();
      });
      loaded = win.loadFile(path.join(__dirname, "ui", "widget.html"));
    }
    await loaded;
    if (!requested || win.isDestroyed()) return;
    const anchor = tray.getBounds();
    win.setBounds(panelBounds(anchor, screen.getDisplayMatching(anchor).workArea, contentHeight));
    win.webContents.send("mac-panel:visibility", { visible: true });
    win.webContents.send("state:changed", { scope: "accounts" });
    // Explicit status-item activation must also activate NSApplication when
    // returning from another app, before asking its window to become key.
    activate();
    win.show();
    win.focus();
  }
  return {
    show, hide, fitHeight,
    toggle: () => requested ? hide() : show(),
    getWindow: () => win && !win.isDestroyed() ? win : null,
  };
}

module.exports = { createMacTrayPanel, panelBounds };
