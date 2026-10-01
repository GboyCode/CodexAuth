// Subscription metadata is a dated account snapshot, not a live billing lookup.
// Never substitute JWT exp or a quota reset for the subscription's end date.
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
  if (value?.source !== "auth-claims") return null;
  const activeUntil = subscriptionTimestamp(value.activeUntil);
  if (!activeUntil) return null;
  return { activeUntil, checkedAt: subscriptionTimestamp(value.checkedAt), source: "auth-claims" };
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

module.exports = { normalizeSubscription, subscriptionFromClaims };
