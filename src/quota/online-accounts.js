const https = require("node:https");
const crypto = require("node:crypto");
const { normalizeBucket, normalizeResetCredits } = require("./local-records");

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CACHE_MS = 60000;
const MAINTENANCE_MS = 5 * 60000;
const RENEW_AGE_MS = 7 * 86400000;
const SOURCE = "online-account";
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const numeric = (n) => typeof n === "number" && Number.isFinite(n) ? n : null;

class OnlineError extends Error {
  constructor(code, message, { status = 0, reauth = false, retryMs = CACHE_MS } = {}) {
    super(message); this.code = code; this.status = status; this.reauth = reauth; this.retryMs = retryMs;
  }
}

// Main process only. No redirects, configurable destinations, raw error bodies,
// cookies or renderer network permissions. Bound both elapsed time and size.
function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  if (![USAGE_URL, TOKEN_URL].includes(url)) return Promise.reject(new OnlineError("destination", "不支持的服务地址。"));
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    let timer;
    const req = https.request(url, { method, headers: { Accept: "application/json", ...headers,
      ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new OnlineError("size", "官方接口响应过大。"));
        else chunks.push(chunk);
      });
      res.on("error", () => req.destroy(new OnlineError("network", "官方接口连接中断，请稍后重试。")));
      res.on("end", () => {
        clearTimeout(timer);
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
        resolve({ status: res.statusCode, data: json, retryAfter: res.headers["retry-after"] });
      });
    });
    timer = setTimeout(() => req.destroy(new OnlineError("timeout", "官方接口请求超时，请稍后重试。")), 15000);
    req.on("error", (error) => { clearTimeout(timer); reject(error instanceof OnlineError ? error
      : new OnlineError("network", "无法连接官方接口，请检查网络后重试。")); });
    req.end(data);
  });
}

function responseError(response, refresh = false, now = Date.now()) {
  const code = typeof response.data?.error === "string" ? response.data.error : response.data?.error?.code;
  const reauth = refresh && [400, 401, 403].includes(response.status)
    && ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"].includes(code);
  const retrySeconds = Number(response.retryAfter);
  const retryMs = Math.min(3600000, Math.max(CACHE_MS, Number.isFinite(retrySeconds)
    ? retrySeconds * 1000 : (Date.parse(response.retryAfter) - now) || CACHE_MS));
  return new OnlineError(reauth ? "reauth" : "http", reauth ? "官方拒绝续期，请重新登录此账号。"
    : `官方${refresh ? "续期" : "额度"}接口暂不可用（HTTP ${response.status}）。`, { status: response.status, reauth, retryMs });
}

function normalizeOnlineWindow(raw, now) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { used_percent: null, window_minutes: null, resets_at: null };
  }
  const used = numeric(raw.used_percent ?? raw.usedPercent);
  const seconds = numeric(raw.limit_window_seconds);
  const minutes = numeric(raw.windowDurationMins ?? raw.window_minutes) ?? (seconds !== null && seconds > 0 ? seconds / 60 : null);
  const after = numeric(raw.reset_after_seconds);
  return { used_percent: used !== null && used >= 0 && used <= 100 ? used : null,
    window_minutes: minutes !== null && minutes > 0 ? minutes : null,
    resets_at: numeric(raw.reset_at ?? raw.resets_at ?? raw.resetsAt) ?? (after !== null && after >= 0 ? Math.floor(now / 1000) + after : null) };
}

