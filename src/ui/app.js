const api = window.codexAuth;
const DASHBOARD_AUTO_REFRESH_MS = 8000;

const state = {
  snapshot: null,
  pendingDelete: null,
  pendingRename: null,
  activePage: "accounts",
  expandedAccountId: null,
  dashboardLoaded: false,
  dashboardLoading: false,
  quotaLoading: false,
  quotaRefreshQueued: false,
  dashboardRefreshTimer: null,
};

const els = {
  accountsTab: document.querySelector("#accountsTab"),
  usageTab: document.querySelector("#usageTab"),
  accountsPage: document.querySelector("#accountsPage"),
  usagePage: document.querySelector("#usagePage"),
  refreshBtn: document.querySelector("#refreshBtn"),
  widgetBtn: document.querySelector("#widgetBtn"),
  restartBtn: document.querySelector("#restartBtn"),
  currentIdentity: document.querySelector("#currentIdentity"),
  currentPath: document.querySelector("#currentPath"),
  accountCount: document.querySelector("#accountCount"),
  storePath: document.querySelector("#storePath"),
  displayNameInput: document.querySelector("#displayNameInput"),
  importBtn: document.querySelector("#importBtn"),
  accountList: document.querySelector("#accountList"),
  restartAfterSwitch: document.querySelector("#restartAfterSwitch"),
  statsRefreshBtn: document.querySelector("#statsRefreshBtn"),
  sessionWindowTitle: document.querySelector("#sessionWindowTitle"),
  sessionPercent: document.querySelector("#sessionPercent"),
  sessionMeter: document.querySelector("#sessionMeter"),
  sessionReset: document.querySelector("#sessionReset"),
  weeklyWindowTitle: document.querySelector("#weeklyWindowTitle"),
  weeklyPercent: document.querySelector("#weeklyPercent"),
  weeklyMeter: document.querySelector("#weeklyMeter"),
  weeklyReset: document.querySelector("#weeklyReset"),
  planType: document.querySelector("#planType"),
  quotaSource: document.querySelector("#quotaSource"),
  creditsInfo: document.querySelector("#creditsInfo"),
  totalTokens: document.querySelector("#totalTokens"),
  inputTokens: document.querySelector("#inputTokens"),
  outputTokens: document.querySelector("#outputTokens"),
  sessionCount: document.querySelector("#sessionCount"),
  dailyBars: document.querySelector("#dailyBars"),
  recentSessions: document.querySelector("#recentSessions"),
  toast: document.querySelector("#toast"),
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmTitle: document.querySelector("#confirmTitle"),
  confirmBody: document.querySelector("#confirmBody"),
  confirmOk: document.querySelector("#confirmOk"),
  renameDialog: document.querySelector("#renameDialog"),
  renameInput: document.querySelector("#renameInput"),
  renameOk: document.querySelector("#renameOk"),
};

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

function formatDate(value) {
  if (!value) return "从未切换";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(Math.round(number));
}

function relativeReset(value) {
  if (!value) return "重置时间不可用";
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return "重置时间不可用";
  if (date.getTime() <= Date.now()) return "已到重置时间";
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (date.toDateString() === now.toDateString()) return `${time} 重置`;
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time} 重置`;
  const day = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${day} ${time} 重置`;
}

function windowTitle(kind, quotaWindow) {
  if (kind === "weekly") return "周额度";
  if (quotaWindow?.windowMinutes === 300) return "5 小时额度";
  if (quotaWindow?.windowMinutes) return `${Math.round(quotaWindow.windowMinutes / 60)} 小时额度`;
  return "会话额度";
}

function quotaSourceLabel(source) {
  if (source === "official") return "来自本地保存的额度快照";
  if (source === "local") return "来自本地 Codex 日志";
  if (source === "local-error") return "来自本地 Codex 限额日志";
  if (source === "account-cache") return "此账号上次本地快照";
  return "不可用";
}

