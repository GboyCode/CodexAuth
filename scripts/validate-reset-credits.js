// Fully isolated: fake tokens, fake account storage and fake official responses.
const assert = require("node:assert/strict");
const { createOnlineAccounts, parseUsage, USAGE_URL, TOKEN_URL } = require("../src/quota/online-accounts");
const { canResetAccount, chooseResetCredit, RESET_CREDITS_URL, CONSUME_RESET_URL } = require("../src/quota/reset-credits");
const NOW = 1800000000000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const credits = () => ({ available_count: 4, credits: [
  { id: "later", status: "available", reset_type: "codex_rate_limits", expires_at: new Date(NOW + 86400000).toISOString() },
  { id: "expired", status: "available", reset_type: "codex_rate_limits", expires_at: new Date(NOW - 1).toISOString() },
  { id: "first", status: "available", reset_type: "codex_rate_limits", expires_at: new Date(NOW + 3600000).toISOString() },
  { id: "unknown", status: "available", reset_type: "something_else", expires_at: null },
] });
function fixture(options = {}) {
  const raw = { account_id: "team-workspace", plan_type: "team", rate_limit: { allowed: false, limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 }, secondary_window: null },
    rate_limit_reset_credits: { available_count: 4 } };
  const account = { id: "team", identity: { userId: "team-workspace", planType: "team" } };
  let content = JSON.stringify({ last_refresh: new Date(NOW).toISOString(), tokens: { access_token: "FAKE-token", refresh_token: "FAKE-refresh" } });
  let active = false, enabled = true, clock = NOW, postCount = 0;
  const calls = [], writes = [];
  const deps = {
    now: () => clock, resetEnabled: () => enabled, runExclusive: (fn) => fn(),
    readAccount: async () => ({ account: clone(account), content, active }), validateRenewal() {},
    saveAuth: async (_id, previous, next) => { assert.equal(previous, content); content = next; },
    saveQuota: async (_id, expected, quota) => { assert.equal(content, expected); account.quotaSnapshot = clone(quota); },
    saveStatus: async () => {},
    saveResetAttempt: async (_id, expected, value) => {
      assert.equal(content, expected);
      if (options.diskError) throw new Error("fake disk failure");
      writes.push(clone(value)); account.autoResetAttempt = clone(value);
      if (options.disableAfterPersist && value.status === "pending") enabled = false;
    },
    request: async (url, init) => {
      calls.push({ url, init });
      if (url === TOKEN_URL) return { status: 200, data: { access_token: "FAKE-renewed", refresh_token: "FAKE-new-refresh" } };
      assert.equal(init.headers["ChatGPT-Account-Id"], "team-workspace");
      if (url === USAGE_URL) return { status: 200, data: clone(raw) };
      if (url === RESET_CREDITS_URL) {
        if (options.changeActive) active = true;
        if (options.disableDuringRead) enabled = false;
        if (options.detailError) return { status: 503, data: null };
        return { status: 200, data: clone(options.credits ?? credits()) };
      }
      assert.equal(url, CONSUME_RESET_URL);
      assert.equal(init.method, "POST");
      assert.equal(init.body.credit_id, "first");
      assert.match(init.body.redeem_request_id, /^[a-f0-9-]{36}$/);
      assert.equal(account.autoResetAttempt.idempotencyKey, init.body.redeem_request_id, "persist before irreversible request");
      postCount++;
      if (options.timeout) throw new Error("fake connection loss");
      if (!options.lag && !options.outcome) {
        for (const window of [raw.rate_limit.primary_window, raw.rate_limit.secondary_window].filter(Boolean)) {
          window.used_percent = 0;
          window.reset_at = NOW / 1000 + window.limit_window_seconds;
        }
        raw.rate_limit.allowed = true; raw.rate_limit.limit_reached = false;
      }
      return { status: options.httpError ? 500 : 200, data: { code: options.outcome ?? "reset", windows_reset: 1 } };
    },
  };
  const service = createOnlineAccounts(deps);
  account.quotaSnapshot = parseUsage(raw, account.identity.userId, NOW);
  return { service, deps, raw, account, calls, writes, postCount: () => postCount,
    advance: (ms) => { clock += ms; }, disable: () => { enabled = false; }, activate: () => { active = true; },
    redeem: (beforeConsume = async () => true) => service.consumeResetLocked("team", { allowed: () => true, beforeConsume }) };
}

