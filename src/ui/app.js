const api = window.codexAuth;
const q = window.CodexQuotaUI;
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
  allAccountsRequestId: 0,
  usageScope: "current", // "current" or "all"
};

const els = {
  accountsTab: document.querySelector("#accountsTab"),
  usageTab: document.querySelector("#usageTab"),
  accountsPage: document.querySelector("#accountsPage"),
  usagePage: document.querySelector("#usagePage"),
  refreshBtn: document.querySelector("#refreshBtn"),
  widgetBtn: document.querySelector("#widgetBtn"),
  restartBtn: document.querySelector("#restartBtn"),
  platformLabel: document.querySelector("#platformLabel"),
  credentialProtection: document.querySelector("#credentialProtection"),
  currentIdentity: document.querySelector("#currentIdentity"),
  currentPath: document.querySelector("#currentPath"),
  accountCount: document.querySelector("#accountCount"),
  storePath: document.querySelector("#storePath"),
  diagnosticsInfo: document.querySelector("#diagnosticsInfo"),
  recoveryInfo: document.querySelector("#recoveryInfo"),
  resetCreditsInfo: document.querySelector("#resetCreditsInfo"),
  tokenBreakdown: document.querySelector("#tokenBreakdown"),
  usageCoverage: document.querySelector("#usageCoverage"),
  displayNameInput: document.querySelector("#displayNameInput"),
  importBtn: document.querySelector("#importBtn"),
  exportCredentialsBtn: document.querySelector("#exportCredentialsBtn"),
  importCredentialsBtn: document.querySelector("#importCredentialsBtn"),
  transferDialog: document.querySelector("#transferDialog"),
  transferForm: document.querySelector("#transferForm"),
  transferTitle: document.querySelector("#transferTitle"),
  transferDescription: document.querySelector("#transferDescription"),
  transferPassword: document.querySelector("#transferPassword"),
  transferConfirm: document.querySelector("#transferConfirm"),
  transferConfirmGroup: document.querySelector("#transferConfirmGroup"),
  transferError: document.querySelector("#transferError"),
  transferCancel: document.querySelector("#transferCancel"),
  transferSubmit: document.querySelector("#transferSubmit"),
  accountList: document.querySelector("#accountList"),
  restartAfterSwitch: document.querySelector("#restartAfterSwitch"),
  statsRefreshBtn: document.querySelector("#statsRefreshBtn"),
  scopeCurrentBtn: document.querySelector("#scopeCurrentBtn"),
  scopeAllBtn: document.querySelector("#scopeAllBtn"),
  quotaModeHint: document.querySelector("#quotaModeHint"),
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
  projectStats: document.querySelector("#projectStats"),
  modelStats: document.querySelector("#modelStats"),
  allAccountsGrid: document.querySelector("#allAccountsGrid"),
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
  const trim = (text) => text.replace(/\.0$/, "");
  if (number >= 100_000_000) return `${trim((number / 100_000_000).toFixed(1))}亿`;
  if (number >= 10_000) return `${trim((number / 10_000).toFixed(1))}万`;
  return String(Math.round(number));
}

function usageScopeLabel(scope, quota) {
  if (quota?.source === "account-cache") return "等待当前账号新快照";
  if (scope?.since) return `当前账号自 ${formatDate(scope.since)} 后`;
  return "全部本地日志";
}

function quotaFreshnessLabel(quota) {
  return q.quotaFreshnessLabel(quota);
}

function snapshotTimeLabel(snapshot) {
  return q.formatSnapshotTime(snapshot?.checkedAt);
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
    loadDashboard(true, { busy: false }).catch((error) => showToast(error.message));
  }
}

function setUsageScope(scope) {
  state.usageScope = scope;
  const isCurrent = scope === "current";
  els.scopeCurrentBtn.classList.toggle("active", isCurrent);
  els.scopeAllBtn.classList.toggle("active", !isCurrent);
  els.scopeCurrentBtn.setAttribute("aria-selected", String(isCurrent));
  els.scopeAllBtn.setAttribute("aria-selected", String(!isCurrent));
  els.scopeCurrentBtn.disabled = true;
  els.scopeAllBtn.disabled = true;
  // Show loading state immediately
  els.totalTokens.textContent = "...";
  els.inputTokens.textContent = "...";
  els.outputTokens.textContent = "...";
  els.sessionCount.textContent = "...";
  state.dashboardLoaded = false;
  loadDashboard(true, { busy: false }).catch((error) => showToast(error.message)).finally(() => {
    els.scopeCurrentBtn.disabled = false;
    els.scopeAllBtn.disabled = false;
  });
}