function usageScopeLabel(scope, quota) {
  if (quota?.source === "account-cache") return "等待当前账号新快照";
  if (scope?.since) return `当前账号自 ${formatDate(scope.since)} 后`;
  return "全部本地日志";
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
  if (seconds < 10) return `快照 ${time} · 刚写入`;
  if (seconds < 60) return `快照 ${time} · ${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 5) return `快照 ${time} · ${minutes} 分钟前`;
  return `快照 ${time} · 等待 Codex 写入下一条额度记录`;
}

function estimateRemainingLabel(window) {
  const value = Number(window?.estimatedRemainingPercent);
  const delta = Number(window?.estimatedDeltaPercent);
  if (!Number.isFinite(value) || !Number.isFinite(delta) || delta <= 0) return "";
  return ` · 预估剩余 ${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function quotaEstimateStatusLabel(quota) {
  if (!quota?.estimate) return "";
  if (quota.estimate.available) return " · 已按本地增量预估";
  return ` · 预估等待：${quota.estimate.reason || "本地新记录"}`;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function remainingPercent(window) {
  const used = clampPercent(window?.usedPercent);
  return used === null ? null : Math.max(0, 100 - used);
}

function displayRemainingPercent(window) {
  const estimated = clampPercent(window?.estimatedRemainingPercent);
  const delta = Number(window?.estimatedDeltaPercent);
  if (estimated !== null && Number.isFinite(delta) && delta > 0) return estimated;
  return remainingPercent(window);
}

function displayUsedPercent(window) {
  const estimated = clampPercent(window?.estimatedUsedPercent);
  const delta = Number(window?.estimatedDeltaPercent);
  if (estimated !== null && Number.isFinite(delta) && delta > 0) return estimated;
  return clampPercent(window?.usedPercent) ?? 0;
}

function quotaWindowLabel(kind, window) {
  if (kind === "weekly") return "周额度";
  if (window?.windowMinutes === 300) return "5 小时额度";
  if (window?.windowMinutes) return `${Math.round(window.windowMinutes / 60)} 小时额度`;
  return "会话额度";
}

function snapshotTimeLabel(snapshot) {
  if (!snapshot?.checkedAt) return "暂无快照时间";
  return `快照 ${formatDate(snapshot.checkedAt)}`;
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2600);
}

function setBusy(element, busy, text) {
  if (!element) return;
  if (busy) {
    element.dataset.previousText = element.textContent;
    element.textContent = text;
    element.disabled = true;
    return;
  }
  element.textContent = element.dataset.previousText || element.textContent;
  element.disabled = false;
}

async function withAction(element, busyText, task) {
  try {
    setBusy(element, true, busyText);
    await task();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(element, false);
  }
}

function startDashboardAutoRefresh() {
  if (!state.dashboardRefreshTimer) {
    state.dashboardRefreshTimer = window.setInterval(() => {
      if (state.activePage !== "usage") return;
      loadDashboard(true, { busy: false }).catch((error) => showToast(error.message));
    }, DASHBOARD_AUTO_REFRESH_MS);
  }
}

function stopDashboardAutoRefresh() {
  if (state.dashboardRefreshTimer) {
    window.clearInterval(state.dashboardRefreshTimer);
    state.dashboardRefreshTimer = null;
  }
}

function setActivePage(page) {
  const isUsage = page === "usage";
  state.activePage = isUsage ? "usage" : "accounts";

  els.accountsPage.classList.toggle("active", !isUsage);
  els.usagePage.classList.toggle("active", isUsage);
  els.accountsTab.classList.toggle("active", !isUsage);
  els.usageTab.classList.toggle("active", isUsage);
  els.accountsTab.setAttribute("aria-selected", String(!isUsage));
  els.usageTab.setAttribute("aria-selected", String(isUsage));

  if (isUsage) {
    startDashboardAutoRefresh();
  } else {
    stopDashboardAutoRefresh();
  }

  if (isUsage && !state.dashboardLoaded) {
    loadDashboard(true, { busy: false }).catch((error) => showToast(error.message));
  } else if (isUsage) {
    readQuota(true).catch((error) => showToast(error.message));
  }
}

function renderStatus(snapshot) {
  const current = snapshot.current;
  if (current?.exists && !current.error) {
    els.currentIdentity.textContent = identityLabel(current);
  } else if (current?.exists && current.error) {
    els.currentIdentity.textContent = "auth.json 无法识别";
  } else {
    els.currentIdentity.textContent = "未找到 auth.json";
  }
  els.currentPath.textContent = current?.error ? `${snapshot.authPath} · ${current.error}` : snapshot.authPath;
  els.accountCount.textContent = `${snapshot.accounts.length} 个账号`;
  els.storePath.textContent = snapshot.storeRoot;
  els.storePath.title = "打开保险箱目录";
}

function createAccountQuotaMetric(kind, window) {
  const metric = document.createElement("div");
  metric.className = "account-quota-metric";

  const head = document.createElement("div");
  head.className = "account-quota-head";

  const label = document.createElement("span");
  label.textContent = quotaWindowLabel(kind, window);

  const value = document.createElement("strong");
  const remaining = remainingPercent(window);
  value.textContent = remaining === null ? "--" : `剩余 ${Math.round(remaining)}%`;
  head.append(label, value);

  const meter = document.createElement("div");
  meter.className = "account-quota-meter";
  const fill = document.createElement("span");
  fill.style.width = remaining === null ? "0%" : `${remaining}%`;
  meter.append(fill);

  const foot = document.createElement("p");
  foot.className = "account-quota-foot";
  if (!window) {
    foot.textContent = "暂无数据";
  } else {
    const used = clampPercent(window.usedPercent) ?? 0;
    foot.textContent = `已用 ${Math.round(used)}% · ${relativeReset(window.resetsAt)}`;
  }

  metric.append(head, meter, foot);
  return metric;
}

function createAccountQuotaDetails(account) {
  const details = document.createElement("section");
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

  const source = document.createElement("span");
  source.textContent = `${snapshotTimeLabel(snapshot)} · ${quotaSourceLabel(snapshot.source)}`;

  const plan = document.createElement("strong");
  plan.textContent = formatPlanType(snapshot.planType || account.planType);
  summary.append(source, plan);

  const grid = document.createElement("div");
  grid.className = "account-quota-grid";
  grid.append(createAccountQuotaMetric("session", snapshot.session), createAccountQuotaMetric("weekly", snapshot.weekly));

  details.append(summary, grid);
  return details;
}

function toggleAccountDetails(accountId) {
  state.expandedAccountId = state.expandedAccountId === accountId ? null : accountId;
  if (state.snapshot) renderAccounts(state.snapshot);
}

function accountCard(account) {
  const card = document.createElement("article");
  const expanded = state.expandedAccountId === account.id;
  card.className = expanded ? "account-card expanded" : "account-card";

  const main = document.createElement("div");
  main.className = "account-main";
  main.setAttribute("role", "button");
  main.setAttribute("tabindex", "0");
  main.setAttribute("aria-expanded", String(expanded));
  main.title = expanded ? "收起上次额度快照" : "查看上次额度快照";
  main.addEventListener("click", () => toggleAccountDetails(account.id));
  main.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleAccountDetails(account.id);
  });

  const line = document.createElement("div");
  line.className = "account-name-line";

  const name = document.createElement("h3");
  name.className = "account-name";
  name.textContent = account.displayName;
  line.append(name);

  if (account.isActive) {
    const pill = document.createElement("span");
    pill.className = "active-pill";
    pill.textContent = "当前";
    line.append(pill);
  }

  const meta = document.createElement("div");
  meta.className = "account-meta";
  const identity = document.createElement("span");
  identity.textContent = account.planType ? `${identityLabel(account)} · ${formatPlanType(account.planType)}` : identityLabel(account);
  const switched = document.createElement("span");
  switched.textContent = account.needsReauth
    ? account.reauthReason || "需要重新登录"
    : account.accessTokenExpired
    ? "登录快照已过期，可能需要官网认证"
    : account.lastSyncedAt
      ? `最近同步 ${formatDate(account.lastSyncedAt)}`
      : `最近切换 ${formatDate(account.lastSwitchedAt)}`;
  meta.append(identity, switched);

  main.append(line, meta);

  const quotaToggle = document.createElement("button");
  quotaToggle.type = "button";
  quotaToggle.className = "account-expand-cue";
  quotaToggle.textContent = expanded ? "收起额度" : "查看额度";
  quotaToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountDetails(account.id);
  });

  const actions = document.createElement("div");
  actions.className = "account-actions";

  const rename = document.createElement("button");
  rename.className = "account-action";
  rename.textContent = "重命名";
  rename.addEventListener("click", () => renameAccount(account));

  const switchBtn = document.createElement("button");
  switchBtn.className = account.isActive ? "account-action" : "account-action primary";
  switchBtn.textContent = account.isActive ? "已启用" : "切换";
  switchBtn.disabled = account.isActive;
  switchBtn.addEventListener("click", () => switchToAccount(account, switchBtn));

  const reauth = document.createElement("button");
  reauth.className = account.needsReauth ? "account-action primary" : "account-action";
  reauth.textContent = "重新登录";
  reauth.addEventListener("click", () => reauthAccount(account, reauth));

  const del = document.createElement("button");
  del.className = "account-action danger";
  del.textContent = "删除";
  del.addEventListener("click", () => confirmDelete(account));

  actions.append(rename, switchBtn, reauth, del);
  card.append(main, quotaToggle, actions);
  if (expanded) card.append(createAccountQuotaDetails(account));
  return card;
}

