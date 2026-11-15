const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeSubscription, subscriptionFromClaims, mergeSubscriptionClaims, accountSubscription,
  parseSubscription, subscriptionRefreshDue, subscriptionUrl, isSubscriptionUrl } = require("../src/subscription");

const identity = { userId: "workspace-a", subject: "person-a", planType: "plus" };
const until = "2026-10-10T20:08:19+08:00";
const checked = "2026-09-19T15:24:07.472360+08:00";
const payload = (changes = {}) => ({ sub: "person-a", exp: 1900000000,
  "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a", chatgpt_plan_type: "plus",
    chatgpt_subscription_active_until: until, chatgpt_subscription_last_checked: checked, ...changes } });
const snapshot = subscriptionFromClaims([payload()], identity);
assert.equal(snapshot.activeUntil, "2026-10-10T12:08:19.000Z");
assert.equal(snapshot.checkedAt, "2026-09-19T07:24:07.472Z");
assert.equal(snapshot.source, "auth-claims");
for (const invalid of [null, "", "not-a-date", 1900000000, "2026-02-30T00:00:00Z", "2026-10-10T24:00:00Z"]) {
  assert.equal(subscriptionFromClaims([payload({ chatgpt_subscription_active_until: invalid })], identity), null);
}
assert.equal(subscriptionFromClaims([payload({ chatgpt_account_id: "workspace-b" })], identity), null);
assert.equal(subscriptionFromClaims([payload({ chatgpt_plan_type: "free" })], identity), null);
assert.equal(subscriptionFromClaims([{ ...payload(), sub: "person-b" }], identity), null);
assert.equal(subscriptionFromClaims([payload({ chatgpt_subscription_active_until: undefined })], identity), null,
  "JWT expiry must never be used as a subscription date");
assert.equal(subscriptionFromClaims([payload()], { ...identity, userId: null }), null);
assert.ok(subscriptionFromClaims([payload({ chatgpt_plan_type: "team" })], { ...identity, planType: "business" }));
assert.equal(subscriptionFromClaims([payload(), payload({ chatgpt_subscription_active_until: "2026-11-10T12:08:19Z",
  chatgpt_subscription_last_checked: "2026-10-01T00:00:00Z" })], identity).activeUntil, "2026-11-10T12:08:19.000Z");
assert.deepEqual(Object.keys(normalizeSubscription({ ...snapshot, access_token: "FAKE-secret" })).sort(), ["activeUntil", "checkedAt", "source"]);
assert.equal(normalizeSubscription({ ...snapshot, source: "quota-reset" }), null);

const main = fs.readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8");
const sandbox = vm.createContext({ Buffer, normalizeSubscription, subscriptionFromClaims });
vm.runInContext(main.slice(main.indexOf("function base64UrlDecode("), main.indexOf("function tokenExpirySeconds(")), sandbox);
const token = (data) => `FAKE.${Buffer.from(JSON.stringify(data)).toString("base64url")}.signature`;
const parsed = sandbox.extractIdentity({ tokens: { access_token: token(payload({ chatgpt_subscription_active_until: undefined })),
  id_token: token(payload()) } });
assert.equal(parsed.subscription.activeUntil, snapshot.activeUntil, "saved-account identity must carry the matching ID-token subscription");

const ui = { window: { CodexI18n: require("../src/ui/i18n") } };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../src/ui/shared-quota.js"), "utf8"), ui);
const display = ui.window.CodexQuotaUI.subscriptionDisplay;
assert.match(display(snapshot, Date.parse("2026-10-01T00:00:00Z")).label, /^到期 \d{2}\/\d{2}$/);
assert.match(display(snapshot, Date.parse("2026-10-01T00:00:00Z")).title, /2026/);
assert.match(display(snapshot, Date.parse("2026-10-01T00:00:00Z")).title, /不代表自动扣费日/);
assert.match(display(snapshot, Date.parse("2026-10-11T00:00:00Z")).label, /^到期 \d{2}\/\d{2} · 待更新$/,
  "an elapsed snapshot keeps its known date without claiming the current subscription has expired");
assert.equal(display(null).label, "到期 未知");

