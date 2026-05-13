const api = window.codexAuth;
const REFRESH_MS = 5000;
const OPACITY_KEY = "codex-auth-widget-opacity";

const els = {
  currentIdentity: document.querySelector("#currentIdentity"),
  sessionPercent: document.querySelector("#sessionPercent"),
  sessionMeter: document.querySelector("#sessionMeter"),
  sessionReset: document.querySelector("#sessionReset"),
  weeklyPercent: document.querySelector("#weeklyPercent"),
  weeklyMeter: document.querySelector("#weeklyMeter"),
  weeklyReset: document.querySelector("#weeklyReset"),
  quotaFreshness: document.querySelector("#quotaFreshness"),
  accountList: document.querySelector("#accountList"),
  refreshBtn: document.querySelector("#refreshBtn"),
  restartBtn: document.querySelector("#restartBtn"),
  mainBtn: document.querySelector("#mainBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsPanel: document.querySelector("#settingsPanel"),
  opacityRange: document.querySelector("#opacityRange"),
  opacityValue: document.querySelector("#opacityValue"),
  hideBtn: document.querySelector("#hideBtn"),
  toast: document.querySelector("#toast"),
  resizeHandles: document.querySelectorAll("[data-resize-edge]"),
};

let loading = false;
let refreshQueued = false;
let toastTimer;
let resizeDrag = null;
let resizeFrame = null;
let restartConfirmTimer = null;
let restartArmed = false;
let latestSnapshot = null;
let expandedAccountId = null;
let accountPopover = null;
let accountPopoverTimer = null;

function identityLabel(accountLike) {
  if (!accountLike) return "未检测到登录";
  return accountLike.email || accountLike.userId || accountLike.subject || "未知账号";
}

function formatPlanType(planType) {
  const value = String(planType || "").trim();
  if (!value) return "--";
  const normalized = value.toLowerCase();
  if (normalized === "team" || normalized === "business") return "Business";
  return value.toUpperCase();
}

function relativeReset(value) {
  if (!value) return "暂无重置时间";
  const diffMs = Number(value) * 1000 - Date.now();
  if (!Number.isFinite(diffMs)) return "暂无重置时间";
  if (diffMs <= 0) return "已到重置时间";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins} 分钟后重置`;
  const hours = Math.floor(mins / 60);
  const leftMins = mins % 60;
  if (hours < 48) return `${hours} 小时 ${leftMins} 分钟后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天后重置`;
}

function quotaFreshnessLabel(quota) {
  if (!quota?.checkedAt) return "快照时间未知";
  const date = new Date(quota.checkedAt);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) return "快照时间未知";
  const seconds = Math.max(0, Math.round(diffMs / 1000));
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
  const estimate = quotaEstimateStatusLabel(quota);
  if (seconds < 10) return `快照 ${time} · 刚写入${estimate}`;
  if (seconds < 60) return `快照 ${time} · ${seconds} 秒前${estimate}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 5) return `快照 ${time} · ${minutes} 分钟前${estimate}`;
  return `快照 ${time} · 等待 Codex 写入${estimate}`;
}

function renderQuotaFreshness(quota) {
  els.quotaFreshness.replaceChildren();
  const text = quotaFreshnessLabel(quota);
  const [snapshotPart, estimatePart] = text.split(" · 预估");
  const snapshot = document.createElement("span");
  snapshot.textContent = snapshotPart;
  els.quotaFreshness.append(snapshot);
  if (estimatePart) {
    const estimate = document.createElement("span");
    estimate.className = "estimate-line";
    estimate.textContent = `预估${estimatePart}`;
    els.quotaFreshness.append(estimate);
  }
}

function estimateRemainingLabel(quotaWindow) {
  const value = Number(quotaWindow?.estimatedRemainingPercent);
  const delta = Number(quotaWindow?.estimatedDeltaPercent);
  if (!Number.isFinite(value) || !Number.isFinite(delta) || delta <= 0) return "";
  return ` · 预估剩余 ${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function quotaEstimateStatusLabel(quota) {
  if (!quota?.estimate) return "";
  if (quota.estimate.available) return " · 已预估";
  return ` · 预估等待：${quota.estimate.reason || "本地新记录"}`;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function remainingPercent(quotaWindow) {
  const used = clampPercent(quotaWindow?.usedPercent);
  return used === null ? null : Math.max(0, 100 - used);
}

function displayRemainingPercent(quotaWindow) {
  const estimated = clampPercent(quotaWindow?.estimatedRemainingPercent);
  const delta = Number(quotaWindow?.estimatedDeltaPercent);
  if (estimated !== null && Number.isFinite(delta) && delta > 0) return estimated;
  return remainingPercent(quotaWindow);
}

function displayUsedPercent(quotaWindow) {
  const estimated = clampPercent(quotaWindow?.estimatedUsedPercent);
  const delta = Number(quotaWindow?.estimatedDeltaPercent);
  if (estimated !== null && Number.isFinite(delta) && delta > 0) return estimated;
  return clampPercent(quotaWindow?.usedPercent) ?? 0;
}

function quotaWindowLabel(kind, quotaWindow) {
  if (kind === "weekly") return "周额度";
  if (quotaWindow?.windowMinutes === 300) return "5 小时额度";
  if (quotaWindow?.windowMinutes) return `${Math.round(quotaWindow.windowMinutes / 60)} 小时额度`;
  return "会话额度";
}

function formatSnapshotTime(value) {
  if (!value) return "暂无快照时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "快照时间未知";
  return `快照 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2200);
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
  if (!quotaWindow) {
    percentEl.textContent = "--";
    meterEl.style.width = "0%";
    resetEl.textContent = "暂无数据";
    return;
  }
  const usedPercent = displayUsedPercent(quotaWindow);
  const remainingPercent = displayRemainingPercent(quotaWindow) ?? Math.max(0, Math.min(100, 100 - usedPercent));
  percentEl.textContent = `剩余 ${Math.round(remainingPercent)}%`;
  meterEl.style.width = `${remainingPercent}%`;
  resetEl.textContent = `已用 ${Math.round(usedPercent)}%${estimateRemainingLabel(
    quotaWindow
  )} · ${relativeReset(quotaWindow.resetsAt)}`;
}

