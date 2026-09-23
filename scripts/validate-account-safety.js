// Fake credentials and process/desktop adapters only. Never accesses live accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createAutoRecovery } = require("../src/auto-recovery");
const { createDesktopBridge, pipeRequest } = require("../src/codex-desktop-bridge");
const { encryptPortableCredentials } = require("../src/portable-credentials");
const clone = (value) => JSON.parse(JSON.stringify(value));
const NOW = 1800000000000;
function auth(person, date = "2026-09-22T00:00:00Z", revision = "new") {
  const claims = { sub: `fake-${person}`, email: `${person}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } };
  return JSON.stringify({ auth_mode: "chatgpt", last_refresh: date, tokens: {
    access_token: `FAKE-access-${person}-${revision}`, refresh_token: `FAKE-refresh-${person}-${revision}`,
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.FAKE`,
  } });
}

async function storage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-safety-"));
  try {
    const home = path.join(root, "home"); await fs.mkdir(home);
    const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
    const selectedFile = path.join(root, "transfer.codexauth");
    const prompts = []; let confirm = 1;
    const sandbox = vm.createContext({ require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => root },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedFile] }),
        showMessageBox: async (_win, options) => { prompts.push(options); return { response: confirm }; } },
    } : name === "node:child_process" ? { spawn() { throw new Error("No real process execution in this test"); } } : realRequire(name),
      __dirname: path.dirname(filename), process: { ...process, env: { ...process.env, CODEX_HOME: home } },
      Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(await fs.readFile(filename, "utf8"), sandbox);
    sandbox.protectText = async (text) => `VAULT:${Buffer.from(text).toString("base64")}`;
    sandbox.unprotectText = async (text) => Buffer.from(text.trim().slice(6), "base64").toString();
    sandbox.currentState = async () => ({ accounts: (await sandbox.readIndex()).accounts });
    sandbox.scheduleReauthCheck = () => {};
    // Capture platform scripts without executing them. Windows parser validation
    // below is syntax-only; it never invokes a process-management statement.
    if (process.platform === "win32") {
      const scripts = [];
      sandbox.runPowerShell = async (script) => { scripts.push(script); return ""; };
      await sandbox.restartCodexApp();
      assert.equal(scripts.length, 3);
      assert.match(scripts[0], /Stop-Process/);
      assert.match(scripts[0], /WaitForExit/);
      assert.match(scripts[1], /writers/);
      assert.match(scripts[2], /Start-Process/);
      const scriptPath = path.join(root, "process-scripts.json");
      await fs.writeFile(scriptPath, JSON.stringify(scripts));
      const { execFileSync } = require("node:child_process");
      execFileSync("powershell.exe", ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; foreach ($script in (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:CODEXAUTH_TEST_SCRIPTS | ConvertFrom-Json)) { $tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors); if ($errors.Count) { throw ($errors | ForEach-Object { $_.ErrorId + ':' + $_.Extent.StartLineNumber }) } }"],
        { windowsHide: true, env: { ...process.env, CODEXAUTH_TEST_SCRIPTS: scriptPath }, stdio: "pipe" });
    }
    await sandbox.ensureStoreDirs();
    const authFile = path.join(home, "auth.json"), aOld = auth("a", "2026-09-01T00:00:00Z", "old"), aNew = auth("a"), bNew = auth("b");
    const records = {};
    for (const [id, content] of [["a", aOld], ["b", bNew]]) {
      records[id] = sandbox.createAccountRecord({ ...sandbox.validateAuthJson(content), content }, id, new Date(NOW).toISOString());
      await sandbox.saveAccountAuth(records[id].id, content);
    }
    await sandbox.writeIndex({ accounts: Object.values(records), activeAccountId: records.a.id, settings: {} });
    await fs.writeFile(authFile, aOld);
    let running = true, starts = 0;
    sandbox.stopCodexApp = async () => {
      assert.equal(await fs.readFile(authFile, "utf8"), aOld, "destination must not be written while old desktop is alive");
      await fs.writeFile(authFile, aNew); // Last refresh immediately before process exit.
      running = false;
    };
    sandbox.assertCodexStopped = async () => { if (running) throw new Error("client still running"); };
    sandbox.startCodexApp = async () => {
      starts++; assert.equal(await fs.readFile(authFile, "utf8"), bNew);
      assert.equal(await sandbox.loadAccountAuth(records.a.id), aNew, "save final old credential after exit");
    };
    await sandbox.switchAccount(records.b.id, { restartCodex: true });
    assert.equal(starts, 1); assert.equal((await sandbox.readIndex()).activeAccountId, records.b.id);
    assert.equal(await fs.readFile(authFile, "utf8"), bNew);
    running = true;
    await assert.rejects(sandbox.switchAccount(records.a.id, { restartCodex: false }), /still running/);
    assert.equal(await fs.readFile(authFile, "utf8"), bNew, "no-restart mode cannot write under a running client");
    sandbox.stopCodexApp = async () => { throw new Error("stop failed"); };
    await assert.rejects(sandbox.switchAccount(records.a.id, { restartCodex: true }), /stop failed/);
    assert.equal(await fs.readFile(authFile, "utf8"), bNew);
    // Detect a second client appearing during the backup, before auth replacement.
    running = false;
    const backup = sandbox.backupCurrentAuth;
    sandbox.backupCurrentAuth = async (...args) => { await backup(...args); running = true; };
    await assert.rejects(sandbox.switchAccount(records.a.id, { restartCodex: false }), /still running/);
    assert.equal(await fs.readFile(authFile, "utf8"), bNew);
    sandbox.backupCurrentAuth = backup; running = false;
    sandbox.backupCurrentAuth = async () => { throw new Error("backup failed"); };
    await assert.rejects(sandbox.switchAccount(records.a.id, { restartCodex: false }), /backup failed/);
    assert.equal(await fs.readFile(authFile, "utf8"), bNew);
    sandbox.backupCurrentAuth = backup;
    // A corrupt or mismatched saved account must not even close the desktop.
    await sandbox.saveAccountAuth(records.a.id, bNew);
    await assert.rejects(sandbox.switchAccount(records.a.id, { restartCodex: true }), /凭证与账号不一致/);
    await sandbox.saveAccountAuth(records.a.id, aNew);

    // Old, missing-date and equal-date/conflicting-token imports keep reauth status.
    await fs.writeFile(authFile, aNew);
    const password = "fixture-password-123";
    for (const date of ["2026-09-01T00:00:00Z", null, "2026-09-22T00:00:00Z"]) {
      await sandbox.saveAccountAuth(records.b.id, bNew);
      const index = await sandbox.readIndex(), record = index.accounts.find((item) => item.id === records.b.id);
      record.needsReauth = true; record.reauthReason = "existing login error";
      await sandbox.writeIndex(index);
      const old = auth("b", date, "old");
      await fs.writeFile(selectedFile, await encryptPortableCredentials({ auth: old, displayName: "b" }, password));
      const selection = await sandbox.selectPortableCredentials();
      confirm = 0;
      assert.equal((await sandbox.importPortableCredentials(password, selection.selectionId)).canceled, true);
      assert.equal(await sandbox.loadAccountAuth(record.id), bNew, "cancel retains newer credential");
      confirm = 1;
      await sandbox.importPortableCredentials(password, selection.selectionId);
      assert.match(prompts.at(-1).detail, /较旧或无法确认/);
      assert.equal((await sandbox.readIndex()).accounts.find((item) => item.id === record.id).needsReauth, true);
      await sandbox.hydrateStoredAccountMetadata();
      assert.equal((await sandbox.readIndex()).accounts.find((item) => item.id === record.id).needsReauth, true, "restart metadata read cannot clear marker");
      await fs.writeFile(authFile, old);
      await sandbox.syncCurrentAuthToStoredAccount();
      assert.equal((await sandbox.readIndex()).accounts.find((item) => item.id === record.id).needsReauth, true, "unchanged active file is not proof of login");
      await fs.writeFile(authFile, aNew);
    }
    // Newer files also cannot silently clear a known invalid-login marker.
    await fs.writeFile(selectedFile, await encryptPortableCredentials({ auth: auth("b", "2026-09-23T00:00:00Z", "latest"), displayName: "b" }, password));
    const selection = await sandbox.selectPortableCredentials();
    await sandbox.importPortableCredentials(password, selection.selectionId);
    assert.equal((await sandbox.readIndex()).accounts.find((item) => item.id === records.b.id).needsReauth, true);
    await fs.writeFile(authFile, auth("b", "2026-09-24T00:00:00Z", "official-new-login"));
    await sandbox.syncCurrentAuthToStoredAccount();
    assert.equal((await sandbox.readIndex()).accounts.find((item) => item.id === records.b.id).needsReauth, undefined, "a refreshed live token can clear marker");

    // Re-login and active-account deletion share the stop-before-auth-write rule.
    let stops = 0;
    sandbox.stopCodexApp = async () => { stops++; assert.ok(await fs.stat(authFile)); running = false; };
    sandbox.startCodexApp = async () => { await assert.rejects(fs.stat(authFile), { code: "ENOENT" }); };
    await sandbox.startAccountReauth(records.b.id);
    assert.equal(stops, 1);
    await fs.writeFile(authFile, bNew);
    await sandbox.deleteAccount(records.b.id);
    assert.equal(stops, 2);
    assert.equal((await sandbox.readIndex()).accounts.some((item) => item.id === records.b.id), false);

    // Recovery must share the real account-operation queue with manual mutations.
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const order = [];
    const first = sandbox.runAccountOperation(async () => { order.push("check"); await gate; order.push("send"); });
    const second = sandbox.runAccountOperation(async () => { order.push("switch"); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["check"]); release(); await Promise.all([first, second]);
    assert.deepEqual(order, ["check", "send", "switch"]);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codexauth-safety-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function recovery(stage) {
  let active = "a", stored = null, sends = 0, resumes = 0, locked = false, controller;
  const accounts = ["a", "b", "c"].map((id) => ({ id, identity: { userId: "shared-workspace", subject: `person-${id}` }, quotaSnapshot: {
    schemaVersion: 2, source: "local", checkedAt: new Date(NOW).toISOString(),
    session: { usedPercent: id === "a" ? 100 : 20, resetsAt: NOW / 1000 + 7200 }, weekly: { usedPercent: 20, resetsAt: NOW / 1000 + 86400 },
  } }));
  const result = { thread: { id: "task", kind: "codex", hostId: "local", status: { type: "systemError" } },
    turns: [{ id: "failure", status: "failed", completedAt: NOW / 1000, error: { codexErrorInfo: "usageLimitExceeded" } }] };
  if (stage === "goal") result.goal = { threadId: "task", goalId: "g", objectiveHash: "g", status: "usageLimited", tokenBudget: 10000, tokensUsed: 20, timeUsedSeconds: 10, createdAt: NOW - 60000, updatedAt: NOW };
  const bridge = {
    reset() {}, listThreads: async () => ({ threads: [{ ...result.thread, updatedAt: NOW / 1000 }] }),
    readThread: async () => clone(result), listGoals: async () => result.goal ? [result.goal] : [],
    readUsage: async () => {
      assert.equal(locked, true);
      if (stage === "usage") active = "c"; // Same workspace, different person.
      if (stage === "manual") controller.invalidate();
      return { accountId: "shared-workspace", ordinaryUsageAllowed: true };
    },
    resumeGoal: async (_id, _goal, allowed) => {
      assert.equal(locked, true); active = "c";
      assert.equal(await allowed(), false); resumes++;
    },
    continueThread: async (_id, _prompt, beforeSend) => {
      assert.equal(locked, true);
      if (stage === "dispatch") active = "c";
      await beforeSend(); sends++;
    },
  };
  const deps = { now: () => NOW, bridge, getAnchor: async () => "task", getAccounts: async () => ({ accounts, activeAccountId: active }),
    loadJournal: async () => stored, saveJournal: async (value) => { stored = clone(value); },
    beforeSwitch: async () => "elapsed", switchAccount: async (id) => { active = id; },
    runAccountOperation: async (task) => { assert.equal(locked, false); locked = true; try { return await task(); } finally { locked = false; } },
  };
  controller = createAutoRecovery(deps); controller.configure(true, NOW - 1000);
  await controller.tick(); assert.equal(active, "b");
  await controller.tick();
  assert.equal(sends, stage === "normal" ? 1 : 0, stage);
  if (stage === "goal") assert.equal(resumes, 1);
  if (stage !== "normal") {
    assert.equal(stored.pending, null, "changed account retires the batch");
    active = "b"; await controller.tick(); assert.equal(sends, 0, "returning to B never replays cancelled work");
  }
}

async function dispatchGuard() {
  let allowed = true, requests = 0;
  const bridge = createDesktopBridge({ platform: "win32", env: {}, listPipes: async () => ["codex-browser-use-00000000-0000-0000-0000-000000000001"],
    request: async (_pipe, method) => {
      if (method === "tools/list") {
        allowed = false;
        return { tools: ["read_thread", "list_threads", "get_usage_limits", "send_message_to_thread"].map((name) => ({ name, namespace: "codex_app" })) };
      }
      requests++; throw new Error("should not dispatch");
    } });
  await assert.rejects(bridge.continueThread("task", "continue", async () => { if (!allowed) throw new Error("account changed"); }), /account changed/);
  assert.equal(requests, 0, "recheck after endpoint discovery");
  const net = require("node:net");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\codexauth-safety-${process.pid}` : path.join(os.tmpdir(), `codexauth-safety-${process.pid}.sock`);
  let bytes = 0;
  const server = net.createServer((socket) => { socket.on("data", (data) => { bytes += data.length; }); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  try {
    await assert.rejects(pipeRequest(endpoint, "tools/call", {}, 1000, async () => { throw new Error("changed at connect"); }));
    assert.equal(bytes, 0, "socket sends no bytes when identity check fails at connection time");
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

(async () => {
  await storage();
  for (const stage of ["normal", "usage", "goal", "manual", "dispatch"]) await recovery(stage);
  await dispatchGuard();
  console.log("Account safety passed: stop-before-write, final snapshot, running-client refusal, guarded continuation, shared-workspace identities, import rollback warnings and persistent reauth markers.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
