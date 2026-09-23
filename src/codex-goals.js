const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const STATUSES = { active: "active", paused: "paused", blocked: "blocked", usage_limited: "usageLimited", budget_limited: "budgetLimited", complete: "complete" };

// Read metadata only. Mutations go through Codex's goal API so its rollout and
// budget accounting remain consistent; never UPDATE the user's SQLite files.
async function readLocalGoals(codexHome) {
  const names = (await fs.readdir(codexHome)).filter((name) => /^goals_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!names.length) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(codexHome, names[0]), { readOnly: true });
  try {
    return db.prepare("SELECT thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals").all().map((row) => {
      if (!STATUSES[row.status] || !row.goal_id || typeof row.objective !== "string") throw new Error("目标记录格式不兼容，已暂停自动恢复。");
      return { threadId: row.thread_id, goalId: row.goal_id, objectiveHash: hash(row.objective), status: STATUSES[row.status],
        tokenBudget: row.token_budget, tokensUsed: row.tokens_used, timeUsedSeconds: row.time_used_seconds,
        createdAt: row.created_at_ms, updatedAt: row.updated_at_ms };
    });
  } finally { db.close(); }
}

async function resolveGoalExecutable(env = process.env) {
  const root = path.join(env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const executable = path.join(root, entry.name, "codex.exe");
    try { return { executable, modified: (await fs.stat(executable)).mtimeMs }; } catch { return null; }
  }))).filter(Boolean).sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error("未找到 Codex 目标接口程序，请更新或打开 Codex。");
  return candidates[0].executable;
}

// This short-lived API helper never loads a conversation or starts model work.
// Only goal get/set are allowed; execution and tools stay in the desktop app.
async function withGoalApi(executable, codexHome, operation, spawnProcess = spawn) {
  const child = spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
    windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let sequence = 0, closed = false;
  const exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  const fail = () => {
    closed = true;
    for (const item of pending.values()) item.reject(new Error("Codex 目标接口未完成请求，请在 Codex 中检查目标状态。"));
    pending.clear();
  };
  child.on("error", fail); child.on("exit", fail); child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.length > 1024 * 1024) { fail(); child.kill(); return; }
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error("Codex 拒绝恢复目标，请检查目标状态或更新 Codex。"));
    else item.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("Codex 目标接口已关闭。"));
    if (!["initialize", "thread/goal/get", "thread/goal/set"].includes(method)) return reject(new Error("不支持的目标操作。"));
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 15000);
  try {
    await request("initialize", { clientInfo: { name: "codexauth_goal_recovery", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await operation(request);
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); fail();
    let exitTimer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("目标接口未退出，请关闭 Codex CLI 后再切换账号。")), 5000);
      })]);
    } finally { clearTimeout(exitTimer); }
  }
}

function sameGoal(a, b) {
  return !!a && !!b && a.goalId === b.goalId && a.objectiveHash === b.objectiveHash
    && a.createdAt === b.createdAt && a.tokenBudget === b.tokenBudget;
}

function matchesApiGoal(goal, expected) {
  return !!goal && typeof goal.objective === "string" && goal.threadId === expected.threadId && hash(goal.objective) === expected.objectiveHash
    && goal.createdAt === Math.floor(expected.createdAt / 1000) && goal.tokenBudget === expected.tokenBudget
    && goal.tokensUsed === expected.tokensUsed && goal.timeUsedSeconds === expected.timeUsedSeconds;
}

function createGoalBridge({ codexHome, resolveExecutable = resolveGoalExecutable, listGoals = () => readLocalGoals(codexHome), api = withGoalApi }) {
  const readGoal = async (id) => (await listGoals()).find((goal) => goal.threadId === id) ?? null;
  return {
    listGoals, readGoal,
    resumeGoal: async (id, expected, allowed = () => true) => {
      const executable = await resolveExecutable();
      return api(executable, codexHome, async (request) => {
        const { goal } = await request("thread/goal/get", { threadId: id });
        const current = await readGoal(id);
        if (!await allowed() || !sameGoal(current, expected) || current.status !== "usageLimited"
          || current.updatedAt !== expected.updatedAt || goal?.status !== "usageLimited" || !matchesApiGoal(goal, expected)) {
          throw new Error("目标状态已改变，已取消自动恢复，请在 Codex 中检查。");
        }
        if (current.tokenBudget !== null && current.tokensUsed >= current.tokenBudget) throw new Error("目标自身预算已用完，请手动调整目标预算。");
        // Omit objective and budget: replacing a goal would reset its accounting.
        const result = await request("thread/goal/set", { threadId: id, status: "active" });
        if (result.goal?.status !== "active" || !matchesApiGoal(result.goal, expected)) throw new Error("未能确认原目标已恢复，请在 Codex 中检查。");
        return result.goal;
      });
    },
  };
}

module.exports = { readLocalGoals, createGoalBridge, sameGoal, matchesApiGoal, withGoalApi, resolveGoalExecutable };