function renderAccounts(snapshot) {
  els.accountList.replaceChildren();
  if (state.expandedAccountId && !snapshot.accounts.some((account) => account.id === state.expandedAccountId)) {
    state.expandedAccountId = null;
  }
  if (!snapshot.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无账号。先在 Codex App 登录一个账号，然后导入当前登录。";
    els.accountList.append(empty);
    return;
  }
  snapshot.accounts.forEach((account) => {
    els.accountList.append(accountCard(account));
  });
}

function renderQuotaWindow(kind, window) {
  const percentEl = kind === "session" ? els.sessionPercent : els.weeklyPercent;
  const meterEl = kind === "session" ? els.sessionMeter : els.weeklyMeter;
  const resetEl = kind === "session" ? els.sessionReset : els.weeklyReset;
  const titleEl = kind === "session" ? els.sessionWindowTitle : els.weeklyWindowTitle;
  titleEl.textContent = windowTitle(kind, window);
  if (!window) {
    percentEl.textContent = "--";
    meterEl.style.width = "0%";
    resetEl.textContent = "暂无数据";
    return;
  }
  const usedPercent = displayUsedPercent(window);
  const remainingPercent = displayRemainingPercent(window) ?? Math.max(0, Math.min(100, 100 - usedPercent));
  percentEl.textContent = `剩余 ${Math.round(remainingPercent)}%`;
  meterEl.style.width = `${remainingPercent}%`;
  resetEl.textContent = `已用 ${Math.round(usedPercent)}%${estimateRemainingLabel(window)} · ${relativeReset(
    window.resetsAt
  )}`;
}

