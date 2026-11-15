const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");
const { app, BrowserWindow, screen } = require("electron");
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
  await fs.writeFile(preload, `(${installFixture.toString()})("test", "darwin");`);
  const helper = path.join(root, "focus-fixture");
  execFileSync("/usr/bin/swiftc", [path.join(__dirname, "mac-focus-fixture.swift"), "-o", helper]);
  await app.whenReady();
  app.on("window-all-closed", () => {});
  // Only replace the IPC fixture; all native window options are production code.
  class FixtureWindow extends BrowserWindow {
    constructor(options) { super({...options, webPreferences: {preload, contextIsolation:false, sandbox:false}}); }
  }
  const area = screen.getPrimaryDisplay().workArea;
  const anchor = {x: area.x + 200, y: area.y - 24, width:20, height:24};
  const panel = createMacTrayPanel({BrowserWindow: FixtureWindow, screen,
    tray: {getBounds: () => anchor}, hardenWindow() {}});
  let external;
  try {
    await panel.show();
    const win = panel.getWindow();
    await waitFor(() => win.isFocused(), "menu window must acquire native focus");
    assert.equal(win.hasShadow(), false);
    assert.equal(win.getBounds().width, 320);
    external = spawn(helper, [], {stdio:"ignore"});
    await waitFor(() => !win.isVisible(), "activating another native application must dismiss the panel");
    await waitFor(() => win.webContents.executeJavaScript("refreshTimer === null"), "hiding must remove the quota timer");
    await panel.show();
    await waitFor(() => win.isVisible() && win.isFocused(), "panel must reopen and regain focus");
    panel.hide();
    await waitFor(() => !win.isVisible(), "explicit close works");
    await waitFor(() => win.webContents.executeJavaScript("refreshTimer === null"), "reopened panel stops its timer on close");
    const quotaCalls = await win.webContents.executeJavaScript("panelFixture.calls.length");
    app.getAppMetrics();
    await new Promise(resolve => setTimeout(resolve, 5000));
    const metrics = app.getAppMetrics();
    assert.equal(await win.webContents.executeJavaScript("panelFixture.calls.length"), quotaCalls, "hidden panel performs no fixture API calls");
    const report = { scope: "isolated menu panel with fixture accounts; not a full-app production benchmark",
      externalApplicationDismissal: true, hiddenRefreshTimerRemoved: true, sampleSeconds: 5,
      totalCpuPercent: metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0),
      summedWorkingSetMB: metrics.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024 };
    await fs.mkdir(path.resolve(__dirname, "../output/playwright/panel"), {recursive:true});
    await fs.writeFile(path.resolve(__dirname, "../output/playwright/panel/mac-native-validation.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    console.log("Native macOS focus passed: cross-application dismissal, reopen, no window shadow, 320pt width, hidden refresh timer stopped.");
  } finally {
    external?.kill();
    panel.getWindow()?.destroy();
    // Unique test profile; Chromium may retain handles until process exit.
  }
}
run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
