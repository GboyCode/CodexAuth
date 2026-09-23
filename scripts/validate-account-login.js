const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createAccountLogin, cleanupLoginHomes, officialLoginUrl, loginEnvironment } = require("../src/account-login");
const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("fixture timeout"); await wait(); }
}
const url = "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture";
function credential(id, revision = "new") {
  const claims = { sub: `person-${id}`, email: `${id}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" } };
  return JSON.stringify({ auth_mode: "chatgpt", last_refresh: "2026-09-23T00:00:00Z", tokens: {
    access_token: `fake-access-${id}-${revision}`, refresh_token: `fake-refresh-${id}-${revision}`,
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fake`,
  } });
}

async function lifecycle(root) {
  let child, helperHome, imports = 0, opens = 0, starts = 0, stopped = false, seenArgs, seenEnv, failStart = false;
  const methods = [];
  const spawnProcess = (_exe, args, options) => {
    starts++; stopped = false; seenArgs = args; seenEnv = options.env; helperHome = options.cwd;
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { stopped = true; setImmediate(() => child.emit("exit", 0)); return true; };
    child.stdin.on("data", (data) => {
      for (const line of data.toString().trim().split("\n")) {
        const message = JSON.parse(line); methods.push(message.method);
        if (message.id) setImmediate(() => child.stdout.write(`${JSON.stringify({ id: message.id,
          ...(failStart && message.method === "account/login/start" ? { error: { message: "SECRET-MUST-NOT-LEAK" } }
            : { result: message.method === "account/login/start" ? { type: "chatgpt", loginId: "fixture-login", authUrl: url } : {} }) })}\n`));
      }
    });
    return child;
  };
  const manager = createAccountLogin({ root, resolveExecutable: async () => "fake-codex", spawnProcess, timeoutMs: 120,
    openExternal: async (value) => { assert.equal(value, url); opens++; },
    importAccount: async (content, label) => { assert.equal(stopped, true); assert.equal(content, credential("b")); assert.equal(label, "新账号"); imports++; return {}; },
  });
  manager.start("新账号"); manager.start("ignored duplicate");
  await until(() => manager.getState().state === "waiting");
  assert.equal(starts, 1); assert.equal(opens, 1);
  assert.equal(seenEnv.CODEX_HOME, helperHome); assert.notEqual(helperHome, process.env.CODEX_HOME);
  assert.ok(seenArgs.includes('cli_auth_credentials_store="file"'));
  assert.equal((await fs.readFile(path.join(helperHome, "config.toml"), "utf8")).includes('cli_auth_credentials_store = "file"'), true);
  assert.equal(manager.getState().authUrl, undefined); assert.equal(manager.getState().loginId, undefined);
  await manager.reopen(); assert.equal(opens, 2);
  child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "another-login", success: true } })}\n`);
  await wait(); assert.equal(imports, 0, "ignore other login IDs");
  await fs.writeFile(path.join(helperHome, "auth.json"), credential("b"));
  child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "fixture-login", success: true } })}\n`);
  await until(() => !manager.isBusy());
  assert.equal(manager.getState().state, "done"); assert.equal(imports, 1);
  assert.deepEqual(await fs.readdir(root), []);
  assert.ok(methods.every((method) => ["initialize", "initialized", "account/login/start"].includes(method)), "never run model work or logout");

  manager.start("新账号"); await until(() => manager.getState().state === "waiting");
  await fs.writeFile(path.join(helperHome, "auth.json"), credential("b"));
  await manager.cancel();
  assert.equal(manager.getState().state, "cancelled"); assert.equal(imports, 1);
  assert.deepEqual(await fs.readdir(root), []);
  manager.start("新账号"); await until(() => manager.getState().state === "waiting");
  await until(() => !manager.isBusy());
  assert.match(manager.getState().message, /超时/); assert.equal(imports, 1);
  assert.deepEqual(await fs.readdir(root), []);
  failStart = true; manager.start("新账号"); await until(() => !manager.isBusy());
  assert.equal(manager.getState().state, "error");
  assert.ok(!JSON.stringify(manager.getState()).includes("SECRET")); assert.deepEqual(await fs.readdir(root), []);
  failStart = false; manager.start("新账号"); await manager.shutdown();
  assert.equal(manager.isBusy(), false); assert.deepEqual(await fs.readdir(root), []);
  const stale = path.join(root, "login-abandoned"); await fs.mkdir(stale); await fs.writeFile(path.join(stale, "auth.json"), "fake abandoned credential");
  await fs.writeFile(path.join(root, "keep.txt"), "unrelated"); await cleanupLoginHomes(root);
  assert.deepEqual(await fs.readdir(root), ["keep.txt"]);
}

