(function initSharedQuotaUi(global) {
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

  function compactReset(value) {
    if (!value) return "";
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return "";
    if (date.getTime() <= Date.now()) return "已重置";
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const time = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    if (date.toDateString() === now.toDateString()) return `${time}重置`;
    if (date.toDateString() === tomorrow.toDateString()) return `明天${time}`;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }

  function quotaWindowLabel(kind, window) {
    if (window?.windowMinutes === 10080) return "周额度";
    if (kind === "weekly") return "周额度";
    if (window?.windowMinutes === 300) return "5 小时额度";
    if (window?.windowMinutes) return `${Math.round(window.windowMinutes / 60)} 小时额度`;
    return "会话额度";
  }

  function windowTitle(kind, quotaWindow) {
    return quotaWindowLabel(kind, quotaWindow);
  }

  function estimateRemainingLabel(window) {
    const value = Number(window?.estimatedRemainingPercent);
    const delta = Number(window?.estimatedDeltaPercent);
    if (!Number.isFinite(value) || !Number.isFinite(delta) || delta <= 0) return "";
    return ` · 预估剩余 ${Math.round(Math.max(0, Math.min(100, value)))}%`;
  }

  function quotaConfidenceLabel(quota) {
    const confidence = String(quota?.estimate?.confidence || "").trim();
    if (!confidence) return "";
    const labels = {
      "active-session": "当前会话校准",
      "active-session-blended": "会话校准混合",
      learned: "账号学习校准",
      "learned-calibrated": "学习 + 历史校准",
      "learned-active-session": "学习 + 会话校准",
      "learned-active-session-blended": "学习 + 混合校准",
      "learned-fallback": "学习 + 保守估算",
      "learned-low-sample": "学习 + 低样本",
      calibrated: "历史校准",
      "official-calibrated": "在线快照校准",
      "low-sample": "低样本校准",
      fallback: "保守估算",
    };
    for (const [key, label] of Object.entries(labels)) {
      if (confidence === key || confidence.startsWith(`${key}-`)) return label;
    }
    return "";
  }

  function quotaEstimateStatusLabel(quota, options = {}) {
    if (!quota?.estimate) return "";
    const compact = options.compact === true;
    if (quota.estimate.available) {
      const confidence = quotaConfidenceLabel(quota);
      if (compact) return confidence ? ` · 已预估（${confidence}）` : " · 已预估";
      return confidence ? ` · 已按本地增量预估（${confidence}）` : " · 已按本地增量预估";
    }
    return compact
      ? ` · 预估等待：${quota.estimate.reason || "本地新记录"}`
      : ` · 预估等待：${quota.estimate.reason || "本地新记录"}`;
  }

  function compactAgeLabel(seconds) {
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    return `${Math.round(hours / 24)}天前`;
  }

  function compactQuotaFreshnessStatus(quota, seconds) {
    if (quota?.estimate?.available && quota.estimate.confidence === "official-calibrated") return "在线校准预估";
    if (["online-account", "local-desktop"].includes(quota?.source)) return seconds < 60 ? "在线快照" : "在线旧快照";
    if (quota?.estimate?.available) return "本地校准预估";
    return seconds < 60 ? "本地快照" : "本地旧快照";
  }

  function quotaSourceLabel(source) {
    if (source === "online-account" || source === "local-desktop") return "在线快照";
    if (["official", "local", "account-cache"].includes(source)) return "本地快照";
    if (source === "local-error") return "本地限额记录";
    return "不可用";
  }

  function quotaFreshnessLabel(quota, options = {}) {
    if (!quota?.checkedAt) return "快照时间未知";
    const date = new Date(quota.checkedAt);
    const diffMs = Date.now() - date.getTime();
    if (!Number.isFinite(diffMs)) return "快照时间未知";
    const seconds = Math.max(0, Math.round(diffMs / 1000));
    if (options.compact === true) {
      const time = new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      if (options.inline) return `${compactQuotaFreshnessStatus(quota, seconds)} ${time}`;
      return `${compactAgeLabel(seconds)}·快照${time} ${compactQuotaFreshnessStatus(quota, seconds)}`;
    }
    const time = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
    const estimate = quotaEstimateStatusLabel(quota, options);
    if (seconds < 10) return `快照 ${time} · 刚写入${estimate}`;
    if (seconds < 60) return `快照 ${time} · ${seconds} 秒前${estimate}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 5) return `快照 ${time} · ${minutes} 分钟前${estimate}`;
    return `快照 ${time} · 等待 Codex 写入${estimate}`;
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

  function formatRemainingText(window) {
    const remaining = displayRemainingPercent(window);
    if (remaining === null) return "--";
    const prefix = isEstimatedWindow(window) ? "≈剩余" : "剩余";
    return `${prefix} ${Math.round(remaining)}%`;
  }

  function formatUsedFootnote(window, options = {}) {
    if (clampPercent(window?.usedPercent) === null) return "已用比例未知 · " + relativeReset(window?.resetsAt);
    const used = displayUsedPercent(window);
    const prefix = isEstimatedWindow(window) ? "≈已用" : "已用";
    if (options.compact === true) {
      const reset = compactReset(window?.resetsAt);
      return reset ? `${prefix}${Math.round(used)}% · ${reset}` : `${prefix}${Math.round(used)}%`;
    }
    return `${prefix} ${Math.round(used)}%${estimateRemainingLabel(window)} · ${relativeReset(window?.resetsAt)}`;
  }

  function resetCreditsLabel(reset, options = {}) {
    if (!reset || !Number.isInteger(reset.availableCount)) return options.inline ? "重置 未知" : "重置次数：未知 · 尚无本地记录";
    const stamp=Date.parse(reset.checkedAt);
    const stale=!Number.isFinite(stamp)||Date.now()-stamp>5*60*1000;
    const expiry=(reset.credits??[]).filter((c)=>c.status==="available"&&Number.isFinite(c.expiresAt)).map((c)=>c.expiresAt);
    const hasExpired=expiry.some((n)=>n*1000<=Date.now());
    const origin=["online-account","local-desktop"].includes(reset.source)?"在线快照":reset.source==="local-browser-cache"?"本地缓存":"本地快照";
    const status=hasExpired?`${origin} · 含已到期记录，待更新`:stale?`${origin.replace("快照","旧快照").replace("缓存","旧缓存")}，待更新`:origin;
    const countLabel = options.inline ? `重置 ${reset.availableCount}` : `重置次数：${reset.availableCount}`;
    return `${countLabel} · ${status}${options.compact?"":` · ${formatSnapshotTime(reset.checkedAt)}`}`;
  }

  function subscriptionDisplay(subscription, now = Date.now()) {
    const until = typeof subscription?.activeUntil === "string" ? Date.parse(subscription.activeUntil) : NaN;
    if (!Number.isFinite(until)) return { label: "到期 未知", title: "账号快照未提供订阅到期日。" };
    const date = new Date(until);
    const fullDate = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
    const checkedAt = Date.parse(subscription.checkedAt);
    let title = `订阅有效期至：${fullDate}\n本地账号快照`;
    if (Number.isFinite(checkedAt)) title += ` · 核验于 ${new Date(checkedAt).toLocaleDateString("zh-CN")}`;
    title += "。此日期不代表自动扣费日。";
    if (until <= now) return { label: "到期 待更新", title: `${title}\n该快照日期已过，当前到期日待更新。` };
    return {
      label: `到期 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date)}`,
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
