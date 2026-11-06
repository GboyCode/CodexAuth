const { bucketsFromRecord, normalizeBucket, combineBuckets, normalizeResetCredits } = require("./local-records");
const { normalizePlanType } = require("./token-math");

const DESKTOP_QUOTA_REFRESH_MS = 30000;
const ERROR_MESSAGES = {
  CODEX_PIPE_CONNECTION: "Codex 本地接口连接失败，请稍后重试。",
  CODEX_PIPE_CLOSED: "Codex 本地接口已断开，请稍后重试。",
  CODEX_PIPE_TIMEOUT: "Codex 本地接口响应超时，请稍后重试。",
  CODEX_PIPE_UNAVAILABLE: "未连接到兼容的 Codex 桌面版，请打开 Codex 后重试。",
  CODEX_PIPE_AMBIGUOUS: "检测到多个 Codex 桌面实例，无法确定额度来源。",
  CODEX_PIPE_REJECTED: "Codex 拒绝了本地额度查询，请稍后重试。",
  CODEX_PIPE_PROTOCOL: "Codex 本地接口返回格式不兼容。",
  CODEX_TOOL_FAILED: "Codex 未完成额度查询，请稍后重试。",
  CODEX_QUOTA_ANCHOR: "没有可用的本地任务，请在 Codex 中打开任务后重试。",
  CODEX_QUOTA_DATA: "Codex 返回的账号或额度数据不匹配，请稍后重试。",
};

function scopeKey(scope) {
  if (!scope?.hasCurrentAuth || !scope.accountId || !scope.account?.userId) return null;
  return JSON.stringify([scope.accountId, scope.since, scope.account.userId,
    scope.account.chatgptUserId, scope.account.subject, scope.account.email]);
}

function quotaFromDesktopUsage(usage, scope, checkedAt) {
  if (!scopeKey(scope) || usage?.accountId !== scope.account.userId) return null;
  const plan = normalizePlanType(scope.accountPlanType);
  const buckets = bucketsFromRecord(usage).map((raw) => normalizeBucket(raw, checkedAt));
  if (buckets.some((bucket) => plan && bucket.planType && normalizePlanType(bucket.planType) !== plan)) return null;
  const quota = combineBuckets(buckets.map((bucket) => ({ ...bucket, source: "local-desktop" })));
  if (!quota) return null;
  const resetCredits = normalizeResetCredits(usage.rateLimitResetCredits, checkedAt);
  return { ...quota, resetCredits: resetCredits ? { ...resetCredits, source: "local-desktop" } : null };
}

// Read through the existing desktop bridge, without handling tokens or calling
// an OpenAI endpoint here. A slow/unavailable desktop must never block the UI.
function createDesktopQuotaReader({ getAnchor, readUsage, getScope, onUpdate, onStatus = async () => {}, now = Date.now,
  refreshMs = DESKTOP_QUOTA_REFRESH_MS }) {
  let state = null;
  function read(scope, { force = false } = {}) {
    const key = scopeKey(scope);
    if (!key) { state = null; return null; }
    if (state?.key !== key) state = { key, quota: null, status: null, pending: null, retryAt: 0 };
    const current = state;
    if (!current.pending && (force || now() >= current.retryAt)) {
      current.retryAt = now() + refreshMs;
      current.pending = Promise.resolve().then(async () => {
        const anchor = await getAnchor();
        if (state !== current) return;
        if (!anchor) throw Object.assign(new Error(), { code: "CODEX_QUOTA_ANCHOR" });
        const usage = await readUsage(anchor);
        const active = await getScope();
        if (state !== current || scopeKey(active) !== key) return;
        const quota = quotaFromDesktopUsage(usage, scope, new Date(now()).toISOString());
        if (!quota) throw Object.assign(new Error(), { code: "CODEX_QUOTA_DATA" });
        await onUpdate(scope, quota);
        current.quota = quota;
        current.status = { checkedAt: quota.checkedAt, error: null, source: "local-desktop" };
        await Promise.resolve().then(() => onStatus(scope, current.status)).catch(() => {});
        return quota;
      }).catch(async (error) => {
        const active = await Promise.resolve().then(getScope).catch(() => null);
        if (state !== current || scopeKey(active) !== key) return;
        // Only expose fixed diagnostic text, never native errors or auth data.
        const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : "CODEX_QUOTA_FAILED";
        current.status = { checkedAt: new Date(now()).toISOString(), code, source: "local-desktop",
          error: ERROR_MESSAGES[code] ?? "当前账号额度读取或保存失败，请稍后重试。" };
        await Promise.resolve().then(() => onStatus(scope, current.status)).catch(() => {});
        // Keep the timestamp of the last successful snapshot.
      })
        .finally(() => {
          current.pending = null;
          const completedAt = now();
          const resets = [current.quota?.session, current.quota?.weekly]
            .map((window) => Number(window?.resetsAt) * 1000)
            .filter((reset) => Number.isFinite(reset) && reset > completedAt);
          // Re-read at the next poll after a known reset instead of retaining
          // the old balance until the regular refresh interval expires.
          current.retryAt = Math.min(completedAt + refreshMs, ...resets);
        });
    }
    return current.quota;
  }
  async function refresh(scope) {
    read(scope, { force: true });
    const current = state;
    if (!current || current.key !== scopeKey(scope)) return null;
    const quota = await current.pending;
    return state === current && scopeKey(await getScope()) === current.key ? quota ?? null : null;
  }
  return { read, refresh, getStatus: (scope) => state?.key === scopeKey(scope) ? state?.status ?? null : null };
}

module.exports = { DESKTOP_QUOTA_REFRESH_MS, quotaFromDesktopUsage, createDesktopQuotaReader };
