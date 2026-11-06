// Subscription dates are separate from both credential expiry and quota resets.
const SUBSCRIPTION_URL = "https://chatgpt.com/backend-api/subscriptions";
const DAY_MS = 86400000;

function subscriptionUrl(accountId) {
  if (typeof accountId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) throw new Error("Invalid subscription account.");
  return `${SUBSCRIPTION_URL}?account_id=${accountId}`;
}

function isSubscriptionUrl(value) {
  try {
    const url = new URL(value);
    return value === subscriptionUrl(url.searchParams.get("account_id"));
  } catch { return false; }
}
function subscriptionTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1
      || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeSubscription(value) {
  if (!["auth-claims", "online-subscription"].includes(value?.source)) return null;
  const activeUntil = subscriptionTimestamp(value.activeUntil);
  if (!activeUntil) return null;
  return { activeUntil, checkedAt: subscriptionTimestamp(value.checkedAt), source: value.source };
}

function mergeSubscriptionClaims(previous, incoming) {
  const before = normalizeSubscription(previous), next = normalizeSubscription(incoming);
  if (!before) return next;
  if (!next) return before;
  return (Date.parse(next.checkedAt) || 0) >= (Date.parse(before.checkedAt) || 0) ? next : before;
}

function accountSubscription(account) {
  return normalizeSubscription(account.subscription) ?? normalizeSubscription(account.identity?.subscription);
}

function parseSubscription(data, identity, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const plan = (value) => typeof value === "string" ? value.toLowerCase().replace(/^team$/, "business") : null;
  if (!identity?.userId || !plan(identity.planType) || plan(data.plan_type) !== plan(identity.planType)
    || plan(data.plan_type) === "free" || (data.account_id && data.account_id !== identity.userId)) return null;
  return normalizeSubscription({ activeUntil: data.active_until, checkedAt: new Date(now).toISOString(), source: "online-subscription" });
}

function subscriptionRefreshDue(account, now = Date.now()) {
  const retryAt = account.subscriptionStatus?.retryAt;
  if (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > now) return false;
  const saved = normalizeSubscription(account.subscription);
  if (!saved || saved.source !== "online-subscription") return true;
  const until = Date.parse(saved.activeUntil), checked = Date.parse(saved.checkedAt);
  if (!Number.isFinite(checked) || checked > now) return true;
  if (until - now > DAY_MS) return false;
  // Refresh once in the day before expiry, again when the date is crossed,
  // then at most daily if the service still reports the old subscription.
  return (until <= now && checked < until) || now - checked >= DAY_MS;
}

function subscriptionFromClaims(payloads, identity) {
  if (!identity?.userId || !identity.planType) return null;
  const plan = (value) => typeof value === "string" ? value.toLowerCase().replace(/^team$/, "business") : null;
  const candidates = [];
  for (const payload of payloads) {
    const claims = payload?.["https://api.openai.com/auth"];
    if (!claims || typeof claims !== "object") continue;
    const accountId = payload.chatgpt_account_id || claims.chatgpt_account_id;
    if (accountId !== identity.userId || plan(claims.chatgpt_plan_type) !== plan(identity.planType)) continue;
    if (payload.sub && identity.subject && payload.sub !== identity.subject) continue;
    const snapshot = normalizeSubscription({
      activeUntil: claims.chatgpt_subscription_active_until,
      checkedAt: claims.chatgpt_subscription_last_checked,
      source: "auth-claims",
    });
    if (snapshot) candidates.push(snapshot);
  }
  return candidates.sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0))[0] ?? null;
}

module.exports = { normalizeSubscription, subscriptionFromClaims, mergeSubscriptionClaims,
  accountSubscription, parseSubscription, subscriptionRefreshDue, subscriptionUrl, isSubscriptionUrl };