function parseUsage(data, accountId, now = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new OnlineError("schema", "官方额度响应格式无法识别。");
  const returnedId = data.account_id ?? data.accountId;
  if (returnedId && returnedId !== accountId) throw new OnlineError("identity", "额度响应的工作区与保存账号不一致。");
  const checkedAt = new Date(now).toISOString();
  const bucket = (raw, id, label, feature) => {
    if (!raw || typeof raw !== "object") return null;
    const primary = normalizeOnlineWindow(raw.primary_window ?? raw.primary, now);
    const secondary = normalizeOnlineWindow(raw.secondary_window ?? raw.secondary, now);
    const result = normalizeBucket({ ...raw, primary, secondary, limit_id: id, limit_name: label ?? id,
      plan_type: data.plan_type ?? data.planType }, checkedAt);
    // Preserve malformed present windows as unknown. They must not disappear
    // into an apparently valid weekly-only allowance.
    const unknownWindow = [primary, secondary].filter(Boolean).some((w) => w.used_percent === null || w.resets_at === null || w.window_minutes === null)
      || (raw.allowed != null && typeof raw.allowed !== "boolean") || (raw.limit_reached != null && typeof raw.limit_reached !== "boolean");
    return { ...result, source: SOURCE, allowed: typeof raw.allowed === "boolean" ? raw.allowed : null,
      limitReached: typeof raw.limit_reached === "boolean" ? raw.limit_reached : null, unknownWindow,
      meteredFeature: typeof feature === "string" ? feature : null };
  };
  const map = data.rateLimitsByLimitId ?? data.rate_limits_by_limit_id;
  let primary = bucket(data.rate_limit ?? data.rateLimits ?? map?.codex, "codex");
  const additional = [];
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [id, raw] of Object.entries(map)) {
      if (id === "codex") continue;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OnlineError("schema", "官方额外额度池格式无法识别。");
      additional.push(bucket(raw, id, raw.limit_name ?? raw.limitName));
    }
  }
  if (data.additional_rate_limits != null && !Array.isArray(data.additional_rate_limits)) throw new OnlineError("schema", "官方额外额度池格式无法识别。");
  for (const raw of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    if (!raw || typeof raw !== "object") throw new OnlineError("schema", "官方额外额度池格式无法识别。");
    const id = raw.metered_feature ?? raw.limit_id ?? raw.limit_name;
    const extra = bucket(raw.rate_limit, id, raw.limit_name, raw.metered_feature);
    if (typeof id !== "string" || !id || !extra) throw new OnlineError("schema", "官方额外额度池数据不完整。");
    additional.push(extra);
  }
  if (!primary) throw new OnlineError("schema", "官方响应缺少普通 Codex 额度，暂不能确认可用。");
  const resetRaw = data.rate_limit_reset_credits ?? data.rateLimitResetCredits;
  const resetCredits = numeric(resetRaw?.available_count ?? resetRaw?.availableCount) === null ? null : normalizeResetCredits(resetRaw, checkedAt);
  return { ...primary, schemaVersion: 2, accountId, additional: additional.filter(Boolean),
    credits: data.credits ? normalizeBucket({ credits: data.credits }, checkedAt).credits : primary.credits,
    resetCredits: resetCredits ? { ...resetCredits, source: SOURCE } : null };
}

function availability(quota, now = Date.now()) {
  // Conservatively check all returned Codex model pools: a task may retain a
  // model whose pool differs from the main allowance. Never infer a reset.
  const buckets = [quota, ...(quota?.additional ?? [])].filter(Boolean);
  if (!buckets.length) return null;
  let unknown = false;
  for (const bucket of buckets) {
    if (bucket.allowed === false || bucket.limitReached === true) return false;
    const windows = [bucket.session, bucket.weekly].filter(Boolean);
    if (!windows.length || bucket.unknownWindow) unknown = true;
    for (const window of windows) {
      if (numeric(window.usedPercent) === null || numeric(window.resetsAt) === null || window.resetsAt * 1000 <= now) unknown = true;
      else if (window.usedPercent >= 98) return false;
    }
  }
  return unknown ? null : true;
}

function shouldRenew(auth, now) {
  let exp = null;
  try { exp = numeric(JSON.parse(Buffer.from(auth.tokens.access_token.split(".")[1], "base64url")).exp); } catch { /* Unknown expiry: let service validate it. */ }
  const last = Date.parse(auth.last_refresh);
  return (exp !== null && exp * 1000 <= now + 5 * 60000) || !Number.isFinite(last) || now - last >= RENEW_AGE_MS;
}

