const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readLocalGoals, createGoalBridge } = require("../src/codex-goals");

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-goals-test-"));
  try {
    assert.deepEqual(await readLocalGoals(dir), []);
    const db = new DatabaseSync(path.join(dir, "goals_1.sqlite"));
    db.exec("CREATE TABLE thread_goals (thread_id TEXT, goal_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)");
    db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("task", "original-id", "original objective", "usage_limited", 10000, 3456, 80, 1800000000123, 1800000010456);
    db.close();
    const [expected] = await readLocalGoals(dir);
    assert.equal(expected.status, "usageLimited");
    assert.equal(expected.objective, undefined, "do not persist objective text in recovery journal");
    let current = { ...expected }, calls = [];
    const original = { threadId: "task", objective: "original objective", status: "usageLimited", tokenBudget: 10000,
      tokensUsed: 3456, timeUsedSeconds: 80, createdAt: 1800000000, updatedAt: 1800000010 };
    let response = { ...original };
    const bridge = createGoalBridge({ codexHome: dir, resolveExecutable: async () => "codex.exe", listGoals: async () => [current],
      api: async (_exe, _home, operation) => operation(async (method, params) => {
        calls.push({ method, params });
        return { goal: { ...response, status: method === "thread/goal/set" ? "active" : response.status } };
      }),
    });
    const resumed = await bridge.resumeGoal("task", expected);
    assert.deepEqual(calls.map((call) => call.method), ["thread/goal/get", "thread/goal/set"]);
    assert.deepEqual(calls[1].params, { threadId: "task", status: "active" }, "never overwrite objective, budget or accounting");
    assert.equal(resumed.tokensUsed, 3456); assert.equal(resumed.timeUsedSeconds, 80);
    for (const change of [{ status: "paused" }, { status: "budgetLimited" }, { goalId: "new-id" }, { updatedAt: expected.updatedAt + 1 }, { objectiveHash: "edited" }, { tokenBudget: 20000 }]) {
      calls = []; current = { ...expected, ...change };
      await assert.rejects(bridge.resumeGoal("task", expected));
      assert.ok(calls.every((call) => call.method !== "thread/goal/set"));
    }
    current = { ...expected }; calls = [];
    await assert.rejects(bridge.resumeGoal("task", expected, () => false));
    assert.equal(calls.length, 1);
    calls = [];
    await assert.rejects(bridge.resumeGoal("task", expected, async () => false));
    assert.equal(calls.length, 1, "async identity guard must finish before goal/set");
    for (const change of [{ status: "paused" }, { objective: "changed" }, { tokensUsed: 5000 }, { tokenBudget: 20000 }]) {
      response = { ...original, ...change }; calls = [];
      await assert.rejects(bridge.resumeGoal("task", expected));
      assert.equal(calls.length, 1, "API and local metadata must agree before activation");
    }
    console.log("Goal metadata, resume guards and accounting preservation validation passed.");
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("codexauth-goals-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
