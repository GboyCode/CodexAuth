const { normalizePlanType } = require("./quota/token-math");
const { sameGoal } = require("./codex-goals");

const CONTINUE_PROMPT = "刚才任务因 Codex 账号额度耗尽而中断，CodexAuth 已切换账号。请基于本任务已有上下文和当前文件状态，继续完成我上一条请求中尚未完成的工作。先确认已完成的步骤，避免重复执行；保留原有模型、权限与审批要求。";
const GOAL_CONTINUE_PROMPT = "刚才本任务的目标因 Codex 账号额度耗尽而中断，CodexAuth 已切换账号并恢复原目标。请读取当前目标状态，基于已有上下文和文件进度继续原目标，遵守原预算、模型、权限与审批要求；避免重复已完成的步骤。";
const POLL_MS = 15000;
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_REMAINING_PERCENT = 2;

function windowScore(window, now) {
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  const reset = Number(window.resetsAt) * 1000;
  if (!Number.isFinite(reset) || reset <= 0 || window.usedPercent < 0 || window.usedPercent > 100) return null;
  if (reset <= now) {
    // This is a candidate estimate only. Recovery verifies the actual signed-in
    // account and live availability before submitting any continuation prompt.
    const duration = Number(window.windowMinutes) * 60000;
    const nextReset = Number.isFinite(duration) && duration > 0
      ? reset + (Math.floor((now - reset) / duration) + 1) * duration : Infinity;
    return { remaining: 100, reset: nextReset, inferred: true };
  }
  return { remaining: 100 - window.usedPercent, reset, inferred: false };
}

function accountPlan(account) {
  return normalizePlanType(account.identity?.planType) || normalizePlanType(account.quotaSnapshot?.planType);
}

function accountPriority(account) {
  const quota = account.quotaSnapshot;
  const plan = accountPlan(account);
  if (plan === "plus") return 0;
  if (plan === "business") {
    if ([quota?.session, quota?.weekly].some((window) => Number(window?.windowMinutes) === 300)) return 1;
    // Only a recorded weekly-only snapshot establishes the absence of a 5h limit.
    // Missing/unknown window metadata must not be mistaken for this plan variant.
    if (quota?.session === null && Number(quota?.weekly?.windowMinutes) >= 10080) return 2;
  }
  return 3;
}

function rankAccounts(accounts, activeId, excluded = {}, now = Date.now()) {
  return accounts.flatMap((account) => {
    if (account.id === activeId || account.needsReauth || Number(excluded[account.id]) > now) return [];
    const quota = account.quotaSnapshot;
    const checkedAt = Date.parse(quota?.checkedAt);
    if (Number.isFinite(checkedAt) && (checkedAt > now + 60000 || now - checkedAt > MAX_SNAPSHOT_AGE_MS)) return [];
    const raw = [quota?.session, quota?.weekly].filter(Boolean);
    const windows = raw.map((window) => windowScore(window, now));
    // A missing/invalid second window must not turn a known nearly exhausted
    // account into an unknown-quota fallback. Only a valid past reset lifts it.
    if (raw.some((window, index) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      && 100 - window.usedPercent <= MIN_REMAINING_PERCENT && !windows[index]?.inferred)) return [];
    const unknownBusiness = () => accountPlan(account) === "business"
      ? [{ account, priority: 4, inferred: true, remaining: null, reset: Infinity }] : [];
    if (!quota || quota.source === "unavailable" || !raw.length) return unknownBusiness();
    if (quota.schemaVersion !== 2 || !Number.isFinite(checkedAt)) return [];
    if (windows.some((window) => !window)) return unknownBusiness();
    return [{ account, priority: accountPriority(account), inferred: windows.some((window) => window.inferred) || now - checkedAt > 86400000,
      remaining: Math.min(...windows.map((window) => window.remaining)),
      reset: Math.min(...windows.map((window) => window.reset)) }];
  }).sort((a, b) => a.priority - b.priority || b.remaining - a.remaining || a.reset - b.reset || a.account.id.localeCompare(b.account.id));
}

