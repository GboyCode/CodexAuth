// The desktop app-tools pipe is a version-dependent local interface. Never fall
// back to a separate CLI session: that would lose the desktop's tool routing.
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUIRED_TOOLS = ["read_thread", "list_threads", "send_message_to_thread", "get_usage_limits"];

function pipeRequest(pipePath, method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Codex 本地接口响应超时。")), timeoutMs);
    socket.on("error", () => finish(new Error("Codex 本地接口连接失败。")));
    socket.on("close", () => finish(new Error("Codex 本地接口已断开。")));
    socket.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
      if (body.length > MAX_FRAME_BYTES) return finish(new Error("Codex 本地请求过大。"));
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return finish(new Error("Codex 本地响应过大。"));
      if (buffer.length < length + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        if (message.id !== 1 || message.jsonrpc !== "2.0") throw new Error();
        // Do not put arbitrary native error text (possibly containing auth data) in UI/logs.
        if (message.error) return finish(new Error("Codex 拒绝了本地任务接口请求。"));
        finish(null, message.result);
      } catch { finish(new Error("Codex 本地接口返回了不兼容的数据。")); }
    });
  });
}

function parseToolResult(result) {
  if (result?.success !== true) throw new Error("Codex 未完成任务接口操作，请在 Codex 中查看任务状态。" );
  for (const item of result.contentItems ?? []) {
    if (item.type !== "inputText") continue;
    try { return JSON.parse(item.text); } catch { /* Try the next structured item. */ }
  }
  throw new Error("Codex 任务接口返回格式不兼容。" );
}

function createDesktopBridge({ request = pipeRequest, platform = process.platform, env = process.env, goals } = {}) {
  let endpoint = null;
  async function discover() {
    // This adapter is currently verified only against the Windows desktop pipe.
    if (platform !== "win32") throw new Error("自动续任务目前仅支持 Windows Codex 桌面版。" );
    const candidates = new Set();
    if (env.CODEX_APP_TOOLS_PIPE_PATH?.startsWith("\\\\.\\pipe\\codex-browser-use-")) {
      candidates.add(env.CODEX_APP_TOOLS_PIPE_PATH);
    }
    const names = await fs.readdir("\\\\.\\pipe\\");
    for (const name of names) {
      if (/^codex-browser-use-[0-9a-f-]{36}$/i.test(name)) candidates.add(`\\\\.\\pipe\\${name}`);
    }
    const matches = (await Promise.all([...candidates].map(async (candidate) => {
      try {
        const result = await request(candidate, "tools/list", { threadStartKind: "all" }, 1500);
        return REQUIRED_TOOLS.every((name) => result?.tools?.some((tool) => tool.name === name && tool.namespace === "codex_app")) ? candidate : null;
      } catch { return null; }
    }))).filter(Boolean);
    if (matches.length !== 1) throw new Error(matches.length > 1
      ? "检测到多个 Codex 桌面实例，无法确定要恢复的实例。"
      : "未连接到兼容的 Codex 桌面版，请打开 Codex 并保持任务窗口可用。" );
    endpoint = matches[0];
    return endpoint;
  }
  async function call(tool, args, threadId) {
    if (!endpoint) await discover();
    try {
      return parseToolResult(await request(endpoint, "tools/call", {
        namespace: "codex_app", tool, arguments: args, threadId,
        callId: `codexauth-${crypto.randomUUID()}`, turnId: "codexauth-auto-recovery",
      }, 15000));
    } catch (error) {
      endpoint = null;
      // In particular, never retry send_message_to_thread after an uncertain response.
      throw error;
    }
  }
  return {
    discover,
    reset: () => { endpoint = null; },
    readThread: async (id) => {
      const result = await call("read_thread", { threadId: id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }, id);
      return { thread: result.thread, goal: goals ? await goals.readGoal(id) : null,
        turns: (result.turns ?? []).map(({ id, status, error, startedAt, completedAt }) => ({ id, status, error, startedAt, completedAt })) };
    },
    listThreads: (anchor) => call("list_threads", { limit: 50 }, anchor),
    readUsage: (anchor) => call("get_usage_limits", {}, anchor),
    continueThread: (id, prompt) => call("send_message_to_thread", { threadId: id, hostId: "local", prompt }, id),
    listGoals: () => goals ? goals.listGoals() : Promise.resolve([]),
    resumeGoal: (id, expected, allowed) => {
      if (!goals) throw new Error("当前版本未连接目标恢复接口。");
      return goals.resumeGoal(id, expected, allowed);
    },
  };
}

// Only metadata is read; credentials and conversation contents stay out of this query.
async function readLocalThreadAnchor(codexHome) {
  return (await readLocalThreadMetadata(codexHome))[0]?.id ?? null;
}

async function readLocalThreadMetadata(codexHome) {
  const names = (await fs.readdir(codexHome)).filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!names.length) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(codexHome, names[0]), { readOnly: true });
  try { return db.prepare("SELECT id, updated_at AS updatedAt FROM threads WHERE archived = 0 ORDER BY updated_at DESC").all(); }
  finally { db.close(); }
}

module.exports = { createDesktopBridge, pipeRequest, parseToolResult, readLocalThreadAnchor, readLocalThreadMetadata };
