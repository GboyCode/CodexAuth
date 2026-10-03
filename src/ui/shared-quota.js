(function initSharedQuotaUi(global) {
  const t = (...args) => global.CodexI18n.t(...args);
  function clampPercent(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, number));
  }

  function remainingPercent(window) {
    const used = clampPercent(window?.usedPercent);
    return used === null ? null : Math.max(0, 100 - used);
  }

  function isEstimatedWindow(window) {
    const estimated = clampPercent(window?.estimatedUsedPercent);
    const delta = Number(window?.estimatedDeltaPercent);
    return estimated !== null && Number.isFinite(delta) && delta > 0;
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

  function formatPlanType(planType) {
    const value = String(planType || "").trim();
    if (!value) return "--";
    const normalized = value.toLowerCase();
    if (normalized === "team" || normalized === "business") return "Business";
    return value.toUpperCase();
  }

  function relativeReset(value) {
    if (!value) return t("重置时间未知");
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return t("重置时间未知");
    if (date.getTime() <= Date.now()) return t("待更新");
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const time = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    if (date.toDateString() === now.toDateString()) return t("{0} 重置", time);
    if (date.toDateString() === tomorrow.toDateString()) return t("明天 {0} 重置", time);
    const day = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      month: "numeric",
      day: "numeric",
    }).format(date);
    return t("{0} {1} 重置", day, time);
  }

  function compactReset(value) {
    if (!value) return "";
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return "";
    if (date.getTime() <= Date.now()) return t("待更新");
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const time = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    if (date.toDateString() === now.toDateString()) return t("{0}重置", time);
    if (date.toDateString() === tomorrow.toDateString()) return t("明天{0}", time);
    return new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }

  function quotaWindowLabel(kind, window) {
    if (window?.windowMinutes === 10080) return t("周额度");
    if (kind === "weekly") return t("周额度");
    if (window?.windowMinutes === 300) return t("5 小时额度");
    if (window?.windowMinutes) return t("{0} 小时额度", Math.round(window.windowMinutes / 60));
    return t("会话额度");
  }

  function windowTitle(kind, quotaWindow) {
    return quotaWindowLabel(kind, quotaWindow);
  }

  function estimateRemainingLabel(window) {
    const value = Number(window?.estimatedRemainingPercent);
    const delta = Number(window?.estimatedDeltaPercent);
    if (!Number.isFinite(value) || !Number.isFinite(delta) || delta <= 0) return "";
    return t(" · 预估剩余 {0}%", Math.round(Math.max(0, Math.min(100, value))));
  }

  function quotaConfidenceLabel(quota) {
    const confidence = String(quota?.estimate?.confidence || "").trim();
    if (!confidence) return "";
    const labels = {
      "active-session": t("当前会话校准"),
      "active-session-blended": t("会话校准混合"),
      learned: t("账号学习校准"),
      "learned-calibrated": t("学习 + 历史校准"),
      "learned-active-session": t("学习 + 会话校准"),
      "learned-active-session-blended": t("学习 + 混合校准"),
      "learned-fallback": t("学习 + 保守估算"),
      "learned-low-sample": t("学习 + 低样本"),
      calibrated: t("历史校准"),
      "official-calibrated": t("在线数据校准"),
      "low-sample": t("低样本校准"),
      fallback: t("保守估算"),
    };
    for (const [key, label] of Object.entries(labels)) {
      if (confidence === key || confidence.startsWith(`${key}-`)) return label;
    }
    return "";
  }

  function quotaEstimateStatusLabel(quota, options = {}) {
    if (!quota?.estimate) return "";
    if (quota.estimate.available) {
      if (options.compact === true) return t(" · 预估");
      const confidence = quotaConfidenceLabel(quota);
      return confidence ? t(" · 预估（{0}）", confidence) : t(" · 预估");
    }
    return options.compact === true ? "" : t(" · 待预估：{0}", quota.estimate.reason || t("暂无新数据"));
  }

  function compactQuotaFreshnessStatus(quota, seconds) {
    if (quota?.estimate?.available) return t("预估");
    if (["online-account", "local-desktop"].includes(quota?.source)) return seconds < 60 ? t("在线") : t("缓存");
    return quota?.source === "local-error" ? t("限额记录") : t("缓存");
  }

  function quotaSourceLabel(source) {
    if (source === "online-account" || source === "local-desktop") return t("在线");
    if (["official", "local", "account-cache"].includes(source)) return t("缓存");
    if (source === "local-error") return t("限额记录");
    return t("暂无数据");
  }

  function quotaFreshnessLabel(quota, options = {}) {
    if (!quota?.checkedAt) return t("暂无数据");
    const date = new Date(quota.checkedAt);
    const diffMs = Date.now() - date.getTime();
    if (!Number.isFinite(diffMs)) return t("更新时间未知");
    const seconds = Math.max(0, Math.round(diffMs / 1000));
    if (options.compact === true && options.inline) {
      const time = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      return `${compactQuotaFreshnessStatus(quota, seconds)} ${time}`;
    }
    const time = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    return `${compactQuotaFreshnessStatus(quota, seconds)} · ${time}`;
  }

  function formatSnapshotTime(value) {
    if (!value) return t("更新时间未知");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("更新时间未知");
    return t("更新 {0}", new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date));
  }

  function formatRemainingText(window) {
    const remaining = displayRemainingPercent(window);
    if (remaining === null) return "--";
    const prefix = isEstimatedWindow(window) ? t("≈剩余") : t("剩余");
    return `${prefix} ${Math.round(remaining)}%`;
  }

  function formatUsedFootnote(window, options = {}) {
    if (clampPercent(window?.usedPercent) === null) return window?.resetsAt ? relativeReset(window.resetsAt) : t("暂无数据");
    const used = displayUsedPercent(window);
    const prefix = isEstimatedWindow(window) ? t("≈已用") : t("已用");
    if (options.compact === true) {
      const reset = compactReset(window?.resetsAt);
      const separator = global.CodexI18n.getLanguage() === "en" ? " " : "";
      return reset ? `${prefix}${separator}${Math.round(used)}% · ${reset}` : `${prefix}${separator}${Math.round(used)}%`;
    }
    return `${prefix} ${Math.round(used)}% · ${relativeReset(window?.resetsAt)}`;
  }

  function resetCreditsLabel(reset, options = {}) {
    if (!reset || !Number.isInteger(reset.availableCount)) return t("重置 --");
    const stamp=Date.parse(reset.checkedAt);
    const stale=!Number.isFinite(stamp)||Date.now()-stamp>5*60*1000;
    const expiry=(reset.credits??[]).filter((c)=>c.status==="available"&&Number.isFinite(c.expiresAt)).map((c)=>c.expiresAt);
    const hasExpired=expiry.some((n)=>n*1000<=Date.now());
    const cached=hasExpired||stale||!["online-account","local-desktop"].includes(reset.source);
    const label=t("重置 {0} 次{1}", reset.availableCount, cached?t(" · 缓存"):"");
    if (options.compact) return label;
    return `${label} · ${formatSnapshotTime(reset.checkedAt)}${hasExpired?t(" · 含过期记录"):""}`;
  }

  function subscriptionDisplay(subscription, now = Date.now()) {
    const until = typeof subscription?.activeUntil === "string" ? Date.parse(subscription.activeUntil) : NaN;
    if (!Number.isFinite(until)) return { label: t("到期 未知"), title: t("暂无到期日期") };
    const date = new Date(until);
    const fullDate = new Intl.DateTimeFormat(window.CodexI18n.locale(), {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
    const checkedAt = Date.parse(subscription.checkedAt);
    let title = t("到期 {0}", fullDate);
    if (Number.isFinite(checkedAt)) title += t("\n更新 {0}", new Date(checkedAt).toLocaleDateString(window.CodexI18n.locale()));
    title += t("\n不代表自动扣费日。");
    if (until <= now) return { label: t("到期 待更新"), title: t("{0}\n日期已过，待更新。", title) };
    return {
      label: t("到期 {0}", new Intl.DateTimeFormat(window.CodexI18n.locale(), { month: "2-digit", day: "2-digit" }).format(date)),
      title,
    };
  }

  global.CodexQuotaUI = {
    subscriptionDisplay,
    resetCreditsLabel,
    clampPercent,
    remainingPercent,
    isEstimatedWindow,
    displayRemainingPercent,
    displayUsedPercent,
    formatPlanType,
    relativeReset,
    quotaWindowLabel,
    windowTitle,
    estimateRemainingLabel,
    quotaConfidenceLabel,
    quotaEstimateStatusLabel,
    quotaSourceLabel,
    quotaFreshnessLabel,
    formatSnapshotTime,
    formatRemainingText,
    formatUsedFootnote,
  };
})(window);
