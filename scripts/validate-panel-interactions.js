const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
app.on("window-all-closed", () => {});

// Render the production UI against isolated fixtures, never the app main process or real credentials.
function installFixture(appVersion) {
  const quota = {
    source: "online-account", checkedAt: new Date().toISOString(), planType: "plus",
    session: { windowMinutes: 300, usedPercent: 20, resetsAt: Date.now() / 1000 + 7200 },
    weekly: { windowMinutes: 10080, usedPercent: 40, resetsAt: Date.now() / 1000 + 86400 },
  };
  const accounts = [
    { id: "current", displayName: "工作账号", email: "work@example.com", isActive: true, planType: "plus", quotaSnapshot: quota },
    { id: "backup", displayName: "备用账号", email: "backup@example.com", planType: "business", quotaSnapshot: { ...quota, source: "account-cache" } },
    { id: "reauth", displayName: "需要重新登录的账号", email: "login@example.com", needsReauth: true, reauthReason: "登录已失效", planType: "plus" },
    { id: "unknown", displayName: "very-long-account-name-that-must-not-hide-the-account-actions@example.com", email: "very-long-account-name-that-must-not-hide-the-account-actions@example.com", planType: "business" },
  ];
  const usage = { tokenUsage: { totalTokens: 1200, inputTokens: 1000, outputTokens: 200 }, scannedFiles: 2, totalFiles: 2, sessionsAnalyzed: 2, coverage: {} };
  const fixture = window.panelFixture = {
    snapshot: { platform: "win32", platformName: "Windows", current: { exists: true, email: "work@example.com" }, accounts,
      authPath: "C:/example/.codex/auth.json", storeRoot: "C:/example/accounts", accountLogin: { state: "idle" },
      settings: { language: localStorage.getItem("fixture.language") || "zh-CN", restartAfterSwitch: true, autoSwitchOnLimit: false, autoResetOnWeeklyLimit: false }, autoRecovery: { state: "disabled" } },
    quota, usage, calls: [], allTotalTokens: 9999,
  };
  const copy = (value) => structuredClone(value);
  window.codexAuth = {
    platform: "win32",
    getState: async () => copy(fixture.snapshot),
    getQuota: async () => { if (fixture.failQuota) throw new Error("quota unavailable"); return { quota: copy(fixture.quota) }; },
    getDashboard: async () => ({ quota: copy(fixture.quota), usage: copy(fixture.usage), scope: { since: new Date().toISOString() } }),
    getAllUsage: async () => ({ ...copy(fixture.usage), tokenUsage: { totalTokens: fixture.allTotalTokens } }),
    getAllAccountsQuota: async () => ({ accounts: copy(fixture.snapshot.accounts) }),
    checkAccountQuota: async (id) => { fixture.calls.push(["quota", id]); return { refreshed: true, reason: "已刷新" }; },
    onStateChanged: (listener) => { fixture.notify = listener; },
    getVersion: async () => appVersion,
    checkForUpdates: async () => ({ ok: true, comparison: 0 }),
    updateSettings: async (patch) => {
      if (fixture.failSettings) throw new Error("设置保存失败");
      Object.assign(fixture.snapshot.settings, patch);
      if (patch.language) localStorage.setItem("fixture.language", patch.language);
      return copy(fixture.snapshot);
    },
    updateAccount: async (id, patch) => { Object.assign(fixture.snapshot.accounts.find(a => a.id === id), patch); return copy(fixture.snapshot); },
    switchAccount: async (id, options) => { fixture.calls.push(["switch", id, options]); return copy(fixture.snapshot); },
    deleteAccount: async (id) => { fixture.calls.push(["delete", id]); return copy(fixture.snapshot); },
    reauthAccount: async (id) => { fixture.calls.push(["reauth", id]); return copy(fixture.snapshot); },
    importCurrent: async (name) => { fixture.calls.push(["save", name]); return copy(fixture.snapshot); },
    loginAccount: async (name) => { fixture.calls.push(["login", name]); fixture.snapshot.accountLogin = { state: "waiting", message: "请完成官方登录", canOpen: true, canCancel: true }; return copy(fixture.snapshot.accountLogin); },
    cancelAccountLogin: async () => { fixture.snapshot.accountLogin = { state: "idle" }; return copy(fixture.snapshot.accountLogin); },
    openAccountLogin: async () => copy(fixture.snapshot.accountLogin),
    selectPortable: async () => { fixture.calls.push(["import-file"]); return { canceled: true }; },
    cancelPortable: async () => {},
    restartCodex: async () => { fixture.calls.push(["restart"]); },
    showWidget: async () => {}, openPath: async () => {}, openAppLink: async () => {},
  };
  window.confirm = (message) => { fixture.confirmMessage = message; return false; };
}

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-panel-test-"));
  const output = path.resolve(__dirname, "../output/playwright/panel");
  await fs.mkdir(output, { recursive: true });
  const preload = path.join(root, "preload.cjs");
  await fs.writeFile(preload, `(${installFixture.toString()})(${JSON.stringify(require('../package.json').version)});`);
  app.setPath("userData", path.join(root, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1040, height: 720, useContentSize: true, show: false,
    webPreferences: { preload, contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => { if (level === 3) errors.push(message); });
  const evaluate = code => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Renderer timed out: ${code.slice(0, 160)}`)), 10000);
    win.webContents.executeJavaScript(code).then(resolve, reject).finally(() => clearTimeout(timeout));
  });
  const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const click = async selector => {
    await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing control'); element.focus(); element.click(); })()`);
    await settle();
  };
  const capture = async name => {
    await evaluate("document.querySelector('#toast').classList.remove('show'); Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))");
    await fs.writeFile(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadFile(path.resolve(__dirname, "../src/ui/index.html"));
    await settle();
    assert.equal(await evaluate("document.querySelectorAll('.account-card').length"), 4);
    assert.equal(await evaluate("document.querySelector('#accountLoginPanel').hidden"), true);
    assert.equal(await evaluate("document.querySelector('[data-account-id=current] .account-action.primary') === null"), true);
    assert.match(await evaluate("document.querySelector('[data-account-id=unknown] .account-quota-preview').textContent"), /--/);
    assert.equal(await evaluate("document.querySelector('[data-account-id=reauth] .account-action.primary').textContent"), "重新登录");
    for (const width of [860, 900, 1040]) {
      win.setContentSize(width, 720); await settle();
      assert.equal(await evaluate("document.documentElement.scrollWidth > window.innerWidth"), false, `horizontal overflow at ${width}`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.account-card')).filter(card => {
        const main = card.querySelector('.account-main').getBoundingClientRect();
        const quota = card.querySelector('.account-quota-preview').getBoundingClientRect();
        const actions = card.querySelector('.account-actions').getBoundingClientRect();
        return main.right > quota.left || quota.right > actions.left || actions.right > card.getBoundingClientRect().right;
      }).map(card => card.dataset.accountId)`), [], `account columns overlap at ${width}`);
      await capture(`accounts-${width}`);
      await click('[data-account-id="backup"] .account-expand-cue');
      assert.equal(await evaluate("document.documentElement.scrollWidth > window.innerWidth"), false, `expanded overflow at ${width}`);
      await click('[data-account-id="backup"] .account-expand-cue');
    }
    await click('[data-account-id="backup"] .account-expand-cue');
    assert.match(await evaluate("document.querySelector('#quota-details-backup').textContent"), /刷新额度/);
    assert.equal(await evaluate("document.activeElement.classList.contains('account-expand-cue')"), true);
    await click('[data-account-id="backup"] .account-more');
    assert.equal(await evaluate("document.querySelector('#accountMenu').matches(':popover-open')"), true);
    assert.equal(await evaluate("document.activeElement.id"), "accountDetailsBtn");
    assert.equal(await evaluate("document.querySelector('#accountMenu').getBoundingClientRect().bottom <= innerHeight"), true);
    await evaluate("panelFixture.snapshot.accounts[1].quotaSnapshot.session = {...panelFixture.quota.session, usedPercent: 25}; panelFixture.notify({scope: 'quota'})"); await settle();
    assert.equal(await evaluate("document.querySelector('#accountMenu').matches(':popover-open')"), true, "background refresh keeps the open menu");
    assert.equal(await evaluate("document.activeElement.id"), "accountDetailsBtn");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await settle();
    assert.equal(await evaluate("document.querySelector('#accountMenu').matches(':popover-open')"), false);
    assert.equal(await evaluate("document.activeElement.classList.contains('account-more')"), true, "Escape restores menu invoker focus");
    assert.match(await evaluate("document.querySelector('[data-account-id=backup] .account-quota-preview').textContent"), /剩余 75%/, "deferred quota renders on menu close");
    await evaluate("panelFixture.notify({scope: 'quota'})"); await settle();
    assert.equal(await evaluate("document.activeElement.classList.contains('account-more')"), true, "background refresh preserves account button focus");
    await click('[data-account-id="backup"] .account-action.primary');
    assert.deepEqual(await evaluate("panelFixture.calls.find(call => call[0] === 'switch')"), ["switch", "backup", { restartCodex: true }]);
    await click('[data-account-id="backup"] .account-more');
    await click('#renameAccountBtn');
    await evaluate("document.querySelector('#renameInput').value = '备用工作账号'");
    await click('#renameOk');
    assert.equal(await evaluate("document.querySelector('[data-account-id=backup] .account-name').textContent"), "备用工作账号");
    await click('[data-account-id="current"] .account-more');
    await click('#deleteAccountBtn');
    assert.match(await evaluate("document.querySelector('#confirmBody').textContent"), /退出当前登录、重启/);
    assert.equal(await evaluate("document.activeElement.value"), "cancel");
    await click('#confirmDialog [value="cancel"]');
    assert.equal(await evaluate("panelFixture.calls.some(call => call[0] === 'delete')"), false);
    await click('[data-account-id="reauth"] .account-action.primary');
    assert.match(await evaluate("panelFixture.confirmMessage"), /清除当前 Codex 登录/);

    await click('#addAccountBtn');
    await evaluate("document.querySelector('#displayNameInput').value = '新备注'");
    await click('#importBtn');
    assert.equal(await evaluate("document.querySelector('#addAccountDialog').open"), false);
    assert.deepEqual(await evaluate("panelFixture.calls.find(call => call[0] === 'save')"), ["save", "新备注"]);
    await click('#addAccountBtn'); await click('#loginAccountBtn');
    assert.equal(await evaluate("document.querySelector('#accountLoginPanel').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#addAccountDialog').open"), false);
    assert.equal(await evaluate("panelFixture.snapshot.current.email"), "work@example.com");
    await click('#cancelAccountLoginBtn');
    assert.equal(await evaluate("document.querySelector('#accountLoginPanel').hidden"), true);
    await evaluate("renderAccountLogin({state: 'done', message: '账号已添加，可在列表中选择切换；当前 Codex 登录未改变。'})");
    assert.equal(await evaluate("document.querySelector('#accountLoginPanel').hidden"), true, "success explanations do not remain on the page");
    await click('[popovertarget="transferMenu"]'); await click('#importCredentialsBtn');
    assert.equal(await evaluate("panelFixture.calls.some(call => call[0] === 'import-file')"), true);
    await click('[popovertarget="transferMenu"]'); await click('#exportCredentialsBtn');
    await click('#exportScopeDialog [value="current"]');
    assert.equal(await evaluate("document.querySelector('#transferDialog').open"), true);
    await click('#transferCancel');

    await click('#settingsBtn');
    assert.equal(await evaluate("document.querySelector('#autoResetOnWeeklyLimit').disabled"), true);
    await click('#autoSwitchOnLimit');
    assert.equal(await evaluate("document.querySelector('#autoResetOnWeeklyLimit').disabled"), false);
    assert.equal(await evaluate("document.querySelector('#autoRecoverySummary').textContent"), "自动切换：开启");
    await click('#autoResetOnWeeklyLimit');
    assert.equal(await evaluate("panelFixture.snapshot.settings.autoResetOnWeeklyLimit"), true);
    await evaluate("panelFixture.failSettings = true"); await click('#restartAfterSwitch');
    assert.equal(await evaluate("document.querySelector('#restartAfterSwitch').checked"), true);
    assert.equal(await evaluate("document.querySelector('#settingsDialog .dialog-notice').textContent"), "设置保存失败");
    await evaluate("panelFixture.failSettings = false; document.querySelector('#settingsDialog .dialog-notice').hidden = true");
    await capture('settings');
    await click('[data-close-dialog="settingsDialog"]');
    assert.equal(await evaluate("document.activeElement.id"), "settingsBtn");
    await evaluate("panelFixture.snapshot.autoRecovery = {state: 'attention', message: '上次用卡结果未确认'}; panelFixture.notify({scope: 'accounts'})"); await settle();
    assert.equal(await evaluate("document.querySelector('#recoveryNotice').hidden"), false);
    await evaluate("panelFixture.snapshot.platform = 'darwin'; panelFixture.notify({scope: 'accounts'})"); await settle();
    assert.equal(await evaluate("document.querySelector('#autoSwitchOnLimit').disabled && document.querySelector('#autoResetOnWeeklyLimit').disabled"), true);
    await evaluate("panelFixture.snapshot.platform = 'win32'");

    await click('#usageTab');
    assert.equal(await evaluate("document.querySelector('#sessionPercent').textContent"), "剩余 80%");
    await click('#scopeAllBtn');
    assert.equal(await evaluate("document.querySelector('#totalTokens').textContent"), "9,999");
    assert.equal(await evaluate("document.querySelector('#sessionPercent').textContent"), "剩余 80%", "local scope preserves account quota");
    assert.match(await evaluate("document.querySelector('#localUsageScope').textContent"), /包含不同账号/);
    await capture('usage');
    await click('#settingsBtn');
    await click('input[name="language"][value="en"]');
    assert.equal(await evaluate("panelFixture.snapshot.settings.language"), "en");
    assert.equal(await evaluate("document.documentElement.lang"), "en");
    assert.equal(await evaluate("document.querySelector('#settingsTitle').textContent"), "Settings");
    assert.equal(await evaluate("document.querySelector('#sessionPercent').textContent"), "Remaining 80%", "language switch preserves known quota");
    assert.equal(await evaluate("document.querySelector('#totalTokens').textContent"), "9,999", "language switch preserves local usage");
    assert.equal(await evaluate("document.querySelector('#appVersion').textContent"), `v${require('../package.json').version}`);
    assert.equal(await evaluate("document.querySelector('[data-account-id=backup] .account-name').textContent"), "备用工作账号", "user-provided names are not translated");
    assert.match(await evaluate("document.querySelector('#autoRecoverySummary').textContent"), /^Auto-switch:/);
    assert.deepEqual(await evaluate(`(() => {
      const dialog = document.querySelector('#settingsDialog');
      const content = dialog.querySelector('.dialog-content');
      const heading = dialog.querySelector('.dialog-heading');
      const close = dialog.querySelector('[data-close-dialog]');
      const headingTop = heading.getBoundingClientRect().top;
      const closeTop = close.getBoundingClientRect().top;
      content.scrollTop = content.scrollHeight;
      const closeBounds = close.getBoundingClientRect();
      const result = { hidden: getComputedStyle(content).scrollbarWidth === 'none', scrollable: content.scrollTop > 0,
        titleFixed: heading.getBoundingClientRect().top === headingTop,
        closeFixed: closeBounds.top === closeTop,
        closeClickable: close.contains(document.elementFromPoint(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2)),
        aboutVisible: dialog.querySelector('.about-actions').getBoundingClientRect().bottom <= content.getBoundingClientRect().bottom };
      return result;
    })()`), { hidden: true, scrollable: true, titleFixed: true, closeFixed: true, closeClickable: true, aboutVisible: true },
      "scrolling settings keeps the header and close button fixed while reaching About");
    await capture('settings-en-scrolled');
    await click('[data-close-dialog="settingsDialog"]');
    assert.equal(await evaluate("document.querySelector('#settingsDialog').open"), false, "close works after scrolling to the bottom");
    await click('#settingsBtn');
    await evaluate("document.querySelector('#settingsDialog .dialog-content').scrollTop = 0");
    await evaluate("document.querySelector('input[name=language]:checked').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await settle();
    assert.equal(await evaluate("document.documentElement.lang"), "zh-CN", "language options support keyboard selection");
    await click('input[name="language"][value="en"]');
    assert.equal(await evaluate("document.querySelector('.language-option.active input').value"), "en");
    await capture('settings-en');
    await evaluate("panelFixture.failSettings = true"); await click('input[name="language"][value="zh-CN"]');
    assert.equal(await evaluate("document.querySelector('input[name=language]:checked').value"), "en", "failed save restores the language selector");
    assert.equal(await evaluate("document.documentElement.lang"), "en", "failed save keeps the current language");
    assert.equal(await evaluate("document.querySelector('#settingsDialog .dialog-notice').textContent"), "Unable to save settings");
    await evaluate("panelFixture.failSettings = false");
    await click('[data-close-dialog="settingsDialog"]');
    await capture('usage-en');
    await click('#accountsTab');
    for (const width of [860, 1040]) {
      win.setContentSize(width, 720); await settle();
      assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false, `English overflow at ${width}`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.account-card')).filter(card => {
        const quota = card.querySelector('.account-quota-preview').getBoundingClientRect();
        const actions = card.querySelector('.account-actions').getBoundingClientRect();
        return quota.right > actions.left || actions.right > card.getBoundingClientRect().right;
      }).map(card => card.dataset.accountId)`), [], `English account columns overlap at ${width}`);
      await capture(`accounts-en-${width}`);
    }
    await click('#settingsBtn');
    await click('input[name="language"][value="zh-CN"]');
    assert.equal(await evaluate("document.querySelector('#settingsTitle').textContent"), "设置");
    await click('[data-close-dialog="settingsDialog"]');
    await click('#usageTab');
    await evaluate("panelFixture.failQuota = true; panelFixture.allTotalTokens = 5432"); await click('#statsRefreshBtn');
    assert.equal(await evaluate("document.querySelector('#totalTokens').textContent"), "5,432", "quota failure must not block local usage");
    assert.equal(await evaluate("document.querySelector('#sessionPercent').textContent"), "剩余 80%", "quota failure preserves last known quota");
    await evaluate("panelFixture.failQuota = false");
    await evaluate("panelFixture.usage.coverage = {invalidLines: 1}"); await click('#statsRefreshBtn');
    assert.equal(await evaluate("document.querySelector('#usageWarning').hidden"), false);
    await click('#accountsTab');
    await evaluate("panelFixture.snapshot.accounts = []; panelFixture.notify({scope: 'accounts'})"); await settle();
    assert.match(await evaluate("document.querySelector('.empty-state').textContent"), /添加账号/);
    await click('.empty-state button');
    assert.equal(await evaluate("document.querySelector('#addAccountDialog').open"), true);
    await click('[data-close-dialog="addAccountDialog"]');
    await click('#settingsBtn');
    await click('input[name="language"][value="en"]');
    await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.reload(); }); await settle();
    assert.equal(await evaluate("document.documentElement.lang"), "en", "saved language is restored on a new renderer");
    assert.equal(await evaluate("document.querySelector('input[name=language]:checked').value"), "en");
    assert.equal(await evaluate("document.querySelector('#settingsBtn').textContent"), "Settings");
    assert.deepEqual(errors, [], "renderer errors");
    console.log("Panel validation passed: 860/900/1040 layouts, long names, quota summaries, unknown data, menus, focus, add/import/export, delete cancellation, settings rollback/dependencies, platform limits, recovery notices and independent usage scope. Mock APIs only.");
    console.log(`Screenshots: ${output}`);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    win.destroy();
    // Only remove the uniquely created fixture profile within the OS temp directory.
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "codexauth-panel-test-")));
    // Chromium can hold its profile until app exit; cleanup must not hide results.
    await Promise.race([fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500))]);
  }
}
run().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
