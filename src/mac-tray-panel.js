const path = require("node:path");

function panelBounds(anchor, workArea) {
  const width = Math.min(320, workArea.width);
  const height = Math.min(560, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(anchor.x + anchor.width / 2 - width / 2, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(anchor.y + anchor.height + 6, workArea.y + workArea.height - height))),
    width, height,
  };
}

function createMacTrayPanel({ BrowserWindow, screen, tray, hardenWindow }) {
  let win = null;
  let loaded = null;
  let requested = false;
  function hide() {
    requested = false;
    if (win && !win.isDestroyed()) win.hide();
  }
  async function show() {
    requested = true;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 320, height: 560, show: false, frame: false,
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
    win.setBounds(panelBounds(anchor, screen.getDisplayMatching(anchor).workArea));
    win.webContents.send("state:changed", { scope: "accounts" });
    win.show();
    win.focus();
  }
  return {
    show, hide,
    toggle: () => requested ? hide() : show(),
    getWindow: () => win && !win.isDestroyed() ? win : null,
  };
}

module.exports = { createMacTrayPanel, panelBounds };