async function storage(root) {
  const home = path.join(root, "real-home"); await fs.mkdir(home);
  const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
  const sandbox = vm.createContext({ require: (name) => name === "electron" ? {
    app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => root },
  } : name === "node:child_process" ? { spawn() { throw new Error("unexpected process"); } } : realRequire(name),
    __dirname: path.dirname(filename), process: { ...process, env: { ...process.env, CODEX_HOME: home } },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(await fs.readFile(filename, "utf8"), sandbox);
  sandbox.protectText = async (value) => `VAULT:${Buffer.from(value).toString("base64")}`;
  sandbox.unprotectText = async (value) => Buffer.from(value.trim().slice(6), "base64").toString();
  await sandbox.ensureStoreDirs();
  const original = credential("a", "active"), authPath = path.join(home, "auth.json"), configPath = path.join(home, "config.toml");
  await fs.writeFile(authPath, original); await fs.writeFile(configPath, 'model = "keep"\n');
  const record = sandbox.createAccountRecord({ content: original, ...sandbox.validateAuthJson(original) }, "active", "2026-09-20T00:00:00Z");
  await sandbox.saveAccountAuth(record.id, original);
  await sandbox.writeIndex({ accounts: [record], activeAccountId: record.id, settings: {} });
  await sandbox.saveLoggedInAccount(credential("b"), "second");
  let index = await sandbox.readIndex();
  assert.equal(index.accounts.length, 2); assert.equal(index.activeAccountId, record.id);
  const second = index.accounts.find((item) => item.id !== record.id);
  assert.equal(second.lastSwitchedAt, null); assert.equal(await sandbox.loadAccountAuth(second.id), credential("b"));
  assert.ok(!(await fs.readFile(sandbox.accountBlobPath(second.id), "utf8")).includes("fake-refresh"));
  second.needsReauth = true; await sandbox.writeIndex(index);
  await sandbox.saveLoggedInAccount(credential("b", "refreshed"), "");
  index = await sandbox.readIndex(); assert.equal(index.accounts.length, 2);
  assert.equal(index.accounts.find((item) => item.id === second.id).needsReauth, undefined);
  assert.equal((await sandbox.saveLoggedInAccount(credential("a", "separate-login"), "")).alreadyActive, true);
  assert.equal(await sandbox.loadAccountAuth(record.id), original);
  assert.equal(await fs.readFile(authPath, "utf8"), original);
  assert.equal(await fs.readFile(configPath, "utf8"), 'model = "keep"\n');
  const before = await sandbox.loadAccountAuth(second.id), writeIndex = sandbox.writeIndex;
  sandbox.writeIndex = async () => { throw new Error("fixture storage error"); };
  await assert.rejects(sandbox.saveLoggedInAccount(credential("b", "failed"), ""), /storage error/);
  assert.equal(await sandbox.loadAccountAuth(second.id), before, "failed index write restores saved credential");
  const fileCount = (await fs.readdir(sandbox.accountsDir())).length;
  await assert.rejects(sandbox.saveLoggedInAccount(credential("c"), ""));
  assert.equal((await fs.readdir(sandbox.accountsDir())).length, fileCount, "failed new import leaves no orphan credential");
  sandbox.writeIndex = writeIndex;
}

(async () => {
  assert.equal(officialLoginUrl(url), url);
  for (const bad of ["http://auth.openai.com/login", "https://auth.openai.com.evil.test", "https://evil.test", "file:///tmp/login", "https://user:pass@chatgpt.com/login", "https://auth.openai.com/login?redirect_uri=https://evil.test/callback"]) assert.throws(() => officialLoginUrl(bad));
  assert.deepEqual(loginEnvironment("isolated", { PATH: "bin", CODEX_HOME: "real", CODEX_ACCESS_TOKEN: "secret", OPENAI_API_KEY: "secret", CODEX_APP_TOOLS_PIPE_PATH: "real-pipe", CHATGPT_TOKEN: "secret" }), { PATH: "bin", CODEX_HOME: "isolated" });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-login-test-"));
  try { await lifecycle(path.join(root, "sessions")); await storage(root); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codexauth-login-test-")); await fs.rm(root, { recursive: true, force: true });
  }
  console.log("Account login passed: isolated home/environment, official URL guard, success/import, duplicate/current identity, cancellation, timeout, cleanup and encrypted rollback.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