(async () => {
  const now = Date.parse("2026-10-01T00:00:00Z"), day = 86400000;
  const online = parseSubscription({ plan_type: "plus", active_until: "2026-11-01T00:00:00Z" }, identity, now);
  assert.equal(online.source, "online-subscription");
  assert.equal(online.checkedAt, new Date(now).toISOString());
  assert.equal(parseSubscription({ plan_type: "plus", active_until: online.activeUntil, account_id: "wrong" }, identity, now), null);
  assert.equal(parseSubscription({ plan_type: "team", active_until: online.activeUntil }, identity, now), null);
  assert.equal(parseSubscription({ plan_type: "plus", active_until: "invalid" }, identity, now), null);
  assert.equal(parseSubscription({ plan_type: "plus" }, identity, now), null);
  assert.deepEqual(accountSubscription({ subscription: online, identity: { subscription: snapshot } }), online,
    "online subscription takes precedence over dated login claims");
  assert.deepEqual(mergeSubscriptionClaims(snapshot, null), snapshot);
  assert.deepEqual(mergeSubscriptionClaims(snapshot, { ...snapshot, activeUntil: "2026-09-01T00:00:00Z", checkedAt: "2026-08-01T00:00:00Z" }), snapshot);
  const account = { subscription: online };
  assert.equal(subscriptionRefreshDue({ identity: { subscription: snapshot } }, now), true, "bootstrap a live record once");
  assert.equal(subscriptionRefreshDue(account, now + 10 * day), false, "reuse the cache weeks before expiry");
  const expiry = Date.parse(online.activeUntil);
  assert.equal(subscriptionRefreshDue(account, expiry - day), true, "refresh in the day before expiry");
  account.subscription = { ...online, checkedAt: new Date(expiry - day).toISOString() };
  assert.equal(subscriptionRefreshDue(account, expiry - 1), false);
  assert.equal(subscriptionRefreshDue(account, expiry), true, "refresh when the old date is crossed");
  account.subscription.checkedAt = new Date(expiry).toISOString();
  assert.equal(subscriptionRefreshDue(account, expiry + day - 1), false, "past dates are checked at most daily");
  assert.equal(subscriptionRefreshDue(account, expiry + day), true);
  account.subscriptionStatus = { retryAt: expiry + 2 * day };
  assert.equal(subscriptionRefreshDue(account, expiry + day), false, "persisted failure cooldown survives restart");
  assert.equal(isSubscriptionUrl(subscriptionUrl("workspace-a")), true);
  for (const invalid of ["https://evil.example/backend-api/subscriptions?account_id=workspace-a",
    "https://chatgpt.com/backend-api/subscriptions?account_id=workspace-a&extra=x",
    "https://chatgpt.com/backend-api/subscriptions?account_id=workspace-a#fragment",
    "https://chatgpt.com/backend-api/subscriptions?account_id=../", "http://chatgpt.com/backend-api/subscriptions?account_id=a"]) {
    assert.equal(isSubscriptionUrl(invalid), false);
  }
  const { requestJson } = require("../src/quota/online-accounts");
  await assert.rejects(requestJson(subscriptionUrl("workspace-a"), { method: "POST" }), /地址/);

  sandbox.accountSubscription = accountSubscription;
  sandbox.isMac = false;
  sandbox.waitForIndexMutations = async () => {};
  sandbox.readIndex = async () => ({ accounts: [{ id: "saved-a", displayName: "Test account", identity: parsed }] });
  sandbox.readCurrentAuth = async () => ({ identity: parsed });
  sandbox.identityKey = (value) => `${value.userId}:${value.subject}`;
  sandbox.normalizePublicQuotaSnapshot = () => null;
  vm.runInContext(main.slice(main.indexOf("async function getAllAccountsQuotaSummary("), main.indexOf("\nfunction createWindow(")), sandbox);
  const summary = await sandbox.getAllAccountsQuotaSummary();
  assert.equal(summary.accounts[0].subscription.activeUntil, snapshot.activeUntil,
    "subscription dates are available even when quota has no snapshot");
  assert.equal(summary.accounts[0].isActive, true);
  sandbox.readIndex = async () => ({ accounts: [{ id: "saved-a", identity: parsed, subscription: online }] });
  assert.equal((await sandbox.getAllAccountsQuotaSummary()).accounts[0].subscription.activeUntil, online.activeUntil);
  console.log("Subscription validation passed: dated claims, workspace/person/plan binding, invalid dates, metadata propagation, safe overview output and stale/unknown display.");
})().catch(error => { console.error(error); process.exitCode = 1; });