function renderSettings(snapshot) {
  els.quotaModeHint.textContent = "本地预估：只读取本机 Codex 日志，不联网。";
  if (els.restartAfterSwitch) {
    els.restartAfterSwitch.checked = snapshot?.settings?.restartAfterSwitch !== false;
  }
}

function renderStatus(snapshot) {
  const current = snapshot.current;
  els.platformLabel.textContent = `${snapshot.platformName || "本机"} 本地`;
  els.credentialProtection.textContent = snapshot.credentialProtection || "操作系统当前用户安全存储";
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
  const d=snapshot.diagnostics;
  if(d) {
    els.diagnosticsInfo.textContent = [
      `CodexAuth ${d.version} · Codex ${d.codexVersion ?? "版本未知"}`,
      `文件凭据：${d.fileCredentials?"正常":"需检查"} · 账号同步：${d.authSynchronized?"一致":"待同步"}`,
      `${d.sessionFiles} 个本地日志 · ${d.logDatabase} ${d.dbReadable?"可读":"暂不可读"}`,
      `日志更新：${d.latestLogAt?formatDate(d.latestLogAt):"未知"} · 全程本地`,
    ].join("\n");
    els.recoveryInfo.hidden=!d.recovery;
    if(d.recovery)els.recoveryInfo.textContent=`已从加密快照恢复 ${d.recovery.recovered} 个账号，${d.recovery.skipped} 个未恢复。原文件保留于 ${d.recovery.path}`;
  }
}

function createAccountQuotaMetric(kind, window) {
  const metric = document.createElement("div");
  metric.className = "account-quota-metric";

  const head = document.createElement("div");
  head.className = "account-quota-head";

  const label = document.createElement("span");
  label.textContent = q.quotaWindowLabel(kind, window);

  const value = document.createElement("strong");
  value.textContent = q.formatRemainingText(window);
  head.append(label, value);

  const meter = document.createElement("div");
  meter.className = q.isEstimatedWindow(window) ? "account-quota-meter estimated" : "account-quota-meter";
  const fill = document.createElement("span");
  const remaining = q.displayRemainingPercent(window);
  fill.style.width = remaining === null ? "0%" : `${remaining}%`;
  meter.append(fill);

  const foot = document.createElement("p");
  foot.className = "account-quota-foot";
  if (!window) {
    foot.textContent = "暂无数据";
  } else {
    foot.textContent = q.formatUsedFootnote(window);
  }

  metric.append(head, meter, foot);
  return metric;
}

function createAccountQuotaDetails(account) {
  const details = document.createElement("section");
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

  const source = document.createElement("span");
  source.textContent = `${snapshotTimeLabel(snapshot)} · ${q.quotaSourceLabel(snapshot.source)}`;

  const plan = document.createElement("strong");
  plan.textContent = q.formatPlanType(snapshot.planType || account.planType);
  summary.append(source, plan);

  const grid = document.createElement("div");
  grid.className = "account-quota-grid";
  grid.append(createAccountQuotaMetric("session", snapshot.session), createAccountQuotaMetric("weekly", snapshot.weekly));

  details.append(summary, resets, grid);
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
  identity.textContent = account.planType ? `${identityLabel(account)} · ${q.formatPlanType(account.planType)}` : identityLabel(account);
  const switched = document.createElement("span");
  switched.textContent = account.needsReauth
    ? account.reauthReason || "需要重新登录"
    : account.accessTokenExpired
    ? "访问令牌已到期，切换并使用时由 Codex 自动刷新"
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
  const cardEl = kind === "session" ? els.sessionPercent.closest(".quota-card") : els.weeklyPercent.closest(".quota-card");
  titleEl.textContent = q.windowTitle(kind, window);
  cardEl?.classList.toggle("estimated", q.isEstimatedWindow(window));
  if (!window) {
    percentEl.textContent = "--";
    meterEl.parentElement?.classList.remove("estimated");
    meterEl.style.width = "0%";
    resetEl.textContent = "暂无数据";
    return;
  }
  const remainingPercent = q.displayRemainingPercent(window) ?? 0;
  percentEl.textContent = q.formatRemainingText(window);
  meterEl.parentElement?.classList.toggle("estimated", q.isEstimatedWindow(window));
  meterEl.style.width = `${remainingPercent}%`;
  resetEl.textContent = q.formatUsedFootnote(window);
}

