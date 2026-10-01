const { bucketsFromRecord, normalizeBucket, combineBuckets, normalizeResetCredits } = require("./local-records");
const { normalizePlanType } = require("./token-math");

const DESKTOP_QUOTA_REFRESH_MS = 30000;

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
function createDesktopQuotaReader({ getAnchor, readUsage, getScope, onUpdate, now = Date.now,
  refreshMs = DESKTOP_QUOTA_REFRESH_MS }) {
  let state = null;
  function read(scope, { force = false } = {}) {
    const key = scopeKey(scope);
    if (!key) { state = null; return null; }
    if (state?.key !== key) state = { key, quota: null, pending: null, retryAt: 0 };
    const current = state;
    if (!current.pending && (force || now() >= current.retryAt)) {
      current.retryAt = now() + refreshMs;
      current.pending = Promise.resolve().then(async () => {
        const anchor = await getAnchor();
        if (!anchor || state !== current) return;
        const usage = await readUsage(anchor);
        const active = await getScope();
        if (state !== current || scopeKey(active) !== key) return;
        const quota = quotaFromDesktopUsage(usage, scope, new Date(now()).toISOString());
        if (!quota) return;
        current.quota = quota;
        await onUpdate(scope, quota);
        return quota;
      }).catch(() => { /* Keep the timestamp of the last successful snapshot. */ })
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
  return { read, refresh };
}

module.exports = { DESKTOP_QUOTA_REFRESH_MS, quotaFromDesktopUsage, createDesktopQuotaReader };
