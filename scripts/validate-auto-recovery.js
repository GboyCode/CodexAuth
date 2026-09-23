const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAutoRecovery, rankAccounts, isQuotaFailure, recoveryJob, canRestart } = require("../src/auto-recovery");
const { createRecoveryCountdown, COUNTDOWN_MS } = require("../src/recovery-countdown");
const { createDesktopBridge, pipeRequest, parseToolResult } = require("../src/codex-desktop-bridge");

const NOW = 1800000000000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const account = (id, used = 20, reset = 7200) => ({ id, identity: { userId: `workspace-${id}` },
  quotaSnapshot: { schemaVersion: 2, source: "local", checkedAt: new Date(NOW - 1000).toISOString(),
    session: { usedPercent: used, resetsAt: NOW / 1000 + reset }, weekly: { usedPercent: used, resetsAt: NOW / 1000 + 86400 } } });
const businessWithoutQuota = (id) => ({ ...account(id), identity: { userId: `workspace-${id}`, planType: "team" }, quotaSnapshot: null });
const failed = (id = "task", turnId = "failed-turn") => ({ thread: { id, kind: "codex", hostId: "local", status: { type: "systemError" } },
  turns: [{ id: turnId, status: "failed", completedAt: NOW / 1000, error: { codexErrorInfo: "usageLimitExceeded" } }] });

function fixture(options = {}) {
  let clock = NOW, stored = options.journal ?? null, activeId = "a", switches = 0, sends = 0, reads = 0, warnings = 0;
  const opened = [];
  const results = new Map([["task", failed()]]);
  const accounts = [account("a", 100), account("b"), account("c", 30)];
  const bridge = {
    listThreads: async () => ({ pinnedThreads: [], threads: [...results].map(([id, value]) => ({ id, kind: "codex", hostId: "local", updatedAt: clock / 1000, status: value.thread.status.type })), ...options.list }),
    readThread: async (id) => { reads++; return clone(results.get(id)); },
    readUsage: async () => ({ ordinaryUsageAllowed: true, accountId: `workspace-${activeId}`, ...options.usage }),
    continueThread: async (id) => {
      sends++;
      if (options.sendError) throw new Error("connection closed after sending");
      results.set(id, { ...results.get(id), thread: { ...results.get(id).thread, status: { type: "active" } }, turns: [{ id: "new-turn", status: "inProgress" }] });
    },
    openThread: async (id) => {
      assert.equal(stored.pending.navigationAttempted, true, "persist navigation attempt before opening a page");
      opened.push(id);
      if (options.navigationError) throw new Error("navigation unavailable");
    },
    reset() {},
  };
  let recovery;
  const deps = {
    runAccountOperation: (task) => task(),
    now: () => clock, bridge, getAnchor: async () => "task",
    getAccounts: async () => ({ activeAccountId: activeId, accounts }),
    loadJournal: async () => clone(stored), saveJournal: async (value) => { stored = clone(value); },
    beforeSwitch: async (...args) => { warnings++; return options.beforeSwitch ? options.beforeSwitch(...args) : "elapsed"; },
    switchAccount: async (id, source, allowed) => {
      assert.equal(source, activeId); assert.equal(allowed(), true); switches++; activeId = id;
      if (options.disableDuringSwitch) recovery.configure(false, null);
    },
  };
  recovery = createAutoRecovery(deps);
  recovery.configure(true, NOW - 1000);
  return { recovery, deps, bridge, accounts, results, setActive: (id) => { activeId = id; }, advance: (ms) => { clock += ms; },
    stats: () => ({ switches, sends, reads, warnings, stored, activeId, opened }) };
}

function countdownFixture() {
  let clock = NOW, timer = null, win;
  const states = [];
  const countdown = createRecoveryCountdown({ now: () => clock,
    schedule: (fn) => { timer = fn; return 1; }, unschedule: () => { timer = null; },
    createWindow: () => {
      win = new EventEmitter(); win.webContents = new EventEmitter(); win.shown = false; win.destroyed = false;
      win.webContents.send = (_channel, value) => states.push(value);
      win.show = () => { win.shown = true; }; win.focus = () => {};
      win.isDestroyed = () => win.destroyed;
      win.destroy = () => { win.destroyed = true; win.emit("closed"); };
      return win;
    },
  });
  return { countdown, states, window: () => win, jump: (ms) => { clock += ms; timer?.(); },
    advance: (ms) => { for (let i = 0; i < ms; i += 250) { clock += Math.min(250, ms - i); timer?.(); } } };
}