function createOnlineAccounts(deps) {
  const now = deps.now ?? Date.now, request = deps.request ?? requestJson;
  const flights = new Map(), pendingWrites = new Map(), attempts = new Map();
  let stopping = false;
  async function commit(id) {
    const pending = pendingWrites.get(id);
    if (!pending) return;
    await deps.saveAuth(id, pending.previous, pending.next);
    pendingWrites.delete(id);
  }
  async function checkLocked(id, { force = false, allowed = () => true } = {}) {
    if (stopping || !allowed()) return { available: null, reason: "检查已取消。" };
    try {
      // A rotated token must be persisted before any later request or switch.
      await commit(id);
      let context = await deps.readAccount(id);
      if (!context || context.active) return { available: null, reason: "当前账号由 Codex 维护登录和额度。" };
      if (context.account.needsReauth) return { available: null, reason: "此账号需要重新登录。" };
      let content = context.content, auth = JSON.parse(content), fingerprint = digest(content);
      const attempt = attempts.get(id);
      if (attempt?.fingerprint === fingerprint && attempt.retryAt > now()) return { available: null, reason: attempt.reason };
      const cached = context.account.quotaSnapshot;
      if (!force && cached?.source === SOURCE && cached.authFingerprint === fingerprint
        && cached.accountId === context.account.identity?.userId && Date.parse(cached.checkedAt) <= now()
        && now() - Date.parse(cached.checkedAt) < CACHE_MS && !shouldRenew(auth, now())) {
        return { available: availability(cached, now()), quota: cached };
      }
      const renew = async () => {
        if (!allowed()) throw new OnlineError("cancelled", "检查已取消。");
        const fresh = await deps.readAccount(id);
        if (!fresh || fresh.active || fresh.content !== content) throw new OnlineError("changed", "账号状态已改变，请重新检查。");
        const response = await request(TOKEN_URL, { method: "POST", body: { client_id: CLIENT_ID,
          grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token, scope: "openid profile email" } });
        if (response.status !== 200) throw responseError(response, true, now());
        const tokens = response.data;
        if (typeof tokens?.access_token !== "string" || !tokens.access_token) throw new OnlineError("schema", "官方续期响应缺少有效凭据。");
        const next = { ...auth, tokens: { ...auth.tokens }, last_refresh: new Date(now()).toISOString() };
        for (const key of ["access_token", "refresh_token", "id_token"]) {
          if (typeof tokens[key] === "string" && tokens[key]) next.tokens[key] = tokens[key];
        }
        const nextContent = JSON.stringify(next, null, 2);
        try { deps.validateRenewal(content, nextContent); }
        catch { throw new OnlineError("identity", "续期返回的身份与保存账号不一致，请重新登录。", { reauth: true }); }
        pendingWrites.set(id, { previous: content, next: nextContent });
        // Do not honour cancellation until the replacement refresh token is safe.
        await commit(id);
        content = nextContent; auth = next; fingerprint = digest(content);
      };
      let renewed = false;
      if (shouldRenew(auth, now())) { await renew(); renewed = true; }
      const read = () => request(USAGE_URL, { headers: { Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": context.account.identity.userId } });
      if (!allowed()) throw new OnlineError("cancelled", "检查已取消。");
      let response = await read();
      if (response.status === 401 && !renewed) { await renew(); response = await read(); }
      if (response.status !== 200) throw responseError(response, false, now());
      const quota = { ...parseUsage(response.data, context.account.identity.userId, now()), authFingerprint: fingerprint };
      const fresh = await deps.readAccount(id);
      if (!allowed() || !fresh || fresh.active || fresh.content !== content) throw new OnlineError("changed", "账号状态已改变，请重新检查。");
      await deps.saveQuota(id, content, quota);
      attempts.delete(id);
      return { available: availability(quota, now()), quota };
    } catch (error) {
      const safe = error instanceof OnlineError ? error : new OnlineError("storage", "账号凭据读取或保存失败，请检查本机存储后重试。");
      const context = await deps.readAccount(id).catch(() => null);
      if (context && !context.active) {
        attempts.set(id, { fingerprint: digest(context.content), retryAt: now() + safe.retryMs, reason: safe.message });
        await deps.saveStatus(id, context.content, { checkedAt: new Date(now()).toISOString(), error: safe.message, needsReauth: safe.reauth }).catch(() => {});
      }
      return { available: null, reason: safe.message };
    }
  }
  function check(id, options) {
    if (stopping) return Promise.resolve({ available: null, reason: "程序正在退出。" });
    if (flights.has(id)) {
      const flight = flights.get(id);
      // A switch-time forced check cannot inherit a display-only cached read.
      return options?.force ? flight.then(() => check(id, options)) : flight;
    }
    const promise = deps.runExclusive(() => checkLocked(id, options)).finally(() => flights.delete(id));
    flights.set(id, promise);
    return promise;
  }
  const flushPending = async () => { for (const id of pendingWrites.keys()) await commit(id); };
  return { check, checkLocked, flushPending, hasPendingWork: () => flights.size > 0 || pendingWrites.size > 0,
    async shutdown() {
      stopping = true;
      await Promise.allSettled([...flights.values()]);
      await deps.runExclusive(flushPending);
    }, resume: () => { stopping = false; } };
}

module.exports = { createOnlineAccounts, parseUsage, availability, shouldRenew, requestJson, OnlineError,
  SOURCE, CACHE_MS, MAINTENANCE_MS, USAGE_URL, TOKEN_URL };
