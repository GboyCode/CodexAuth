const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { resolveGoalExecutable } = require("./codex-goals");

function loginEnvironment(home, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(CODEX_|CHATGPT_|OPENAI_)/i.test(key)));
  return { ...env, CODEX_HOME: home };
}

function officialLoginUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== "443")) throw new Error("不兼容的官方登录地址。");
  const callback = url.searchParams.get("redirect_uri");
  if (callback) {
    const local = new URL(callback);
    if (local.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)
      || local.username || local.password || local.pathname !== "/auth/callback") throw new Error("不兼容的登录回调地址。");
  }
  return url.href;
}

async function resolveLoginExecutable() {
  if (process.platform === "win32") {
    try { return await resolveGoalExecutable(); } catch { /* Show a login-specific error. */ }
  } else if (process.platform === "darwin") {
    for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const app of ["Codex.app", "ChatGPT.app"]) {
        for (const name of ["codex", "bin/codex"]) {
          const candidate = path.join(base, app, "Contents", "Resources", name);
          try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* Next supported location. */ }
        }
      }
    }
  }
  throw new Error("未找到 Codex 登录程序，请先安装或更新 Codex 桌面版。");
}

async function removeLoginHome(root, home) {
  if (path.dirname(path.resolve(home)) !== path.resolve(root) || !/^login-[A-Za-z0-9_-]+$/.test(path.basename(home))) {
    throw new Error("无效的临时登录目录。");
  }
  // rm removes links themselves; it must never traverse outside this owned root.
  await fs.rm(home, { recursive: true, force: true });
}

async function cleanupLoginHomes(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (/^login-[A-Za-z0-9_-]+$/.test(entry.name)) await removeLoginHome(root, path.join(root, entry.name));
  }
}