async function run() {
  assert.deepEqual(rankAccounts([account("a"), account("b", 10, 1000), account("c", 10, 500), account("d", 5)], "a", {}, NOW).map((x) => x.account.id), ["d", "c", "b"]);
  const bottleneck = account("low-week", 1); bottleneck.quotaSnapshot.weekly.usedPercent = 95;
  assert.equal(rankAccounts([bottleneck, account("balanced", 40)], "a", {}, NOW)[0].account.id, "balanced");
  const plus = account("plus", 95); plus.identity.planType = "Plus";
  const plusEarlier = account("plus-earlier", 95, 500); plusEarlier.quotaSnapshot.planType = "plus";
  const business5h = account("business-5h", 70); business5h.identity.planType = "team"; business5h.quotaSnapshot.session.windowMinutes = 300;
  const businessWeek = account("business-week", 0); businessWeek.identity.planType = "Business";
  businessWeek.quotaSnapshot.session = null; businessWeek.quotaSnapshot.weekly.windowMinutes = 10080;
  const businessUnknown = account("business-unknown", 0); businessUnknown.identity.planType = "team";
  delete businessUnknown.quotaSnapshot.session; businessUnknown.quotaSnapshot.weekly.windowMinutes = 10080;
  const pro = account("pro", 0); pro.identity.planType = "pro";
  const preferred = rankAccounts([pro, businessUnknown, businessWeek, business5h, plus, plusEarlier], "a", {}, NOW);
  assert.deepEqual(preferred.map((item) => item.account.id), ["plus-earlier", "plus", "business-5h", "business-week", "pro", "business-unknown"]);
  assert.deepEqual(preferred.map((item) => item.priority), [0, 0, 1, 2, 3, 3]);
  assert.deepEqual(rankAccounts([plus, business5h, businessWeek], "a", { plus: NOW + 1000 }, NOW).map((item) => item.account.id), ["business-5h", "business-week"]);
  const priorityRecovery = fixture(); priorityRecovery.accounts[1].identity.planType = "team";
  priorityRecovery.accounts[1].quotaSnapshot.session.windowMinutes = 300;
  priorityRecovery.accounts[2].identity.planType = "plus";
  await priorityRecovery.recovery.tick(); assert.equal(priorityRecovery.stats().activeId, "c", "recovery selects Plus before higher-quota Business");
  const resetCandidate = account("reset", 100, -10);
  resetCandidate.quotaSnapshot.weekly.usedPercent = 15;
  resetCandidate.quotaSnapshot.session.windowMinutes = 300;
  resetCandidate.quotaSnapshot.checkedAt = new Date(NOW - 2 * 86400000).toISOString();
  const resetRank = rankAccounts([resetCandidate], "a", {}, NOW)[0];
  assert.equal(resetRank.remaining, 85); assert.equal(resetRank.inferred, true); assert.ok(resetRank.reset > NOW);
  const bad = [{ ...account("reauth"), needsReauth: true }, account("empty", 100)];
  const unknown = account("unknown"); unknown.quotaSnapshot.session.usedPercent = null; bad.push(unknown);
  const stale = account("stale"); stale.quotaSnapshot.checkedAt = new Date(NOW - 7 * 86400000 - 1).toISOString(); bad.push(stale);
  assert.equal(rankAccounts(bad, "a", {}, NOW).length, 0);
  assert.equal(rankAccounts([account("blocked")], "a", { blocked: NOW + 1000 }, NOW).length, 0);
  for (const used of [98, 99, 100]) {
    const low = account(`low-${used}`, used); low.identity.planType = "business";
    assert.equal(rankAccounts([low], "a", {}, NOW).length, 0, "skip every unreset window with at most 2% remaining");
    low.quotaSnapshot.session.resetsAt = NOW / 1000 - 1;
    assert.equal(rankAccounts([low], "a", {}, NOW).length, 0, "a session reset cannot override a low unreset week");
    low.quotaSnapshot.weekly.usedPercent = 25;
    assert.equal(rankAccounts([low], "a", {}, NOW)[0].remaining, 75, "a past reset lifts only its own low-quota block");
    low.quotaSnapshot.session.resetsAt = null;
    assert.equal(rankAccounts([low], "a", {}, NOW).length, 0, "an unknown reset cannot excuse a known low balance");
  }
  assert.equal(rankAccounts([account("above-threshold", 97.99)], "a", {}, NOW).length, 1);
  const missingBusiness = businessWithoutQuota("missing-business");
  const fallbackRank = rankAccounts([missingBusiness, pro, businessWeek, business5h, plus], "a", {}, NOW);
  assert.deepEqual(fallbackRank.map((item) => item.account.id), ["plus", "business-5h", "business-week", "pro", "missing-business"]);
  assert.equal(fallbackRank.at(-1).remaining, null, "unknown quota must not be represented as available quota");
  for (const planType of ["plus", "pro", ""]) {
    const other = businessWithoutQuota("other"); other.identity.planType = planType;
    assert.equal(rankAccounts([other], "a", {}, NOW).length, 0, "unknown fallback is limited to Business");
  }
  for (const snapshot of [
    { schemaVersion: 2, source: "unavailable", session: null, weekly: null },
    { schemaVersion: 2, source: "local", session: null, weekly: null },
    { ...account("partial").quotaSnapshot, session: { usedPercent: null } },
  ]) {
    const partial = { ...missingBusiness, quotaSnapshot: snapshot };
    assert.equal(rankAccounts([partial], "a", {}, NOW)[0].priority, 4);
    partial.quotaSnapshot.weekly = { usedPercent: 98, resetsAt: NOW / 1000 + 86400 };
    assert.equal(rankAccounts([partial], "a", {}, NOW).length, 0, "partial/unavailable quota cannot conceal a low known window");
  }
  assert.equal(rankAccounts([missingBusiness], missingBusiness.id, {}, NOW).length, 0);
  assert.equal(rankAccounts([{ ...missingBusiness, needsReauth: true }], "a", {}, NOW).length, 0);
  assert.equal(rankAccounts([missingBusiness], "a", { [missingBusiness.id]: NOW + 1000 }, NOW).length, 0);
  const staleBusiness = { ...stale, identity: { ...stale.identity, planType: "team" } };
  assert.equal(rankAccounts([staleBusiness], "a", {}, NOW).length, 0, "expired recorded snapshots remain excluded");
  staleBusiness.quotaSnapshot.source = "unavailable";
  assert.equal(rankAccounts([staleBusiness], "a", {}, NOW).length, 0, "unavailable data must not bypass the snapshot age limit");
  assert.equal(isQuotaFailure(failed(), NOW - 1), true);
  for (const code of ["rateLimitExceeded", "unauthorized", "sessionBudgetExceeded", "internalServerError"]) {
    const sample = failed(); sample.turns[0].error.codexErrorInfo = code;
    assert.equal(isQuotaFailure(sample), false, code);
  }
  const cancelled = failed(); cancelled.turns[0].status = "interrupted"; assert.equal(isQuotaFailure(cancelled), false);
  const workspaceEmpty = failed(); workspaceEmpty.turns[0].error = { message: "Your workspace is out of credits. Add credits to continue.", additionalDetails: null };
  assert.equal(isQuotaFailure(workspaceEmpty, NOW - 1), true, "native workspace exhaustion can omit codexErrorInfo");
  assert.equal(isQuotaFailure(workspaceEmpty, NOW + 1), false, "old workspace failures remain excluded");
  for (const status of ["completed", "interrupted", "inProgress"]) {
    const sample = clone(workspaceEmpty); sample.turns[0].status = status;
    assert.equal(isQuotaFailure(sample), false, `workspace message in ${status} turn is not a quota failure`);
  }
  for (const message of ["429 Too Many Requests", "Your API billing account is out of credits.", "Tool failed: Your workspace is out of credits. Add credits to continue."]) {
    const sample = clone(workspaceEmpty); sample.turns[0].error.message = message;
    assert.equal(isQuotaFailure(sample), false, "do not broaden message fallback to other billing/tool errors");
  }
  const explicitOtherError = clone(workspaceEmpty); explicitOtherError.turns[0].error.codexErrorInfo = "unauthorized";
  assert.equal(isQuotaFailure(explicitOtherError), false, "an explicit non-quota error overrides message fallback");
  const plusEmpty = failed();
  plusEmpty.turns[0].error = { message: "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:12 PM.", additionalDetails: null };
  assert.equal(isQuotaFailure(plusEmpty, NOW - 1), true, "observed Plus exhaustion omits codexErrorInfo too");
  const straightQuote = clone(plusEmpty); straightQuote.turns[0].error.message = straightQuote.turns[0].error.message.replace("’", "'");
  assert.equal(isQuotaFailure(straightQuote), true);
  assert.equal(isQuotaFailure(plusEmpty, NOW + 1), false, "historical Plus failures remain excluded");
  for (const status of ["completed", "interrupted", "inProgress"]) {
    const sample = clone(plusEmpty); sample.turns[0].status = status;
    assert.equal(isQuotaFailure(sample), false, `Plus message in ${status} turn must not trigger recovery`);
  }
  for (const message of ["You’ve hit your usage limit.", "Tool failed: " + plusEmpty.turns[0].error.message,
    plusEmpty.turns[0].error.message.replace("chatgpt.com/explore", "example.com/explore")]) {
    const sample = clone(plusEmpty); sample.turns[0].error.message = message;
    assert.equal(isQuotaFailure(sample), false, "only the observed native template is accepted");
  }
  const plusWrongCode = clone(plusEmpty); plusWrongCode.turns[0].error.codexErrorInfo = "unauthorized";
  assert.equal(isQuotaFailure(plusWrongCode), false);
  assert.equal(isQuotaFailure(failed(), NOW + 1), false);
  assert.equal(canRestart({ threads: [{ kind: "codex", hostId: "local", status: "active" }] }), false);
  assert.equal(canRestart({ threads: Array(50).fill({}) }), false);

  const happy = fixture();
  await happy.recovery.tick(); assert.equal(happy.stats().switches, 1);
  await happy.recovery.tick(); assert.equal(happy.stats().sends, 1);
  assert.deepEqual(happy.stats().opened, [], "only open a task after confirming its new turn");
  await happy.recovery.tick(); await happy.recovery.tick(); await happy.recovery.tick();
  assert.equal(happy.stats().sends, 1); assert.equal(happy.stats().switches, 1);
  assert.equal(happy.recovery.getStatus().state, "resumed");
  assert.deepEqual(happy.stats().opened, ["task"]);

  const navigationFailed = fixture({ navigationError: true });
  for (let i = 0; i < 5; i++) await navigationFailed.recovery.tick();
  assert.equal(navigationFailed.recovery.getStatus().state, "resumed", "page navigation failure must not fail task recovery");
  assert.match(navigationFailed.recovery.getStatus().message, /页面未能自动打开/);
  assert.equal(navigationFailed.stats().sends, 1);
  assert.deepEqual(navigationFailed.stats().opened, ["task"], "navigation errors do not cause repeated focus attempts");
  const optionalNavigation = fixture(); delete optionalNavigation.bridge.openThread;
  for (let i = 0; i < 5; i++) await optionalNavigation.recovery.tick();
  assert.equal(optionalNavigation.recovery.getStatus().state, "resumed");

  const workspaceRecovery = fixture(); workspaceRecovery.results.set("task", workspaceEmpty);
  await workspaceRecovery.recovery.tick(); await workspaceRecovery.recovery.tick();
  assert.equal(workspaceRecovery.stats().switches, 1); assert.equal(workspaceRecovery.stats().sends, 1);

  const plusRecovery = fixture(); plusRecovery.results.set("task", plusEmpty);
  plusRecovery.accounts[0].quotaSnapshot.session.usedPercent = 99;
  plusRecovery.accounts[0].quotaSnapshot.weekly.usedPercent = 36;
  await plusRecovery.recovery.tick(); await plusRecovery.recovery.tick();
  assert.equal(plusRecovery.stats().warnings, 1, "Plus exhaustion starts the cancellable countdown even when the widget still has 1% remaining");
  assert.equal(plusRecovery.stats().switches, 1); assert.equal(plusRecovery.stats().sends, 1);
  const noFailureAt99 = fixture(); noFailureAt99.accounts[0].quotaSnapshot.session.usedPercent = 99;
  noFailureAt99.results.get("task").turns[0].status = "completed";
  await noFailureAt99.recovery.tick();
  assert.equal(noFailureAt99.stats().switches, 0, "99% usage alone never triggers account rotation");

  const scanReconnect = fixture(); scanReconnect.results.get("task").turns[0].status = "completed";
  const connectedList = scanReconnect.bridge.listThreads;
  scanReconnect.bridge.listThreads = async () => { throw new Error("Codex 本地接口连接失败。"); };
  await scanReconnect.recovery.tick(); assert.equal(scanReconnect.recovery.getStatus().state, "attention");
  scanReconnect.bridge.listThreads = connectedList;
  await scanReconnect.recovery.tick();
  assert.equal(scanReconnect.recovery.getStatus().state, "watching", "successful scan clears a stale connection failure");
  assert.equal(scanReconnect.stats().switches, 0); assert.equal(scanReconnect.stats().sends, 0);

  const goal = { threadId: "task", goalId: "goal-1", objectiveHash: "original-goal", status: "usageLimited",
    tokenBudget: 10000, tokensUsed: 1200, timeUsedSeconds: 36, createdAt: NOW - 60000, updatedAt: NOW };
  for (const status of ["paused", "blocked", "complete", "budgetLimited"]) {
    assert.equal(recoveryJob({ ...failed(), goal: { ...goal, status } }), null, `do not resume ${status} goals even with a quota-failed turn`);
  }
  assert.equal(recoveryJob({ ...failed(), goal: { ...goal, tokensUsed: 10000 } }), null);
  assert.equal(recoveryJob({ ...failed(), goal }, NOW + 1), null, "do not resume old stopped goals");

  const goalBatch = fixture();
  let goalResumes = 0;
  goalBatch.results.set("task", { ...failed(), goal: clone(goal) });
  goalBatch.results.set("second", { ...failed("second"), turns: [], goal: { ...goal, threadId: "second", goalId: "goal-2" } });
  goalBatch.bridge.listGoals = async () => [...goalBatch.results.values()].map((value) => value.goal);
  goalBatch.bridge.resumeGoal = async (id, expected, allowed) => {
    assert.equal(await allowed(), true); assert.equal(expected.status, "usageLimited");
    goalResumes++; goalBatch.results.get(id).goal.status = "active";
  };
  for (let i = 0; i < 6; i++) await goalBatch.recovery.tick();
  assert.equal(goalBatch.stats().switches, 1); assert.equal(goalResumes, 2); assert.equal(goalBatch.stats().sends, 2);
  assert.equal(goalBatch.recovery.getStatus().state, "resumed");
  assert.equal(goalBatch.results.get("task").goal.tokensUsed, 1200);

  const goalChanged = fixture({ beforeSwitch: async () => { goalChanged.results.get("task").goal.status = "paused"; return "elapsed"; } });
  goalChanged.results.get("task").goal = clone(goal);
  await goalChanged.recovery.tick(); assert.equal(goalChanged.stats().switches, 0, "manual goal pause cancels countdown recovery");
  const replacedGoal = fixture(); replacedGoal.results.get("task").goal = clone(goal);
  await replacedGoal.recovery.tick(); replacedGoal.results.get("task").goal.goalId = "replacement";
  await replacedGoal.recovery.tick(); assert.equal(replacedGoal.stats().sends, 0);

  const goalUnconfirmed = fixture(); goalUnconfirmed.results.get("task").goal = clone(goal);
  goalUnconfirmed.bridge.resumeGoal = async () => {}; // Faulty adapter: a new turn alone must not count as goal recovery.
  for (let i = 0; i < 4; i++) await goalUnconfirmed.recovery.tick();
  assert.equal(goalUnconfirmed.recovery.getStatus().state, "attention");
  assert.equal(goalUnconfirmed.stats().sends, 1);
  const goalUncertain = fixture(); goalUncertain.results.get("task").goal = clone(goal);
  goalUncertain.bridge.resumeGoal = async () => {
    goalUncertain.results.get("task").goal.status = "active";
    goalUncertain.results.get("task").goal.updatedAt += 1000;
    throw new Error("lost response after activation");
  };
  for (let i = 0; i < 6; i++) await goalUncertain.recovery.tick();
  assert.equal(goalUncertain.stats().sends, 0); assert.equal(goalUncertain.recovery.getStatus().state, "attention");
  assert.equal(goalUncertain.stats().switches, 1, "activation timestamp changes must not retry an uncertain goal");

  const betweenTurns = fixture();
  betweenTurns.results.set("other", { ...failed("other"), turns: [{ id: "last-completed", status: "completed" }],
    goal: { ...goal, threadId: "other", status: "active" } });
  betweenTurns.bridge.listGoals = async () => [betweenTurns.results.get("other").goal];
  await betweenTurns.recovery.tick();
  assert.equal(betweenTurns.stats().switches, 0, "an active goal between turns prevents restart");

  const goalOnlyUpdate = fixture({ list: { threads: [] } });
  goalOnlyUpdate.results.get("task").goal = clone(goal);
  goalOnlyUpdate.results.get("task").turns = [];
  goalOnlyUpdate.deps.getLocalThreads = async () => [{ id: "task", updatedAt: (NOW - 86400000) / 1000 }];
  goalOnlyUpdate.bridge.listGoals = async () => [goalOnlyUpdate.results.get("task").goal];
  await goalOnlyUpdate.recovery.tick();
  assert.equal(goalOnlyUpdate.stats().switches, 1, "goal update finds a stopped task outside the recent thread page without a failed turn");

  const gated = fixture();
  let releaseWarning, shownWarning;
  const shown = new Promise((resolve) => { shownWarning = resolve; });
  gated.deps.beforeSwitch = (_details, signal) => new Promise((resolve) => {
    releaseWarning = resolve; shownWarning(); signal.addEventListener("abort", () => resolve("cancelled"));
  });
  const gatedTick = gated.recovery.tick(); await shown;
  assert.equal(gated.stats().switches, 0, "no switch or auth mutation while the warning is open");
  assert.equal(gated.recovery.getStatus().state, "countdown");
  gated.recovery.configure(false, null); await gatedTick;
  assert.equal(gated.stats().switches, 0, "disabling closes the pending warning");
  releaseWarning("elapsed");

  const cancelledWarning = fixture({ beforeSwitch: async () => "cancelled" });
  await cancelledWarning.recovery.tick(); await cancelledWarning.recovery.tick();
  assert.equal(cancelledWarning.stats().switches, 0); assert.equal(cancelledWarning.stats().warnings, 1);
  const afterCancelRestart = createAutoRecovery(cancelledWarning.deps);
  afterCancelRestart.configure(true, NOW - 1000); await afterCancelRestart.tick();
  assert.equal(cancelledWarning.stats().warnings, 1, "cancellation survives an application restart");
  cancelledWarning.results.set("task", failed("task", "later-failure")); cancelledWarning.advance(1000);
  await afterCancelRestart.tick(); assert.equal(cancelledWarning.stats().warnings, 2, "a new failure still receives a warning");
  const warningFailed = fixture({ beforeSwitch: async () => "unavailable" });
  await warningFailed.recovery.tick(); await warningFailed.recovery.tick();
  assert.equal(warningFailed.stats().switches, 0); assert.equal(warningFailed.stats().warnings, 1);

  const changedAccount = fixture({ beforeSwitch: async () => { changedAccount.setActive("c"); return "elapsed"; } });
  await changedAccount.recovery.tick(); assert.equal(changedAccount.stats().switches, 0);
  const changedTarget = fixture({ beforeSwitch: async () => { changedTarget.accounts[1].needsReauth = true; return "elapsed"; } });
  await changedTarget.recovery.tick(); assert.equal(changedTarget.stats().switches, 0);
  const continuedDuringWarning = fixture({ beforeSwitch: async () => {
    continuedDuringWarning.results.set("task", { thread: failed().thread, turns: [{ id: "manual-completed", status: "completed" }] });
    return "elapsed";
  } });
  await continuedDuringWarning.recovery.tick(); assert.equal(continuedDuringWarning.stats().switches, 0);
  const busyAfterWarning = fixture({ beforeSwitch: async () => {
    busyAfterWarning.results.set("other", { thread: { ...failed("other").thread, status: { type: "active" } }, turns: [] });
    return "elapsed";
  } });
  await busyAfterWarning.recovery.tick(); assert.equal(busyAfterWarning.stats().switches, 0);
  assert.equal(busyAfterWarning.recovery.getStatus().state, "waiting");

  const timer = countdownFixture(), abort = new AbortController();
  const timerResult = timer.countdown.request({ targetLabel: "Test account", taskCount: 2 }, abort.signal);
  timer.advance(8000); assert.equal(timer.window().shown, false);
  assert.equal(timer.countdown.ready({}), null); assert.equal(timer.countdown.cancel({}), false);
  assert.equal(timer.countdown.ready(timer.window().webContents).seconds, 15);
  timer.advance(COUNTDOWN_MS - 250); assert.equal(timer.window().destroyed, false);
  timer.advance(250); assert.equal(await timerResult, "elapsed"); assert.equal(timer.window().destroyed, true);
  const manualTimer = countdownFixture();
  const manualResult = manualTimer.countdown.request({}, new AbortController().signal);
  manualTimer.countdown.ready(manualTimer.window().webContents); manualTimer.advance(5000);
  assert.equal(manualTimer.countdown.cancel(manualTimer.window().webContents), true);
  manualTimer.advance(15000); assert.equal(await manualResult, "cancelled");
  for (const action of ["close", "abort", "crash", "no-renderer", "sleep"]) {
    const t = countdownFixture(), control = new AbortController();
    const result = t.countdown.request({}, control.signal);
    if (action !== "no-renderer") t.countdown.ready(t.window().webContents);
    if (action === "close") t.window().destroy();
    if (action === "abort") control.abort();
    if (action === "crash") t.window().webContents.emit("render-process-gone");
    if (action === "no-renderer") t.advance(10000);
    if (action === "sleep") t.jump(20000);
    assert.equal(await result, ["close", "abort"].includes(action) ? "cancelled" : "unavailable", action);
  }

  const busy = fixture({ list: { pinnedThreads: [{ id: "other", kind: "codex", hostId: "local", status: "active" }] } });
  await busy.recovery.tick(); assert.equal(busy.stats().switches, 0); assert.equal(busy.recovery.getStatus().state, "waiting");
  const unavailable = fixture(); unavailable.accounts[1].needsReauth = true; unavailable.accounts[2].quotaSnapshot = null;
  await unavailable.recovery.tick(); assert.equal(unavailable.stats().switches, 0);
  const hiddenRunning = fixture();
  hiddenRunning.deps.getLocalThreads = async () => [{ id: "task", updatedAt: NOW / 1000 }, { id: "older-running", updatedAt: NOW / 1000 - 600 }];
  const originalRead = hiddenRunning.bridge.readThread;
  hiddenRunning.bridge.readThread = async (id) => id === "older-running"
    ? { thread: { id, status: { type: "active" } }, turns: [] } : originalRead(id);
  await hiddenRunning.recovery.tick(); assert.equal(hiddenRunning.stats().switches, 0, "older active tasks outside the recent list prevent restart");

  const disabled = fixture({ disableDuringSwitch: true });
  await disabled.recovery.tick(); await disabled.recovery.tick(); assert.equal(disabled.stats().sends, 0);
  const off = fixture(); off.recovery.configure(false, null); await off.recovery.tick(); assert.equal(off.stats().reads, 0);

  const manual = fixture(); await manual.recovery.tick(); manual.setActive("c"); await manual.recovery.tick(); assert.equal(manual.stats().sends, 0);
  const wrongAuth = fixture({ usage: { accountId: "wrong" } }); await wrongAuth.recovery.tick(); await wrongAuth.recovery.tick(); assert.equal(wrongAuth.stats().sends, 0);
  const retry = fixture();
  retry.bridge.readUsage = async () => ({ accountId: `workspace-${retry.stats().activeId}`, ordinaryUsageAllowed: retry.stats().activeId === "c" });
  await retry.recovery.tick(); await retry.recovery.tick();
  assert.equal(retry.stats().activeId, "c"); assert.equal(retry.stats().sends, 0, "an unavailable candidate never receives a continuation");
  await retry.recovery.tick(); assert.equal(retry.stats().sends, 1);
  assert.equal(retry.stats().warnings, 2, "each fallback account switch requires a new countdown");
  const unknownFallback = fixture();
  unknownFallback.accounts.push(businessWithoutQuota("d"));
  unknownFallback.bridge.readUsage = async () => ({ accountId: `workspace-${unknownFallback.stats().activeId}`,
    ordinaryUsageAllowed: unknownFallback.stats().activeId === "d" });
  for (const expected of ["b", "c", "d"]) {
    await unknownFallback.recovery.tick();
    assert.equal(unknownFallback.stats().activeId, expected);
    assert.equal(unknownFallback.stats().sends, 0, "no continuation before live quota approval");
  }
  assert.equal(unknownFallback.stats().warnings, 3, "unknown Business also requires its own countdown");
  const resumedFallback = createAutoRecovery(unknownFallback.deps); resumedFallback.configure(true, NOW - 1000);
  for (let i = 0; i < 3; i++) await resumedFallback.tick();
  assert.equal(unknownFallback.stats().sends, 1);
  assert.equal(resumedFallback.getStatus().state, "resumed", "a restarted recovery can finish the unknown Business attempt");
  const skipLow = fixture(); skipLow.accounts[1] = account("b", 98); skipLow.accounts[2] = businessWithoutQuota("c");
  await skipLow.recovery.tick(); assert.equal(skipLow.stats().activeId, "c", "skip near-empty accounts before an unknown Business");
  const noUnknownQuota = fixture({ usage: { ordinaryUsageAllowed: null } });
  noUnknownQuota.accounts.splice(1, 2, businessWithoutQuota("c"));
  await noUnknownQuota.recovery.tick(); await noUnknownQuota.recovery.tick();
  assert.equal(noUnknownQuota.stats().sends, 0, "unknown live availability must never send a continuation");
  const cancelledUnknown = fixture({ beforeSwitch: async () => "cancelled" });
  cancelledUnknown.accounts.splice(1, 2, businessWithoutQuota("c"));
  await cancelledUnknown.recovery.tick(); await cancelledUnknown.recovery.tick();
  assert.equal(cancelledUnknown.stats().switches, 0); assert.equal(cancelledUnknown.stats().warnings, 1);
  const allUnknownEmpty = fixture({ usage: { ordinaryUsageAllowed: false } });
  allUnknownEmpty.accounts.splice(1, 2, businessWithoutQuota("c"), businessWithoutQuota("d"));
  for (let i = 0; i < 5; i++) await allUnknownEmpty.recovery.tick();
  assert.equal(allUnknownEmpty.stats().switches, 2); assert.equal(allUnknownEmpty.stats().sends, 0);
  assert.equal(allUnknownEmpty.recovery.getStatus().state, "waiting");
  assert.ok(allUnknownEmpty.stats().stored.excluded.c > NOW && allUnknownEmpty.stats().stored.excluded.d > NOW);
  const cancelFallback = fixture({ beforeSwitch: async () => cancelFallback.stats().warnings === 1 ? "elapsed" : "cancelled" });
  cancelFallback.bridge.readUsage = async () => ({ accountId: `workspace-${cancelFallback.stats().activeId}`, ordinaryUsageAllowed: false });
  for (let i = 0; i < 5; i++) await cancelFallback.recovery.tick();
  assert.equal(cancelFallback.stats().switches, 1); assert.equal(cancelFallback.stats().sends, 0);
  assert.equal(cancelFallback.stats().warnings, 2); assert.equal(cancelFallback.stats().stored.pending, null);
  const allEmpty = fixture({ usage: { ordinaryUsageAllowed: false } });
  await allEmpty.recovery.tick(); await allEmpty.recovery.tick(); await allEmpty.recovery.tick(); await allEmpty.recovery.tick();
  assert.equal(allEmpty.stats().switches, 2); assert.equal(allEmpty.stats().sends, 0); assert.equal(allEmpty.recovery.getStatus().state, "waiting");
  const raced = fixture(); await raced.recovery.tick(); raced.results.set("task", { thread: { ...failed().thread, status: { type: "active" } }, turns: [{ id: "manual-turn", status: "inProgress" }] });
  await raced.recovery.tick(); assert.equal(raced.stats().sends, 0);

  const uncertain = fixture({ sendError: true }); await uncertain.recovery.tick(); await uncertain.recovery.tick(); await uncertain.recovery.tick(); await uncertain.recovery.tick();
  assert.equal(uncertain.stats().sends, 1); assert.equal(uncertain.stats().switches, 1); assert.equal(uncertain.recovery.getStatus().state, "attention");
  assert.deepEqual(uncertain.stats().opened, [], "never navigate on an unconfirmed continuation");
  const crash = fixture(); await crash.recovery.tick();
  const resumed = createAutoRecovery(crash.deps); resumed.configure(true, NOW - 1000); await resumed.tick(); assert.equal(crash.stats().sends, 1);
  const journal = clone(crash.stats().stored); journal.pending.jobs[0].phase = "sending";
  const ambiguous = fixture({ journal }); ambiguous.setActive("b"); ambiguous.advance(61000);
  await ambiguous.recovery.tick(); await ambiguous.recovery.tick(); assert.equal(ambiguous.stats().sends, 0);

  const multiple = fixture(); multiple.results.set("second", failed("second", "second-failed"));
  for (let i = 0; i < 7; i++) await multiple.recovery.tick();
  assert.equal(multiple.stats().switches, 1); assert.equal(multiple.stats().sends, 2);
  assert.deepEqual(multiple.stats().opened, ["task"], "batch recovery opens only the first confirmed task");
  const navigationRestart = fixture();
  for (let i = 0; i < 3; i++) await navigationRestart.recovery.tick();
  const restartedNavigation = createAutoRecovery(navigationRestart.deps);
  restartedNavigation.configure(true, NOW - 1000); await restartedNavigation.tick();
  assert.deepEqual(navigationRestart.stats().opened, ["task"], "application restart must not navigate again");
  // A second quota failure moves to another account, without cycling to exhausted accounts.
  const again = fixture(); await again.recovery.tick(); await again.recovery.tick(); await again.recovery.tick(); await again.recovery.tick();
  again.results.set("task", failed("task", "new-failure")); again.advance(1000);
  await again.recovery.tick(); assert.equal(again.stats().activeId, "c");
  assert.equal(again.stats().switches, 2);

  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codexauth-test-${process.pid}` : path.join(os.tmpdir(), `codexauth-test-${process.pid}.sock`);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      const data = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", result: { success: true, contentItems: [{ type: "inputText", text: '{"ok":true}' }] } }));
      const frame = Buffer.alloc(data.length + 4); frame.writeUInt32LE(data.length); data.copy(frame, 4);
      socket.write(frame.subarray(0, 2)); setImmediate(() => socket.end(frame.subarray(2)));
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  try { assert.deepEqual(parseToolResult(await pipeRequest(endpoint, "tools/list", {})), { ok: true }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
  assert.throws(() => parseToolResult({ success: false, contentItems: [] }));
  await assert.rejects(pipeRequest(endpoint, "tools/list", {}, 1000), (error) => error.code === "CODEX_PIPE_CONNECTION");
  const requiredTools = ["read_thread", "list_threads", "send_message_to_thread", "get_usage_limits"]
    .map((name) => ({ name, namespace: "codex_app" }));
  const pipeNames = ["codex-browser-use-00000000-0000-0000-0000-000000000001", "codex-browser-use-00000000-0000-0000-0000-000000000002"];
  function connectionFixture({ failures = 1, protocolFailure = false } = {}) {
    let calls = 0, enumerations = 0;
    const used = [];
    const bridge = createDesktopBridge({ platform: "win32", env: {},
      listPipes: async () => [pipeNames[Math.min(enumerations++, 1)]],
      request: async (pipe, method) => {
        if (method === "tools/list") return { tools: requiredTools };
        calls++; used.push(pipe);
        if (protocolFailure) return { success: false };
        if (calls <= failures) throw Object.assign(new Error("disconnected"), { code: "CODEX_PIPE_CLOSED" });
        return { success: true, contentItems: [{ type: "inputText", text: '{"threads":[]}' }] };
      },
    });
    return { bridge, stats: () => ({ calls, enumerations, used }) };
  }
  const transportReconnect = connectionFixture();
  assert.deepEqual(await transportReconnect.bridge.listThreads("task"), { threads: [] });
  assert.equal(transportReconnect.stats().calls, 2);
  assert.equal(transportReconnect.stats().enumerations, 2);
  assert.notEqual(...transportReconnect.stats().used, "read reconnect discovers the replacement pipe");
  const repeatedFailure = connectionFixture({ failures: 3 });
  await assert.rejects(repeatedFailure.bridge.readUsage("task"));
  assert.equal(repeatedFailure.stats().calls, 2, "reconnect attempts are bounded");
  const uncertainSend = connectionFixture();
  await assert.rejects(uncertainSend.bridge.continueThread("task", "continue"));
  assert.equal(uncertainSend.stats().calls, 1, "never replay a continuation after a lost response");
  const uncertainNavigation = connectionFixture();
  await assert.rejects(uncertainNavigation.bridge.openThread("task"));
  assert.equal(uncertainNavigation.stats().calls, 1, "navigation is not retried after a lost response");
  const navigationRequests = [];
  const navigationBridge = createDesktopBridge({ platform: "win32", env: {}, listPipes: async () => [pipeNames[0]],
    request: async (_pipe, method, params) => {
      if (method === "tools/list") return { tools: requiredTools };
      navigationRequests.push(params);
      return { success: true, contentItems: [{ type: "inputText", text: '{"ok":true}' }] };
    } });
  await navigationBridge.openThread("original-task");
  assert.equal(navigationRequests[0].tool, "navigate_to_codex_page");
  assert.deepEqual(navigationRequests[0].arguments, { threadId: "original-task" });
  const incompatible = connectionFixture({ protocolFailure: true });
  await assert.rejects(incompatible.bridge.listThreads("task"));
  assert.equal(incompatible.stats().calls, 1, "protocol errors are not connection retries");
  console.log("Auto recovery validation passed: workspace-credit exhaustion without error codes, recovered scan status, bounded read-only reconnect, no send replay, ranking, countdown cancellation, idle guard, batch resume, cooldown and desktop transport.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
