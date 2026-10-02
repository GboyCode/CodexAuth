const api = window.codexAuth;
document.documentElement.classList.toggle("custom-titlebar", api.platform === "win32");
const q = window.CodexQuotaUI;
const DASHBOARD_AUTO_REFRESH_MS = 8000;
const OVERVIEW_PRIVACY_KEY = "codexauth.overview.hideEmails";

function readOverviewPrivacy() {
  try { return window.localStorage?.getItem(OVERVIEW_PRIVACY_KEY) === "true"; }
  catch { return false; }
}

const state = {
  snapshot: null,
  pendingDelete: null,
  pendingRename: null,
  activePage: "accounts",
  expandedAccountId: null,
  dashboardLoaded: false,
  dashboardLoading: false,
  dashboardPromise: null,
  quotaLoading: false,
  quotaRefreshQueued: false,
  dashboardRefreshTimer: null,
  allAccountsRequestId: 0,
  overviewEmailsHidden: readOverviewPrivacy(),
  overviewNames: [],
  overviewRefreshing: false,
  overviewRefreshFailures: new Map(),
  usageScope: "current", // "current" or "all"
  menuAccountId: null,
  accountLoginState: "idle",
  accountsRenderDeferred: false,
};

const els = {
  settingsBtn: document.querySelector("#settingsBtn"),
  settingsDialog: document.querySelector("#settingsDialog"),
  addAccountBtn: document.querySelector("#addAccountBtn"),
  addAccountDialog: document.querySelector("#addAccountDialog"),
  autoRecoverySummary: document.querySelector("#autoRecoverySummary"),
  recoveryNotice: document.querySelector("#recoveryNotice"),
  switchEffect: document.querySelector("#switchEffect"),
  accountLoginPanel: document.querySelector("#accountLoginPanel"),
  accountMenu: document.querySelector("#accountMenu"),
  transferMenu: document.querySelector("#transferMenu"),
  accountDetailsBtn: document.querySelector("#accountDetailsBtn"),
  renameAccountBtn: document.querySelector("#renameAccountBtn"),
  reauthAccountBtn: document.querySelector("#reauthAccountBtn"),
  deleteAccountBtn: document.querySelector("#deleteAccountBtn"),
  usageWarning: document.querySelector("#usageWarning"),
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
  localUsageScope: document.querySelector("#localUsageScope"),
  displayNameInput: document.querySelector("#displayNameInput"),
  importBtn: document.querySelector("#importBtn"),
  loginAccountBtn: document.querySelector("#loginAccountBtn"),
  accountLoginStatus: document.querySelector("#accountLoginStatus"),
  openAccountLoginBtn: document.querySelector("#openAccountLoginBtn"),
  cancelAccountLoginBtn: document.querySelector("#cancelAccountLoginBtn"),
  exportCredentialsBtn: document.querySelector("#exportCredentialsBtn"),
  exportScopeDialog: document.querySelector("#exportScopeDialog"),
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
  autoSwitchOnLimit: document.querySelector("#autoSwitchOnLimit"),
  autoResetOnWeeklyLimit: document.querySelector("#autoResetOnWeeklyLimit"),
  autoRecoveryStatus: document.querySelector("#autoRecoveryStatus"),
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
  allAccountsGrid: document.querySelector("#allAccountsGrid"),
  overviewPrivacyBtn: document.querySelector("#overviewPrivacyBtn"),
  overviewRefreshBtn: document.querySelector("#overviewRefreshBtn"),
  overviewRefreshStatus: document.querySelector("#overviewRefreshStatus"),
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

function usageScopeLabel(scope, quota) {
  if (quota?.source === "account-cache") return "当前账号缓存";
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
  els.toast.classList.remove("show");
  document.querySelectorAll(".dialog-notice").forEach((notice) => { notice.hidden = true; });
  const dialog = document.querySelector("dialog[open]");
  if (dialog) {
    let notice = dialog.querySelector(".dialog-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.className = "inline-notice dialog-notice";
      notice.setAttribute("role", "status");
      (dialog.querySelector(".dialog-content") || dialog).append(notice);
    }
    notice.textContent = message;
    notice.hidden = false;
    toastTimer = window.setTimeout(() => { notice.hidden = true; }, 5000);
    return;
  }
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
  els.quotaModeHint.textContent = "当前账号：在线额度与本地日志。备用账号：仅手动刷新或自动切换前查询并按需续期，不定时查询。";
  if (els.restartAfterSwitch) {
    els.restartAfterSwitch.checked = snapshot?.settings?.restartAfterSwitch !== false;
  }
  if (els.autoSwitchOnLimit) {
    els.autoSwitchOnLimit.checked = snapshot?.settings?.autoSwitchOnLimit === true;
    els.autoSwitchOnLimit.disabled = snapshot?.platform !== "win32";
  }
  if (els.autoResetOnWeeklyLimit) {
    els.autoResetOnWeeklyLimit.checked = snapshot?.settings?.autoResetOnWeeklyLimit === true;
    els.autoResetOnWeeklyLimit.disabled = snapshot?.platform !== "win32" || snapshot?.settings?.autoSwitchOnLimit !== true;
  }
  const supported = snapshot?.platform === "win32";
  const enabled = snapshot?.settings?.autoSwitchOnLimit === true;
  const recovery = snapshot?.autoRecovery;
  const labels = { checking: "检查中", countdown: "即将切换", waiting: "等待中", switching: "切换中", resuming: "恢复中", attention: "需处理" };
  els.autoRecoverySummary.textContent = `自动切换：${!supported ? "不支持" : !enabled ? "关闭" : labels[recovery?.state] || "开启"}`;
  const showNotice = supported && enabled && recovery?.message && !["disabled", "watching"].includes(recovery.state);
  els.recoveryNotice.hidden = !showNotice;
  els.recoveryNotice.textContent = showNotice ? recovery.message : "";
  els.autoRecoveryStatus.hidden = supported && !showNotice;
  els.autoRecoveryStatus.textContent = !supported ? "自动切换与续任务仅支持 Windows 桌面版。" : showNotice ? recovery.message : "";
  els.switchEffect.textContent = snapshot?.settings?.restartAfterSwitch !== false
    ? "切换账号将重启 Codex" : "切换后需手动重启 Codex 才能生效";
}

function renderStatus(snapshot) {
  const current = snapshot.current;
  els.platformLabel.textContent = `${snapshot.platformName || "本机"} 本地`;
  els.credentialProtection.textContent = snapshot.credentialProtection || "操作系统当前用户安全存储";
  if (current?.exists && !current.error) {
    els.currentIdentity.textContent = identityLabel(current);
  } else if (current?.exists && current.error) {
    els.currentIdentity.textContent = "登录信息无法读取";
  } else {
    els.currentIdentity.textContent = "未检测到 Codex 登录";
  }
  els.currentPath.textContent = current?.error ? `${snapshot.authPath} · ${current.error}` : snapshot.authPath;
  els.accountCount.textContent = String(snapshot.accounts.length);
  els.storePath.textContent = snapshot.storeRoot;
  els.storePath.title = "打开账号存储目录";
  const d=snapshot.diagnostics;
  if(d) {
    els.diagnosticsInfo.textContent = [
      `CodexAuth ${d.version} · Codex ${d.codexVersion ?? "版本未知"}`,
      `文件凭据：${d.fileCredentials?"正常":"需检查"} · 账号同步：${d.authSynchronized?"一致":"待同步"}`,
      `${d.sessionFiles} 个本地日志 · ${d.logDatabase} ${d.dbReadable?"可读":"暂不可读"}`,
      `日志更新：${d.latestLogAt?formatDate(d.latestLogAt):"未知"} · 用量统计来自本机`,
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
  details.id = `quota-details-${account.id}`;
  const credentialStatus = document.createElement("p");
  credentialStatus.className = "account-detail-status";
  credentialStatus.textContent = account.needsReauth ? account.reauthReason || "需要重新登录"
    : account.accessTokenExpired ? "登录凭证待刷新，使用时会尝试自动续期。"
      : account.lastSyncedAt ? `最近同步 ${formatDate(account.lastSyncedAt)}` : `最近切换 ${formatDate(account.lastSwitchedAt)}`;
  details.append(credentialStatus);

  if (!account.isActive) {
    const check = document.createElement("button");
    check.className = "account-action";
    check.dataset.accountAction = "refresh";
    check.textContent = "刷新额度";
    check.addEventListener("click", async () => {
      check.disabled = true;
      check.textContent = "查询中…";
      try {
        const result = await api.checkAccountQuota(account.id);
        await refresh(true);
        showToast(result.reason);
      } catch (error) { showToast(error.message); }
      finally { check.disabled = false; check.textContent = "刷新额度"; }
    });
    details.append(check);
  }
  if (account.onlineQuotaStatus?.error) {
    const warning = document.createElement("p");
    warning.className = "account-quota-empty";
    warning.textContent = account.quotaSnapshot ? "更新失败 · 显示缓存" : "更新失败";
    warning.title = account.onlineQuotaStatus.error;
    details.append(warning);
  }

  const snapshot = account.quotaSnapshot;
  const resets = document.createElement("p");
  resets.className = "account-reset-credits";
  resets.textContent = q.resetCreditsLabel(snapshot?.resetCredits, { compact: true });
  resets.title = q.resetCreditsLabel(snapshot?.resetCredits);
  if (!snapshot) {
    const empty = document.createElement("p");
    empty.className = "account-quota-empty";
    empty.textContent = "暂无数据";
    details.append(empty, resets);
    return details;
  }

  const summary = document.createElement("div");
  summary.className = "account-quota-summary";

  const source = document.createElement("span");
  source.textContent = snapshotTimeLabel(snapshot);

  const plan = document.createElement("strong");
  plan.textContent = q.formatPlanType(snapshot.planType || account.planType);
  summary.append(source, plan);

  const grid = document.createElement("div");
  grid.className = "account-quota-grid";
  grid.append(createAccountQuotaMetric("session", snapshot.session), createAccountQuotaMetric("weekly", snapshot.weekly));

  details.append(summary, resets, grid);
  for (const bucket of snapshot.additional ?? []) {
    const label = document.createElement("p");
    label.className = "account-quota-foot";
    label.textContent = bucket.label || bucket.limitId;
    const windows = document.createElement("div");
    windows.className = "account-quota-grid";
    windows.append(createAccountQuotaMetric("session", bucket.session), createAccountQuotaMetric("weekly", bucket.weekly));
    details.append(label, windows);
  }
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
  card.dataset.accountId = account.id;

  const main = document.createElement("div");
  main.className = "account-main";

  const line = document.createElement("div");
  line.className = "account-name-line";

  const name = document.createElement("h3");
  name.className = "account-name";
  name.textContent = account.displayName;
  name.title = account.displayName;
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
  identity.textContent = [account.displayName !== identityLabel(account) ? identityLabel(account) : "", q.formatPlanType(account.planType)].filter(Boolean).join(" · ");
  identity.title = identity.textContent;
  const switched = document.createElement("span");
  const quota = account.quotaSnapshot;
  switched.textContent = account.needsReauth ? "需要重新登录"
    : account.onlineQuotaStatus?.error ? quota ? "更新失败 · 显示缓存" : "更新失败"
      : q.quotaFreshnessLabel(quota, { compact: true, inline: true });
  switched.title = account.reauthReason || account.onlineQuotaStatus?.error || q.quotaFreshnessLabel(quota);
  meta.append(identity, switched);

  main.append(line, meta);

  const quotaSummary = document.createElement("div");
  quotaSummary.className = "account-quota-preview";
  for (const kind of ["session", "weekly"]) {
    const metric = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = q.windowTitle(kind, quota?.[kind]);
    const value = document.createElement("strong");
    value.textContent = q.formatRemainingText(quota?.[kind]);
    metric.title = q.formatUsedFootnote(quota?.[kind]);
    metric.append(label, value);
    quotaSummary.append(metric);
  }
  const quotaToggle = document.createElement("button");
  quotaToggle.type = "button";
  quotaToggle.className = "account-expand-cue";
  quotaToggle.dataset.accountAction = "details";
  quotaToggle.textContent = expanded ? "收起" : "详情";
  quotaToggle.setAttribute("aria-label", `${account.displayName}：${expanded ? "收起" : "查看"}详情`);
  quotaToggle.setAttribute("aria-expanded", String(expanded));
  if (expanded) quotaToggle.setAttribute("aria-controls", `quota-details-${account.id}`);
  quotaToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountDetails(account.id);
    [...els.accountList.children].find((item) => item.dataset.accountId === account.id)?.querySelector(".account-expand-cue")?.focus();
  });

  const actions = document.createElement("div");
  actions.className = "account-actions";

  actions.append(quotaToggle);
  if (account.needsReauth || !account.isActive) {
    const primary = document.createElement("button");
    primary.className = "account-action primary";
    primary.dataset.accountAction = "primary";
    primary.textContent = account.needsReauth ? "重新登录" : "切换";
    primary.addEventListener("click", () => account.needsReauth ? reauthAccount(account, primary) : switchToAccount(account, primary));
    actions.append(primary);
  }
  const more = document.createElement("button");
  more.className = "account-action account-more";
  more.dataset.accountAction = "more";
  more.textContent = "更多";
  more.setAttribute("aria-label", `${account.displayName}：更多操作`);
  more.setAttribute("popovertarget", "accountMenu");
  more.addEventListener("click", () => {
    state.menuAccountId = account.id;
    els.accountDetailsBtn.textContent = expanded ? "收起详情" : "查看详情";
    els.reauthAccountBtn.hidden = account.needsReauth;
  });
  actions.append(more);
  card.append(main, quotaSummary, actions);
  if (expanded) card.append(createAccountQuotaDetails(account));
  return card;
}

function renderAccounts(snapshot) {
  // Background quota events must not dismiss a menu or drop keyboard focus.
  if (els.accountMenu.matches(":popover-open")) {
    state.accountsRenderDeferred = true;
    return;
  }
  state.accountsRenderDeferred = false;
  const focused = document.activeElement;
  const focusedAccount = focused?.closest(".account-card")?.dataset.accountId;
  const focusedAction = focused?.dataset.accountAction;
  els.accountList.replaceChildren();
  if (state.expandedAccountId && !snapshot.accounts.some((account) => account.id === state.expandedAccountId)) {
    state.expandedAccountId = null;
  }
  if (!snapshot.accounts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("p");
    title.textContent = "还没有保存的账号";
    const add = document.createElement("button");
    add.className = "primary-btn";
    add.textContent = "添加账号";
    add.addEventListener("click", () => els.addAccountDialog.showModal());
    empty.append(title, add);
    els.accountList.append(empty);
    return;
  }
  snapshot.accounts.forEach((account) => {
    els.accountList.append(accountCard(account));
  });
  if (focusedAccount && focusedAction) {
    const card = [...els.accountList.children].find((item) => item.dataset.accountId === focusedAccount);
    card?.querySelector(`[data-account-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }
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
  const sourceText = quotaFreshnessLabel(quota);
  els.quotaSource.textContent = quota?.error ? `${sourceText} · 更新失败` : sourceText;
  els.quotaSource.title = [usageScopeLabel(dashboard?.scope, quota), q.quotaEstimateStatusLabel(quota).replace(/^ · /, ""), quota?.error].filter(Boolean).join("\n");
  els.creditsInfo.textContent =
    quota?.credits?.balance !== undefined && quota?.credits?.balance !== null
      ? `余额 ${quota.credits.balance}`
      : "余额 --";
  els.resetCreditsInfo.textContent=q.resetCreditsLabel(quota?.resetCredits, { compact: true });
  els.resetCreditsInfo.title=q.resetCreditsLabel(quota?.resetCredits);
}

function renderDashboard(dashboard) {
  state.dashboardLoaded = true;
  // Local usage scope never clears or replaces the current account's quota.
  if (state.usageScope !== "all") renderQuotaPanel(dashboard);

  const usage = dashboard?.usage;
  const tokenUsage = usage?.tokenUsage || {};
  const exact=(n)=>usage?.available === false ? "--" : new Intl.NumberFormat("zh-CN").format(Number(n??0));
  els.localUsageScope.textContent = state.usageScope === "all"
    ? "本机全部日志用量（包含不同账号）"
    : usage?.available === false ? "尚无可归属的本次本地用量"
      : `最近切换后的本地用量 · 自 ${formatDate(dashboard?.scope?.since)} 起`;
  els.totalTokens.textContent = exact(tokenUsage.totalTokens);
  els.inputTokens.textContent = exact(tokenUsage.inputTokens);
  els.outputTokens.textContent = exact(tokenUsage.outputTokens);
  els.tokenBreakdown.textContent=`缓存输入 ${exact(tokenUsage.cachedInputTokens)} · 推理输出 ${exact(tokenUsage.reasoningOutputTokens)}（均为已包含的子项）`;
  const c=usage?.coverage??{};
  els.usageWarning.hidden = !(usage?.available === false || usage?.failedFiles || c.invalidLines || c.boundaryIntervals || c.missingBaselines);
  els.usageWarning.textContent = usage?.available === false ? "暂无可归属的本次用量" : "部分日志未计入，查看统计详情";
  els.usageCoverage.textContent=[`已扫描 ${usage?.scannedFiles??0}/${usage?.totalFiles??0} 个日志文件`,
    `重复事件去重 ${c.duplicates??0} 条`,
    usage?.failedFiles?`${usage.failedFiles} 个文件暂不可读`:null,
    c.invalidLines?`${c.invalidLines} 行损坏或尚未写完`:null,
    c.counterResets?`${c.counterResets} 次计数回退已重新设定基准`:null,
    (c.boundaryIntervals||c.missingBaselines)?`存在缺失基准的区间，未推算用量`:null,
  ].filter(Boolean).join(" · ");
  els.sessionCount.textContent = usage?.available === false ? "--" : String(usage?.sessionsAnalyzed ?? 0);
  if (usage?.totalFiles && usage.totalFiles > usage.scannedFiles) {
    els.sessionCount.title = `已读取当前统计范围内 ${usage.scannedFiles} 个会话文件，本机共 ${usage.totalFiles} 个`;
  } else {
    els.sessionCount.title = "";
  }
  renderAllAccountsQuota();
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
    foot.textContent = "暂无数据";
  } else {
    foot.textContent = q.formatUsedFootnote(quotaWindow);
  }

  row.append(head, meter, foot);
  return row;
}

function renderOverviewPrivacy() {
  const label = state.overviewEmailsHidden ? "显示邮箱" : "隐藏邮箱";
  els.overviewPrivacyBtn.title = label;
  els.overviewPrivacyBtn.setAttribute("aria-label", label);
  els.overviewPrivacyBtn.setAttribute("aria-pressed", String(state.overviewEmailsHidden));
  state.overviewNames.forEach(({ element, label }, index) => {
    element.textContent = state.overviewEmailsHidden ? `账号 ${index + 1}` : label;
  });
}

function toggleOverviewPrivacy() {
  state.overviewEmailsHidden = !state.overviewEmailsHidden;
  try { window.localStorage?.setItem(OVERVIEW_PRIVACY_KEY, String(state.overviewEmailsHidden)); }
  catch { /* Keep the toggle usable if local preferences cannot be saved. */ }
  renderOverviewPrivacy();
}

async function refreshAllAccountsQuota() {
  if (state.overviewRefreshing) return;
  state.overviewRefreshing = true;
  state.overviewRefreshFailures.clear();
  els.overviewRefreshBtn.disabled = true;
  els.overviewRefreshBtn.setAttribute("aria-busy", "true");
  els.overviewRefreshBtn.textContent = "读取账号…";
  els.overviewRefreshStatus.hidden = false;
  els.overviewRefreshStatus.textContent = "正在读取账号列表…";
  try {
    const data = await api.getAllAccountsQuota();
    if (!Array.isArray(data?.accounts)) throw new Error("账号列表暂时不可用，请稍后重试。");
    const total = data.accounts.length;
    let completed = 0, refreshed = 0;
    for (const account of data.accounts) {
      els.overviewRefreshBtn.textContent = `刷新中 ${completed}/${total}`;
      els.overviewRefreshStatus.textContent = "正在刷新额度…";
      try {
        const result = await api.checkAccountQuota(account.id);
        if (result?.refreshed) refreshed++;
        else state.overviewRefreshFailures.set(account.id, { at: Date.now(), reason: result?.reason || "在线查询未成功。" });
      } catch {
        state.overviewRefreshFailures.set(account.id, { at: Date.now(), reason: "在线查询失败，请稍后重试。" });
      }
      completed++;
      els.overviewRefreshBtn.textContent = `刷新中 ${completed}/${total}`;
      await renderAllAccountsQuota();
    }
    els.overviewRefreshStatus.textContent = total
      ? `已刷新 ${refreshed}/${total} 个账号${refreshed < total ? ` · ${total - refreshed} 个失败` : ""}`
      : "暂无账号";
  } catch (error) {
    els.overviewRefreshStatus.textContent = error.message || "批量刷新失败，请稍后重试。";
  } finally {
    state.overviewRefreshing = false;
    els.overviewRefreshBtn.disabled = false;
    els.overviewRefreshBtn.removeAttribute("aria-busy");
    els.overviewRefreshBtn.textContent = "刷新全部";
  }
}

function overviewQuotaFailure(account) {
  const snapshotAt = Date.parse(account.quotaSnapshot?.checkedAt);
  const failed = state.overviewRefreshFailures.get(account.id);
  if (failed && (!Number.isFinite(snapshotAt) || snapshotAt <= failed.at)) return failed.reason;
  const status = account.onlineQuotaStatus;
  return status?.error && (!Number.isFinite(snapshotAt) || Date.parse(status.checkedAt) >= snapshotAt)
    ? "在线查询失败。" : null;
}

async function renderAllAccountsQuota() {
  try {
    const requestId = ++state.allAccountsRequestId;
    const data = await api.getAllAccountsQuota();
    if (requestId !== state.allAccountsRequestId) return;
    if (!data?.accounts) return;
    els.allAccountsGrid.replaceChildren();
    state.overviewNames = [];
    for (const account of data.accounts) {
      const card = document.createElement("article");
      card.className = account.isActive ? "all-account-card active" : "all-account-card";

      const head = document.createElement("div");
      head.className = "all-account-head";
      const name = document.createElement("strong");
      state.overviewNames.push({ element: name, label: account.displayName });
      name.textContent = state.overviewEmailsHidden ? `账号 ${state.overviewNames.length}` : account.displayName;
      const badge = document.createElement("span");
      badge.className = "plan-badge";
      badge.textContent = q.formatPlanType(account.planType);
      head.append(name, badge);

      card.append(head);

      const note = document.createElement("p");
      note.className = "all-account-status";
      const failure = overviewQuotaFailure(account);
      const quota = account.quotaSnapshot;
      note.textContent = [
        account.isActive ? "当前账号" : "",
        failure ? "更新失败" : "",
        q.quotaFreshnessLabel(failure && quota ? { ...quota, source: "account-cache" } : quota),
      ].filter(Boolean).join(" · ");
      note.title = failure || note.textContent;
      card.append(note,
        createAllAccountQuotaMeter("session", account.quotaSnapshot?.session),
        createAllAccountQuotaMeter("weekly", account.quotaSnapshot?.weekly)
      );

      const footer = document.createElement("div");
      footer.className = "all-account-footer";
      const resets = document.createElement("span");
      resets.className = "all-account-resets";
      resets.textContent = q.resetCreditsLabel(account.quotaSnapshot?.resetCredits, { compact: true });
      resets.title = q.resetCreditsLabel(account.quotaSnapshot?.resetCredits);
      const subscription = document.createElement("span");
      subscription.className = "all-account-subscription";
      const expiry = q.subscriptionDisplay(account.subscription);
      subscription.textContent = expiry.label;
      subscription.title = expiry.title;
      footer.append(resets, subscription);
      card.append(footer);
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
  renderAccountLogin(snapshot.accountLogin);
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

function readDashboard(silent) {
  if (state.dashboardPromise) return state.dashboardPromise;
  state.dashboardLoading = true;
  state.dashboardPromise = Promise.resolve().then(async () => {
    for (;;) {
      const scope = state.usageScope;
      let dashboard;
      try {
        dashboard = scope === "all"
          ? { quota: null, usage: await api.getAllUsage(), scope: null }
          : await api.getDashboard();
      } catch (error) {
        if (scope !== state.usageScope) continue;
        throw error;
      }
      // A slow response must not overwrite a newly selected statistics scope.
      if (scope !== state.usageScope) continue;
      renderDashboard(dashboard);
      if (!silent) showToast("已刷新");
      break;
    }
  }).finally(() => {
    state.dashboardLoading = false;
    state.dashboardPromise = null;
  });
  return state.dashboardPromise;
}

async function loadDashboard(silent = false, options = {}) {
  const read = async () => {
    const requests = [readDashboard(silent)];
    if (state.usageScope === "all") requests.push(readQuota(true));
    const results = await Promise.allSettled(requests);
    if (results[0].status === "rejected") throw results[0].reason;
    if (results[1]?.status === "rejected") showToast("额度刷新失败，本地用量已更新");
  };
  if (options.busy === false) {
    await read();
    return;
  }
  await withAction(els.statsRefreshBtn, "刷新中", read);
}

let transferMode = "export";
let transferBusy = false;
let importSelection = null;

async function startCredentialImport() {
  await withAction(els.importCredentialsBtn, "选择文件中", async () => {
    const selection = await api.selectPortable();
    if (selection.canceled) return;
    importSelection = selection;
    openCredentialTransfer("import");
  });
}

function openCredentialTransfer(mode) {
  transferMode = mode;
  const exporting = mode === "export" || mode === "export-all";
  const all = mode === "export-all";
  els.transferForm.reset();
  els.transferError.textContent = "";
  els.transferTitle.textContent = all ? "导出全部账号" : exporting ? "导出当前账号" : "导入账号凭证";
  els.transferDescription.textContent = all
    ? "为全部已保存账号和当前登录各导出一份加密文件，共用本次迁移密码。"
    : exporting
    ? "导出当前登录的加密凭证。在另一台电脑导入时，需要相同的迁移密码。"
    : `已选择 ${importSelection.count} 个凭证文件。输入这批文件共用的迁移密码即可批量导入；不同密码的文件请分批选择。`;
  els.transferDescription.title = exporting ? "" : importSelection.names.join("\n");
  els.transferConfirmGroup.hidden = !exporting;
  els.transferConfirm.required = exporting;
  els.transferSubmit.textContent = all ? "选择保存文件夹" : exporting ? "选择保存位置" : "导入所选账号";
  els.transferDialog.showModal();
  els.transferPassword.focus();
}

async function submitCredentialTransfer(event) {
  event.preventDefault();
  if (transferBusy || !els.transferForm.reportValidity()) return;
  const exporting = transferMode === "export" || transferMode === "export-all";
  if (exporting && els.transferPassword.value !== els.transferConfirm.value) {
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
    const result = exporting ? await api.exportPortable(password, transferMode === "export-all" ? "all" : "current") : await api.importPortable(password, importSelection.selectionId);
    if (!result.canceled) {
      if (result.snapshot) { render(result.snapshot); state.dashboardLoaded = false; }
      els.transferDialog.close();
      showToast(transferMode === "export-all" ? `已导出 ${result.count} 个账号的加密凭证`
        : exporting ? "加密凭证已导出，可在另一台电脑导入"
        : `已导入 ${result.importedCount} 个账号${result.skippedCount ? `，${result.skippedCount} 个当前账号保留本机凭证` : ""}，在列表点击“切换”即可使用`);
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
  await withAction(els.importBtn, "保存中", async () => {
    const snapshot = await api.importCurrent(els.displayNameInput.value);
    els.displayNameInput.value = "";
    render(snapshot);
    els.addAccountDialog.close();
    state.dashboardLoaded = false;
    if (state.activePage === "usage") await loadDashboard(true, { busy: false });
    showToast("已保存当前登录");
  });
}

function renderAccountLogin(login = {}) {
  const busy = ["starting", "waiting", "importing"].includes(login.state);
  const wasBusy = ["starting", "waiting", "importing"].includes(state.accountLoginState);
  if (wasBusy && login.state === "done") showToast("登录已完成");
  if (wasBusy && login.state === "cancelled") showToast("已取消登录");
  state.accountLoginState = login.state || "idle";
  els.loginAccountBtn.disabled = busy;
  els.loginAccountBtn.textContent = busy ? "等待登录完成…" : "登录新账号";
  els.importBtn.disabled = busy;
  els.accountLoginPanel.hidden = !busy && login.state !== "error";
  const labels = { starting: "正在打开登录页…", waiting: "请在浏览器完成登录", importing: "正在保存账号…" };
  els.accountLoginStatus.textContent = labels[login.state] || (login.message || "").replace("登录并添加", "添加账号");
  if (busy && els.addAccountDialog.open) els.addAccountDialog.close();
  els.openAccountLoginBtn.hidden = login.canOpen !== true;
  els.cancelAccountLoginBtn.hidden = login.canCancel !== true;
}

async function loginAccount() {
  els.loginAccountBtn.disabled = true;
  try { renderAccountLogin(await api.loginAccount(els.displayNameInput.value)); }
  catch (error) { els.loginAccountBtn.disabled = false; showToast(error.message); }
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
  const ok = window.confirm(`重新登录 ${account.displayName}？\n\n会备份并清除当前 Codex 登录，然后重启 Codex。`);
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
  els.confirmTitle.textContent = "删除账号";
  els.confirmBody.textContent = account.isActive
    ? `删除 ${account.displayName} 的本地凭证，并退出当前登录、重启 Codex。再次使用需重新登录。`
    : `删除 ${account.displayName} 的本地凭证。再次使用需重新登录。`;
  els.confirmDialog.returnValue = "";
  els.confirmDialog.showModal();
  els.confirmDialog.querySelector('[value="cancel"]').focus();
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

function positionActionMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8))}px`;
}

function withMenuAccount(action) {
  const account = state.snapshot?.accounts.find((item) => item.id === state.menuAccountId);
  els.accountMenu.hidePopover();
  if (account) action(account);
}

function wireEvents() {
  els.settingsBtn.addEventListener("click", () => els.settingsDialog.showModal());
  els.autoRecoverySummary.addEventListener("click", () => els.settingsDialog.showModal());
  els.addAccountBtn.addEventListener("click", () => els.addAccountDialog.showModal());
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close());
  });
  for (const menu of [els.accountMenu, els.transferMenu]) {
    let trigger;
    menu.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") trigger = document.activeElement;
    });
    menu.addEventListener("toggle", (event) => {
      if (event.newState === "closed" && menu === els.accountMenu && state.accountsRenderDeferred && state.snapshot) renderAccounts(state.snapshot);
      if (event.newState !== "open" || !trigger?.isConnected) return;
      positionActionMenu(menu, trigger);
      menu.querySelector("button:not([hidden])")?.focus();
    });
  }
  els.accountDetailsBtn.addEventListener("click", () => withMenuAccount((account) => {
    toggleAccountDetails(account.id);
    [...els.accountList.children].find((item) => item.dataset.accountId === account.id)?.querySelector(".account-expand-cue")?.focus();
  }));
  els.renameAccountBtn.addEventListener("click", () => withMenuAccount(renameAccount));
  els.reauthAccountBtn.addEventListener("click", () => withMenuAccount((account) => reauthAccount(account, els.reauthAccountBtn)));
  els.deleteAccountBtn.addEventListener("click", () => withMenuAccount(confirmDelete));
  els.accountsTab.addEventListener("click", () => setActivePage("accounts"));
  els.usageTab.addEventListener("click", () => setActivePage("usage"));
  els.refreshBtn.addEventListener("click", () => refresh(false).catch((error) => showToast(error.message)));
  els.widgetBtn.addEventListener("click", () => api.showWidget().catch((error) => showToast(error.message)));
  els.statsRefreshBtn.addEventListener("click", () => loadDashboard(false).catch((error) => showToast(error.message)));
  els.scopeCurrentBtn.addEventListener("click", () => setUsageScope("current"));
  els.scopeAllBtn.addEventListener("click", () => setUsageScope("all"));
  els.overviewPrivacyBtn.addEventListener("click", toggleOverviewPrivacy);
  els.overviewRefreshBtn.addEventListener("click", refreshAllAccountsQuota);
  renderOverviewPrivacy();
  els.restartAfterSwitch?.addEventListener("change", async () => {
    els.restartAfterSwitch.disabled = true;
    try {
      state.snapshot = await api.updateSettings({ restartAfterSwitch: els.restartAfterSwitch.checked });
    } catch (error) { showToast(error.message); }
    finally { renderSettings(state.snapshot); els.restartAfterSwitch.disabled = false; }
  });
  els.autoSwitchOnLimit?.addEventListener("change", async () => {
    const enabled = els.autoSwitchOnLimit.checked;
    els.autoSwitchOnLimit.disabled = true;
    try {
      const snapshot = await api.updateSettings({ autoSwitchOnLimit: enabled });
      state.snapshot = snapshot;
      renderSettings(snapshot);
      showToast(enabled ? "已开启自动切换与续任务" : "已关闭自动切换");
    } catch (error) {
      els.autoSwitchOnLimit.checked = !enabled;
      showToast(error.message);
    } finally { els.autoSwitchOnLimit.disabled = state.snapshot?.platform !== "win32"; }
  });
  els.autoResetOnWeeklyLimit?.addEventListener("change", async () => {
    const enabled = els.autoResetOnWeeklyLimit.checked;
    els.autoResetOnWeeklyLimit.disabled = true;
    try {
      const snapshot = await api.updateSettings({ autoResetOnWeeklyLimit: enabled });
      state.snapshot = snapshot;
      renderSettings(snapshot);
      showToast(enabled ? "已开启自动使用重置卡" : "已关闭自动使用重置卡");
    } catch (error) {
      els.autoResetOnWeeklyLimit.checked = !enabled;
      showToast(error.message);
    } finally { renderSettings(state.snapshot); }
  });
  els.importBtn.addEventListener("click", () => importCurrent());
  els.loginAccountBtn.addEventListener("click", loginAccount);
  els.cancelAccountLoginBtn.addEventListener("click", async () => {
    try { renderAccountLogin(await api.cancelAccountLogin()); } catch (error) { showToast(error.message); }
  });
  els.openAccountLoginBtn.addEventListener("click", async () => {
    try { renderAccountLogin(await api.openAccountLogin()); } catch (error) { showToast(error.message); }
  });
  els.exportCredentialsBtn.addEventListener("click", () => {
    els.transferMenu.hidePopover();
    els.exportScopeDialog.returnValue = "";
    els.exportScopeDialog.showModal();
  });
  els.exportScopeDialog.addEventListener("close", () => {
    if (els.exportScopeDialog.returnValue === "current") openCredentialTransfer("export");
    else if (els.exportScopeDialog.returnValue === "all") openCredentialTransfer("export-all");
  });
  els.importCredentialsBtn.addEventListener("click", () => { els.transferMenu.hidePopover(); startCredentialImport(); });
  els.transferForm.addEventListener("submit", submitCredentialTransfer);
  els.transferCancel.addEventListener("click", () => els.transferDialog.close());
  els.transferDialog.addEventListener("cancel", (event) => { if (transferBusy) event.preventDefault(); });
  els.transferDialog.addEventListener("close", () => {
    els.transferForm.reset(); els.transferError.textContent = "";
    if (importSelection) { api.cancelPortable(importSelection.selectionId).catch(() => {}); importSelection = null; }
  });
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
    refresh(true).catch((error) => showToast(error.message));
  });
}

wireEvents();
refresh(true).catch((error) => showToast(error.message));
