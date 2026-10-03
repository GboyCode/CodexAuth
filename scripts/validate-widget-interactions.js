const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { app, BrowserWindow, ipcMain } = require("electron");
app.on("window-all-closed", () => {});

// Load the real widget with fake accounts and APIs; never load the application main process.
function installFixture() {
  const accounts = Array.from({ length: 7 }, (_, index) => ({
    id: `account-${index}`,
    displayName: `user${index}@example.com`,
    email: `user${index}@example.com`,
    planType: index < 3 ? "plus" : "business",
    isActive: index === 5,
    quotaSnapshot: {
      checkedAt: new Date().toISOString(),
      weekly: { usedPercent: 30, remainingPercent: 70, resetsAt: Date.now() / 1000 + 86400 },
    },
  }));
  window.widgetFixture = {
    snapshot: { accounts, current: { exists: true, email: "user5@example.com" } },
    orders: [],
    switches: [],
    logins: [],
  };
  const fixture = window.widgetFixture;
  window.codexAuth = {
    getState: async () => fixture.snapshot,
    getQuota: async () => ({ quota: {} }),
    getVersion: async () => "test",
    getWidgetTopmost: async () => ({ pinned: false }),
    setWidgetTopmost: async (pinned) => {
      if (fixture.failNextPin) {
        fixture.failNextPin = false;
        throw new Error("fixture pin failure");
      }
      return require("electron").ipcRenderer.invoke("widget-test:set-pinned", pinned);
    },
    resizeWidget: async () => ({}),
    widgetPointerEnter: async () => ({}),
    widgetPointerLeave: async () => ({}),
    onStateChanged: (listener) => { fixture.notify = listener; },
    reorderAccounts: async (ids) => {
      fixture.orders.push(ids);
      fixture.snapshot.accounts = ids.map((id) => fixture.snapshot.accounts.find((account) => account.id === id));
      return fixture.snapshot;
    },
    switchAccount: (id) => new Promise((resolve) => {
      fixture.switches.push(id);
      fixture.finishSwitch = resolve;
    }),
    reauthAccount: async (id) => { fixture.logins.push(id); },
  };
}

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-widget-test-"));
  const preload = path.join(root, "preload.cjs");
  await fs.writeFile(preload, `(${installFixture.toString()})();`);
  app.setPath("userData", path.join(root, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({
    width: 304, height: 760, useContentSize: true, show: false,
    webPreferences: { preload, contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false },
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.resolve(__dirname, "../src/ui/widget.html"));
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`document.querySelectorAll('.account-row').length`), 7);

    const logoPoint = await evaluate(`(() => {
      widgetFixture.logoDrags = 0;
      const logo = document.querySelector('.mark');
      logo.addEventListener('dragstart', event => {
        widgetFixture.logoDrags += 1;
        event.preventDefault();
      });
      const bounds = logo.getBoundingClientRect();
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`);
    for (const pinned of [false, true]) {
      await evaluate(`document.body.classList.toggle('pinned', ${pinned})`);
      win.webContents.sendInputEvent({ type: "mouseDown", ...logoPoint, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseMove", x: logoPoint.x + 20, y: logoPoint.y + 15, modifiers: ["leftButtonDown"] });
      win.webContents.sendInputEvent({ type: "mouseUp", x: logoPoint.x + 20, y: logoPoint.y + 15, button: "left", clickCount: 1 });
      assert.equal(await evaluate(`widgetFixture.logoDrags`), 0,
        `dragging the logo must not start an image/file drag when pinned=${pinned}`);
    }
    await evaluate(`document.body.classList.remove('pinned')`);

    const mainSource = await fs.readFile(path.resolve(__dirname, "../src/main.js"), "utf8");
    const pinContext = vm.createContext({
      widgetAlwaysOnTop: false, widgetWindow: win, widgetResizeSession: null,
      widgetManualSize: false, widgetDockState: { collapsed: false },
      createWidgetWindow: () => win,
      finishWidgetResize: () => { pinContext.widgetResizeSession = null; },
      expandWidgetDock: () => {}, resetWidgetDockState: () => {}, scheduleWidgetDockCheck: () => {},
      screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }) },
      VALID_RESIZE_EDGES: new Set(["nw"]),
    });
    for (const name of ["setWidgetTopmost", "startWidgetResize", "updateWidgetResize", "collapseWidgetToDock", "collapseWidgetDock"]) {
      const start = mainSource.indexOf(`function ${name}(`);
      const end = mainSource.indexOf("\nfunction ", start + 1);
      vm.runInContext(mainSource.slice(start, end), pinContext);
    }
    ipcMain.handle("widget-test:set-pinned", (_event, pinned) => pinContext.setWidgetTopmost(pinned));
    assert.equal(pinContext.startWidgetResize("nw").ok, true);
    const originalBounds = win.getBounds();
    for (const pinned of [true, false]) {
      const ui = await evaluate(`(async () => {
        const button = document.querySelector('#pinBtn');
        button.click();
        while (button.disabled) await new Promise(resolve => setTimeout(resolve, 0));
        const pinIcon = button.querySelector('svg');
        getComputedStyle(pinIcon).transform;
        await Promise.all(pinIcon.getAnimations().map(animation => animation.finished));
        const icon = new DOMMatrix(getComputedStyle(pinIcon).transform);
        return { pressed: button.getAttribute('aria-pressed'),
          drag: getComputedStyle(document.querySelector('.widget-head')).webkitAppRegion,
          handlesHidden: [...document.querySelectorAll('.resize-handle')].every(el => getComputedStyle(el).display === 'none'),
          angle: Math.round(Math.atan2(icon.b, icon.a) * 180 / Math.PI) };
      })()`);
      assert.equal(ui.pressed, String(pinned));
      assert.equal(ui.drag, pinned ? "no-drag" : "drag");
      assert.equal(ui.handlesHidden, pinned);
      assert.equal(ui.angle, pinned ? 0 : 45);
      assert.equal(win.isMovable(), !pinned);
      assert.equal(win.isAlwaysOnTop(), pinned);
      if (pinned) {
        assert.equal(pinContext.widgetResizeSession, null, "pinning cancels an active edge resize");
        assert.equal(pinContext.startWidgetResize("nw").ok, false);
        assert.equal(pinContext.updateWidgetResize().ok, false);
        assert.equal(pinContext.collapseWidgetToDock().ok, false);
        pinContext.collapseWidgetDock({ force: true });
        assert.deepEqual(win.getBounds(), originalBounds, "pinning and rejected movement must retain the position");
      }
    }
    assert.equal(pinContext.startWidgetResize("nw").ok, true, "unpinning restores edge resize");
    pinContext.finishWidgetResize();
    await evaluate(`(async () => {
      widgetFixture.failNextPin = true;
      document.querySelector('#pinBtn').click();
      while (document.querySelector('#pinBtn').disabled) await new Promise(resolve => setTimeout(resolve, 0));
    })()`);
    assert.equal(await evaluate(`document.body.classList.contains('pinned')`), false, "failed pinning restores the unlocked UI");
    assert.equal(win.isMovable(), true);

    const sizingConstants = mainSource.match(/^const WIDGET_(?:BASE_HEIGHT|ACCOUNT_ROW_DELTA|MIN_ACCOUNT_ROWS) = .+;$/gm).join("\n");
    const sizingFunction = mainSource.slice(mainSource.indexOf("function widgetHeightForAccounts("), mainSource.indexOf("function widgetMaxHeightForBounds("));
    const heightForAccounts = vm.runInNewContext(`${sizingConstants}\n${sizingFunction}\nwidgetHeightForAccounts`);
    await evaluate(`widgetFixture.allAccounts = [...widgetFixture.snapshot.accounts]`);
    for (const count of [2, 7]) {
      const height = heightForAccounts(count);
      win.setContentSize(304, height);
      await evaluate(`widgetFixture.snapshot.accounts = widgetFixture.allAccounts.slice(0, ${count}); refresh(true)`);
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const layout = await evaluate(`(() => {
        const list = document.querySelector('.account-list');
        const last = list.lastElementChild.getBoundingClientRect();
        return { height: innerHeight, gap: list.getBoundingClientRect().bottom - last.bottom,
          overflow: list.scrollHeight - list.clientHeight };
      })()`);
      if (layout.height >= height - 1) {
        assert.ok(layout.gap >= -1 && layout.gap <= 4,
          `${count} accounts must fit without unused height below the last row: ${JSON.stringify(layout)}`);
      } else {
        assert.ok(layout.overflow > 1, "a screen-height-limited widget must keep the account list scrollable");
      }
    }

    const point = await evaluate(`(() => {
      const r = document.querySelector('.account-label').getBoundingClientRect();
      return { x: Math.round(r.left + 15), y: Math.round(r.top + 10) };
    })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    // Reproduce a timer refresh landing between pointerdown and click, with slight hand movement.
    await evaluate(`refresh(true)`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 3, y: point.y + 2, modifiers: ["leftButtonDown"] });
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x + 3, y: point.y + 2, button: "left", clickCount: 1 });
    assert.equal(await evaluate(`document.querySelectorAll('.account-quota-popover').length`), 1,
      "refresh and slight pointer motion during a click must not swallow the click");

    await evaluate(`(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const rows = () => [...document.querySelectorAll('.account-row')];
      const first = rows()[0];
      const popup = document.querySelector('.account-quota-popover');
      first.focus();
      widgetFixture.snapshot.accounts[0].quotaSnapshot.weekly = { usedPercent: 55, remainingPercent: 45 };
      await refresh(true);
      check(rows()[0] === first, 'refresh must preserve account row identity');
      check(document.activeElement === first, 'refresh must preserve keyboard focus');
      check(document.querySelector('.account-quota-popover') === popup, 'refresh must preserve the open popup');
      check(popup.textContent.includes('45%'), 'open popup must display the new quota');
      check(first.getAttribute('aria-expanded') === 'true', 'expanded accessibility state must remain true');
      check(!first.draggable && getComputedStyle(first).cursor === 'pointer', 'account surface must be for clicking');
      const handle = first.querySelector('.account-drag-handle');
      check(handle.draggable && getComputedStyle(handle).cursor === 'grab', 'only the handle offers dragging');
      first.dispatchEvent(new MouseEvent('mouseleave'));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
      await new Promise(resolve => setTimeout(resolve, 400));
      check(popup.isConnected, 'moving away must not dismiss a clicked popup');
      popup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      check(popup.isConnected, 'clicking inside must retain the popup');
      first.click();
      check(!popup.isConnected, 'clicking the same account must close');
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      check(first.getAttribute('aria-expanded') === 'true', 'Enter must open the account');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      check(!document.querySelector('.account-quota-popover'), 'Escape must close');
      first.click();
      document.querySelector('.section-title').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      check(!document.querySelector('.account-quota-popover'), 'outside pointerdown must close');
      first.click();
      rows()[1].click();
      check(first.getAttribute('aria-expanded') === 'false' && rows()[1].getAttribute('aria-expanded') === 'true',
        'another account must replace the popup');
      const button = rows()[1].querySelector('button');
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      check(rows()[1].getAttribute('aria-expanded') === 'true', 'button keyboard events must not toggle the account');
      const data = new DataTransfer();
      check(!first.querySelector('.account-label').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data })),
        'dragging from the label must be rejected');
      check(!document.querySelector('.dragging'), 'the rejected drag must not change order state');
      check(handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data })),
        'dragging from the handle must start');
      check(!document.querySelector('.account-quota-popover'), 'starting a reorder closes the popup');
      const list = document.querySelector('#accountList');
      list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: 10000 }));
      const draggedIds = rows().map(row => row.dataset.accountId).join();
      renderAccounts(widgetFixture.snapshot);
      check(rows().map(row => row.dataset.accountId).join() === draggedIds, 'an in-flight refresh must not interrupt dragging');
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      await new Promise(resolve => setTimeout(resolve, 0));
      check(widgetFixture.orders.length === 1 && widgetFixture.orders[0].at(-1) === first.dataset.accountId,
        'drop must persist the new account order');
      first.click();
      check(!document.querySelector('.account-quota-popover'), 'the trailing click after drag must be ignored');
      const beforeCancel = rows().map(row => row.dataset.accountId).join();
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientY: 0 }));
      handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      check(rows().map(row => row.dataset.accountId).join() === beforeCancel && widgetFixture.orders.length === 1,
        'cancelling drag must restore order without saving');
      await new Promise(resolve => setTimeout(resolve, 300));
      rows()[0].querySelector('button').click();
      await refresh(true);
      check(rows()[0].querySelector('button').disabled && rows()[0].querySelector('button').textContent === '切换中',
        'refresh must not re-enable a pending account switch');
      widgetFixture.finishSwitch();
      await new Promise(resolve => setTimeout(resolve, 0));
      rows()[0].querySelector('[data-action="reauth"]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      check(widgetFixture.switches.length === 1 && widgetFixture.logins.length === 1 && !document.querySelector('.account-quota-popover'),
        'action buttons must call only their own actions');
      rows()[0].click();
      widgetFixture.snapshot.accounts.shift();
      await refresh(true);
      check(!document.querySelector('.account-quota-popover'), 'removing the open account must close its popup');
      rows()[0].click();
      widgetFixture.popupBeforeTimer = document.querySelector('.account-quota-popover');
    })()`);
    // Let the real five-second refresh timer fire while the popup is open.
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(await evaluate(`document.querySelector('.account-quota-popover') === widgetFixture.popupBeforeTimer`), true);
    const screenshot = path.join(root, "widget.png");
    await fs.writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log("Widget interactions passed: no logo image/file drag, native pin movement lock, resize/dock guards, rotated icon, unpin/failure recovery, compact height for 2/7 accounts, screen-height overflow, native click across refresh, pointer motion, live popup updates, dismissal, keyboard, handle-only reorder, cancel, in-flight refresh and action isolation.");
    console.log(`Preview: ${screenshot}`);
    await evaluate(`widgetFixture.snapshot.settings = { language: "en" }; widgetFixture.notify({scope: "accounts"});
      new Promise(resolve => setTimeout(resolve, 60))`);
    assert.equal(await evaluate("document.documentElement.lang"), "en", "widget follows saved language changes");
    assert.equal(await evaluate("document.querySelector('#mainBtn').textContent"), "Main window");
    assert.equal(await evaluate("document.querySelector('#refreshBtn').textContent"), "Refresh");
    assert.equal(await evaluate("document.querySelector('#sessionReset').textContent"), "No data");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false, "English widget does not overflow");
    await evaluate("destroyAccountPopover()");
    const englishPreview = path.resolve(__dirname, "../output/playwright/widget-en.png");
    await fs.mkdir(path.dirname(englishPreview), {recursive: true});
    await fs.writeFile(englishPreview, (await win.webContents.capturePage()).toPNG());
    await evaluate(`widgetFixture.snapshot.settings.language = "zh-CN"; widgetFixture.notify({scope: "accounts"});
      new Promise(resolve => setTimeout(resolve, 60))`);
    assert.equal(await evaluate("document.querySelector('#mainBtn').textContent"), "主窗口");
    console.log("Widget language validation passed: live settings sync, English layout and switching back to Chinese.");
  } finally {
    ipcMain.removeHandler("widget-test:set-pinned");
    win.destroy();
  }
}

run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
