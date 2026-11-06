// Synthetic credentials only. Real endpoint verification is separate.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createSubscriptionReader } = require("../src/subscription-client");

const NOW = Date.parse("2026-10-27T00:00:00Z"), DAY = 86400000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const result = { status: 200, data: { plan_type: "plus", active_until: "2026-11-09T00:00:00Z" } };

function fixture(request = async () => result) {
  const account = { id: "saved", identity: { userId: "workspace", subject: "person", planType: "plus" } };
  const context = { identity: account.identity, content: JSON.stringify({ tokens: { access_token: "FAKE" } }) };
  let clock = NOW, requests = 0, writes = 0;
  const deps = {
    now: () => clock, listAccounts: async () => [clone(account)], getAccount: async () => clone(account),
    readCredentials: async () => clone(context),
    request: async (url, options) => {
      requests++;
      assert.equal(url, "https://chatgpt.com/backend-api/subscriptions?account_id=workspace");
      assert.equal(options.method, undefined, "subscription reads are GET only");
      assert.equal(options.headers["ChatGPT-Account-Id"], "workspace");
      return request(url, options);
    },
    saveResult: async (_id, _expected, subscription, status) => {
      writes++;
      if (subscription) account.subscription = subscription;
      account.subscriptionStatus = status;
    },
  };
  return { account, deps, reader: createSubscriptionReader(deps), advance: (ms) => { clock += ms; },
    stats: () => ({ requests, writes }) };
}

async function validateReader() {
  const f = fixture();
  await Promise.all([f.reader.check("saved"), f.reader.check("saved"), f.reader.checkAll()]);
  assert.equal(f.stats().requests, 1, "all entrypoints share the initial read");
  assert.equal(f.account.subscription.activeUntil, result.data.active_until.replace("Z", ".000Z"));
  for (let i = 0; i < 10; i++) { f.advance(DAY); await f.reader.checkAll(); }
  assert.equal(f.stats().requests, 1, "daily switching reuses a valid recorded date");
  await createSubscriptionReader(f.deps).checkAll();
  assert.equal(f.stats().requests, 1, "restart reuses persisted dates");
  f.advance(2 * DAY); await f.reader.checkAll();
  assert.equal(f.stats().requests, 2, "refresh the day before expiry");
  f.advance(DAY); await f.reader.checkAll();
  assert.equal(f.stats().requests, 3, "recheck at expiry");
  await f.reader.check("saved"); assert.equal(f.stats().requests, 3, "no repeated request for a confirmed old date");

  for (const response of [{ status: 503 }, { status: 200, data: { plan_type: "plus" } },
    { status: 200, data: { ...result.data, account_id: "wrong" } }]) {
    const failed = fixture(async () => response);
    const previous = { source: "auth-claims", activeUntil: "2026-09-09T00:00:00Z", checkedAt: "2026-09-01T00:00:00Z" };
    failed.account.subscription = clone(previous);
    await failed.reader.checkAll();
    assert.deepEqual(failed.account.subscription, previous, "failure does not clear an existing date");
    await createSubscriptionReader(failed.deps).checkAll();
    assert.equal(failed.stats().requests, 1, "failed attempts are throttled across restart");
    failed.advance(6 * 3600000); await failed.reader.checkAll();
    assert.equal(failed.stats().requests, 2);
  }
  const limited = fixture(async () => ({ status: 429, retryAfter: "86400" }));
  await limited.reader.checkAll(); limited.advance(6 * 3600000); await limited.reader.checkAll();
  assert.equal(limited.stats().requests, 1, "respect a longer server cooldown");
  const network = fixture(async () => { throw new Error("FAKE-secret"); });
  await network.reader.checkAll();
  assert.equal(network.account.subscriptionStatus.error.includes("FAKE"), false);
  const reauth = fixture(); reauth.account.needsReauth = true;
  await reauth.reader.checkAll(); assert.equal(reauth.stats().requests, 0);
  let complete;
  const stopped = fixture(() => new Promise((resolve) => { complete = resolve; }));
  const pending = stopped.reader.check("saved"); await tick(); stopped.reader.stop(); complete(result); await pending;
  assert.equal(stopped.stats().writes, 0, "no late writes on shutdown");
}

async function validatePersistence() {
  const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
  let deps;
  const sandbox = vm.createContext({ require: (name) => name === "electron"
    ? { app: { requestSingleInstanceLock: () => false, quit() {}, on() {} } }
    : name === "./subscription-client" ? { createSubscriptionReader: (value) => { deps = value; return {}; } } : realRequire(name),
    process, __dirname: path.dirname(filename), console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox);
  const identity = { userId: "workspace", subject: "person", planType: "plus" };
  const subscription = { source: "online-subscription", activeUntil: "2026-11-09T00:00:00.000Z", checkedAt: new Date(NOW).toISOString() };
  const account = { id: "saved", identity: { ...identity }, subscription: clone(subscription) };
  const index = { accounts: [account] };
  let content = "FAKE-old";
  sandbox.readIndex = async () => index;
  sandbox.readSubscriptionCredentials = async () => ({ content, identity });
  sandbox.mutateIndex = async (fn) => (await fn(index))?.value;
  sandbox.broadcastStateChanged = () => {};
  sandbox.getSubscriptions();
  const next = { ...subscription, activeUntil: "2026-12-09T00:00:00.000Z" };
  const status = { checkedAt: subscription.checkedAt, error: null, retryAt: null };
  const expected = { content, identity };
  content = "FAKE-new";
  await deps.saveResult("saved", expected, next, status);
  assert.deepEqual(account.subscription, subscription, "discard a response crossing credential rotation");
  content = expected.content;
  await deps.saveResult("saved", expected, next, status);
  assert.equal(account.subscription.activeUntil, next.activeUntil);

  sandbox.fingerprint = () => "FAKE-fingerprint";
  sandbox.authTokenStatus = () => ({});
  const auth = { parsed: { tokens: {} }, identity: { ...identity, subscription: null } };
  sandbox.markAccountAuthSnapshot(account, auth, "FAKE", status.checkedAt);
  assert.equal(account.subscription.activeUntil, next.activeUntil, "credential synchronization cannot erase the live date");
  const originalUntil = "2026-10-09T00:00:00.000Z";
  account.identity.subscription = { ...subscription, source: "auth-claims", activeUntil: originalUntil };
  sandbox.markAccountAuthSnapshot(account, auth, "FAKE", status.checkedAt);
  assert.equal(account.identity.subscription.activeUntil, originalUntil, "missing claims preserve the prior dated record");
  sandbox.markAccountAuthSnapshot(account, { ...auth, identity: { ...identity, planType: "business" } }, "FAKE", status.checkedAt);
  assert.equal(account.subscription, undefined, "a changed plan must obtain its own subscription date");
}

(async () => {
  await validateReader(); await validatePersistence();
  console.log("Subscription client validation passed: first read, persistent cache, expiry boundaries, failure retention, server cooldown, no token renewal, account isolation and credential sync.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
