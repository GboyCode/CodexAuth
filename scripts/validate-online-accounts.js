// Fake credentials and service responses only; never reads real auth.json.
const assert = require("node:assert/strict");
const { createOnlineAccounts, parseUsage, availability, shouldRenew, requestJson, OnlineError,
  USAGE_URL, TOKEN_URL } = require("../src/quota/online-accounts");

const NOW = 1800000000000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const token = (exp) => `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.FAKE`;
const sample = () => ({ account_id: "workspace", plan_type: "plus", rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 7200 },
  secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 } },
  rate_limit_reset_credits: { available_count: 0 } });

function fixture(options = {}) {
  let clock = NOW, active = false, writes = 0, saves = 0, status = null, locked = false, blockedWrite = false;
  let content = JSON.stringify({ auth_mode: "chatgpt", preserve: "unknown-field", last_refresh: new Date(NOW).toISOString(),
    tokens: { access_token: token(NOW / 1000 + (options.expired ? -1 : 3600)), refresh_token: "FAKE-old-refresh", id_token: "FAKE-id", account_id: "workspace" } });
  const account = { id: "b", identity: { userId: "workspace" } }, calls = [];
  let queue = Promise.resolve();
  const deps = {
    now: () => clock,
    runExclusive: (fn) => {
      const work = queue.then(async () => { assert.equal(locked, false); locked = true; try { return await fn(); } finally { locked = false; } });
      queue = work.catch(() => {}); return work;
    },
    readAccount: async () => ({ account: clone(account), active, content }),
    validateRenewal: () => { if (options.identityError) throw new Error("wrong identity"); },
    saveAuth: async (_id, previous, next) => {
      assert.equal(locked, true);
      assert.ok(content === previous || content === next);
      if (blockedWrite) throw new Error("disk unavailable FAKE-secret");
      writes++; content = next;
    },
    saveQuota: async (_id, expected, quota) => {
      assert.equal(locked, true); assert.equal(expected, content);
      account.quotaSnapshot = clone(quota); saves++;
    },
    saveStatus: async (_id, expected, value) => { assert.equal(expected, content); status = value; if (value.needsReauth) account.needsReauth = true; },
    request: async (url, init) => {
      assert.equal(locked, true); calls.push({ url, init });
      if (options.request) return options.request(url, init, { calls, changeActive: () => { active = true; } });
      if (url === TOKEN_URL) return { status: 200, data: { access_token: token(NOW / 1000 + 7200), refresh_token: "FAKE-rotated-refresh" } };
      assert.equal(init.headers["ChatGPT-Account-Id"], "workspace");
      return { status: 200, data: sample() };
    },
  };
  const service = createOnlineAccounts(deps);
  return { service, deps, account, calls, state: () => ({ writes, saves, status, auth: JSON.parse(content) }),
    active: () => { active = true; }, blockWrite: (value) => { blockedWrite = value; }, advance: (ms) => { clock += ms; } };
}