function renderQuotaPanel(dashboard) {
  const quota = dashboard?.quota;
  renderQuotaWindow("session", quota?.session);
  renderQuotaWindow("weekly", quota?.weekly);
  els.planType.textContent = q.formatPlanType(quota?.planType);
  const sourceText = `${q.quotaSourceLabel(quota?.source)} · ${usageScopeLabel(dashboard?.scope, quota)} · ${quotaFreshnessLabel(
    quota
  )}${q.quotaEstimateStatusLabel(quota)}`;
  els.quotaSource.textContent = quota?.error ? `${sourceText} · ${quota.error}` : sourceText;
  els.creditsInfo.textContent =
    quota?.credits?.balance !== undefined && quota?.credits?.balance !== null
      ? `余额 ${quota.credits.balance}`
      : "余额 --";
  els.resetCreditsInfo.textContent=q.resetCreditsLabel(quota?.resetCredits);
}

function renderDashboard(dashboard) {
  state.dashboardLoaded = true;
  renderQuotaPanel(dashboard);

  const usage = dashboard?.usage;
  const tokenUsage = usage?.tokenUsage || {};
  const exact=(n)=>new Intl.NumberFormat("zh-CN").format(Number(n??0));
  els.totalTokens.textContent = exact(tokenUsage.totalTokens);
  els.inputTokens.textContent = exact(tokenUsage.inputTokens);
  els.outputTokens.textContent = exact(tokenUsage.outputTokens);
  els.tokenBreakdown.textContent=`缓存输入 ${exact(tokenUsage.cachedInputTokens)} · 推理输出 ${exact(tokenUsage.reasoningOutputTokens)}（均为已包含的子项）`;
  const c=usage?.coverage??{};
  els.usageCoverage.textContent=[`已扫描 ${usage?.scannedFiles??0}/${usage?.totalFiles??0} 个日志文件`,
    `重复事件去重 ${c.duplicates??0} 条`,
    usage?.failedFiles?`${usage.failedFiles} 个文件暂不可读`:null,
    c.invalidLines?`${c.invalidLines} 行损坏或尚未写完`:null,
    c.counterResets?`${c.counterResets} 次计数回退已重新设定基准`:null,
    (c.boundaryIntervals||c.missingBaselines)?`存在缺失基准的区间，未推算用量`:null,
  ].filter(Boolean).join(" · ");
  els.sessionCount.textContent = String(usage?.sessionsAnalyzed ?? 0);
  if (usage?.totalFiles && usage.totalFiles > usage.scannedFiles) {
    els.sessionCount.title = `已扫描最近 ${usage.scannedFiles} 个会话文件，本机共 ${usage.totalFiles} 个`;
  } else {
    els.sessionCount.title = "";
  }
  renderDailyBars(usage?.daily || []);
  renderRecentSessions(usage?.recentSessions || []);
  renderProjectStats(usage?.projects || []);
  renderModelStats(usage?.models || []);
  renderAllAccountsQuota();
}

function renderDailyBars(days) {
  els.dailyBars.replaceChildren();
  const title = document.createElement("p");
  title.className = "usage-title";
  title.textContent = "每日用量";
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
    sub.textContent = `${compactNumber(session.tokenUsage?.totalTokens)} Token · ${session.model || "未知模型"} · ${formatDate(session.updatedAt)}`;
    row.append(main, sub);
    list.append(row);
  });
  els.recentSessions.append(list);
}