function isQuotaFailure(result, since = 0) {
  const thread = result?.thread, turn = result?.turns?.[0];
  const code = turn?.error?.codexErrorInfo;
  const message = typeof turn?.error?.message === "string" ? turn.error.message.trim() : "";
  // Desktop read_thread can omit codexErrorInfo for both workspace credits and
  // Plus usage limits. Match known native templates in the failed turn's error;
  // a stale widget snapshot (e.g. 99% used) is never the exhaustion trigger.
  const nativeQuotaMessage = /^Your workspace is out of credits\. Add credits to continue\.$/i.test(message)
    || /^You['’]ve hit your usage limit\. Upgrade to Pro \(https:\/\/chatgpt\.com\/explore\/pro\), visit https:\/\/chatgpt\.com\/codex\/settings\/usage to purchase more credits or try again at [^\r\n]{1,80}\.$/i.test(message);
  const missingCodeQuota = (code == null || code === "other")
    && nativeQuotaMessage;
  // Do not infer exhaustion from 429, arbitrary transcripts, or tool/image failures.
  return thread?.kind === "codex" && thread.hostId === "local"
    && thread.status?.type !== "active" && turn?.status === "failed"
    && (code === "usageLimitExceeded" || missingCodeQuota || (code === "other" && /\busage_limit_reached\b/.test(message)))
    && Number.isFinite(turn.completedAt) && turn.completedAt * 1000 >= since;
}

function recoveryJob(result, since = 0) {
  const { thread, goal, turns } = result ?? {};
  const turn = turns?.[0];
  if (thread?.kind !== "codex" || thread.hostId !== "local" || thread.status?.type === "active"
    || ["inProgress", "running"].includes(turn?.status)) return null;
  if (goal) {
    if (!["usageLimited", "active"].includes(goal.status)
      || (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget)) return null;
    if (goal.status === "usageLimited") {
      if (!Number.isFinite(goal.updatedAt) || goal.updatedAt < since) return null;
    } else if (!isQuotaFailure(result, since) || goal.createdAt > turn.completedAt * 1000 + 1000) return null;
    return { threadId: thread.id, turnId: turn?.id ?? null, phase: "waiting", goal,
      failureKey: `${thread.id}:goal:${goal.goalId}:${turn?.id ?? goal.updatedAt}` };
  }
  return isQuotaFailure(result, since) ? { threadId: thread.id, turnId: turn.id, phase: "waiting" } : null;
}

function matchesJob(result, job, since = 0) {
  const fresh = recoveryJob(result, since);
  return !!fresh && fresh.turnId === job.turnId && (job.goal
    ? sameGoal(fresh.goal, job.goal) && fresh.goal.updatedAt === job.goal.updatedAt && fresh.goal.status === job.goal.status
    : !fresh.goal);
}

function localThreads(list) {
  return [...(list?.pinnedThreads ?? []), ...(list?.threads ?? [])]
    .filter((thread) => thread.kind === "codex" && thread.hostId === "local");
}

function canRestart(list) {
  if (list?.unavailableHosts?.length || list?.unavailableSources?.length) return false;
  // The list API has no pagination. A full page cannot prove all tasks are idle.
  if ((list?.threads?.length ?? 0) >= 50 && list.localCoverageComplete !== true) return false;
  return !localThreads(list).some((thread) => ["active", "running", "inProgress"].includes(thread.status?.type ?? thread.status));
}

function createAutoRecovery(deps) {
  const now = deps.now ?? Date.now;
  let enabled = false, since = 0, generation = 0, busy = false, journal = null, warningAbort = null, scanFailed = false;
  let status = { state: "disabled", message: "未开启自动切换与续任务。" };
  const cache = new Map();
  const setStatus = (state, message) => {
    if (status.state === state && status.message === message) return;
    status = { state, message, updatedAt: new Date(now()).toISOString() };
    deps.onStatus?.(status);
  };
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = JSON.parse(JSON.stringify(journal));
    saveQueue = saveQueue.catch(() => {}).then(() => deps.saveJournal(snapshot));
    return saveQueue;
  };
  const key = (id, turnId) => `${id}:${turnId}`;
  const jobKey = (job) => job.failureKey ?? key(job.threadId, job.turnId);
  const failure = (message) => setStatus("attention", message);
  async function dismissJobs(jobs, state, message) {
    journal.handled = [...new Set([...journal.handled, ...jobs.map(jobKey)])].slice(-1000);
    journal.pending = null;
    await save();
    setStatus(state, message);
  }
  async function approveSwitch(target, sourceId, jobs, anchor, allowed, cutoff = 0) {
    if (!allowed()) return null;
    const abort = new AbortController();
    warningAbort = abort;
    setStatus("countdown", "自动切换前倒计时 15 秒，可在浮窗弹窗中取消本次。" );
    let decision;
    try {
      decision = await deps.beforeSwitch({ targetLabel: target.displayName || target.identity?.email || "候选账号",
        taskCount: jobs.length }, abort.signal);
    } finally {
      if (warningAbort === abort) warningAbort = null;
    }
    if (!allowed()) return null;
    if (decision !== "elapsed") {
      await dismissJobs(jobs, decision === "cancelled" ? "cancelled" : "attention", decision === "cancelled"
        ? "已取消本次自动切换；这次中断不会再次自动重试，新中断仍会监听。"
        : "切换提醒未能完整显示，已取消本次自动切换，请手动继续任务。");
      return null;
    }
    // The user may have resumed a task or changed an account during the warning.
    const freshAccounts = await deps.getAccounts();
    if (!allowed()) return null;
    if (freshAccounts.activeAccountId !== sourceId) {
      await dismissJobs(jobs, "cancelled", "账号已被手动切换，已取消本次自动恢复。");
      return null;
    }
    if (!rankAccounts(freshAccounts.accounts, sourceId, journal.excluded, now()).some((item) => item.account.id === target.id)) {
      setStatus("waiting", "候选账号状态已改变，稍后重新选择账号并倒计时。");
      return null;
    }
    if (!await desktopIsIdle(anchor, allowed)) return null;
    const freshJobs = [];
    for (const job of jobs) {
      const result = await deps.bridge.readThread(job.threadId);
      if (!allowed()) return null;
      if (matchesJob(result, job, cutoff)) freshJobs.push(job);
      else job.phase = "skipped";
    }
    if (!freshJobs.length) {
      await dismissJobs(jobs, "cancelled", "原任务状态已改变，已取消本次自动切换。");
      return null;
    }
    return freshJobs;
  }
  async function desktopIsIdle(anchor, allowed) {
    const list = await deps.bridge.listThreads(anchor);
    if (!allowed()) return false;
    const metadata = deps.getLocalThreads ? await deps.getLocalThreads() : null;
    if (!allowed()) return false;
    if (!canRestart({ ...list, localCoverageComplete: metadata !== null })) {
      setStatus("waiting", "仍有其他本地任务在运行，暂缓切换账号。" ); return false;
    }
    // Active goals can be idle briefly between their automatically scheduled
    // turns. Treat them as running unless their latest turn exhausted quota.
    for (const goal of await deps.bridge.listGoals?.() ?? []) {
      if (goal.status !== "active") continue;
      const result = await deps.bridge.readThread(goal.threadId);
      if (!allowed()) return false;
      if (!isQuotaFailure(result)) {
        setStatus("waiting", "仍有其他目标在运行，暂缓切换账号。" ); return false;
      }
    }
    if (metadata) {
      setStatus("checking", "正在检查其他本地任务是否已结束。" );
      const visible = new Set(localThreads(list).map((thread) => thread.id));
      const others = metadata.filter((thread) => !visible.has(thread.id));
      for (let i = 0; i < others.length; i += 4) {
        const results = await Promise.all(others.slice(i, i + 4).map((thread) => deps.bridge.readThread(thread.id)));
        if (!allowed()) return false;
        if (results.some((result) => !result?.thread || result.thread.status?.type === "active")) {
          setStatus("waiting", "仍有其他本地任务在运行，暂缓切换账号。" ); return false;
        }
      }
    }
    return true;
  }
  function configure(nextEnabled, nextSince) {
    const next = nextEnabled === true;
    if (enabled === next && since === nextSince) return;
    enabled = next; since = Number(nextSince) || now(); generation += 1;
    scanFailed = false;
    warningAbort?.abort();
    cache.clear();
    setStatus(enabled ? "watching" : "disabled", enabled ? "正在监听额度耗尽的任务。" : "未开启自动切换与续任务。" );
  }
  function invalidate() {
    generation += 1;
    warningAbort?.abort();
    cache.clear();
    // Also retire a batch when a manual action arrives between polling ticks.
    if (journal?.pending) {
      journal.pending = null;
    }
    if (enabled) setStatus("cancelled", "登录操作已改变，已取消待恢复任务。");
    const persisted = journal ? save() : Promise.resolve();
    persisted.catch(() => failure("无法保存恢复取消状态，请关闭自动恢复并检查磁盘。"));
    return persisted;
  }
  async function tick() {
    if (busy || deps.isPaused?.()) return;
    busy = true;
    const revision = generation;
    const allowed = () => enabled && revision === generation;
    try {
      if (!journal) {
        journal = await deps.loadJournal() ?? { version: 1, handled: [], excluded: {}, pending: null };
        if (journal.version !== 1 || !Array.isArray(journal.handled) || !journal.excluded || typeof journal.excluded !== "object") {
          throw new Error("自动恢复记录格式异常，请检查本地 auto-recovery.json。" );
        }
      }
      if (!allowed()) {
        if (journal.pending) { journal.pending = null; await save(); }
        return;
      }
      const accounts = await deps.getAccounts();
      if (!allowed()) return;
      if (!accounts.activeAccountId) { failure("请先导入当前 Codex 登录账号。" ); return; }
      if (journal.pending) {
        const pending = journal.pending;
        if (pending.enabledAt !== since) { journal.pending = null; await save(); return; }
        if (pending.stage === "switching") {
          failure("上次切换过程被中断，请确认 Codex 登录状态并手动继续任务。" );
          journal.pending = null; await save(); return;
        }
        if (accounts.activeAccountId !== pending.targetId) {
          failure("账号已被手动切换，已取消待恢复任务。" );
          journal.pending = null; await save(); return;
        }
        if (pending.nextAttemptAt > now()) return;
        const job = pending.jobs.find((item) => !["done", "skipped", "uncertain"].includes(item.phase));
        if (!job) {
          const done = pending.jobs.filter((item) => item.phase === "done").length;
          const uncertain = pending.jobs.some((item) => item.phase === "uncertain");
          const navigationNote = pending.navigationFailed ? " 页面未能自动打开，可在 Codex 中选择原任务。" : "";
          journal.pending = null; await save();
          setStatus(uncertain ? "attention" : "resumed", uncertain
            ? `已确认恢复 ${done} 个任务；部分任务或目标恢复未确认，请在 Codex 中检查，未重复发送。`
            : `已切换账号并确认恢复 ${done} 个任务。${navigationNote}`);
          return;
        }
        const result = await deps.bridge.readThread(job.threadId);
        if (!allowed()) return;
        const turn = result?.turns?.[0];
        if ((turn?.id ?? null) !== job.turnId) {
          job.phase = ["sending", "sent"].includes(job.phase) && turn?.id ? "done" : "skipped";
          if (job.phase === "done" && job.goal && (!sameGoal(result.goal, job.goal)
            || !["active", "complete"].includes(result.goal.status))) job.phase = "uncertain";
          // Persist the attempt first: a restart must not keep stealing focus.
          // Navigation is optional and independent from sending a continuation.
          const shouldOpen = job.phase === "done" && !pending.navigationAttempted && typeof deps.bridge.openThread === "function";
          if (shouldOpen) pending.navigationAttempted = true;
          await save();
          if (shouldOpen && allowed()) {
            try { await deps.bridge.openThread(job.threadId); }
            catch { pending.navigationFailed = true; await save(); }
          }
          return;
        }
        if (["sending", "sent"].includes(job.phase)) {
          if (now() - job.sentAt < 60000) return;
          job.phase = "uncertain"; await save(); return;
        }
        if (!matchesJob(result, job)) { job.phase = "skipped"; await save(); return; }
        const target = accounts.accounts.find((item) => item.id === pending.targetId);
        const accountAllowed = async () => {
          if (!allowed()) return false;
          const fresh = await deps.getAccounts();
          return allowed() && fresh.activeAccountId === pending.targetId
            && (fresh.activeSince ?? 0) === (accounts.activeSince ?? 0);
        };
        const assertAccount = async () => {
          if (!await accountAllowed()) {
            journal.pending = null;
            await save();
            throw new Error("账号已改变，已停止自动恢复，请手动检查原任务。");
          }
        };
        // The same queue owns manual login mutations and this complete
        // validation-to-dispatch interval, including the goal helper lifetime.
        const usage = await deps.runAccountOperation(async () => {
          await assertAccount();
          const checked = await deps.bridge.readUsage(job.threadId);
          await assertAccount();
          if (!target?.identity?.userId || checked?.accountId !== target.identity.userId || checked.ordinaryUsageAllowed !== true) return checked;
          job.phase = "sending"; job.sentAt = now(); await save();
          try {
            await assertAccount();
            if (job.goal?.status === "usageLimited") await deps.bridge.resumeGoal(job.threadId, job.goal, accountAllowed);
            await assertAccount();
            await deps.bridge.continueThread(job.threadId, job.goal ? GOAL_CONTINUE_PROMPT : CONTINUE_PROMPT, assertAccount);
            job.phase = "sent";
          } catch {
            job.phase = "uncertain";
          }
          await save();
          return checked;
        });
        if (!allowed()) return;
        if (target?.identity?.userId && usage?.accountId === target.identity.userId && usage.ordinaryUsageAllowed === false) {
          journal.excluded[target.id] = now() + 30 * 60 * 1000;
          const next = rankAccounts(accounts.accounts, target.id, journal.excluded, now())[0]?.account;
          if (!next) {
            pending.nextAttemptAt = now() + 60000;
            await save();
            setStatus("waiting", "备用账号的实际额度仍不可用，等待账号额度恢复后重试。" ); return;
          }
          await save();
          if (!await desktopIsIdle(job.threadId, allowed)) return;
          if (!await approveSwitch(next, target.id, pending.jobs.filter((item) => item.phase === "waiting"), job.threadId, allowed)) return;
          pending.stage = "switching"; pending.sourceId = target.id; pending.targetId = next.id; pending.createdAt = now();
          delete pending.nextAttemptAt;
          await save();
          if (!allowed()) return;
          setStatus("switching", "候选账号实际额度不可用，正在切换下一个账号。" );
          await deps.switchAccount(next.id, target.id, allowed);
          deps.bridge.reset(); pending.stage = "switched"; await save();
          if (allowed()) setStatus("resuming", "已切换下一账号，等待核验额度后继续原任务。" );
          return;
        }
        if (!target?.identity?.userId || usage?.accountId !== target.identity.userId || usage.ordinaryUsageAllowed !== true) {
          failure("切换后尚未确认新账号可用，已暂停续任务，请在 Codex 中检查登录与额度。" );
          if (now() - pending.createdAt > 120000) { journal.pending = null; await save(); }
          return;
        }
        if (allowed()) setStatus(job.phase === "uncertain" ? "attention" : "resuming", job.phase === "uncertain"
          ? "未能确认账号或恢复结果，请检查原任务，未重复发送。" : "已请求原任务继续，正在确认任务状态。" );
        return;
      }
      const anchor = await deps.getAnchor();
      if (!anchor || !allowed()) return;
      const list = await deps.bridge.listThreads(anchor);
      if (!allowed()) return;
      const cutoff = Math.max(since, accounts.activeSince || 0);
      const metadata = deps.getLocalThreads ? await deps.getLocalThreads() : null;
      if (!allowed()) return;
      const goals = await deps.bridge.listGoals?.() ?? [];
      if (!allowed()) return;
      const goalMap = new Map(goals.map((goal) => [goal.threadId, goal]));
      const candidates = new Map(localThreads(list).map((thread) => [thread.id, thread]));
      for (const thread of metadata ?? []) {
        if (!candidates.has(thread.id) && Math.max(thread.updatedAt * 1000, goalMap.get(thread.id)?.updatedAt ?? 0) >= cutoff)
          candidates.set(thread.id, { ...thread, kind: "codex", hostId: "local" });
      }
      const failures = [];
      for (const thread of candidates.values()) {
        if ((thread.status?.type ?? thread.status) === "active"
          || Math.max(Number(thread.updatedAt) * 1000 || 0, goalMap.get(thread.id)?.updatedAt ?? 0) < cutoff) continue;
        const signature = `${thread.updatedAt}:${JSON.stringify(thread.status)}`;
        let entry = cache.get(thread.id);
        if (entry?.signature !== signature) {
          const result = await deps.bridge.readThread(thread.id);
          if (!allowed()) return;
          entry = { signature, result }; cache.set(thread.id, entry);
        }
        const result = deps.bridge.listGoals ? { ...entry.result, goal: goalMap.get(thread.id) ?? null } : entry.result;
        const job = recoveryJob(result, cutoff);
        if (!job || journal.handled.includes(jobKey(job))) continue;
        failures.push(job);
      }
      if (cache.size > 200) cache.clear();
      const recoveredScan = scanFailed;
      scanFailed = false;
      if (!failures.length) {
        if (status.state === "waiting" || recoveredScan) setStatus("watching", "正在监听额度耗尽的任务。" );
        return;
      }
      if (!canRestart({ ...list, localCoverageComplete: metadata !== null })) { setStatus("waiting", "检测到额度中断；等待其他任务结束后再切换，避免重启打断它们。" ); return; }
      const ranked = rankAccounts(accounts.accounts, accounts.activeAccountId, journal.excluded, now());
      if (!ranked.length) { setStatus("waiting", "暂无可尝试的备用账号；请检查额度、重置时间或登录状态。" ); return; }
      const target = ranked[0].account;
      // Recheck immediately before changing global authentication/restarting the app.
      if (!await desktopIsIdle(anchor, allowed)) return;
      const freshFailures = [];
      for (const job of failures) {
        const result = await deps.bridge.readThread(job.threadId);
        if (!allowed()) return;
        if (matchesJob(result, job, cutoff)) freshFailures.push(job);
      }
      if (!freshFailures.length) return;
      const approvedJobs = await approveSwitch(target, accounts.activeAccountId, freshFailures, anchor, allowed, cutoff);
      if (!approvedJobs || !allowed()) return;
      journal.pending = { stage: "switching", enabledAt: since, sourceId: accounts.activeAccountId,
        targetId: target.id, createdAt: now(), jobs: approvedJobs };
      journal.handled = [...journal.handled, ...approvedJobs.map(jobKey)].slice(-1000);
      journal.excluded = Object.fromEntries(Object.entries(journal.excluded).filter(([, until]) => until > now()));
      journal.excluded[accounts.activeAccountId] = now() + 30 * 60 * 1000;
      await save();
      if (!allowed()) return;
      setStatus("switching", "正在切换候选账号并重启 Codex，随后核验实际额度。" );
      await deps.switchAccount(target.id, accounts.activeAccountId, allowed);
      deps.bridge.reset();
      if (!allowed() || !journal.pending) return;
      journal.pending.stage = "switched";
      await save();
      if (allowed()) setStatus("resuming", "账号已切换，等待 Codex 就绪后继续原任务。" );
    } catch (error) {
      if (allowed()) {
        scanFailed = !journal?.pending;
        failure(error.message || "自动恢复失败，请检查 Codex 状态。" );
      }
    } finally {
      // Disabling during any asynchronous step cancels all subsequent work.
      if ((!enabled || revision !== generation) && journal?.pending) { journal.pending = null; await save().catch(() => {}); }
      busy = false;
    }
  }
  return { configure, invalidate, tick, getStatus: () => ({ ...status }) };
}

module.exports = { createAutoRecovery, rankAccounts, isQuotaFailure, recoveryJob, canRestart, POLL_MS, CONTINUE_PROMPT };