async function run() {
  const quota = parseUsage(sample(), "workspace", NOW);
  assert.equal(quota.session.windowMinutes, 300);
  assert.equal(quota.weekly.windowMinutes, 10080);
  assert.equal(quota.session.resetsAt, NOW / 1000 + 7200);
  assert.equal(quota.resetCredits.availableCount, 0);
  assert.equal(availability(quota, NOW), true);
  const weekly = sample(); weekly.rate_limit.primary_window = weekly.rate_limit.secondary_window; delete weekly.rate_limit.secondary_window;
  assert.equal(parseUsage(weekly, "workspace", NOW).session, null);
  assert.equal(availability(parseUsage(weekly, "workspace", NOW), NOW), true);
  for (const invalid of [null, false, "", "20", -1, 101]) {
    const raw = sample(); raw.rate_limit.primary_window.used_percent = invalid;
    assert.equal(availability(parseUsage(raw, "workspace", NOW), NOW), null, `unknown counter ${invalid}`);
  }
  for (const slot of ["primary_window", "secondary_window"]) {
    for (const invalid of [false, true, 0, 42, "", "window", [], {},
      { used_percent: 20, window_minutes: 0, reset_at: NOW / 1000 + 3600 },
      { used_percent: 20, windowDurationMins: -1, reset_at: NOW / 1000 + 3600 }]) {
      const raw = sample(); raw.rate_limit[slot] = invalid;
      const parsed = parseUsage(raw, "workspace", NOW);
      assert.equal(parsed.unknownWindow, true, `malformed ${slot} must remain unknown: ${JSON.stringify(invalid)}`);
      assert.equal(availability(parsed, NOW), null, "a valid other window cannot conceal a malformed window");
    }
  }
  const nullableWindow = sample(); nullableWindow.rate_limit.primary_window = null;
  assert.equal(availability(parseUsage(nullableWindow, "workspace", NOW), NOW), true,
    "an explicitly absent session window is valid for weekly-only plans");
  const invalidPoolWindow = sample();
  invalidPoolWindow.additional_rate_limits = [{ limit_name: "Model pool", metered_feature: "model-pool",
    rate_limit: { primary_window: false, secondary_window: sample().rate_limit.secondary_window } }];
  assert.equal(availability(parseUsage(invalidPoolWindow, "workspace", NOW), NOW), null,
    "malformed windows in additional model pools also block switching");
  const stale = sample(); stale.rate_limit.secondary_window.reset_at = NOW / 1000 - 1;
  assert.equal(availability(parseUsage(stale, "workspace", NOW), NOW), null, "a passed reset never proves replenishment");
  const denied = sample(); denied.rate_limit.allowed = false;
  assert.equal(availability(parseUsage(denied, "workspace", NOW), NOW), false);
  const extra = sample(); extra.additional_rate_limits = [{ limit_name: "Model pool", metered_feature: "model-pool",
    rate_limit: { primary_window: { ...extra.rate_limit.primary_window, used_percent: 100 } } }];
  assert.equal(parseUsage(extra, "workspace", NOW).additional.length, 1);
  assert.equal(availability(parseUsage(extra, "workspace", NOW), NOW), false, "a separate exhausted model pool blocks automatic switching");
  const missingPool = sample(); missingPool.additional_rate_limits = [{ limit_name: "Missing pool" }];
  assert.throws(() => parseUsage(missingPool, "workspace", NOW), /不完整/, "a malformed model pool cannot silently disappear");
  const malformedFlag = sample(); malformedFlag.rate_limit.allowed = "false";
  assert.equal(availability(parseUsage(malformedFlag, "workspace", NOW), NOW), null);
  const malformed = sample(); malformed.rate_limit_reset_credits.available_count = false;
  assert.equal(parseUsage(malformed, "workspace", NOW).resetCredits, null);
  assert.throws(() => parseUsage(sample(), "other-workspace", NOW), /工作区/);
  assert.throws(() => parseUsage({}, "workspace", NOW), /缺少/);
  await assert.rejects(requestJson("https://untrusted.example/usage"), /地址/);

  const f = fixture();
  const [a, b] = await Promise.all([f.service.check("b"), f.service.check("b")]);
  assert.equal(a.available, true); assert.equal(b.available, true);
  assert.equal(f.calls.length, 1, "duplicate requests share one response");
  await f.service.check("b"); assert.equal(f.calls.length, 1);
  await f.service.check("b", { force: true }); assert.equal(f.calls.length, 2);
  f.advance(61000); await f.service.check("b"); assert.equal(f.calls.length, 3);
  f.active(); await f.service.check("b", { force: true }); assert.equal(f.calls.length, 3, "never renew or query the active account");

  const concurrent = fixture(); await concurrent.service.check("b");
  await Promise.all([concurrent.service.check("b"), concurrent.service.check("b", { force: true })]);
  assert.equal(concurrent.calls.length, 2, "forced switch-time checks cannot reuse an in-flight cached display read");

  const renewal = fixture({ expired: true });
  assert.equal((await renewal.service.check("b")).available, true);
  assert.deepEqual(renewal.calls.map((r) => r.url), [TOKEN_URL, USAGE_URL]);
  assert.equal(renewal.state().auth.tokens.refresh_token, "FAKE-rotated-refresh");
  assert.equal(renewal.state().auth.tokens.id_token, "FAKE-id");
  assert.equal(renewal.state().auth.preserve, "unknown-field");
  assert.equal(renewal.calls[1].init.headers.Authorization, `Bearer ${renewal.state().auth.tokens.access_token}`);
  assert.equal(shouldRenew({ ...renewal.state().auth, last_refresh: new Date(NOW - 8 * 86400000).toISOString() }, NOW), true);

  const disk = fixture({ expired: true }); disk.blockWrite(true);
  assert.equal((await disk.service.check("b")).available, null);
  assert.equal(disk.calls.length, 1, "no usage request before new refresh token is safe");
  assert.equal(disk.state().status.error.includes("FAKE"), false, "internal errors are sanitized");
  await assert.rejects(disk.service.shutdown(), /disk/);
  disk.blockWrite(false); disk.service.resume(); await disk.service.check("b");
  assert.equal(disk.calls.filter((c) => c.url === TOKEN_URL).length, 1, "retry persistence, never reuse the rotated token");
  assert.equal(disk.state().auth.tokens.refresh_token, "FAKE-rotated-refresh");

  const revoked = fixture({ expired: true, request: async () => ({ status: 400, data: { error: "invalid_grant", error_description: "FAKE-secret" } }) });
  await revoked.service.check("b");
  assert.equal(revoked.state().status.needsReauth, true);
  assert.equal(revoked.state().status.error.includes("FAKE"), false);
  await revoked.service.check("b", { force: true }); assert.equal(revoked.calls.length, 1);
  const network = fixture({ request: async () => { throw new OnlineError("network", "network unavailable"); } });
  network.account.quotaSnapshot = clone(quota);
  await network.service.check("b");
  assert.equal(network.state().status.needsReauth, false);
  assert.deepEqual(network.account.quotaSnapshot, quota, "failure keeps the previous success and timestamp");
  await network.service.check("b", { force: true }); assert.equal(network.calls.length, 1, "force still respects failure backoff");
  network.advance(60001); await network.service.check("b"); assert.equal(network.calls.length, 2);

  const unauthorized = fixture({ request: async (url, _init, { calls }) => url === TOKEN_URL
    ? { status: 200, data: { access_token: token(NOW / 1000 + 7200) } }
    : calls.length === 1 ? { status: 401 } : { status: 200, data: sample() } });
  assert.equal((await unauthorized.service.check("b")).available, true);
  assert.deepEqual(unauthorized.calls.map((r) => r.url), [USAGE_URL, TOKEN_URL, USAGE_URL]);
  assert.equal(unauthorized.state().auth.tokens.refresh_token, "FAKE-old-refresh", "omitted replacement retains refresh token");
  const race = fixture({ request: async (_url, _init, context) => { context.changeActive(); return { status: 200, data: sample() }; } });
  assert.equal((await race.service.check("b")).available, null); assert.equal(race.state().saves, 0);

  let cancel = false;
  const cancelled = fixture({ expired: true, request: async (url) => {
    assert.equal(url, TOKEN_URL); cancel = true;
    return { status: 200, data: { access_token: token(NOW / 1000 + 7200), refresh_token: "FAKE-new" } };
  } });
  assert.equal((await cancelled.service.check("b", { allowed: () => !cancel })).available, null);
  assert.equal(cancelled.state().auth.tokens.refresh_token, "FAKE-new", "cancellation must still persist rotated credentials");
  await cancelled.service.shutdown();
  assert.equal((await cancelled.service.check("b")).available, null);
  console.log("Online account quota, refresh rotation, storage recovery, cancellation, scope and cache validation passed.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
