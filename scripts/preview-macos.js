const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { installFixture } = require("./validate-panel-interactions");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-mac-preview-"));
  app.setPath("userData", path.join(root, "profile"));
  const preload = path.join(root, "preview.cjs");
  await fs.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify(require("../package.json").version)}, "darwin");
    const {ipcRenderer} = require("electron");
    codexAuth.showMainWindow = async () => ipcRenderer.send("preview:main");
    codexAuth.hideWidget = async () => ipcRenderer.send("preview:hide");
    codexAuth.switchAccount = async id => {
      const snapshot = panelFixture.snapshot;
      snapshot.accounts.forEach(account => { account.isActive = account.id === id; });
      snapshot.current = {exists: true, email: snapshot.accounts.find(account => account.id === id).email};
      panelFixture.notify?.({scope: "accounts"});
      return structuredClone(snapshot);
    };`);
  await app.whenReady();
  const make = (title, width, height) => {
    const win = new BrowserWindow({ title, width, height, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: false, sandbox: false, nodeIntegration: false } });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    win.webContents.on("will-navigate", event => event.preventDefault());
    return win;
  };
  const mainWindow = make("macOS 主窗口预览 · 模拟账号", 1040, 720);
  const panel = make("macOS 菜单栏面板预览 · 模拟账号", 360, 560);
  ipcMain.on("preview:main", () => { if (!mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
  ipcMain.on("preview:hide", () => panel.hide());
  await mainWindow.loadFile(path.resolve(__dirname, "../src/ui/index.html"));
  await panel.loadFile(path.resolve(__dirname, "../src/ui/widget.html"));
  mainWindow.show();
  panel.show();
  panel.focus();
  const state = await panel.webContents.executeJavaScript("({platform: codexAuth.platform, accounts: document.querySelectorAll('.account-row').length})");
  if (state.platform !== "darwin" || state.accounts !== 4) throw new Error("macOS preview did not initialize");
  console.log(JSON.stringify({ ready: true, ...state, profile: root }));
  app.on("window-all-closed", () => app.quit());
}
main().catch(error => { console.error(error); app.exit(1); });
