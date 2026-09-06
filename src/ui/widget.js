const api = window.codexAuth;
const q = window.CodexQuotaUI;
const REFRESH_MS = 5000;
const OPACITY_KEY = "codex-auth-widget-opacity";
const ACCOUNT_POPOVER_CLOSE_DELAY_MS = 320;
const ACCOUNT_POPOVER_SAFE_GAP_PX = 28;

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
let accountPopoverTimer = null;
let accountPopoverPointer = { x: Number.NaN, y: Number.NaN };
let accountOrderDrag = null;
let suppressAccountClickUntil = 0;

function identityLabel(accountLike) {
  if (!accountLike) return "未检测到登录";
  return accountLike.email || accountLike.userId || accountLike.subject || "未知账号";
}

function renderQuotaFreshness(quota) {
  const text = q.quotaFreshnessLabel(quota, { compact: true });
  els.quotaFreshness.textContent = text;
  els.quotaFreshness.title = text;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function setDockHint(payload) {
  if (!els.dockCollapseBtn) return;
  if (!payload?.available) {
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
  const percent = Math.round(clampNumber(value, 82, 100));
  const alpha = percent / 100;
  const panelAlpha = Math.max(0.88, Math.min(0.96, alpha - 0.04));
  const controlAlpha = Math.max(0.9, Math.min(0.98, alpha - 0.02));
  document.documentElement.style.setProperty("--widget-alpha", alpha.toFixed(2));
  document.documentElement.style.setProperty("--panel-alpha", panelAlpha.toFixed(2));
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
  els.pinBtn.classList.toggle("active", pinned);
  els.pinBtn.setAttribute("aria-pressed", String(pinned));
  els.pinBtn.title = pinned ? "取消固定" : "固定在最前";
  els.pinBtn.setAttribute("aria-label", pinned ? "取消固定" : "固定在最前");
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
  resets.textContent = q.resetCreditsLabel(snapshot?.resetCredits);
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

  if (!account.isActive) {
    const note = document.createElement("p");
    note.className = "account-quota-empty";
    note.textContent = "该账号上次保存的本地快照";
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

function clearAccountPopoverTimer() {
  window.clearTimeout(accountPopoverTimer);
  accountPopoverTimer = null;
}

function trackAccountPopoverPointer(event) {
  accountPopoverPointer = { x: event.clientX, y: event.clientY };
}

function pointerWithinRect(point, rect, padding = 0) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return (
    point.x >= rect.left - padding &&
    point.x <= rect.right + padding &&
    point.y >= rect.top - padding &&
    point.y <= rect.bottom + padding
  );
}

function pointerWithinPopoverZone(accountId) {
  if (!accountPopover || accountPopover.accountId !== accountId) return false;
  const rowRect = accountPopover.row.getBoundingClientRect();
  const popoverRect = accountPopover.element.getBoundingClientRect();
  const bridgeRect = {
    left: Math.min(rowRect.left, popoverRect.left),
    right: Math.max(rowRect.right, popoverRect.right),
    top: Math.min(rowRect.top, popoverRect.top),
    bottom: Math.max(rowRect.bottom, popoverRect.bottom),
  };
  return (
    pointerWithinRect(accountPopoverPointer, rowRect, ACCOUNT_POPOVER_SAFE_GAP_PX) ||
    pointerWithinRect(accountPopoverPointer, popoverRect, ACCOUNT_POPOVER_SAFE_GAP_PX) ||
    pointerWithinRect(accountPopoverPointer, bridgeRect, 8)
  );
}

function destroyAccountPopover() {
  clearAccountPopoverTimer();
  accountPopover?.row?.classList.remove("expanded");
  accountPopover?.row?.setAttribute("aria-expanded", "false");
  accountPopover?.element?.remove();
  accountPopover = null;
  expandedAccountId = null;
}

function scheduleAccountPopoverClose(accountId) {
  if (expandedAccountId !== accountId) return;
  clearAccountPopoverTimer();
  accountPopoverTimer = window.setTimeout(() => {
    if (expandedAccountId !== accountId) return;
    if (pointerWithinPopoverZone(accountId)) {
      scheduleAccountPopoverClose(accountId);
      return;
    }
    destroyAccountPopover();
  }, ACCOUNT_POPOVER_CLOSE_DELAY_MS);
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

  const popover = document.createElement("div");
  popover.className = "account-quota-popover";
  popover.append(createAccountQuotaDetails(account));
  document.body.append(popover);
  positionAccountPopover(popover, row);

  popover.addEventListener("mouseenter", clearAccountPopoverTimer);
  popover.addEventListener("mouseleave", () => scheduleAccountPopoverClose(account.id));
  accountPopover = { accountId: account.id, element: popover, row };
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
  latestSnapshot = snapshot;
  restartAfterSwitch = snapshot?.settings?.restartAfterSwitch !== false;
  destroyAccountPopover();
  els.accountList.replaceChildren();
  api.resizeWidget?.(snapshot.accounts.length).catch(() => {});
  if (!snapshot.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无已保存账号";
    els.accountList.append(empty);
    queueAccountListOverflowUpdate();
    return;
  }
  snapshot.accounts.forEach((account) => {
    const row = document.createElement("div");
    row.className = "account-row";
    row.dataset.accountId = account.id;
    row.draggable = true;
    row.title = "按住拖动可调整顺序";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-expanded", "false");
    row.addEventListener("click", (event) => {
      if (Date.now() < suppressAccountClickUntil) return;
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      row.setAttribute("aria-expanded", expandedAccountId === account.id ? "false" : "true");
      showAccountPopover(account, row);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      row.setAttribute("aria-expanded", expandedAccountId === account.id ? "false" : "true");
      showAccountPopover(account, row);
    });
    row.addEventListener("mouseenter", clearAccountPopoverTimer);
    row.addEventListener("mouseleave", () => scheduleAccountPopoverClose(account.id));
    let dragAllowed = false;
    row.addEventListener("pointerdown", (event) => {
      dragAllowed =
        event.button === 0 &&
        !(event.target instanceof HTMLElement && event.target.closest("button"));
    });
    row.addEventListener("pointerup", () => {
      dragAllowed = false;
    });
    row.addEventListener("pointercancel", () => {
      dragAllowed = false;
    });
    row.addEventListener("dragstart", (event) => {
      if (!dragAllowed || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      destroyAccountPopover();
      accountOrderDrag = { row, originalIds: accountRowIds() };
      row.classList.add("dragging");
      els.accountList.classList.add("reordering");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", account.id);
    });
    row.addEventListener("dragend", () => {
      dragAllowed = false;
      if (!accountOrderDrag) return;
      const originalOrder = new Map(accountOrderDrag.originalIds.map((accountId, index) => [accountId, index]));
      const rows = Array.from(els.accountList.querySelectorAll(".account-row"));
      rows
        .sort((left, right) => originalOrder.get(left.dataset.accountId) - originalOrder.get(right.dataset.accountId))
        .forEach((accountRow) => els.accountList.append(accountRow));
      clearAccountOrderDrag();
    });

    const label = document.createElement("div");
    label.className = "account-label";
    const name = document.createElement("strong");
    name.textContent = account.displayName;
    const meta = document.createElement("small");
    meta.textContent = account.needsReauth
      ? "需要重新登录"
      : account.accessTokenExpired
        ? "切换后自动刷新"
        : account.isActive
        ? account.planType
          ? `当前账号 · ${q.formatPlanType(account.planType)}`
          : "当前账号"
        : account.planType
          ? `${identityLabel(account)} · ${q.formatPlanType(account.planType)}`
          : identityLabel(account);
    label.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "account-row-actions";

    const button = document.createElement("button");
    button.textContent = account.isActive ? "已启用" : "切换";
    button.className = account.isActive ? "" : "primary";
    button.disabled = account.isActive;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      switchAccount(account.id, button);
    });

    const reauth = document.createElement("button");
    reauth.textContent = account.needsReauth ? "登录" : "重登";
    reauth.className = account.needsReauth ? "primary" : "";
    reauth.addEventListener("click", (event) => {
      event.stopPropagation();
      reauthAccount(account.id, reauth);
    });
    actions.append(button, reauth);

    row.append(label, actions);
    els.accountList.append(row);
  });
  queueAccountListOverflowUpdate();
}

function render(snapshot, dashboard) {
  els.currentIdentity.textContent = snapshot.current?.exists ? identityLabel(snapshot.current) : "未检测到登录";
  const quota = dashboard?.quota;
  renderWindow("session", quota?.session);
  renderWindow("weekly", quota?.weekly);
  renderQuotaFreshness(quota);
  els.resetCreditsInfo.textContent=q.resetCreditsLabel(quota?.resetCredits,{compact:true});
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
  const previous = button.textContent;
  button.textContent = "切换中";
  button.disabled = true;
  try {
    await api.switchAccount(accountId, { restartCodex: restartAfterSwitch });
    await refresh(true);
    showToast(restartAfterSwitch ? "已切换并重启 Codex" : "已切换账号");
  } catch (error) {
    button.textContent = previous;
    button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function reauthAccount(accountId, button) {
  const previous = button.textContent;
  button.textContent = "打开中";
  button.disabled = true;
  try {
    await api.reauthAccount(accountId);
    await refresh(true);
    showToast("已打开 Codex 官方登录流程");
  } catch (error) {
    button.textContent = previous;
    button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function wireEvents() {
  els.refreshBtn.addEventListener("click", () => refresh(false));
  els.pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const nextPinned = els.pinBtn.getAttribute("aria-pressed") !== "true";
    applyPinState(nextPinned);
    try {
      const result = await api.setWidgetTopmost?.(nextPinned);
      applyPinState(result?.pinned === true);
      showToast(result?.pinned ? "浮窗已固定在最前" : "浮窗已取消固定");
    } catch (error) {
      applyPinState(!nextPinned);
      showToast(error instanceof Error ? error.message : String(error));
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
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setSettingsOpen(false);
      destroyAccountPopover();
    }
  });
  window.addEventListener("resize", () => {
    destroyAccountPopover();
    queueAccountListOverflowUpdate();
  });
  window.addEventListener("mousemove", trackAccountPopoverPointer, { passive: true });
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
      if (event.button !== 0) return;
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