function createAccountQuotaMetric(kind, quotaWindow) {
  const metric = document.createElement("div");
  metric.className = "account-quota-metric";

  const line = document.createElement("div");
  line.className = "account-quota-line";

  const label = document.createElement("span");
  label.textContent = quotaWindowLabel(kind, quotaWindow);

  const value = document.createElement("strong");
  const remaining = remainingPercent(quotaWindow);
  value.textContent = remaining === null ? "--" : `剩余 ${Math.round(remaining)}%`;
  line.append(label, value);

  const meter = document.createElement("div");
  meter.className = "account-quota-meter";
  const fill = document.createElement("span");
  fill.style.width = remaining === null ? "0%" : `${remaining}%`;
  meter.append(fill);

  const foot = document.createElement("p");
  const used = clampPercent(quotaWindow?.usedPercent);
  foot.textContent = quotaWindow ? `已用 ${Math.round(used ?? 0)}% · ${relativeReset(quotaWindow.resetsAt)}` : "暂无数据";

  metric.append(line, meter, foot);
  return metric;
}

function createAccountQuotaDetails(account) {
  const details = document.createElement("div");
  details.className = "account-quota-details";

  const snapshot = account.quotaSnapshot;
  if (!snapshot) {
    const empty = document.createElement("p");
    empty.className = "account-quota-empty";
    empty.textContent = "暂无上次额度快照";
    details.append(empty);
    return details;
  }

  const summary = document.createElement("div");
  summary.className = "account-quota-summary";
  const time = document.createElement("span");
  time.textContent = formatSnapshotTime(snapshot.checkedAt);
  const plan = document.createElement("strong");
  plan.textContent = formatPlanType(snapshot.planType || account.planType);
  summary.append(time, plan);

  details.append(
    summary,
    createAccountQuotaMetric("session", snapshot.session),
    createAccountQuotaMetric("weekly", snapshot.weekly)
  );
  return details;
}

function clearAccountPopoverTimer() {
  window.clearTimeout(accountPopoverTimer);
  accountPopoverTimer = null;
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
    if (expandedAccountId === accountId) destroyAccountPopover();
  }, 120);
}

function positionAccountPopover(popover, row) {
  const margin = 12;
  const gap = 8;
  const rect = row.getBoundingClientRect();
  const width = Math.min(window.innerWidth - margin * 2, Math.max(330, window.innerWidth - 48));
  const left = Math.round((window.innerWidth - width) / 2);
  const availableAbove = Math.max(128, rect.top - margin - gap);

  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.min(236, availableAbove)}px`;
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

function renderAccounts(snapshot) {
  latestSnapshot = snapshot;
  destroyAccountPopover();
  els.accountList.replaceChildren();
  api.resizeWidget?.(snapshot.accounts.length).catch(() => {});
  const visibleRows = Math.max(2, Math.min(4, snapshot.accounts.length || 2));
  els.accountList.style.setProperty("--visible-account-rows", String(visibleRows));
  els.accountList.classList.toggle("scrollable", snapshot.accounts.length > 4);
  if (!snapshot.accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无已保存账号";
    els.accountList.append(empty);
    return;
  }
  snapshot.accounts.forEach((account) => {
    const row = document.createElement("div");
    row.className = "account-row";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-expanded", "false");
    row.addEventListener("click", (event) => {
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

    const label = document.createElement("div");
    label.className = "account-label";
    const name = document.createElement("strong");
    name.textContent = account.displayName;
    const meta = document.createElement("small");
    meta.textContent = account.accessTokenExpired
      ? "登录快照已过期"
      : account.isActive
        ? account.planType
          ? `当前账号 · ${formatPlanType(account.planType)}`
          : "当前账号"
        : account.planType
          ? `${identityLabel(account)} · ${formatPlanType(account.planType)}`
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
}

function render(snapshot, dashboard) {
  els.currentIdentity.textContent = snapshot.current?.exists ? identityLabel(snapshot.current) : "未检测到登录";
  const quota = dashboard?.quota;
  renderWindow("session", quota?.session);
  renderWindow("weekly", quota?.weekly);
  renderQuotaFreshness(quota);
  renderAccounts(snapshot);
}

async function refresh(silent = true) {
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
    await api.switchAccount(accountId, { restartCodex: true });
    await refresh(true);
    showToast("已切换并重启 Codex");
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
  window.addEventListener("resize", destroyAccountPopover);
  els.accountList.addEventListener("scroll", destroyAccountPopover);
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
  api.onStateChanged(() => refresh(true));
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
refresh(true);
window.setInterval(() => {
  refresh(true);
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh(true);
});
