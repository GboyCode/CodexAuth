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
  return { ...quota, resetCredits: normalizeResetCredits(usage.rateLimitResetCredits, checkedAt) };
}

// Read through the existing desktop bridge, without handling tokens or calling
// an OpenAI endpoint here. A slow/unavailable desktop must never block the UI.
function createDesktopQuotaReader({ getAnchor, readUsage, getScope, onUpdate, now = Date.now,
  refreshMs = DESKTOP_QUOTA_REFRESH_MS }) {
  let state = null;
  function read(scope) {
    const key = scopeKey(scope);
    if (!key) { state = null; return null; }
    if (state?.key !== key) state = { key, quota: null, pending: null, retryAt: 0 };
    const current = state;
    if (!current.pending && now() >= current.retryAt) {
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
      }).catch(() => { /* Keep the timestamp of the last successful snapshot. */ })
        .finally(() => { current.pending = null; current.retryAt = now() + refreshMs; });
    }
    return current.quota;
  }
  return { read };
}

module.exports = { DESKTOP_QUOTA_REFRESH_MS, quotaFromDesktopUsage, createDesktopQuotaReader };
