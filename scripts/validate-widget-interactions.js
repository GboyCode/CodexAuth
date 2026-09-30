const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

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
    webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.resolve(__dirname, "../src/ui/widget.html"));
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`document.querySelectorAll('.account-row').length`), 7);

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
    console.log("Widget interactions passed: native click across refresh, pointer motion, live popup updates, dismissal, keyboard, handle-only reorder, cancel, in-flight refresh and action isolation.");
    console.log(`Preview: ${screenshot}`);
  } finally {
    win.destroy();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.quit());
