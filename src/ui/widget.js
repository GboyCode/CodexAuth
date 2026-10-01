const api = window.codexAuth;
const q = window.CodexQuotaUI;
const REFRESH_MS = 5000;
const OPACITY_KEY = "codex-auth-widget-opacity";

const els = {
  currentIdentity: document.querySelector("#currentIdentity"),
  sessionWindowTitle: document.querySelector("#sessionWindowTitle"),
  sessionPercent: document.querySelector("#sessionPercent"),
  sessionMeter: document.querySelector("#sessionMeter"),
  sessionReset: document.querySelector("#sessionReset"),
  weeklyPercent: document.querySelector("#weeklyPercent"),
  weeklyMeter: document.querySelector("#weeklyMeter"),
  weeklyReset: document.querySelector("#weeklyReset"),
  quotaFreshness: document.querySelector("#quotaFreshness"),
  resetCreditsInfo: document.querySelector("#resetCreditsInfo"),
  accountList: document.querySelector("#accountList"),
  refreshBtn: document.querySelector("#refreshBtn"),
  restartBtn: document.querySelector("#restartBtn"),
  mainBtn: document.querySelector("#mainBtn"),
  pinBtn: document.querySelector("#pinBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsPanel: document.querySelector("#settingsPanel"),
  opacityRange: document.querySelector("#opacityRange"),
  opacityValue: document.querySelector("#opacityValue"),
  hideBtn: document.querySelector("#hideBtn"),
  dockCollapseBtn: document.querySelector("#dockCollapseBtn"),
  dockCollapseIcon: document.querySelector("#dockCollapseIcon"),
  toast: document.querySelector("#toast"),
  resizeHandles: document.querySelectorAll("[data-resize-edge]"),
};

let loading = false;
let refreshQueued = false;
let toastTimer;
let resizeDrag = null;
let resizeFrame = null;
let accountListOverflowFrame = null;
let restartConfirmTimer = null;
let restartArmed = false;
let latestSnapshot = null;
let restartAfterSwitch = true;
let expandedAccountId = null;
let accountPopover = null;
let accountOrderDrag = null;
let suppressAccountClickUntil = 0;

function identityLabel(accountLike) {
  if (!accountLike) return "未检测到登录";
  return accountLike.email || accountLike.userId || accountLike.subject || "未知账号";
}

function renderQuotaFreshness(quota) {
  els.quotaFreshness.textContent = q.quotaFreshnessLabel(quota, { compact: true, inline: true });
  els.quotaFreshness.title = q.quotaFreshnessLabel(quota, { compact: true });
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function setDockHint(payload) {
  if (!els.dockCollapseBtn) return;
  if (!payload?.available || document.body.classList.contains("pinned")) {
    els.dockCollapseBtn.hidden = true;
    return;
  }

  els.dockCollapseIcon.textContent = ">";
  els.dockCollapseBtn.hidden = false;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return max;
  return Math.max(min, Math.min(max, number));
}

function applyWidgetOpacity(value) {
  const percent = Math.round(clampNumber(value, 0, 100));
  const alpha = percent / 100;
  const controlAlpha = Math.max(0.9, Math.min(0.98, alpha - 0.02));
  document.documentElement.style.setProperty("--widget-alpha", alpha.toFixed(2));
  document.documentElement.style.setProperty("--panel-alpha", alpha.toFixed(2));
  document.documentElement.style.setProperty("--control-alpha", controlAlpha.toFixed(2));
  els.opacityRange.value = String(percent);
  els.opacityValue.textContent = `${percent}%`;
  return percent;
}

function loadWidgetOpacity() {
  const saved = window.localStorage.getItem(OPACITY_KEY);
  applyWidgetOpacity(saved ?? els.opacityRange.value);
}

function setSettingsOpen(open) {
  els.settingsPanel.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
}

function applyPinState(pinned) {
  document.body.classList.toggle("pinned", pinned);
  if (pinned) {
    resizeDrag = null;
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
    document.body.classList.remove("resizing");
    setDockHint(null);
  }
  els.pinBtn.classList.toggle("active", pinned);
  els.pinBtn.setAttribute("aria-pressed", String(pinned));
  const label = pinned ? "取消钉住：恢复拖动" : "钉住：置顶并锁定位置";
  els.pinBtn.title = label;
  els.pinBtn.setAttribute("aria-label", label);
}

async function loadPinState() {
  try {
    const result = await api.getWidgetTopmost?.();
    applyPinState(result?.pinned === true);
  } catch {
    applyPinState(false);
  }
}

function resetRestartConfirm() {
  restartArmed = false;
  window.clearTimeout(restartConfirmTimer);
  restartConfirmTimer = null;
  els.restartBtn.textContent = "重启 Codex";
  els.restartBtn.classList.remove("confirming");
  els.restartBtn.disabled = false;
}

function renderWindow(kind, quotaWindow) {
  const percentEl = kind === "session" ? els.sessionPercent : els.weeklyPercent;
  const meterEl = kind === "session" ? els.sessionMeter : els.weeklyMeter;
  const resetEl = kind === "session" ? els.sessionReset : els.weeklyReset;
  const cardEl = percentEl.closest(".quota-line")?.closest(".quota-card") ?? percentEl.closest(".quota-card");
  if (kind === "session") {
    els.sessionWindowTitle.textContent = q.quotaWindowLabel(kind, quotaWindow);
  }
  cardEl?.classList.toggle("estimated", q.isEstimatedWindow(quotaWindow));
  if (!quotaWindow) {
    percentEl.textContent = "--";
    meterEl.parentElement?.classList.remove("estimated");
    meterEl.style.width = "0%";
    resetEl.textContent = "暂无数据";
    return;
  }
  const remainingPercent =
    q.displayRemainingPercent(quotaWindow) ?? 0;
  percentEl.textContent = q.formatRemainingText(quotaWindow);
  meterEl.parentElement?.classList.toggle("estimated", q.isEstimatedWindow(quotaWindow));
  meterEl.style.width = `${remainingPercent}%`;
  resetEl.textContent = q.formatUsedFootnote(quotaWindow, { compact: true });
}

function createAccountQuotaMetric(kind, quotaWindow) {
  const metric = document.createElement("div");
  metric.className = "account-quota-metric";

  const line = document.createElement("div");
  line.className = "account-quota-line";

  const label = document.createElement("span");
  label.textContent = q.quotaWindowLabel(kind, quotaWindow);

  const value = document.createElement("strong");
  value.textContent = q.formatRemainingText(quotaWindow);
  line.append(label, value);

  const meter = document.createElement("div");
  meter.className = q.isEstimatedWindow(quotaWindow) ? "account-quota-meter estimated" : "account-quota-meter";
  const fill = document.createElement("span");
  const remaining = q.displayRemainingPercent(quotaWindow);
  fill.style.width = remaining === null ? "0%" : `${remaining}%`;
  meter.append(fill);

  const foot = document.createElement("p");
  foot.textContent = quotaWindow ? q.formatUsedFootnote(quotaWindow, { compact: true }) : "暂无数据";

  metric.append(line, meter, foot);
  return metric;
}

function createAccountQuotaDetails(account) {
  const details = document.createElement("div");
  details.className = "account-quota-details";

  const snapshot = account.quotaSnapshot;
  const resets = document.createElement("p");
  resets.className = "account-reset-credits";
  resets.textContent = q.resetCreditsLabel(snapshot?.resetCredits, { compact: true });
  if (!snapshot) {
    const empty = document.createElement("p");
    empty.className = "account-quota-empty";
    empty.textContent = "暂无上次额度快照";
    details.append(empty, resets);
    return details;
  }

  const summary = document.createElement("div");
  summary.className = "account-quota-summary";
  const time = document.createElement("span");
  time.textContent = q.formatSnapshotTime(snapshot.checkedAt);
  const plan = document.createElement("strong");
  plan.textContent = q.formatPlanType(snapshot.planType || account.planType);
  summary.append(time, plan);

  if (account.onlineQuotaStatus?.error) {
    const note = document.createElement("p");
    note.className = "account-quota-empty";
    note.textContent = "在线查询失败，保留旧快照";
    details.append(note);
  }

  details.append(
    summary,
    resets,
    createAccountQuotaMetric("session", snapshot.session),
    createAccountQuotaMetric("weekly", snapshot.weekly)
  );
  return details;
}

function destroyAccountPopover() {
  accountPopover?.row?.classList.remove("expanded");
  accountPopover?.row?.setAttribute("aria-expanded", "false");
  accountPopover?.element?.remove();
  accountPopover = null;
  expandedAccountId = null;
}

function positionAccountPopover(popover, row) {
  const margin = 12;
  const gap = 8;
  const rect = row.getBoundingClientRect();
  const width = Math.min(window.innerWidth - margin * 2, Math.max(330, window.innerWidth - 48));
  const left = Math.round((window.innerWidth - width) / 2);
  const availableAbove = Math.max(128, rect.top - margin - gap);

  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.min(340, availableAbove)}px`;
  const height = popover.offsetHeight;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, rect.top - height - gap)}px`;
}

function showAccountPopover(account, row) {
  if (expandedAccountId === account.id && accountPopover) {
    destroyAccountPopover();
    return;
  }

  destroyAccountPopover();
  expandedAccountId = account.id;
  row.classList.add("expanded");
  row.setAttribute("aria-expanded", "true");

  const popover = document.createElement("div");
  popover.className = "account-quota-popover";
  popover.append(createAccountQuotaDetails(account));
  document.body.append(popover);
  positionAccountPopover(popover, row);

  accountPopover = { accountId: account.id, element: popover, row };
}

function updateAccountPopover(snapshot) {
  if (!accountPopover) return;
  const account = snapshot.accounts.find((item) => item.id === accountPopover.accountId);
  if (!account || !accountPopover.row.isConnected) {
    destroyAccountPopover();
    return;
  }
  const scrollTop = accountPopover.element.scrollTop;
  accountPopover.element.replaceChildren(createAccountQuotaDetails(account));
  positionAccountPopover(accountPopover.element, accountPopover.row);
  accountPopover.element.scrollTop = scrollTop;
}

function updateAccountListOverflow() {
  accountListOverflowFrame = null;
  els.accountList.classList.toggle(
    "scrollable",
    els.accountList.scrollHeight > els.accountList.clientHeight + 1
  );
}

function queueAccountListOverflowUpdate() {
  if (accountListOverflowFrame) window.cancelAnimationFrame(accountListOverflowFrame);
  accountListOverflowFrame = window.requestAnimationFrame(updateAccountListOverflow);
}

function accountRowIds() {
  return Array.from(els.accountList.querySelectorAll(".account-row"), (row) => row.dataset.accountId);
}

function clearAccountOrderDrag() {
  accountOrderDrag?.row?.classList.remove("dragging");
  els.accountList.classList.remove("reordering");
  accountOrderDrag = null;
  suppressAccountClickUntil = Date.now() + 250;
}

function moveDraggedAccountRow(pointerY) {
  if (!accountOrderDrag) return;
  const otherRows = Array.from(els.accountList.querySelectorAll(".account-row:not(.dragging)"));
  const nextRow = otherRows.find((row) => {
    const bounds = row.getBoundingClientRect();
    return pointerY < bounds.top + bounds.height / 2;
  });
  els.accountList.insertBefore(accountOrderDrag.row, nextRow ?? null);

  const listBounds = els.accountList.getBoundingClientRect();
  const edgeSize = 24;
  if (pointerY < listBounds.top + edgeSize) els.accountList.scrollTop -= 12;
  if (pointerY > listBounds.bottom - edgeSize) els.accountList.scrollTop += 12;
}

async function saveDraggedAccountOrder() {
  if (!accountOrderDrag) return;
  const originalIds = accountOrderDrag.originalIds;
  const accountIds = accountRowIds();
  clearAccountOrderDrag();
  if (accountIds.every((accountId, index) => accountId === originalIds[index])) return;

  try {
    const snapshot = await api.reorderAccounts(accountIds);
    render(snapshot, await api.getQuota());
    showToast("账号顺序已保存");
  } catch (error) {
    await refresh(true);
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function renderAccounts(snapshot) {
  // A refresh that started before a drag must not replace or reorder its targets.
  if (accountOrderDrag) return;
  latestSnapshot = snapshot;
  restartAfterSwitch = snapshot?.settings?.restartAfterSwitch !== false;
  const existingRows = new Map(Array.from(els.accountList.querySelectorAll(".account-row"),
    (row) => [row.dataset.accountId, row]));
  els.accountList.querySelector(".empty")?.remove();
  api.resizeWidget?.(snapshot.accounts.length).catch(() => {});
  if (!snapshot.accounts.length) {
    destroyAccountPopover();
    els.accountList.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无已保存账号";
    els.accountList.append(empty);
    queueAccountListOverflowUpdate();
    return;
  }
  snapshot.accounts.forEach((account, index) => {
    let row = existingRows.get(account.id);
    existingRows.delete(account.id);
    if (!row) {
      row = document.createElement("div");
      row.className = "account-row";
      row.dataset.accountId = account.id;
      row.title = "点击查看额度";
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-expanded", "false");
      row.addEventListener("click", (event) => {
        if (Date.now() < suppressAccountClickUntil) return;
        if (event.target instanceof HTMLElement && event.target.closest("button, .account-drag-handle")) return;
        const currentAccount = latestSnapshot.accounts.find((item) => item.id === account.id);
        if (currentAccount) showAccountPopover(currentAccount, row);
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const currentAccount = latestSnapshot.accounts.find((item) => item.id === account.id);
        if (currentAccount) showAccountPopover(currentAccount, row);
      });
      row.addEventListener("dragstart", (event) => {
        if (!(event.target instanceof HTMLElement) ||
            !event.target.closest(".account-drag-handle") || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        destroyAccountPopover();
        accountOrderDrag = { row, originalIds: accountRowIds() };
        row.classList.add("dragging");
        els.accountList.classList.add("reordering");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", account.id);
        event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
      });
      row.addEventListener("dragend", () => {
        if (!accountOrderDrag) return;
        const originalOrder = new Map(accountOrderDrag.originalIds.map((accountId, index) => [accountId, index]));
        const rows = Array.from(els.accountList.querySelectorAll(".account-row"));
        rows
          .sort((left, right) => originalOrder.get(left.dataset.accountId) - originalOrder.get(right.dataset.accountId))
          .forEach((accountRow) => els.accountList.append(accountRow));
        clearAccountOrderDrag();
      });

      const handle = document.createElement("span");
      handle.className = "account-drag-handle";
      handle.draggable = true;
      handle.title = "拖动调整账号顺序";
      handle.setAttribute("aria-hidden", "true");
      handle.textContent = "⠿";

      const label = document.createElement("div");
      label.className = "account-label";
      const name = document.createElement("strong");
      const meta = document.createElement("small");
      label.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "account-row-actions";

      const button = document.createElement("button");
      button.dataset.action = "switch";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        switchAccount(account.id, button);
      });

      const reauth = document.createElement("button");
      reauth.dataset.action = "reauth";
      reauth.addEventListener("click", (event) => {
        event.stopPropagation();
        reauthAccount(account.id, reauth);
      });
      actions.append(button, reauth);

      row.append(handle, label, actions);
    }

    row.querySelector("strong").textContent = account.displayName;
    row.querySelector("small").textContent = account.needsReauth
      ? "需要重新登录"
      : account.accessTokenExpired
        ? "切换后自动刷新"
        : account.isActive
          ? account.planType ? `当前账号 · ${q.formatPlanType(account.planType)}` : "当前账号"
          : account.planType ? `${identityLabel(account)} · ${q.formatPlanType(account.planType)}` : identityLabel(account);
    const button = row.querySelector('[data-action="switch"]');
    if (!button.hasAttribute("aria-busy")) {
      button.textContent = account.isActive ? "已启用" : "切换";
      button.className = account.isActive ? "" : "primary";
      button.disabled = account.isActive;
    }
    const reauth = row.querySelector('[data-action="reauth"]');
    if (!reauth.hasAttribute("aria-busy")) {
      reauth.textContent = account.needsReauth ? "登录" : "重登";
      reauth.className = account.needsReauth ? "primary" : "";
      reauth.disabled = false;
    }
    if (els.accountList.children[index] !== row) {
      els.accountList.insertBefore(row, els.accountList.children[index] ?? null);
    }
  });
  existingRows.forEach((row) => row.remove());
  updateAccountPopover(snapshot);
  queueAccountListOverflowUpdate();
}

function render(snapshot, dashboard) {
  els.currentIdentity.textContent = snapshot.current?.exists ? identityLabel(snapshot.current) : "未检测到登录";
  const quota = dashboard?.quota;
  renderWindow("session", quota?.session);
  renderWindow("weekly", quota?.weekly);
  renderQuotaFreshness(quota);
  els.resetCreditsInfo.textContent = q.resetCreditsLabel(quota?.resetCredits, { compact: true, inline: true });
  els.resetCreditsInfo.title = q.resetCreditsLabel(quota?.resetCredits);
  renderAccounts(snapshot);
}

async function refresh(silent = true) {
  if (accountOrderDrag) {
    if (!silent) refreshQueued = true;
    return;
  }
  if (loading) {
    if (!silent) refreshQueued = true;
    return;
  }
  loading = true;
  try {
    const [snapshot, dashboard] = await Promise.all([api.getState(), api.getQuota()]);
    render(snapshot, dashboard);
    if (!silent) showToast("已刷新本地数据");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    loading = false;
    if (refreshQueued) {
      refreshQueued = false;
      window.setTimeout(() => refresh(true), 0);
    }
  }
}

async function switchAccount(accountId, button) {
  destroyAccountPopover();
  const previous = button.textContent;
  button.setAttribute("aria-busy", "true");
  button.textContent = "切换中";
  button.disabled = true;
  try {
    await api.switchAccount(accountId, { restartCodex: restartAfterSwitch });
    button.removeAttribute("aria-busy");
    await refresh(true);
    showToast(restartAfterSwitch ? "已切换并重启 Codex" : "已切换账号");
  } catch (error) {
    button.textContent = previous;
    button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    button.removeAttribute("aria-busy");
  }
}

async function reauthAccount(accountId, button) {
  destroyAccountPopover();
  const previous = button.textContent;
  button.setAttribute("aria-busy", "true");
  button.textContent = "打开中";
  button.disabled = true;
  try {
    await api.reauthAccount(accountId);
    button.removeAttribute("aria-busy");
    await refresh(true);
    showToast("已打开 Codex 官方登录流程");
  } catch (error) {
    button.textContent = previous;
    button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    button.removeAttribute("aria-busy");
  }
}

function wireEvents() {
  els.refreshBtn.addEventListener("click", () => refresh(false));
  els.pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (els.pinBtn.disabled) return;
    const nextPinned = els.pinBtn.getAttribute("aria-pressed") !== "true";
    els.pinBtn.disabled = true;
    applyPinState(nextPinned);
    try {
      const result = await api.setWidgetTopmost?.(nextPinned);
      applyPinState(result?.pinned === true);
      showToast(result?.pinned ? "浮窗已钉住，位置已锁定" : "浮窗已取消钉住，可拖动");
    } catch (error) {
      applyPinState(!nextPinned);
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      els.pinBtn.disabled = false;
    }
  });
  els.settingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setSettingsOpen(els.settingsPanel.hidden);
  });
  els.settingsPanel.addEventListener("click", (event) => event.stopPropagation());
  els.opacityRange.addEventListener("input", () => {
    const percent = applyWidgetOpacity(els.opacityRange.value);
    window.localStorage.setItem(OPACITY_KEY, String(percent));
  });
  window.addEventListener("click", () => setSettingsOpen(false));
  window.addEventListener("pointerdown", (event) => {
    if (accountPopover && !accountPopover.row.contains(event.target) &&
        !accountPopover.element.contains(event.target)) destroyAccountPopover();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setSettingsOpen(false);
      destroyAccountPopover();
    }
  });
  window.addEventListener("resize", () => {
    if (accountPopover) positionAccountPopover(accountPopover.element, accountPopover.row);
    queueAccountListOverflowUpdate();
  });
  window.addEventListener("mouseenter", () => api.widgetPointerEnter?.().catch(() => {}));
  window.addEventListener("mouseleave", () => api.widgetPointerLeave?.().catch(() => {}));
  els.accountList.addEventListener("scroll", destroyAccountPopover);
  els.accountList.addEventListener("dragover", (event) => {
    if (!accountOrderDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    moveDraggedAccountRow(event.clientY);
  });
  els.accountList.addEventListener("drop", (event) => {
    if (!accountOrderDrag) return;
    event.preventDefault();
    saveDraggedAccountOrder();
  });
  els.restartBtn.addEventListener("click", async () => {
    if (!restartArmed) {
      restartArmed = true;
      els.restartBtn.textContent = "确认重启";
      els.restartBtn.classList.add("confirming");
      window.clearTimeout(restartConfirmTimer);
      restartConfirmTimer = window.setTimeout(resetRestartConfirm, 5000);
      showToast("再次点击确认重启 Codex");
      return;
    }
    window.clearTimeout(restartConfirmTimer);
    els.restartBtn.disabled = true;
    try {
      await api.restartCodex();
      showToast("已发送重启命令");
    } finally {
      resetRestartConfirm();
    }
  });
  els.mainBtn.addEventListener("click", () => api.showMainWindow());
  els.hideBtn.addEventListener("click", () => api.hideWidget());
  els.dockCollapseBtn?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const result = await api.collapseWidgetDock?.();
      if (!result?.ok) showToast("请先把浮窗贴近屏幕边缘");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  });
  api.onWidgetDockHint?.(setDockHint);
  api.onStateChanged((payload) => {
    if (payload?.scope === "accounts") {
      refresh(true);
      return;
    }
    if (payload?.scope === "quota") {
      refresh(true);
    }
  });
}

function flushResize() {
  resizeFrame = null;
  if (!resizeDrag) return;
  api.updateWidgetResize?.().catch(() => {});
}

function queueResize() {
  if (!resizeFrame) resizeFrame = window.requestAnimationFrame(flushResize);
}

function wireResizeHandles() {
  els.resizeHandles.forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || document.body.classList.contains("pinned")) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      resizeDrag = {
        edge: handle.dataset.resizeEdge,
        pointerId: event.pointerId,
      };
      api.startWidgetResize?.(resizeDrag.edge).catch(() => {});
      document.body.classList.add("resizing");
    });
  });

  window.addEventListener("pointermove", (event) => {
    if (!resizeDrag) return;
    event.preventDefault();
    queueResize();
  });

  window.addEventListener("pointerup", () => {
    api.endWidgetResize?.().catch(() => {});
    resizeDrag = null;
    document.body.classList.remove("resizing");
  });

  window.addEventListener("pointercancel", () => {
    api.endWidgetResize?.().catch(() => {});
    resizeDrag = null;
    document.body.classList.remove("resizing");
  });
}

wireEvents();
wireResizeHandles();
loadWidgetOpacity();
loadPinState();
refresh(true);
window.setInterval(() => {
  refresh(true);
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh(true);
});
