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
    if (quota?.estimate?.available) return seconds < 10 ? "已写入校准" : "已预估校准";
    if (quota?.estimate) return "等待新记录";
    return "等待写入";
  }

  function paceLabel(window, options = {}) {
    if (!window?.resetsAt || !window?.windowMinutes) return "";
    const used = displayUsedPercent(window);
    if (!Number.isFinite(used) || used <= 0) {
      return options.compact ? " · 速度宽松" : " · 消耗速度宽松";
    }
    const resetsAtMs = Number(window.resetsAt) * 1000;
    const periodMs = Number(window.windowMinutes) * 60 * 1000;
    if (!Number.isFinite(resetsAtMs) || !Number.isFinite(periodMs) || periodMs <= 0) return "";
    const startMs = resetsAtMs - periodMs;
    const elapsedMs = Date.now() - startMs;
    if (elapsedMs <= 0 || Date.now() >= resetsAtMs) return "";
    const elapsedFraction = elapsedMs / periodMs;
    if (elapsedFraction < 0.05 && used < 100) return "";
    const projectedUsed = (used / elapsedMs) * periodMs;
    if (projectedUsed <= 80) return options.compact ? " · 速度宽松" : " · 消耗速度宽松";
    if (projectedUsed <= 100) return options.compact ? " · 速度正常" : " · 消耗速度正常";
    return options.compact ? " · 会提前用完" : " · 按当前速度会提前用完";
  }

  function quotaSourceLabel(source) {
    if (source === "official") return "来自本地保存的额度快照";
    if (source === "local") return "来自本地 Codex 日志";
    if (source === "local-error") return "来自本地 Codex 限额日志";
    if (source === "account-cache") return "此账号上次本地快照";
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
    return `${prefix} ${Math.round(used)}%${estimateRemainingLabel(window)} · ${relativeReset(window?.resetsAt)}${paceLabel(window, options)}`;
  }

  function resetCreditsLabel(reset, options = {}) {
    if (!reset || !Number.isInteger(reset.availableCount)) return "重置次数：未知 · 尚无本地记录";
    const stamp=Date.parse(reset.checkedAt);
    const stale=!Number.isFinite(stamp)||Date.now()-stamp>5*60*1000;
    const expiry=(reset.credits??[]).filter((c)=>c.status==="available"&&Number.isFinite(c.expiresAt)).map((c)=>c.expiresAt);
    const hasExpired=expiry.some((n)=>n*1000<=Date.now());
    const status=hasExpired?"含已到期记录，待更新":stale?"旧快照，待更新":"本地快照";
    return `重置次数：${reset.availableCount} · ${status}${options.compact?"":` · ${formatSnapshotTime(reset.checkedAt)}`}`;
  }

  global.CodexQuotaUI = {
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
    paceLabel,
    quotaSourceLabel,
    quotaFreshnessLabel,
    formatSnapshotTime,
    formatRemainingText,
    formatUsedFootnote,
  };
})(window);
