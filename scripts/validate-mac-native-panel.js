const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");
const { app, BrowserWindow, screen, ipcMain } = require("electron");
const { createMacTrayPanel } = require("../src/mac-tray-panel");
const { installFixture } = require("./validate-panel-interactions");
const waitFor = async (condition, message) => {
  const deadline = Date.now() + 15000;
  while (!await condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(await condition(), message);
};
async function run() {
  if (process.platform !== "darwin") { console.log("Native focus verification runs on the macOS release runner."); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-native-panel-"));
  app.setPath("userData", path.join(root, "profile"));
  const preload = path.join(root, "fixture.cjs");
  await fs.writeFile(preload, `(${installFixture.toString()})("test", "darwin");
    const {ipcRenderer} = require("electron");
    codexAuth.fitMacPanel = height => ipcRenderer.invoke("native-test:fit", height);
    codexAuth.onMacPanelVisibility = callback => ipcRenderer.on("mac-panel:visibility", (_event, payload) => callback(payload));`);
  const helper = path.join(root, "focus-fixture");
  execFileSync("/usr/bin/swiftc", [path.join(__dirname, "mac-focus-fixture.swift"), "-o", helper]);
  await app.whenReady();
  app.setActivationPolicy("accessory");
  app.on("window-all-closed", () => {});
  // Only replace the IPC fixture; all native window options are production code.
  class FixtureWindow extends BrowserWindow {
    constructor(options) { super({...options, webPreferences: {preload, contextIsolation:false, sandbox:false}}); }
  }
  const area = screen.getPrimaryDisplay().workArea;
  const anchor = {x: area.x + 200, y: area.y - 24, width:20, height:24};
  const panel = createMacTrayPanel({BrowserWindow: FixtureWindow, screen,
    tray: {getBounds: () => anchor}, hardenWindow() {}, activate: () => app.focus({steal:true})});
  ipcMain.handle("native-test:fit", (_event, height) => panel.fitHeight(height));
  let external;
  const events = [];
  try {
    await panel.show();
    const win = panel.getWindow();
    for (const name of ["show", "hide", "focus", "blur"]) win.on(name, () => events.push({name, time:Date.now(), visible:win.isVisible(), focused:win.isFocused()}));
    await waitFor(() => win.isFocused(), "menu window must acquire native focus");
    await waitFor(() => win.webContents.executeJavaScript("document.activeElement.matches('.widget')"), "opening focuses the panel instead of the version button");
    win.webContents.sendInputEvent({type:"keyDown", keyCode:"Tab"});
    win.webContents.sendInputEvent({type:"keyUp", keyCode:"Tab"});
    await waitFor(() => win.webContents.executeJavaScript("document.activeElement.id === 'checkUpdatesBtn' && document.activeElement.matches(':focus-visible')"), "keyboard Tab still focuses the version button visibly");
    assert.equal(win.hasShadow(), false);
    assert.equal(win.getBounds().width, 320);
    assert.equal(app.dock.isVisible(), false, "accessory app has no running Dock icon");
    await win.webContents.executeJavaScript("panelFixture.savedAccounts = structuredClone(panelFixture.snapshot.accounts); panelFixture.snapshot.accounts = panelFixture.savedAccounts.slice(0,3); panelFixture.notify({scope:'accounts'})");
    await waitFor(async () => {
      const state = await win.webContents.executeJavaScript("({count: document.querySelectorAll('.account-row').length, height:lastMacPanelHeight})");
      return state.count === 3 && win.getBounds().height === state.height;
    }, "native height fits three accounts");
    const threeHeight = win.getBounds().height;
    await win.webContents.executeJavaScript("panelFixture.snapshot.accounts = panelFixture.savedAccounts.slice(0,1); panelFixture.notify({scope:'accounts'})");
    await waitFor(() => win.getBounds().height <= threeHeight - 90, "native window shrinks after removing accounts");
    await win.webContents.executeJavaScript("panelFixture.snapshot.accounts = Array.from({length:30}, (_, i) => ({...panelFixture.savedAccounts[0],id:'many-'+i})); panelFixture.notify({scope:'accounts'})");
    await waitFor(() => win.getBounds().height > threeHeight, "native window grows for many accounts");
    assert.ok(win.getBounds().y + win.getBounds().height <= area.y + area.height - 8);
    await panel.hide();
    assert.equal(win.isVisible(), true, "window stays visible during its short exit animation");
    await panel.show();
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(win.isVisible(), true, "reopening cancels the pending hide");
    external = spawn(helper, [], {stdio:"ignore"});
    await waitFor(() => !win.isVisible(), "activating another native application must dismiss the panel");
    await waitFor(() => win.webContents.executeJavaScript("refreshTimer === null"), "hiding must remove the quota timer");
    await panel.show();
    await waitFor(() => win.isVisible() && win.isFocused(), "panel must reopen and regain focus");
    await waitFor(() => win.webContents.executeJavaScript("document.activeElement.matches('.widget')"), "reopening resets previous button focus to the panel");
    const main = new FixtureWindow({width:800, height:600, show:false});
    await main.loadFile(path.resolve(__dirname, "../src/ui/index.html"));
    app.focus({steal:true}); main.show(); main.focus();
    await waitFor(() => main.isFocused(), "accessory mode can open and focus the main window");
    assert.equal(app.dock.isVisible(), false, "opening the main window must not restore the Dock icon");
    main.destroy();
    panel.hide();
    await waitFor(() => !win.isVisible(), "explicit close works");
    await waitFor(() => win.webContents.executeJavaScript("refreshTimer === null"), "reopened panel stops its timer on close");
    const quotaCalls = await win.webContents.executeJavaScript("panelFixture.calls.length");
    app.getAppMetrics();
    await new Promise(resolve => setTimeout(resolve, 5000));
    const metrics = app.getAppMetrics();
    assert.equal(await win.webContents.executeJavaScript("panelFixture.calls.length"), quotaCalls, "hidden panel performs no fixture API calls");
    const report = { scope: "isolated menu panel with fixture accounts; not a full-app production benchmark",
      accessoryDockHidden: true, accessoryMainWindowFocused: true, panelInitialFocus: true, keyboardTabPreserved: true,
      externalApplicationDismissal: true, automaticAccountHeight: true, interruptedHideSafe: true,
      hiddenRefreshTimerRemoved: true, sampleSeconds: 5,
      totalCpuPercent: metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0),
      summedWorkingSetMB: metrics.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024 };
    await fs.mkdir(path.resolve(__dirname, "../output/playwright/panel"), {recursive:true});
    await fs.writeFile(path.resolve(__dirname, "../output/playwright/panel/mac-native-validation.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    console.log("Native macOS focus passed: cross-application dismissal, reopen, no window shadow, 320pt width, hidden refresh timer stopped.");
  } catch (error) {
    const win = panel.getWindow();
    console.error("Native panel event trace:", JSON.stringify(events));
    if (win) console.error("Native panel final state:", JSON.stringify({visible:win.isVisible(), focused:win.isFocused(),
      renderer:await win.webContents.executeJavaScript("({classes:document.body.className, hidden:document.hidden, opacity:getComputedStyle(document.body).opacity, height:innerHeight})")}));
    throw error;
  } finally {
    external?.kill();
    panel.getWindow()?.destroy();
    ipcMain.removeHandler("native-test:fit");
    // Unique test profile; Chromium may retain handles until process exit.
  }
}
run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
