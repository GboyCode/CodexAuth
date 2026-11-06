const { requestJson } = require("./quota/online-accounts");
const { parseSubscription, subscriptionRefreshDue, subscriptionUrl } = require("./subscription");

const FAILURE_RETRY_MS = 6 * 3600000;

// Independent, read-only work: never renew tokens or hold up quota/switching.
function createSubscriptionReader(deps) {
  const now = deps.now ?? Date.now, request = deps.request ?? requestJson;
  const flights = new Map();
  let queue = Promise.resolve(), stopped = false, scanning = null;

  async function read(id) {
    if (stopped) return;
    const account = await deps.getAccount(id);
    if (!account || account.needsReauth || !subscriptionRefreshDue(account, now())) return;
    let context;
    try {
      context = await deps.readCredentials(id);
      if (stopped || !context) return;
      const auth = JSON.parse(context.content);
      if (typeof auth.tokens?.access_token !== "string" || !auth.tokens.access_token) throw new Error();
      const response = await request(subscriptionUrl(context.identity.userId), { headers: {
        Accept: "application/json", Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": context.identity.userId, "OpenAI-Beta": "codex-1", "User-Agent": "CodexAuth",
      } });
      if (stopped) return;
      const checkedAt = new Date(now()).toISOString();
      const subscription = response.status === 200 ? parseSubscription(response.data, context.identity, now()) : null;
      let retryMs = FAILURE_RETRY_MS;
      const header = response.retryAfter == null ? "" : String(response.retryAfter).trim();
      if (header) {
        const delay = Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - now();
        if (Number.isFinite(delay)) retryMs = Math.max(retryMs, delay);
      }
      const status = subscription ? { checkedAt, error: null, retryAt: null } : { checkedAt,
        error: response.status === 200 ? "订阅接口未返回匹配的有效日期，保留上次记录。" : `订阅查询暂不可用（HTTP ${response.status}），保留上次记录。`,
        retryAt: now() + retryMs, httpStatus: response.status };
      await deps.saveResult(id, context, subscription, status);
    } catch {
      if (stopped) return;
      await deps.saveResult(id, context ?? null, null, { checkedAt: new Date(now()).toISOString(),
        error: "订阅查询未成功，保留上次记录。", retryAt: now() + FAILURE_RETRY_MS }).catch(() => {});
    }
  }

  function check(id) {
    if (stopped) return Promise.resolve();
    if (flights.has(id)) return flights.get(id);
    const pending = queue.then(() => read(id)).catch(() => {}).finally(() => flights.delete(id));
    queue = pending;
    flights.set(id, pending);
    return pending;
  }

  function checkAll() {
    if (scanning) return scanning;
    scanning = Promise.resolve().then(async () => {
      for (const account of await deps.listAccounts()) {
        if (stopped) break;
        if (subscriptionRefreshDue(account, now())) await check(account.id);
      }
    }).catch(() => {}).finally(() => { scanning = null; });
    return scanning;
  }
  return { check, checkAll, stop: () => { stopped = true; } };
}

module.exports = { createSubscriptionReader };