function renderQuotaPanel(dashboard) {
  const quota = dashboard?.quota;
  renderQuotaWindow("session", quota?.session);
  renderQuotaWindow("weekly", quota?.weekly);
  els.planType.textContent = formatPlanType(quota?.planType);
  const sourceText = `${quotaSourceLabel(quota?.source)} · ${usageScopeLabel(dashboard?.scope, quota)} · ${quotaFreshnessLabel(
    quota
  )}${quotaEstimateStatusLabel(quota)}`;
  els.quotaSource.textContent = quota?.error ? `${sourceText} · ${quota.error}` : sourceText;
  els.creditsInfo.textContent =
    quota?.credits?.balance !== undefined && quota?.credits?.balance !== null
      ? `余额 ${quota.credits.balance}`
      : "余额 --";
}

function renderDashboard(dashboard) {
  state.dashboardLoaded = true;
  renderQuotaPanel(dashboard);

  const usage = dashboard?.usage;
  const tokenUsage = usage?.tokenUsage || {};
  els.totalTokens.textContent = compactNumber(tokenUsage.totalTokens);
  els.inputTokens.textContent = compactNumber(tokenUsage.inputTokens);
  els.outputTokens.textContent = compactNumber(tokenUsage.outputTokens);
  els.sessionCount.textContent = String(usage?.sessionsAnalyzed ?? 0);
  renderDailyBars(usage?.daily || []);
  renderRecentSessions(usage?.recentSessions || []);
}