async function run() {
  assert.equal(chooseResetCredit(credits(), NOW).id, "first");
  assert.equal(chooseResetCredit({ available_count: 1, credits: [{ ...credits().credits[0], expires_at: "invalid" }] }, NOW), null);
  const readOnly = fixture();
  const peek = () => readOnly.service.readResetCreditLocked("team", { allowed: () => true });
  const selected = await peek();
  assert.deepEqual(selected.resetCredit, { id: "first", expiresAt: NOW + 3600000 });
  assert.equal(readOnly.postCount(), 0); assert.equal(readOnly.writes.length, 0, "expiry lookup never reserves or spends a card");
  await peek();
  assert.equal(readOnly.calls.filter(call => call.url === RESET_CREDITS_URL).length, 1, "candidate lookups use a one-minute card cache");
  await readOnly.service.consumeResetLocked("team", { allowed: () => true, beforeConsume: async () => true, expectedCredit: selected.resetCredit });
  assert.equal(readOnly.calls.filter(call => call.url === RESET_CREDITS_URL).length, 2, "redemption rechecks card details after the countdown");
  assert.equal(readOnly.postCount(), 1);
  const changedOptions = { credits: credits() }; const changedCard = fixture(changedOptions);
  const originalCredit = (await changedCard.service.readResetCreditLocked("team", { allowed: () => true })).resetCredit;
  changedOptions.credits.credits.find(credit => credit.id === "first").status = "redeemed";
  await changedCard.service.consumeResetLocked("team", { allowed: () => true, beforeConsume: async () => true, expectedCredit: originalCredit });
  assert.equal(changedCard.postCount(), 0); assert.equal(changedCard.writes.length, 0, "never silently substitute a later card after the selected card changes");
  const expiredDuringCheck = fixture();
  await expiredDuringCheck.redeem(async () => { expiredDuringCheck.advance(3600001); return true; });
  assert.equal(expiredDuringCheck.postCount(), 0, "expiry during final task checks must block POST");
  const unavailableDetails = fixture({ detailError: true });
  await unavailableDetails.service.readResetCreditLocked("team", { allowed: () => true });
  await unavailableDetails.service.readResetCreditLocked("team", { allowed: () => true });
  assert.equal(unavailableDetails.calls.filter(call => call.url === RESET_CREDITS_URL).length, 1, "failed details lookup backs off instead of polling every recovery tick");
  assert.equal(unavailableDetails.postCount(), 0);
  const success = fixture();
  assert.equal(canResetAccount(success.account, undefined, NOW), true, "weekly-only Business is eligible");
  assert.equal((await success.redeem()).available, true);
  assert.equal(success.account.autoResetAttempt.status, "verified");
  assert.equal(success.postCount(), 1);
  await success.redeem(); assert.equal(success.postCount(), 1, "already available needs no card");
  success.raw.rate_limit.primary_window.used_percent = 100;
  success.raw.rate_limit.allowed = false; success.raw.rate_limit.limit_reached = true;
  await success.redeem(); assert.equal(success.postCount(), 2, "a later exhausted window after verified recovery can use another card");

  const setWindows = (f, plan, sessionUsed, weeklyUsed) => {
    f.account.identity.planType = plan; f.raw.plan_type = plan;
    f.raw.rate_limit.primary_window = { used_percent: sessionUsed, limit_window_seconds: 18000, reset_at: NOW / 1000 + 7200 };
    f.raw.rate_limit.secondary_window = { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_at: NOW / 1000 + 86400 };
  };
  for (const plan of ["plus", "team"]) {
    for (const weeklyUsed of [0, 40, 98, 99, null]) {
      const f = fixture(); setWindows(f, plan, 100, weeklyUsed);
      assert.notEqual((await f.redeem()).available, true);
      assert.equal(f.postCount(), 0, `${plan}: exhausted 5h must not spend a card while weekly=${weeklyUsed}`);
      assert.equal(f.calls.filter(call => call.url === RESET_CREDITS_URL).length, 0, "ineligible usage must not fetch card details");
    }
    const missingWeek = fixture(); setWindows(missingWeek, plan, 100, 100);
    missingWeek.raw.rate_limit.secondary_window = null;
    await missingWeek.redeem(); assert.equal(missingWeek.postCount(), 0, "missing weekly allowance never authorizes spending");
    const exhaustedWeek = fixture(); setWindows(exhaustedWeek, plan, 20, 100);
    assert.equal((await exhaustedWeek.redeem()).available, true);
    assert.equal(exhaustedWeek.postCount(), 1, `${plan}: weekly exhaustion permits one card even when 5h has room`);
    const changedDuringWarning = fixture(); setWindows(changedDuringWarning, plan, 100, 100);
    changedDuringWarning.account.quotaSnapshot = parseUsage(changedDuringWarning.raw, "team-workspace", NOW);
    assert.equal(canResetAccount(changedDuringWarning.account, undefined, NOW), true);
    changedDuringWarning.raw.rate_limit.secondary_window.used_percent = 30;
    await changedDuringWarning.redeem();
    assert.equal(changedDuringWarning.postCount(), 0, "fresh weekly balance overrides an exhausted cached snapshot");
  }

  for (const modify of [
    (f) => { f.account.identity.planType = "plus"; },
    (f) => { f.raw.plan_type = "plus"; },
    (f) => { f.account.identity.planType = "pro"; f.raw.plan_type = "pro"; },
    (f) => { f.raw.rate_limit.primary_window.used_percent = 98; },
    (f) => { f.raw.rate_limit.primary_window.used_percent = null; },
    (f) => { f.raw.rate_limit_reset_credits.available_count = 0; },
    (f) => { f.raw.account_id = "different-workspace"; },
    (f) => { f.account.needsReauth = true; },
    (f) => { f.disable(); },
    (f) => { f.activate(); },
  ]) {
    const f = fixture(); modify(f); await f.redeem(); assert.equal(f.postCount(), 0);
  }
  for (const options of [{ diskError: true }, { changeActive: true }, { disableDuringRead: true }, { disableAfterPersist: true }, { credits: { available_count: 0, credits: [] } }]) {
    const f = fixture(options); await f.redeem(); assert.equal(f.postCount(), 0);
  }
  const cancelledWrite = fixture({ disableAfterPersist: true }); await cancelledWrite.redeem();
  assert.equal(cancelledWrite.account.autoResetAttempt.status, "not-sent");
  assert.equal(canResetAccount(cancelledWrite.account, undefined, NOW), true, "cancellation before POST does not permanently block an unused card");
  const cancelled = fixture(); await cancelled.redeem(async () => false); assert.equal(cancelled.postCount(), 0);
  for (const options of [{ timeout: true }, { lag: true }, { lag: true, httpError: true },
    { outcome: "nothing_to_reset" }, { outcome: "no_credit" }, { outcome: "already_redeemed" }]) {
    const f = fixture(options);
    assert.notEqual((await f.redeem()).available, true);
    assert.equal(f.postCount(), 1);
    f.advance(6 * 60000);
    await f.redeem(); assert.equal(f.postCount(), 1, "uncertain or failed redemption never spends another card");
    const restarted = createOnlineAccounts(f.deps);
    await restarted.consumeResetLocked("team", { allowed: () => true, beforeConsume: async () => true });
    assert.equal(f.postCount(), 1, "persistent guard survives service restart");
  }
  const sameWindow = fixture();
  const original = clone(sameWindow.raw);
  await sameWindow.redeem();
  Object.assign(sameWindow.raw, original);
  await sameWindow.redeem(); assert.equal(sameWindow.postCount(), 1, "stale exhausted window cannot spend twice after verification");
  const recovery = fixture({ lag: true }); await recovery.redeem();
  recovery.raw.rate_limit.allowed = true; recovery.raw.rate_limit.limit_reached = false;
  recovery.raw.rate_limit.primary_window.used_percent = 20;
  await recovery.service.check("team", { force: true });
  assert.equal(recovery.account.autoResetAttempt.status, "verified", "manual refresh can resolve a delayed quota update without POST");
  console.log("reset credits validation passed (mock services only)");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