function renderProjectStats(projects) {
  els.projectStats.replaceChildren();
  const title = document.createElement("p");
  title.className = "usage-title";
  title.textContent = "按项目统计";
  els.projectStats.append(title);

  if (!projects || !projects.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "未找到项目数据。";
    els.projectStats.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "project-list";
  projects.slice(0, 8).forEach((project) => {
    const row = document.createElement("div");
    row.className = "project-row";
    const name = document.createElement("strong");
    name.textContent = project.project;
    const sub = document.createElement("small");
    sub.textContent = `${compactNumber(project.tokenUsage?.totalTokens)} Token · ${project.sessions} 次会话`;
    row.append(name, sub);
    list.append(row);
  });
  els.projectStats.append(list);
}

function renderModelStats(models) {
  els.modelStats.replaceChildren();
  const title = document.createElement("p");
  title.className = "usage-title";
  title.textContent = "按模型统计";
  els.modelStats.append(title);

  if (!models || !models.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "未找到模型数据。";
    els.modelStats.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "model-list";
  models.slice(0, 6).forEach((model) => {
    const row = document.createElement("div");
    row.className = "model-row";
    const left = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = model.model;
    const sessions = document.createElement("small");
    sessions.textContent = ` · ${model.sessions} 次会话`;
    left.append(name, sessions);
    const right = document.createElement("div");
    right.className = "model-tokens";
    right.textContent = compactNumber(model.tokenUsage?.totalTokens);
    row.append(left, right);
    list.append(row);
  });
  els.modelStats.append(list);
}

function createAllAccountQuotaMeter(kind, quotaWindow) {
  const row = document.createElement("div");
  row.className = "all-account-meter-row";

  const head = document.createElement("div");
  head.className = "all-account-meter-head";
  const label = document.createElement("span");
  label.textContent = q.windowTitle(kind,quotaWindow);
  const value = document.createElement("strong");
  value.textContent = q.formatRemainingText(quotaWindow);
  head.append(label, value);

  const meter = document.createElement("div");
  meter.className = q.isEstimatedWindow(quotaWindow) ? "all-account-meter estimated" : "all-account-meter";
  const fill = document.createElement("span");
  const remaining = q.displayRemainingPercent(quotaWindow);
  fill.style.width = remaining != null ? `${Math.round(Math.max(0, Math.min(100, remaining)))}%` : "0%";
  meter.append(fill);

  const foot = document.createElement("p");
  foot.className = "all-account-meter-foot";
  if (!quotaWindow) {
    foot.textContent = "暂无快照";
  } else {
    foot.textContent = q.formatUsedFootnote(quotaWindow);
  }

  row.append(head, meter, foot);
  return row;
}

async function renderAllAccountsQuota() {
  try {
    const requestId = ++state.allAccountsRequestId;
    const data = await api.getAllAccountsQuota();
    if (requestId !== state.allAccountsRequestId) return;
    if (!data?.accounts) return;
    els.allAccountsGrid.replaceChildren();
    for (const account of data.accounts) {
      const card = document.createElement("article");
      card.className = account.isActive ? "all-account-card active" : "all-account-card";

      const head = document.createElement("div");
      head.className = "all-account-head";
      const name = document.createElement("strong");
      name.textContent = account.displayName;
      const badge = document.createElement("span");
      badge.className = "plan-badge";
      badge.textContent = q.formatPlanType(account.planType);
      head.append(name, badge);

      card.append(head);

      if (account.quotaSnapshot?.isCachedSnapshot) {
        const note = document.createElement("p");
        note.className = "all-account-no-data";
        note.textContent = "上次切换时的本地快照";
        card.append(note);
      }

      if (account.quotaSnapshot) {
        const meters = document.createElement("div");
        meters.className = "all-account-meters";
        meters.append(
          createAllAccountQuotaMeter("session", account.quotaSnapshot.session),
          createAllAccountQuotaMeter("weekly", account.quotaSnapshot.weekly)
        );
        card.append(meters);
      } else {
        const noData = document.createElement("p");
        noData.className = "all-account-no-data";
        noData.textContent = "暂无额度数据";
        card.append(noData);
      }

      const resets=document.createElement("p");
      resets.className="all-account-no-data";
      resets.textContent=q.resetCreditsLabel(account.quotaSnapshot?.resetCredits,{compact:true});
      card.append(resets);
      els.allAccountsGrid.append(card);
    }
  } catch (error) {
    const empty = document.createElement("p");
    empty.className = "all-account-no-data";
    empty.textContent = "全部账号额度暂时不可用";
    els.allAccountsGrid.append(empty);
    if (error instanceof Error) console.warn(error.message);
  }
}

function render(snapshot) {
  state.snapshot = snapshot;
  renderSettings(snapshot);
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
    if (state.usageScope === "all") {
      const usage = await api.getAllUsage();
      renderDashboard({ quota: null, usage, scope: null });
    } else {
      const dashboard = await api.getDashboard();
      renderDashboard(dashboard);
    }
    if (!silent) showToast("已刷新");
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

let transferMode = "export";
let transferBusy = false;

function openCredentialTransfer(mode) {
  transferMode = mode;
  const exporting = mode === "export";
  els.transferForm.reset();
  els.transferError.textContent = "";
  els.transferTitle.textContent = exporting ? "导出当前账号" : "导入账号凭证";
  els.transferDescription.textContent = exporting
    ? "导出当前 Codex 登录的最新凭证为加密 .codexauth 文件。B 电脑导入时需要相同的迁移密码。"
    : "输入导出时设置的迁移密码，然后选择 .codexauth 文件。导入后在账号列表点击“切换”即可使用。";
  els.transferConfirmGroup.hidden = !exporting;
  els.transferConfirm.required = exporting;
  els.transferSubmit.textContent = exporting ? "选择保存位置" : "选择迁移文件";
  els.transferDialog.showModal();
  els.transferPassword.focus();
}

async function submitCredentialTransfer(event) {
  event.preventDefault();
  if (transferBusy || !els.transferForm.reportValidity()) return;
  if (transferMode === "export" && els.transferPassword.value !== els.transferConfirm.value) {
    els.transferError.textContent = "两次输入的迁移密码不一致。";
    return;
  }
  transferBusy = true;
  els.transferError.textContent = "";
  els.transferSubmit.disabled = true;
  els.transferCancel.disabled = true;
  let password = els.transferPassword.value;
  els.transferPassword.value = "";
  els.transferConfirm.value = "";
  try {
    const result = transferMode === "export" ? await api.exportPortable(password) : await api.importPortable(password);
    if (!result.canceled) {
      if (result.snapshot) { render(result.snapshot); state.dashboardLoaded = false; }
      els.transferDialog.close();
      showToast(transferMode === "export" ? "加密凭证已导出，可在另一台电脑导入"
        : result.alreadyActive ? "该账号已在本机登录，已保留本机凭证" : "账号已导入，在列表点击“切换”即可使用");
    }
  } catch (error) { els.transferError.textContent = error.message; }
  finally {
    password = "";
    transferBusy = false;
    els.transferSubmit.disabled = false;
    els.transferCancel.disabled = false;
  }
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
  els.scopeCurrentBtn.addEventListener("click", () => setUsageScope("current"));
  els.scopeAllBtn.addEventListener("click", () => setUsageScope("all"));
  els.restartAfterSwitch?.addEventListener("change", () => {
    api.updateSettings({ restartAfterSwitch: els.restartAfterSwitch.checked }).catch((error) => showToast(error.message));
  });
  els.importBtn.addEventListener("click", () => importCurrent());
  els.exportCredentialsBtn.addEventListener("click", () => openCredentialTransfer("export"));
  els.importCredentialsBtn.addEventListener("click", () => openCredentialTransfer("import"));
  els.transferForm.addEventListener("submit", submitCredentialTransfer);
  els.transferCancel.addEventListener("click", () => els.transferDialog.close());
  els.transferDialog.addEventListener("cancel", (event) => { if (transferBusy) event.preventDefault(); });
  els.transferDialog.addEventListener("close", () => { els.transferForm.reset(); els.transferError.textContent = ""; });
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
  api.onStateChanged((payload) => {
    const scope = payload?.scope || "accounts";
    if (scope === "quota" && state.activePage === "usage") {
      readQuota(true).catch((error) => showToast(error.message));
      return;
    }
    if (scope === "quota") return;
    refresh(true).catch((error) => showToast(error.message));
  });
}

wireEvents();
refresh(true).catch((error) => showToast(error.message));