function renderDailyBars(days) {
  els.dailyBars.replaceChildren();
  const title = document.createElement("p");
  title.className = "usage-title";
  title.textContent = "每日 Tokens";
  els.dailyBars.append(title);

  if (!days.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "未找到本地用量。";
    els.dailyBars.append(empty);
    return;
  }

  const maxTokens = Math.max(...days.map((day) => day.tokenUsage?.totalTokens || 0), 1);
  const bars = document.createElement("div");
  bars.className = "bars";
  days.forEach((day) => {
    const item = document.createElement("div");
    item.className = "bar-item";
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(8, ((day.tokenUsage?.totalTokens || 0) / maxTokens) * 100)}%`;
    const label = document.createElement("em");
    label.textContent = day.day.slice(5);
    const value = document.createElement("small");
    value.textContent = compactNumber(day.tokenUsage?.totalTokens);
    item.append(value, bar, label);
    bars.append(item);
  });
  els.dailyBars.append(bars);
}

function renderRecentSessions(sessions) {
  els.recentSessions.replaceChildren();
  const title = document.createElement("p");
  title.className = "usage-title";
  title.textContent = "最近会话";
  els.recentSessions.append(title);

  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "未找到本地会话。";
    els.recentSessions.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "session-list";
  sessions.slice(0, 6).forEach((session) => {
    const row = document.createElement("div");
    row.className = "session-row";
    const main = document.createElement("span");
    main.textContent = session.title || "会话";
    const sub = document.createElement("small");
    sub.textContent = `${compactNumber(session.tokenUsage?.totalTokens)} tokens · ${session.model || "未知模型"} · ${formatDate(session.updatedAt)}`;
    row.append(main, sub);
    list.append(row);
  });
  els.recentSessions.append(list);
}

function render(snapshot) {
  state.snapshot = snapshot;
  renderStatus(snapshot);
  renderAccounts(snapshot);
}

async function refresh(silent = false) {
  const snapshot = await api.getState();
  render(snapshot);
  if (state.activePage === "usage") {
    await loadDashboard(true, { busy: false });
  } else {
    state.dashboardLoaded = false;
  }
  if (!silent) showToast("已刷新");
}

async function readQuota(silent = true) {
  if (state.quotaLoading) {
    if (!silent) state.quotaRefreshQueued = true;
    return;
  }
  state.quotaLoading = true;
  try {
    const quotaDashboard = await api.getQuota();
    renderQuotaPanel(quotaDashboard);
    if (!silent) showToast("额度已刷新");
  } finally {
    state.quotaLoading = false;
    if (state.quotaRefreshQueued) {
      state.quotaRefreshQueued = false;
      window.setTimeout(() => readQuota(true), 0);
    }
  }
}

async function readDashboard(silent) {
  if (state.dashboardLoading) return;
  state.dashboardLoading = true;
  try {
    const dashboard = await api.getDashboard();
    renderDashboard(dashboard);
    if (!silent) showToast("额度与用量已刷新");
  } finally {
    state.dashboardLoading = false;
  }
}

async function loadDashboard(silent = false, options = {}) {
  if (options.busy === false) {
    await readDashboard(silent);
    return;
  }
  await withAction(els.statsRefreshBtn, "刷新中", () => readDashboard(silent));
}

async function importCurrent() {
  await withAction(els.importBtn, "导入中", async () => {
    const snapshot = await api.importCurrent(els.displayNameInput.value);
    els.displayNameInput.value = "";
    render(snapshot);
    state.dashboardLoaded = false;
    if (state.activePage === "usage") await loadDashboard(true, { busy: false });
    showToast("已导入当前 Codex 登录");
  });
}

async function switchToAccount(account, button) {
  await withAction(button, "切换中", async () => {
    const snapshot = await api.switchAccount(account.id, {
      restartCodex: els.restartAfterSwitch.checked,
    });
    render(snapshot);
    state.dashboardLoaded = false;
    if (state.activePage === "usage") await loadDashboard(true, { busy: false });
    showToast(els.restartAfterSwitch.checked ? "已切换并重启 Codex App" : "已切换账号");
  });
}

async function reauthAccount(account, button) {
  const ok = window.confirm(`重新登录 ${account.displayName}？\n\n会加密备份当前 auth.json，然后清除当前 Codex 本地登录并重启 Codex App。`);
  if (!ok) return;
  await withAction(button, "打开中", async () => {
    const snapshot = await api.reauthAccount(account.id);
    render(snapshot);
    state.dashboardLoaded = false;
    showToast("已打开 Codex 官方登录流程");
  });
}

async function renameAccount(account) {
  state.pendingRename = account;
  els.renameInput.value = account.displayName;
  els.renameDialog.showModal();
  window.setTimeout(() => {
    els.renameInput.focus();
    els.renameInput.select();
  }, 0);
}

async function commitRename() {
  const account = state.pendingRename;
  state.pendingRename = null;
  if (!account) return;
  const nextName = els.renameInput.value.trim();
  if (!nextName || nextName === account.displayName) return;
  await withAction(els.renameOk, "保存中", async () => {
    const snapshot = await api.updateAccount(account.id, { displayName: nextName });
    render(snapshot);
    showToast("已重命名");
  });
}

function confirmDelete(account) {
  state.pendingDelete = account;
  els.confirmTitle.textContent = "删除保存的账号";
  els.confirmBody.textContent = `会删除本地保存的 ${account.displayName}。如果它就是当前 Codex 登录，也会清理当前 auth.json 并重启 Codex，避免再次自动导入。`;
  els.confirmDialog.showModal();
}

async function deletePendingAccount() {
  if (!state.pendingDelete) return;
  const account = state.pendingDelete;
  state.pendingDelete = null;
  const snapshot = await api.deleteAccount(account.id);
  render(snapshot);
  showToast("已删除本地账号");
}

async function restartCodex() {
  await withAction(els.restartBtn, "重启中", async () => {
    await api.restartCodex();
    showToast("已发送重启命令");
  });
}

function wireEvents() {
  els.accountsTab.addEventListener("click", () => setActivePage("accounts"));
  els.usageTab.addEventListener("click", () => setActivePage("usage"));
  els.refreshBtn.addEventListener("click", () => refresh(false).catch((error) => showToast(error.message)));
  els.widgetBtn.addEventListener("click", () => api.showWidget().catch((error) => showToast(error.message)));
  els.statsRefreshBtn.addEventListener("click", () => loadDashboard(false).catch((error) => showToast(error.message)));
  els.importBtn.addEventListener("click", () => importCurrent());
  els.restartBtn.addEventListener("click", () => restartCodex());
  els.storePath.addEventListener("click", () => api.openPath(state.snapshot.storeRoot));
  els.confirmDialog.addEventListener("close", () => {
    if (els.confirmDialog.returnValue === "ok") {
      deletePendingAccount().catch((error) => showToast(error.message));
    }
  });
  els.renameDialog.addEventListener("close", () => {
    if (els.renameDialog.returnValue === "ok") {
      commitRename().catch((error) => showToast(error.message));
    } else {
      state.pendingRename = null;
    }
  });
  els.renameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    els.renameDialog.close("ok");
  });
  api.onStateChanged(() => {
    refresh(true).catch((error) => showToast(error.message));
  });
}

wireEvents();
refresh(true).catch((error) => showToast(error.message));