function createAccountLogin({ root, importAccount, openExternal, onChange = () => {},
  resolveExecutable = resolveLoginExecutable, spawnProcess = spawn, timeoutMs = 5 * 60 * 1000, requestTimeoutMs = 15000 }) {
  let active = null;
  let status = { state: "idle", message: "在官方页面登录，完成后自动添加；当前 Codex 登录保持不变。" };
  const publish = (state, message) => { status = { state, message }; onChange(); };
  const getState = () => ({ ...status, canCancel: !!active && ["starting", "waiting"].includes(status.state),
    canOpen: !!active?.url && status.state === "waiting" });

  async function run(job) {
    let home, child, timer, sequence = 0, buffer = "", exitPromise, exited = false, intentionalExit = false;
    const pending = new Map();
    const interrupted = () => { if (job.cancelled) throw new Error("cancelled"); };
    let complete;
    const completed = new Promise((resolve) => { complete = resolve; });
    const notifications = [];
    const failRequests = () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("登录接口不可用，请重试或更新 Codex。")); }
      pending.clear();
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      if (!child || exited || job.cancelled) return reject(new Error("登录已结束。"));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("登录接口响应超时，请重试。")); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    const stop = async () => {
      if (!child || exited) return;
      intentionalExit = true;
      child.stdin.end(); child.kill(); failRequests();
      let exitTimer;
      try {
        await Promise.race([exitPromise, new Promise((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error("登录程序尚未退出，请关闭 CodexAuth 后重试。")), 5000);
        })]);
      } finally { clearTimeout(exitTimer); }
    };
    job.interrupt = () => { complete({ cancelled: true }); failRequests(); };
    let outcome = ["error", "登录未完成，请重试。"];
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const executable = await resolveExecutable(); interrupted();
      home = await fs.mkdtemp(path.join(root, "login-"));
      await fs.writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n', { mode: 0o600 });
      interrupted();
      child = spawnProcess(executable, ["-c", 'cli_auth_credentials_store="file"', "app-server", "--listen", "stdio://"], {
        windowsHide: true, cwd: home, env: loginEnvironment(home), stdio: ["pipe", "pipe", "ignore"],
      });
      exitPromise = new Promise((resolve) => {
        const exit = () => { exited = true; failRequests(); if (!intentionalExit) complete({ failed: true }); resolve(); };
        child.once("error", exit); child.once("exit", exit);
      });
      child.stdin.on("error", () => { failRequests(); complete({ failed: true }); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) { complete({ failed: true }); failRequests(); return; }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          const item = pending.get(message.id);
          if (item) {
            pending.delete(message.id); clearTimeout(item.timer);
            if (message.error) item.reject(new Error("Codex 未能发起登录，请关闭其他登录页面后重试。"));
            else item.resolve(message.result);
          } else if (message.method === "account/login/completed") {
            const result = message.params;
            if (job.loginId && result?.loginId === job.loginId) complete(result);
            else if (!job.loginId && notifications.length < 8) notifications.push(result);
          }
        }
      });
      await request("initialize", { clientInfo: { name: "codexauth_account_login", version: "1" }, capabilities: {} });
      interrupted();
      child.stdin.write('{"method":"initialized"}\n');
      const result = await request("account/login/start", { type: "chatgpt" });
      interrupted();
      if (result?.type !== "chatgpt" || typeof result.loginId !== "string" || !result.loginId) throw new Error("Codex 登录接口不兼容，请更新 Codex。");
      job.loginId = result.loginId;
      job.url = officialLoginUrl(result.authUrl);
      for (const notification of notifications) if (notification?.loginId === job.loginId) complete(notification);
      timer = setTimeout(() => { job.timedOut = true; job.cancelled = true; job.interrupt(); }, timeoutMs);
      publish("waiting", "请在官方页面选择要添加的账号并登录，完成后会自动导入。" );
      await openExternal(job.url); interrupted();
      const login = await completed;
      interrupted();
      if (login?.success !== true || login.loginId !== job.loginId) throw new Error("官方登录未完成，请重试；需要的验证码或工作区授权请在官方页面完成。");
      clearTimeout(timer);
      // Stop the isolated writer before consuming the final file. No logout:
      // logging out could invalidate the credential we are about to save.
      await stop(); interrupted();
      const file = await fs.open(path.join(home, "auth.json"), "r");
      let content;
      try {
        if ((await file.stat()).size > 1024 * 1024) throw new Error("登录凭证格式异常。");
        content = await file.readFile("utf8");
      } finally { await file.close(); }
      interrupted();
      publish("importing", "登录成功，正在加密保存账号…");
      const saved = await importAccount(content, job.label);
      content = null;
      outcome = ["done", saved.alreadyActive ? "登录的是当前账号，已保留当前凭证，无需重复添加。" : "账号已添加，可在列表中选择切换；当前 Codex 登录未改变。"];
    } catch {
      outcome = job.timedOut ? ["error", "登录已超时，请点击“登录并添加”重试。"]
        : job.cancelled ? ["cancelled", "已取消登录，当前 Codex 登录未改变。"]
          : ["error", "登录或保存未完成，请重试。请确认 Codex 已安装，并关闭其他尚未完成的 Codex 登录流程。"];
    } finally {
      clearTimeout(timer);
      try { await stop(); if (home) await removeLoginHome(root, home); }
      catch { outcome = ["error", "临时登录数据清理未完成，请退出并重新打开 CodexAuth。"]; }
      failRequests(); job.url = null;
      if (active === job) active = null;
      publish(...outcome);
    }
  }
  return {
    getState, isBusy: () => active !== null,
    start(label) {
      if (active) return getState();
      const job = { label: typeof label === "string" ? label.trim().slice(0, 200) : "", cancelled: false };
      active = job; publish("starting", "正在打开官方登录…");
      job.done = run(job);
      return getState();
    },
    async reopen() { if (active?.url && status.state === "waiting") await openExternal(officialLoginUrl(active.url)); return getState(); },
    async cancel() {
      const job = active;
      if (!job || status.state === "importing") return getState();
      job.cancelled = true; job.interrupt?.(); await job.done;
      return getState();
    },
    async shutdown() {
      const job = active;
      if (!job) return;
      if (status.state !== "importing") { job.cancelled = true; job.interrupt?.(); }
      await job.done;
    },
  };
}

module.exports = { createAccountLogin, cleanupLoginHomes, resolveLoginExecutable, officialLoginUrl, loginEnvironment };
