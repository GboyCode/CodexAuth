const { normalizePlanType } = require("./token-math");

const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_RESET_URL = `${RESET_CREDITS_URL}/consume`;

function resetWindowKey(quota) {
  return JSON.stringify([quota?.session, quota?.weekly].map((window) => window
    ? [window.windowMinutes, window.resetsAt] : null));
}

function canResetAccount(account, quota = account?.quotaSnapshot, now = Date.now()) {
  // Require a matching supported plan and an exhausted weekly allowance.
  // Spending a full reset for a depleted 5h window would waste the remaining week.
  const plan = normalizePlanType(account?.identity?.planType);
  if (!account?.identity?.userId || account.needsReauth
    || !["plus", "business"].includes(plan)
    || normalizePlanType(quota?.planType) !== plan
    // Desktop snapshots are already bound by the account store but omit this
    // field. They may nominate a candidate; redemption always reads live usage.
    || (quota.accountId != null && quota.accountId !== account.identity.userId) || quota.unknownWindow
    || !(quota.resetCredits?.availableCount > 0)) return false;
  const windows = [quota.session, quota.weekly].filter(Boolean);
  if (!windows.length || windows.some((window) => !Number.isFinite(window.usedPercent)
    || !Number.isFinite(window.resetsAt) || window.resetsAt * 1000 <= now
    || !Number.isFinite(window.windowMinutes) || window.windowMinutes <= 0)
    || !Number.isFinite(quota.weekly?.windowMinutes) || quota.weekly.windowMinutes < 10080
    || quota.weekly.usedPercent !== 100) return false;
  const previous = account.autoResetAttempt;
  // Unknown results remain blocked across restarts. A later confirmed available
  // quota and a different exhaustion window are required before another card.
  return !previous || (previous.accountId === account.identity.userId && (previous.status === "not-sent"
    || (previous.status === "verified" && previous.windowKey !== resetWindowKey(quota))));
}

function chooseResetCredit(data, now = Date.now()) {
  if (!Number.isInteger(data?.available_count) || data.available_count <= 0 || !Array.isArray(data.credits)) return null;
  const expires = (credit) => credit.expires_at === null ? Infinity : Date.parse(credit.expires_at);
  return data.credits.filter((credit) => typeof credit?.id === "string" && credit.id.length > 0
    && credit.status === "available" && credit.reset_type === "codex_rate_limits"
    && (credit.expires_at === null || (typeof credit.expires_at === "string" && expires(credit) > now)))
    .sort((a, b) => expires(a) - expires(b) || a.id.localeCompare(b.id))[0] ?? null;
}

module.exports = { canResetAccount, resetWindowKey, chooseResetCredit, RESET_CREDITS_URL, CONSUME_RESET_URL };
