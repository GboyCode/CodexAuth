const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  shell,
  session: electronSession,
} = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const APP_NAME = "CodexAuth Switch";
const APP_ID = "local.codexauth.switch";
const STORE_DIR_NAME = "codex-auth-switcher";
const STORE_VERSION = 1;
const isWindows = process.platform === "win32";
const WIDGET_WIDTH = 340;
const WIDGET_MIN_WIDTH = 300;
const WIDGET_MAX_WIDTH = 620;
const WIDGET_BASE_HEIGHT = 420;
const WIDGET_ACCOUNT_ROW_DELTA = 49;
const WIDGET_MIN_ACCOUNT_ROWS = 2;
const WIDGET_MAX_ACCOUNT_ROWS = 4;
const WIDGET_MIN_HEIGHT = WIDGET_BASE_HEIGHT + (WIDGET_MIN_ACCOUNT_ROWS - 1) * WIDGET_ACCOUNT_ROW_DELTA;
const WIDGET_MAX_HEIGHT = 900;
const VALID_RESIZE_EDGES = new Set(["n", "e", "s", "w", "ne", "se", "sw", "nw"]);

let mainWindow;
let widgetWindow;
let tray;
let isQuitting = false;
let widgetManualSize = false;
let widgetResizeSession = null;
let authWatcher;
let authSyncTimer;
let authSyncInterval;
let localLogWatcher;
let localLogRefreshTimer;
let localLogRefreshInFlight = false;
let localLogRefreshPending = false;
let sessionsWatcher;
let sessionsPollingInterval;
let lastKnownLogsMtimeMs = 0;
let indexMutationQueue = Promise.resolve();
const sessionParseCache = new Map();
const quotaEventParseCache = new Map();
const sqliteResponseEventCache = new Map();
const reauthCheckTimers = new Map();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function codexDir() {
  return path.join(os.homedir(), ".codex");
}

function authPath() {
  return path.join(codexDir(), "auth.json");
}

function sessionsDir() {
  return path.join(codexDir(), "sessions");
}

function sessionIndexPath() {
  return path.join(codexDir(), "session_index.jsonl");
}

function logsDbPath() {
  return path.join(codexDir(), "logs_2.sqlite");
}

function logsDbWalPath() {
  return `${logsDbPath()}-wal`;
}

function logsDbShmPath() {
  return `${logsDbPath()}-shm`;
}

function storeRoot() {
  return path.join(app.getPath("appData"), STORE_DIR_NAME);
}

function indexPath() {
  return path.join(storeRoot(), "accounts.json");
}

function accountsDir() {
  return path.join(storeRoot(), "accounts");
}

function accountBlobPath(id) {
  return path.join(accountsDir(), `${id}.dpapi`);
}

function backupsDir() {
  return path.join(storeRoot(), "backups");
}

function appIconPngPath() {
  return path.join(__dirname, "ui", "assets", "codex-color.png");
}

function appIconIcoPath() {
  return path.join(__dirname, "ui", "assets", "codex-color.ico");
}

function trayIconIcoPath() {
  return path.join(__dirname, "ui", "assets", "codex-color-tray.ico");
}

function widgetHeightForAccounts(accountCount) {
  const count = Number.isFinite(Number(accountCount)) ? Number(accountCount) : 0;
  const visibleRows = Math.max(WIDGET_MIN_ACCOUNT_ROWS, Math.min(WIDGET_MAX_ACCOUNT_ROWS, count || WIDGET_MIN_ACCOUNT_ROWS));
  return WIDGET_BASE_HEIGHT + (visibleRows - 1) * WIDGET_ACCOUNT_ROW_DELTA;
}

async function ensureStoreDirs() {
  await fs.mkdir(accountsDir(), { recursive: true });
  await fs.mkdir(backupsDir(), { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${crypto.randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
}

async function readIndex() {
  const fallback = { version: STORE_VERSION, activeAccountId: null, accounts: [], deletedIdentityKeys: [] };
  const data = await readJson(indexPath(), fallback);
  return {
    version: STORE_VERSION,
    activeAccountId: data.activeAccountId ?? null,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    deletedIdentityKeys: Array.isArray(data.deletedIdentityKeys) ? data.deletedIdentityKeys : [],
  };
}

async function writeIndex(index) {
  await writeJsonAtomic(indexPath(), {
    version: STORE_VERSION,
    activeAccountId: index.activeAccountId ?? null,
    accounts: index.accounts,
    deletedIdentityKeys: Array.isArray(index.deletedIdentityKeys) ? index.deletedIdentityKeys : [],
  });
}

async function waitForIndexMutations() {
  await indexMutationQueue.catch(() => {});
}

async function mutateIndex(mutator) {
  const previous = indexMutationQueue;
  let release;
  indexMutationQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    const index = await readIndex();
    const result = (await mutator(index)) ?? {};
    if (result.write !== false) {
      await writeIndex(index);
    }
    return result.value;
  } finally {
    release();
  }
}

function runPowerShell(script, stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()));
    });
    child.stdin.end(stdinText);
  });
}

async function protectText(plainText) {
  if (!isWindows) {
    throw new Error("Current build only supports Windows DPAPI storage.");
  }
  const input = Buffer.from(plainText, "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText.Trim())
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
  return runPowerShell(script, input);
}

async function unprotectText(cipherText) {
  if (!isWindows) {
    throw new Error("Current build only supports Windows DPAPI storage.");
  }
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText.Trim())
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;
  return runPowerShell(script, cipherText);
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

function nestedClaim(payload, key) {
  const nested = payload?.["https://api.openai.com/auth"];
  return typeof nested?.[key] === "string" ? nested[key] : null;
}

function extractIdentity(authJson) {
  const tokens = authJson?.tokens ?? {};
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const idPayload = decodeJwtPayload(tokens.id_token);
  const email =
    (typeof idPayload?.email === "string" && idPayload.email) ||
    nestedClaim(idPayload, "email") ||
    nestedClaim(accessPayload, "email") ||
    null;
  const userId =
    (typeof accessPayload?.chatgpt_account_id === "string" && accessPayload.chatgpt_account_id) ||
    nestedClaim(accessPayload, "chatgpt_account_id") ||
    (typeof idPayload?.chatgpt_account_id === "string" && idPayload.chatgpt_account_id) ||
    nestedClaim(idPayload, "chatgpt_account_id") ||
    null;
  const subject =
    (typeof idPayload?.sub === "string" && idPayload.sub) ||
    (typeof accessPayload?.sub === "string" && accessPayload.sub) ||
    null;
  const accountUserId =
    nestedClaim(accessPayload, "chatgpt_account_user_id") ||
    nestedClaim(idPayload, "chatgpt_account_user_id") ||
    null;
  const chatgptUserId =
    nestedClaim(accessPayload, "chatgpt_user_id") ||
    nestedClaim(idPayload, "chatgpt_user_id") ||
    nestedClaim(accessPayload, "user_id") ||
    nestedClaim(idPayload, "user_id") ||
    null;
  const planType =
    nestedClaim(accessPayload, "chatgpt_plan_type") ||
    nestedClaim(idPayload, "chatgpt_plan_type") ||
    null;
  return { email, userId, subject, accountUserId, chatgptUserId, planType };
}

function tokenExpirySeconds(token) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp : null;
}

function authTokenStatus(parsed) {
  const accessExp = tokenExpirySeconds(parsed?.tokens?.access_token);
  const accessTokenExpiresAt = accessExp ? new Date(accessExp * 1000).toISOString() : null;
  return {
    accessTokenExpiresAt,
    accessTokenExpired: accessExp ? accessExp * 1000 <= Date.now() : null,
  };
}

function validateAuthJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("auth.json is not valid JSON.");
  }

  if (parsed.auth_mode !== "chatgpt") {
    throw new Error("Only Codex App ChatGPT sign-in auth is supported in this app.");
  }
  const tokens = parsed.tokens ?? {};
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("auth.json is missing access_token or refresh_token.");
  }
  const identity = extractIdentity(parsed);
  if (!identity.email && !identity.userId && !identity.subject) {
    throw new Error("Cannot identify this Codex account from auth.json.");
  }
  return { parsed, identity };
}

function identityKey(identity) {
  // Business/workspace ids and person ids are not unique enough by themselves:
  // same Business workspace can have multiple people, and one person can belong to multiple workspaces.
  const personKey = identity.subject || identity.email || null;
  const workspaceKey = identity.userId || null;
  if (personKey && workspaceKey) return `${personKey}::${workspaceKey}`;
  return personKey || workspaceKey || null;
}

function safeAccountName(input, identity) {
  const fallback = identity.email || identity.userId || identity.subject || "Codex Account";
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed || fallback;
}

function createAccountRecord(auth, displayName, now) {
  const account = {
    id: crypto.randomUUID(),
    displayName,
    identity: auth.identity,
    createdAt: now,
    updatedAt: now,
    lastRefresh: authLastRefresh(auth.parsed),
    authFingerprint: fingerprint(auth.content),
    lastSwitchedAt: now,
  };
  Object.assign(account, authTokenStatus(auth.parsed));
  return account;
}

function fingerprint(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function readCurrentAuth() {
  const currentPath = authPath();
  const content = await fs.readFile(currentPath, "utf8");
  const validation = validateAuthJson(content);
  return { path: currentPath, content, ...validation };
}

async function loadAccountAuth(accountId) {
  const encrypted = await fs.readFile(accountBlobPath(accountId), "utf8");
  return unprotectText(encrypted);
}

async function saveAccountAuth(accountId, content) {
  await ensureStoreDirs();
  const encrypted = await protectText(content);
  await fs.writeFile(accountBlobPath(accountId), `${encrypted}\n`, { encoding: "utf8", mode: 0o600 });
}

function authLastRefresh(parsed) {
  return typeof parsed?.last_refresh === "string" ? parsed.last_refresh : null;
}

function markAccountAuthSnapshot(account, auth, content, now) {
  account.identity = auth.identity;
  account.updatedAt = now;
  account.lastRefresh = authLastRefresh(auth.parsed);
  account.authFingerprint = fingerprint(content);
  Object.assign(account, authTokenStatus(auth.parsed));
  delete account.needsReauth;
  delete account.reauthReason;
  delete account.reauthMarkedAt;
}

function normalizePublicAccount(account, activeId, currentIdentityKey) {
  const key = identityKey(account.identity ?? {});
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.identity?.email ?? null,
    userId: account.identity?.userId ?? null,
    subject: account.identity?.subject ?? null,
    accountUserId: account.identity?.accountUserId ?? null,
    chatgptUserId: account.identity?.chatgptUserId ?? null,
    planType: account.identity?.planType ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastRefresh: account.lastRefresh ?? null,
    accessTokenExpiresAt: account.accessTokenExpiresAt ?? null,
    accessTokenExpired: account.accessTokenExpired ?? null,
    needsReauth: account.needsReauth === true,
    reauthReason: account.reauthReason ?? null,
    reauthMarkedAt: account.reauthMarkedAt ?? null,
    lastSyncedAt: account.lastSyncedAt ?? null,
    lastSwitchedAt: account.lastSwitchedAt ?? null,
    quotaSnapshot: account.quotaSnapshot ?? null,
    quotaSnapshotUpdatedAt: account.quotaSnapshotUpdatedAt ?? null,
    isActive: account.id === activeId || (!!currentIdentityKey && key === currentIdentityKey),
  };
}

async function currentState() {
  await ensureStoreDirs();
  await waitForIndexMutations();
  const index = await readIndex();
  let current = null;
  let currentIdentityKey = null;
  try {
    const auth = await readCurrentAuth();
    currentIdentityKey = identityKey(auth.identity);
    current = {
      path: auth.path,
      exists: true,
      email: auth.identity.email,
      userId: auth.identity.userId,
      subject: auth.identity.subject,
      fingerprint: fingerprint(auth.content),
      ...authTokenStatus(auth.parsed),
    };
  } catch (error) {
    current = {
      path: authPath(),
      exists: await pathExists(authPath()),
      error: error.message,
    };
  }

  return {
    codexDir: codexDir(),
    authPath: authPath(),
    storeRoot: storeRoot(),
    current,
    accounts: index.accounts.map((account) =>
      normalizePublicAccount(account, index.activeAccountId, currentIdentityKey)
    ),
  };
}

async function importCurrentAccount(displayName) {
  const auth = await readCurrentAuth();
  const now = new Date().toISOString();
  const name = safeAccountName(displayName, auth.identity);
  const key = identityKey(auth.identity);
  await mutateIndex(async (index) => {
    index.deletedIdentityKeys = (index.deletedIdentityKeys ?? []).filter((item) => item !== key);
    let account = index.accounts.find((item) => identityKey(item.identity ?? {}) === key);
    if (!account) {
      account = createAccountRecord(auth, name, now);
      index.accounts.push(account);
    } else {
      account.displayName = name;
      markAccountAuthSnapshot(account, auth, auth.content, now);
    }

    await saveAccountAuth(account.id, auth.content);
    account.lastSyncedAt = now;
    index.activeAccountId = account.id;
  });
  return currentState();
}

async function backupCurrentAuth(content, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsDir(), `auth-${reason}-${stamp}.json.dpapi`);
  const encrypted = await protectText(content);
  await fs.writeFile(backupPath, `${encrypted}\n`, { encoding: "utf8", mode: 0o600 });
  return backupPath;
}

async function migratePlaintextBackups() {
  await ensureStoreDirs();
  let entries;
  try {
    entries = await fs.readdir(backupsDir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const source = path.join(backupsDir(), entry.name);
    const target = `${source}.dpapi`;
    try {
      const content = await fs.readFile(source, "utf8");
      const encrypted = await protectText(content);
      await fs.writeFile(target, `${encrypted}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rm(source, { force: true });
    } catch {
      // Keep the original file if encryption or deletion fails.
    }
  }
}

async function hydrateStoredAccountMetadata() {
  await mutateIndex(async (index) => {
    let changed = false;
    for (const account of index.accounts) {
      try {
        const content = await loadAccountAuth(account.id);
        const auth = validateAuthJson(content);
        const previous = JSON.stringify({
          identity: account.identity ?? null,
          lastRefresh: account.lastRefresh ?? null,
          accessTokenExpiresAt: account.accessTokenExpiresAt ?? null,
          accessTokenExpired: account.accessTokenExpired ?? null,
          authFingerprint: account.authFingerprint ?? null,
        });
        markAccountAuthSnapshot(account, { content, ...auth }, content, account.updatedAt ?? new Date().toISOString());
        const next = JSON.stringify({
          identity: account.identity ?? null,
          lastRefresh: account.lastRefresh ?? null,
          accessTokenExpiresAt: account.accessTokenExpiresAt ?? null,
          accessTokenExpired: account.accessTokenExpired ?? null,
          authFingerprint: account.authFingerprint ?? null,
        });
        if (previous !== next) changed = true;
      } catch {
        // Leave unreadable saved accounts untouched so the UI can still manage them.
      }
    }
    return changed ? {} : { write: false };
  });
}

async function atomicWriteAuth(content) {
  await fs.mkdir(codexDir(), { recursive: true });
  validateAuthJson(content);
  const target = authPath();
  const temp = path.join(codexDir(), `.auth.json.tmp-${crypto.randomUUID()}`);
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
}

async function refreshStoredActiveAccount(index) {
  if (!index.activeAccountId) return null;
  const active = index.accounts.find((account) => account.id === index.activeAccountId);
  if (!active) return null;

  try {
    const current = await readCurrentAuth();
    const currentKey = identityKey(current.identity);
    const activeKey = identityKey(active.identity ?? {});
    if (currentKey && activeKey && currentKey === activeKey) {
      await saveAccountAuth(active.id, current.content);
      const now = new Date().toISOString();
      markAccountAuthSnapshot(active, current, current.content, now);
      active.lastSyncedAt = now;
      return current.content;
    }
  } catch {
    return null;
  }
  return null;
}

async function syncCurrentAuthToStoredAccount() {
  await ensureStoreDirs();
  const current = await readCurrentAuth();
  const currentKey = identityKey(current.identity);
  if (!currentKey) return false;

  return mutateIndex(async (index) => {
    let account = index.accounts.find((item) => identityKey(item.identity ?? {}) === currentKey);
    let isNewAccount = false;
    const now = new Date().toISOString();
    if (!account) {
      if ((index.deletedIdentityKeys ?? []).includes(currentKey)) {
        return { value: false, write: false };
      }
      account = createAccountRecord(current, safeAccountName("", current.identity), now);
      account.autoImportedAt = now;
      index.accounts.push(account);
      isNewAccount = true;
    }

    const nextFingerprint = fingerprint(current.content);
    const nextLastRefresh = authLastRefresh(current.parsed);
    if (!isNewAccount && account.authFingerprint === nextFingerprint && account.lastRefresh === nextLastRefresh) {
      if (account.needsReauth === true) {
        markAccountAuthSnapshot(account, current, current.content, now);
        account.lastSyncedAt = now;
        index.activeAccountId = account.id;
        clearReauthCheck(account.id);
        return { value: true };
      }
      if (index.activeAccountId !== account.id) {
        index.activeAccountId = account.id;
        return { value: true };
      }
      return { value: false, write: false };
    }

    await saveAccountAuth(account.id, current.content);
    markAccountAuthSnapshot(account, current, current.content, now);
    account.lastSyncedAt = now;
    index.activeAccountId = account.id;
    clearReauthCheck(account.id);
    return { value: true };
  });
}

function clearReauthCheck(accountId) {
  const timer = reauthCheckTimers.get(accountId);
  if (timer) clearTimeout(timer);
  reauthCheckTimers.delete(accountId);
}

function scheduleReauthCheck(accountId, expectedFingerprint, expectedLastRefresh) {
  clearReauthCheck(accountId);
  const timer = setTimeout(async () => {
    reauthCheckTimers.delete(accountId);
    try {
      const changed = await mutateIndex(async (index) => {
        const account = index.accounts.find((item) => item.id === accountId);
        if (!account || index.activeAccountId !== accountId) return { value: false, write: false };

        try {
          const current = await readCurrentAuth();
          const currentKey = identityKey(current.identity);
          const accountKey = identityKey(account.identity ?? {});
          const status = authTokenStatus(current.parsed);
          if (currentKey && accountKey && currentKey === accountKey && status.accessTokenExpired !== true) {
            markAccountAuthSnapshot(account, current, current.content, new Date().toISOString());
            return { value: true };
          }
        } catch {
          // Fall through to the stale-snapshot check below.
        }

        const unchanged =
          account.authFingerprint === expectedFingerprint && account.lastRefresh === expectedLastRefresh;
        if (!unchanged) return { value: false, write: false };
        account.needsReauth = true;
        account.reauthReason = "切换后 Codex 没有写回新的登录快照，可能需要重新登录。";
        account.reauthMarkedAt = new Date().toISOString();
        return { value: true };
      });
      if (changed) broadcastStateChanged();
    } catch {
      // Reauth checks are best-effort and should not interrupt the app.
    }
  }, 45000);
  timer.unref?.();
  reauthCheckTimers.set(accountId, timer);
}

function scheduleAuthSync() {
  if (authSyncTimer) clearTimeout(authSyncTimer);
  authSyncTimer = setTimeout(async () => {
    authSyncTimer = null;
    try {
      const changed = await syncCurrentAuthToStoredAccount();
      if (changed) broadcastStateChanged();
    } catch {
      // The auth file can be temporarily missing or half-written while Codex updates it.
    }
  }, 500);
}

function shouldSyncAuthFile(filename) {
  if (!filename) return true;
  return String(filename).toLowerCase().includes("auth");
}

async function startAuthWatcher() {
  if (authWatcher) return;
  try {
    await fs.mkdir(codexDir(), { recursive: true });
    authWatcher = fsSync.watch(codexDir(), { persistent: false }, (_event, filename) => {
      if (shouldSyncAuthFile(filename)) {
        scheduleAuthSync();
      }
    });
    scheduleAuthSync();
    authSyncInterval = setInterval(scheduleAuthSync, 10000);
    authSyncInterval.unref?.();
  } catch {
    authWatcher = null;
  }
}

function shouldRefreshForLocalLog(filename) {
  const value = String(filename || "").toLowerCase();
  return value === "logs_2.sqlite" || value === "logs_2.sqlite-wal" || value === "logs_2.sqlite-shm";
}

function scheduleLocalLogRefresh() {
  if (localLogRefreshTimer) return;
  localLogRefreshTimer = setTimeout(() => {
    localLogRefreshTimer = null;
    refreshQuotaSnapshotFromLocalLog().catch(() => {});
  }, 2500);
  localLogRefreshTimer.unref?.();
}

async function refreshQuotaSnapshotFromLocalLog() {
  if (localLogRefreshInFlight) {
    localLogRefreshPending = true;
    return;
  }

  localLogRefreshInFlight = true;
  try {
    do {
      localLogRefreshPending = false;
      const scope = await dashboardScope();
      if (!scope.hasCurrentAuth || !scope.accountId) continue;
      const latestQuota = newerQuota(
        newerQuota(
          await readLatestLocalQuota({ since: scope.since }),
          await readLatestSqliteRateLimitQuota({ since: scope.since })
        ),
        await readLatestUsageLimitQuota({ since: scope.since })
      );
      const changed = await saveAccountQuotaSnapshot(scope.accountId, latestQuota);
      if (changed) broadcastStateChanged();
    } while (localLogRefreshPending);
  } catch {
    // Codex can write the sqlite database in bursts; the next file event will retry.
  } finally {
    localLogRefreshInFlight = false;
  }
}

async function startLocalLogWatcher() {
  if (localLogWatcher) return;
  try {
    await fs.mkdir(codexDir(), { recursive: true });
    localLogWatcher = fsSync.watch(codexDir(), { persistent: false }, (_event, filename) => {
      if (shouldRefreshForLocalLog(filename)) scheduleLocalLogRefresh();
    });
  } catch {
    localLogWatcher = null;
  }
}

// Watch the sessions directory for new/updated rollout-*.jsonl files.
// Codex writes rate_limits into these files during conversations, so watching
// them lets us pick up quota changes without needing a separate API call.
async function startSessionsWatcher() {
  if (sessionsWatcher) return;
  const dir = sessionsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    sessionsWatcher = fsSync.watch(dir, { persistent: false, recursive: true }, (_event, filename) => {
      const name = String(filename || "").toLowerCase();
      if (name.endsWith(".jsonl")) scheduleLocalLogRefresh();
    });
  } catch {
    sessionsWatcher = null;
  }
}

// Periodic polling fallback: checks if the sqlite log file has been updated
// since the last check. This catches writes that the filesystem watcher may
// miss (e.g. WAL checkpoints, or when Codex flushes records in the background
// without triggering a visible fs event on the parent directory).
// Runs every 15 seconds — low enough frequency to avoid any risk of triggering
// rate-limiting or appearing as automated API access.
async function startSessionsPolling() {
  if (sessionsPollingInterval) return;
  sessionsPollingInterval = setInterval(async () => {
    try {
      const dbPath = logsDbPath();
      const walPath = logsDbWalPath();
      let latestMtime = 0;
      for (const p of [dbPath, walPath]) {
        try {
          const stat = await fs.stat(p);
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch {
          // File may not exist yet.
        }
      }
      if (latestMtime > lastKnownLogsMtimeMs) {
        lastKnownLogsMtimeMs = latestMtime;
        scheduleLocalLogRefresh();
      }
    } catch {
      // Best-effort polling; errors are non-fatal.
    }
  }, 15000);
  sessionsPollingInterval.unref?.();
}

async function switchAccount(accountId, options = {}) {
  let reauthCheck = null;
  await mutateIndex(async (index) => {
    const target = index.accounts.find((account) => account.id === accountId);
    if (!target) {
      throw new Error("Account not found.");
    }

    const currentContent = await refreshStoredActiveAccount(index);
    if (currentContent) {
      await backupCurrentAuth(currentContent, "before-switch");
    } else if (await pathExists(authPath())) {
      try {
        const raw = await fs.readFile(authPath(), "utf8");
        await backupCurrentAuth(raw, "unmatched-before-switch");
      } catch {
        // Backup should not block switching if auth.json cannot be read.
      }
    }

    const targetContent = await loadAccountAuth(target.id);
    const validation = validateAuthJson(targetContent);
    await atomicWriteAuth(targetContent);
    const now = new Date().toISOString();
    Object.assign(target, authTokenStatus(validation.parsed));
    target.lastSwitchedAt = now;
    target.updatedAt = now;
    index.activeAccountId = target.id;
    delete target.needsReauth;
    delete target.reauthReason;
    delete target.reauthMarkedAt;
    reauthCheck = {
      accountId: target.id,
      fingerprint: target.authFingerprint,
      lastRefresh: target.lastRefresh ?? null,
    };
  });

  if (options.restartCodex === true) {
    await restartCodexApp();
  }

  if (reauthCheck) {
    scheduleReauthCheck(reauthCheck.accountId, reauthCheck.fingerprint, reauthCheck.lastRefresh);
  }

  return currentState();
}

async function startAccountReauth(accountId) {
  await mutateIndex(async (index) => {
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    clearReauthCheck(account.id);
    if (await pathExists(authPath())) {
      try {
        const raw = await fs.readFile(authPath(), "utf8");
        await backupCurrentAuth(raw, "before-reauth");
      } catch {
        // Backup should not block reauth.
      }
      await fs.rm(authPath(), { force: true });
    }
    const now = new Date().toISOString();
    account.needsReauth = true;
    account.reauthReason = "已清除当前本地登录，请在 Codex App 完成官方登录。";
    account.reauthMarkedAt = now;
    account.lastReauthStartedAt = now;
    index.activeAccountId = account.id;
  });
  await restartCodexApp();
  return currentState();
}

async function updateAccount(accountId, patch) {
  await mutateIndex(async (index) => {
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    if (typeof patch?.displayName === "string" && patch.displayName.trim()) {
      account.displayName = patch.displayName.trim();
      account.updatedAt = new Date().toISOString();
      return {};
    }
    return { write: false };
  });
  return currentState();
}

async function deleteAccount(accountId) {
  const result = await mutateIndex(async (index) => {
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");

    let removedCurrentAuth = false;
    const deletedKey = identityKey(account.identity ?? {});
    if (deletedKey) {
      try {
        const current = await readCurrentAuth();
        if (identityKey(current.identity) === deletedKey) {
          try {
            await backupCurrentAuth(current.content, "before-delete-account");
          } catch {
            // Backup should not block deletion.
          }
          await fs.rm(authPath(), { force: true });
          removedCurrentAuth = true;
        }
      } catch {
        // Missing or invalid current auth still allows deleting the saved account.
      }
    }

    clearReauthCheck(account.id);
    if (deletedKey) {
      index.deletedIdentityKeys = Array.from(new Set([...(index.deletedIdentityKeys ?? []), deletedKey]));
    }
    index.accounts = index.accounts.filter((item) => item.id !== accountId);
    if (index.activeAccountId === accountId) index.activeAccountId = null;
    await fs.rm(accountBlobPath(accountId), { force: true });
    return { value: { removedCurrentAuth } };
  });
  if (result?.removedCurrentAuth) {
    await restartCodexApp().catch(() => {});
  }
  return currentState();
}

async function restartCodexApp() {
  if (!isWindows) {
    throw new Error("Restart is currently implemented for Windows only.");
  }
  const script = `
$ErrorActionPreference = 'Stop'
$targets = Get-Process -Name 'Codex' -ErrorAction SilentlyContinue
if ($targets) { $targets | Stop-Process -Force }
Start-Sleep -Milliseconds 850
$pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg -and $pkg.InstallLocation) {
  $candidate = Join-Path $pkg.InstallLocation 'app\\Codex.exe'
  if (Test-Path $candidate) {
    Start-Process -FilePath $candidate
    exit 0
  }
}
$candidates = @(
  "$env:LOCALAPPDATA\\Microsoft\\WindowsApps\\Codex.exe",
  "$env:ProgramFiles\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0\\app\\Codex.exe"
)
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path $candidate)) {
    Start-Process -FilePath $candidate
    exit 0
  }
}
exit 0
`;
  await runPowerShell(script);
  return { ok: true };
}

function trayIcon() {
  const icon = nativeImage.createFromPath(isWindows ? trayIconIcoPath() : appIconPngPath());
  if (!icon.isEmpty() && isWindows) return icon;
  return icon.resize({ width: 16, height: 16 });
}

function identityLabel(accountLike) {
  if (!accountLike) return "未检测到登录";
  return accountLike.email || accountLike.userId || accountLike.subject || "未知账号";
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    createWidgetWindow();
  }
  widgetWindow.show();
  widgetWindow.focus();
}

function hideWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.hide();
  }
}

function toggleWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) {
    hideWidgetWindow();
    return;
  }
  showWidgetWindow();
}

function broadcastStateChanged() {
  for (const win of [mainWindow, widgetWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("state:changed");
    }
  }
  rebuildTrayMenu().catch(() => {});
}

async function rebuildTrayMenu() {
  if (!tray) return;
  let snapshot = null;
  try {
    snapshot = await currentState();
  } catch {
    snapshot = null;
  }
  const accounts = snapshot?.accounts ?? [];
  const currentLabel = snapshot?.current?.exists ? identityLabel(snapshot.current) : "未检测到登录";
  const accountItems = accounts.length
    ? accounts.map((account) => ({
        label: `${account.isActive ? "✓ " : ""}${account.displayName}`,
        enabled: !account.isActive,
        click: async () => {
          await switchAccount(account.id, { restartCodex: true });
          broadcastStateChanged();
        },
      }))
    : [{ label: "暂无已保存账号", enabled: false }];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: APP_NAME, enabled: false },
      { label: `当前：${currentLabel}`, enabled: false },
      { type: "separator" },
      { label: "打开主窗口", click: () => showMainWindow() },
      {
        label: widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible() ? "隐藏浮窗" : "显示浮窗",
        click: () => {
          toggleWidgetWindow();
          rebuildTrayMenu().catch(() => {});
        },
      },
      { type: "separator" },
      { label: "切换账号并重启", submenu: accountItems },
      { label: "重启 Codex App", click: () => restartCodexApp().catch(() => {}) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip(APP_NAME);
  tray.on("click", () => toggleWidgetWindow());
  rebuildTrayMenu().catch(() => {});
}

async function openPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  const allowedRoots = [storeRoot(), codexDir()].map((root) => path.resolve(root));
  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!isAllowed) {
    throw new Error("Path is outside allowed local app folders.");
  }
  await shell.openPath(resolved);
  return { ok: true };
}

function installNetworkGuards() {
  const filter = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
  electronSession.defaultSession.webRequest.onBeforeRequest(filter, (_details, callback) => {
    callback({ cancel: true });
  });
}

function hardenWindowNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!String(url).startsWith("file://")) event.preventDefault();
  });
}

function normalizeRateWindow(window) {
  if (!window) return null;
  const seconds = Number(window.limit_window_seconds ?? window.window_minutes * 60);
  const resetRaw = window.reset_at ?? window.resets_at;
  const resetsAt = resetRaw ? Number(resetRaw) : null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(Number(window.used_percent ?? 0)))),
    windowMinutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : null,
    resetsAt,
  };
}

function normalizeCredits(credits) {
  if (!credits) return null;
  return {
    hasCredits: credits.has_credits ?? null,
    unlimited: credits.unlimited ?? null,
    balance: credits.balance ?? null,
  };
}

function numberHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (value === undefined || value === null || value === "") return null;
  return String(value).toLowerCase() === "true";
}

function normalizeHeaderMap(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

async function walkSessionFiles(dir) {
  const result = [];
  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        const stat = await fs.stat(fullPath).catch(() => null);
        result.push({ path: fullPath, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 });
      }
    }
  }
  await walk(dir);
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readSessionIndexMap() {
  const map = new Map();
  try {
    const content = await fs.readFile(sessionIndexPath(), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id) map.set(entry.id, entry);
      } catch {
        // Skip partial or old index lines.
      }
    }
  } catch {
    return map;
  }
  return map;
}

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeTokenUsage(raw) {
  return {
    inputTokens: Number(raw?.input_tokens ?? raw?.inputTokens ?? 0),
    cachedInputTokens: Number(
      raw?.cached_input_tokens ?? raw?.cachedInputTokens ?? raw?.input_tokens_details?.cached_tokens ?? 0
    ),
    outputTokens: Number(raw?.output_tokens ?? raw?.outputTokens ?? 0),
    reasoningOutputTokens: Number(
      raw?.reasoning_output_tokens ?? raw?.reasoningOutputTokens ?? raw?.output_tokens_details?.reasoning_tokens ?? 0
    ),
    totalTokens: Number(raw?.total_tokens ?? raw?.totalTokens ?? 0),
  };
}

function addTokenUsage(total, usage) {
  total.inputTokens += usage.inputTokens;
  total.cachedInputTokens += usage.cachedInputTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningOutputTokens += usage.reasoningOutputTokens;
  total.totalTokens += usage.totalTokens;
}

function subtractTokenUsage(later, earlier) {
  const left = later ?? emptyTokenUsage();
  const right = earlier ?? emptyTokenUsage();
  return {
    inputTokens: Math.max(0, Number(left.inputTokens || 0) - Number(right.inputTokens || 0)),
    cachedInputTokens: Math.max(0, Number(left.cachedInputTokens || 0) - Number(right.cachedInputTokens || 0)),
    outputTokens: Math.max(0, Number(left.outputTokens || 0) - Number(right.outputTokens || 0)),
    reasoningOutputTokens: Math.max(
      0,
      Number(left.reasoningOutputTokens || 0) - Number(right.reasoningOutputTokens || 0)
    ),
    totalTokens: Math.max(0, Number(left.totalTokens || 0) - Number(right.totalTokens || 0)),
  };
}

function tokenUsageTotal(usage) {
  const total = Number(usage?.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage?.inputTokens ?? 0);
  const output = Number(usage?.outputTokens ?? 0);
  return Math.max(0, (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0));
}

function modelQuotaMultiplier(model) {
  const value = String(model || "").toLowerCase();
  return /(^|[-_\s])fast($|[-_\s])|high[-_\s]?speed|speedy/.test(value) ? 1.5 : 1;
}

function weightedTokenUsage(usage, model) {
  return tokenUsageTotal(usage) * modelQuotaMultiplier(model);
}

function cloneTokenUsage(usage) {
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    cachedInputTokens: Number(usage?.cachedInputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    reasoningOutputTokens: Number(usage?.reasoningOutputTokens ?? 0),
    totalTokens: Number(usage?.totalTokens ?? 0),
  };
}

function dateMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function fileCachePart(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function parseSessionFile(file, indexMap, options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null;
  const summary = {
    id: null,
    title: null,
    cwd: null,
    model: null,
    startedAt: null,
    updatedAt: new Date(file.mtimeMs).toISOString(),
    tokenUsage: null,
    rateLimits: null,
    tokenCountAt: null,
    rateLimitsAt: null,
  };
  let lastTokenCount = null;
  let lastRateLimitEvent = null;
  let afterSince = null;
  let afterSinceRateLimitEvent = null;

  const stream = fsSync.createReadStream(file.path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.timestamp) summary.updatedAt = entry.timestamp;
    if (entry.type === "session_meta") {
      summary.id = entry.payload?.id ?? summary.id;
      summary.startedAt = entry.payload?.timestamp ?? summary.startedAt;
      summary.cwd = entry.payload?.cwd ?? summary.cwd;
    } else if (entry.type === "turn_context") {
      summary.model = entry.payload?.model ?? summary.model;
      summary.cwd = entry.payload?.cwd ?? summary.cwd;
    } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      const info = entry.payload?.info ?? {};
      const timestamp = entry.timestamp ?? summary.updatedAt;
      const tokenCount = {
        timestamp,
        tokenUsage: normalizeTokenUsage(info.total_token_usage ?? info.totalTokenUsage),
        rateLimits: entry.payload?.rate_limits ?? null,
      };
      lastTokenCount = tokenCount;
      if (tokenCount.rateLimits) lastRateLimitEvent = tokenCount;

      const eventMs = new Date(timestamp).getTime();
      if (sinceMs && Number.isFinite(eventMs) && eventMs >= sinceMs) {
        afterSince = tokenCount;
        if (tokenCount.rateLimits) afterSinceRateLimitEvent = tokenCount;
      }
    }
  }

  const scopedTokenCount = sinceMs ? afterSince : lastTokenCount;
  if (!scopedTokenCount) return null;
  const quotaEvent = sinceMs ? afterSinceRateLimitEvent : lastRateLimitEvent;
  summary.tokenUsage = scopedTokenCount.tokenUsage;
  summary.rateLimits = quotaEvent?.rateLimits ?? null;
  summary.tokenCountAt = scopedTokenCount.timestamp;
  summary.rateLimitsAt = quotaEvent?.rateLimits ? quotaEvent.timestamp : null;

  const indexed = summary.id ? indexMap.get(summary.id) : null;
  summary.title =
    indexed?.thread_name ||
    (summary.cwd ? path.basename(summary.cwd) || summary.cwd : null) ||
    summary.id ||
    path.basename(file.path);
  const indexedMs = indexed?.updated_at ? new Date(indexed.updated_at).getTime() : null;
  summary.updatedAt =
    indexed?.updated_at && Number.isFinite(indexedMs)
      ? indexed.updated_at
      : scopedTokenCount.timestamp ?? summary.updatedAt;
  return summary;
}

async function parseSessionFileCached(file, indexMap, options = {}) {
  const sinceKey = Number.isFinite(options.sinceMs) ? String(options.sinceMs) : "all";
  const cacheKey = `${file.path}:${file.size}:${file.mtimeMs}:${sinceKey}`;
  if (sessionParseCache.has(cacheKey)) return sessionParseCache.get(cacheKey);
  const parsed = await parseSessionFile(file, indexMap, options);
  sessionParseCache.set(cacheKey, parsed);
  if (sessionParseCache.size > 200) {
    const firstKey = sessionParseCache.keys().next().value;
    sessionParseCache.delete(firstKey);
  }
  return parsed;
}

function quotaFromLocalRateLimits(rateLimits, checkedAt) {
  if (!rateLimits) return null;
  return {
    source: "local",
    checkedAt,
    planType: rateLimits.plan_type ?? null,
    session: normalizeRateWindow(rateLimits.primary),
    weekly: normalizeRateWindow(rateLimits.secondary),
    credits: normalizeCredits(rateLimits.credits),
    error: null,
  };
}

function extractCodexLogMessage(body) {
  const text = String(body ?? "");
  const markers = ["Received message ", "websocket event: "];
  for (const marker of markers) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const jsonText = text.slice(markerIndex + marker.length).trim();
    try {
      return JSON.parse(jsonText);
    } catch {
      const first = jsonText.indexOf("{");
      const last = jsonText.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try {
          return JSON.parse(jsonText.slice(first, last + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function quotaFromUsageLimitMessage(message, timestampSeconds) {
  if (message?.type !== "error" || message?.error?.type !== "usage_limit_reached") return null;
  const headers = normalizeHeaderMap(message.headers);
  const checkedAt = new Date(timestampSeconds * 1000).toISOString();
  const primaryResetAt =
    numberHeader(headers, "x-codex-primary-reset-at") ??
    (numberHeader(headers, "x-codex-primary-reset-after-seconds")
      ? timestampSeconds + numberHeader(headers, "x-codex-primary-reset-after-seconds")
      : null);
  const secondaryResetAt =
    numberHeader(headers, "x-codex-secondary-reset-at") ??
    (numberHeader(headers, "x-codex-secondary-reset-after-seconds")
      ? timestampSeconds + numberHeader(headers, "x-codex-secondary-reset-after-seconds")
      : null);
  const planType = headers["x-codex-plan-type"] ?? message.error?.plan_type ?? null;
  return {
    source: "local-error",
    checkedAt,
    planType,
    session: {
      usedPercent: Math.max(100, numberHeader(headers, "x-codex-primary-used-percent") ?? 100),
      windowMinutes: numberHeader(headers, "x-codex-primary-window-minutes"),
      resetsAt: primaryResetAt ?? message.error?.resets_at ?? null,
    },
    weekly: {
      usedPercent: Math.max(0, Math.min(100, numberHeader(headers, "x-codex-secondary-used-percent") ?? 0)),
      windowMinutes: numberHeader(headers, "x-codex-secondary-window-minutes"),
      resetsAt: secondaryResetAt,
    },
    credits: {
      hasCredits: boolHeader(headers, "x-codex-credits-has-credits"),
      unlimited: boolHeader(headers, "x-codex-credits-unlimited"),
      balance: numberHeader(headers, "x-codex-credits-balance"),
    },
    error: "Codex 返回 usage_limit_reached，本地日志显示当前会话额度已用完。",
  };
}

function quotaFromCodexRateLimitsMessage(message, timestampSeconds) {
  if (message?.type !== "codex.rate_limits" || !message.rate_limits) return null;
  const checkedAt = new Date(timestampSeconds * 1000).toISOString();
  return {
    source: "local",
    checkedAt,
    planType: message.plan_type ?? message.rate_limits?.plan_type ?? null,
    session: normalizeRateWindow(message.rate_limits.primary),
    weekly: normalizeRateWindow(message.rate_limits.secondary),
    credits: normalizeCredits(message.credits),
    error: null,
  };
}

async function readLatestSqliteRateLimitQuota(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceSeconds = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000)
    : Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
  if (!(await pathExists(logsDbPath()))) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(logsDbPath(), { readOnly: true });
    const rows = db
      .prepare(
        `select ts, feedback_log_body
         from logs
         where ts >= ? and feedback_log_body like '%codex.rate_limits%'
         order by ts desc, id desc
         limit 1000`
      )
      .all(effectiveSinceSeconds);
    for (const row of rows) {
      const quota = quotaFromCodexRateLimitsMessage(extractCodexLogMessage(row.feedback_log_body), row.ts);
      if (quota) return quota;
    }
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore sqlite close errors from a best-effort local log read.
    }
  }
  return null;
}

async function readLatestUsageLimitQuota(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceSeconds = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000)
    : Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
  if (!(await pathExists(logsDbPath()))) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }

  let db;
  try {
    db = new DatabaseSync(logsDbPath(), { readOnly: true });
    const rows = db
      .prepare(
        `select ts, feedback_log_body
         from logs
         where ts >= ? and feedback_log_body like '%usage_limit_reached%'
         order by ts desc, id desc
         limit 1000`
      )
      .all(effectiveSinceSeconds);
    for (const row of rows) {
      const quota = quotaFromUsageLimitMessage(extractCodexLogMessage(row.feedback_log_body), row.ts);
      if (quota) return quota;
    }
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore sqlite close errors from a best-effort local log read.
    }
  }
  return null;
}

function newerQuota(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  const leftMs = new Date(left.checkedAt).getTime();
  const rightMs = new Date(right.checkedAt).getTime();
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

async function parseLatestRateLimitFile(file, sinceMs) {
  let latest = null;
  const maxTailBytes = 512 * 1024;
  const handle = await fs.open(file.path, "r");
  let text = "";
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxTailBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
  } finally {
    await handle.close();
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
    if (!entry.payload?.rate_limits) continue;
    const timestamp = entry.timestamp ?? new Date(file.mtimeMs).toISOString();
    const eventMs = new Date(timestamp).getTime();
    if (sinceMs && Number.isFinite(eventMs) && eventMs < sinceMs) continue;
    latest = {
      rateLimits: entry.payload.rate_limits,
      timestamp,
    };
  }
  return latest;
}

async function parseQuotaEventFile(file) {
  const events = [];
  let sessionId = null;
  let startedAtMs = null;
  let model = null;

  const stream = fsSync.createReadStream(file.path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id ?? sessionId;
      startedAtMs = dateMs(entry.payload?.timestamp ?? entry.timestamp) ?? startedAtMs;
    } else if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
    } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      const timestamp = entry.timestamp ?? new Date(file.mtimeMs).toISOString();
      const ms = dateMs(timestamp);
      if (!Number.isFinite(ms)) continue;
      const info = entry.payload?.info ?? {};
      events.push({
        filePath: file.path,
        sessionId: sessionId ?? file.path,
        startedAtMs,
        timestamp,
        ms,
        model,
        tokenUsage: normalizeTokenUsage(info.total_token_usage ?? info.totalTokenUsage),
        rateLimits: entry.payload?.rate_limits ?? null,
      });
    }
  }
  return events;
}

async function parseQuotaEventFileCached(file) {
  const cacheKey = `${file.path}:${file.size}:${file.mtimeMs}`;
  if (quotaEventParseCache.has(cacheKey)) return quotaEventParseCache.get(cacheKey);
  const parsed = await parseQuotaEventFile(file);
  quotaEventParseCache.set(cacheKey, parsed);
  if (quotaEventParseCache.size > 120) {
    const firstKey = quotaEventParseCache.keys().next().value;
    quotaEventParseCache.delete(firstKey);
  }
  return parsed;
}

function parseLogKeyValues(text) {
  const fields = {};
  const source = String(text ?? "");
  const pattern = /\b([A-Za-z0-9_.-]+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[2] ?? match[3] ?? "";
    fields[match[1]] = match[2] === undefined ? raw : raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return fields;
}

function numberField(fields, key) {
  const value = Number(fields?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function responseCompletedEventFromLogRow(row) {
  const message = extractCodexLogMessage(row?.feedback_log_body);
  if (message?.type === "response.completed" && message.response?.usage) {
    const response = message.response;
    const tokenUsage = normalizeTokenUsage(response.usage);
    if (tokenUsageTotal(tokenUsage) <= 0) return null;
    const timestamp = response.completed_at
      ? new Date(Number(response.completed_at) * 1000).toISOString()
      : new Date(Number(row.ts || 0) * 1000).toISOString();
    const ms = dateMs(timestamp);
    if (!Number.isFinite(ms)) return null;
    const model = response.model || response.metadata?.model || null;
    const signature = [
      Math.floor(ms / 1000),
      model ?? "",
      tokenUsage.inputTokens,
      tokenUsage.outputTokens,
      tokenUsage.cachedInputTokens,
      tokenUsage.reasoningOutputTokens,
    ].join("|");
    return {
      id: row?.id ?? null,
      sessionId: `sqlite:${row?.thread_id || response.previous_response_id || response.id || "response"}`,
      timestamp,
      ms,
      model,
      tokenUsage,
      signature,
    };
  }

  const fields = parseLogKeyValues(row?.feedback_log_body);
  if (fields["event.name"] !== "codex.sse_event" || fields["event.kind"] !== "response.completed") {
    return null;
  }

  const timestamp = fields["event.timestamp"] || new Date(Number(row.ts || 0) * 1000).toISOString();
  const ms = dateMs(timestamp);
  if (!Number.isFinite(ms)) return null;

  const inputTokens = numberField(fields, "input_token_count");
  const outputTokens = numberField(fields, "output_token_count");
  const cachedInputTokens = numberField(fields, "cached_token_count");
  const reasoningOutputTokens = numberField(fields, "reasoning_token_count");
  const totalTokens = Math.max(0, inputTokens + outputTokens);
  if (totalTokens <= 0) return null;

  const conversationId = fields["conversation.id"] || row?.thread_id || `sqlite-row-${row?.id ?? ms}`;
  const model = fields.slug || fields.model || null;
  return {
    id: row?.id ?? null,
    sessionId: `sqlite:${conversationId}`,
    timestamp,
    ms,
    model,
    tokenUsage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
    },
    signature: [
      Math.floor(ms / 1000),
      model ?? "",
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
    ].join("|"),
  };
}

async function readSqliteResponseCompletedEvents(options = {}) {
  if (!(await pathExists(logsDbPath()))) return [];
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return [];
  }

  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : Date.now() - 6 * 60 * 60 * 1000;
  const sinceSeconds = Math.max(0, Math.floor((sinceMs - 5 * 60 * 1000) / 1000));
  const cacheKey = [
    await fileCachePart(logsDbPath()),
    await fileCachePart(logsDbWalPath()),
    await fileCachePart(logsDbShmPath()),
    sinceSeconds,
  ].join(":");
  if (sqliteResponseEventCache.has(cacheKey)) return sqliteResponseEventCache.get(cacheKey);

  let db;
  try {
    db = new DatabaseSync(logsDbPath(), { readOnly: true });
    const rows = db
      .prepare(
        `select id, ts, thread_id, feedback_log_body
         from logs
         where ts >= ?
           and (
             (
               feedback_log_body like '%event.name="codex.sse_event"%'
               and feedback_log_body like '%event.kind=response.completed%'
             )
             or feedback_log_body like '%Received message {"type":"response.completed"%'
           )
         order by ts asc, id asc
         limit 2000`
      )
      .all(sinceSeconds);

    const seen = new Set();
    const rawEvents = [];
    for (const row of rows) {
      const event = responseCompletedEventFromLogRow(row);
      if (!event || seen.has(event.signature)) continue;
      seen.add(event.signature);
      rawEvents.push(event);
    }

    const bySession = new Map();
    for (const event of rawEvents) {
      if (!bySession.has(event.sessionId)) bySession.set(event.sessionId, []);
      bySession.get(event.sessionId).push(event);
    }

    const events = [];
    for (const sessionEvents of bySession.values()) {
      sessionEvents.sort((a, b) => a.ms - b.ms);
      const cumulative = emptyTokenUsage();
      const startedAtMs = sessionEvents[0]?.ms ?? null;
      for (const event of sessionEvents) {
        addTokenUsage(cumulative, event.tokenUsage);
        events.push({
          filePath: logsDbPath(),
          sessionId: event.sessionId,
          startedAtMs,
          timestamp: event.timestamp,
          ms: event.ms,
          model: event.model,
          tokenUsage: cloneTokenUsage(cumulative),
          rateLimits: null,
          source: "sqlite-response-completed",
        });
      }
    }
    events.sort((a, b) => a.ms - b.ms);

    sqliteResponseEventCache.set(cacheKey, events);
    if (sqliteResponseEventCache.size > 12) {
      const firstKey = sqliteResponseEventCache.keys().next().value;
      sqliteResponseEventCache.delete(firstKey);
    }
    return events;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore sqlite close errors from a best-effort local log read.
    }
  }
}

function quotaRawWindow(rateLimits, kind) {
  return kind === "weekly" ? rateLimits?.secondary : rateLimits?.primary;
}

function rawUsedPercent(rateLimits, kind) {
  const value = Number(quotaRawWindow(rateLimits, kind)?.used_percent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function rateLimitsMatchPlan(rateLimits, planType) {
  const eventPlan = rateLimits?.plan_type ?? null;
  return !planType || !eventPlan || eventPlan === planType;
}

function addCalibrationSample(samples, percentDelta, weightedTokens) {
  if (!Number.isFinite(percentDelta) || !Number.isFinite(weightedTokens)) return;
  if (percentDelta <= 0 || percentDelta > 40 || weightedTokens < 1000) return;
  const coefficient = percentDelta / weightedTokens;
  if (coefficient > 0 && coefficient < 0.01) samples.push(coefficient);
}

function collectQuotaCalibration(events, planType) {
  const sessionSamples = [];
  const weeklySamples = [];
  const bySession = new Map();
  for (const event of events) {
    const key = event.sessionId || event.filePath;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(event);
  }

  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => a.ms - b.ms);
    let previous = null;
    for (const event of sessionEvents) {
      if (!event.rateLimits || !rateLimitsMatchPlan(event.rateLimits, planType)) continue;
      if (previous) {
        const deltaUsage = subtractTokenUsage(event.tokenUsage, previous.tokenUsage);
        const weightedTokens = weightedTokenUsage(deltaUsage, event.model || previous.model);
        const currentSessionPercent = rawUsedPercent(event.rateLimits, "session");
        const previousSessionPercent = rawUsedPercent(previous.rateLimits, "session");
        const currentWeeklyPercent = rawUsedPercent(event.rateLimits, "weekly");
        const previousWeeklyPercent = rawUsedPercent(previous.rateLimits, "weekly");
        if (Number.isFinite(currentSessionPercent) && Number.isFinite(previousSessionPercent)) {
          addCalibrationSample(sessionSamples, currentSessionPercent - previousSessionPercent, weightedTokens);
        }
        if (Number.isFinite(currentWeeklyPercent) && Number.isFinite(previousWeeklyPercent)) {
          addCalibrationSample(weeklySamples, currentWeeklyPercent - previousWeeklyPercent, weightedTokens);
        }
      }
      previous = event;
    }
  }

  return {
    sessionCoefficient: median(sessionSamples),
    weeklyCoefficient: median(weeklySamples),
    sessionSamples: sessionSamples.length,
    weeklySamples: weeklySamples.length,
  };
}

function tokenDeltaSinceBase(events, baseMs) {
  const bySession = new Map();
  for (const event of events) {
    const key = event.sessionId || event.filePath;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(event);
  }

  const tokenUsage = emptyTokenUsage();
  let weightedTokens = 0;
  let latestAt = null;
  let latestMs = baseMs;
  let sessions = 0;

  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => a.ms - b.ms);
    const after = sessionEvents.filter((event) => event.ms > baseMs);
    if (!after.length) continue;
    const latestAfter = after[after.length - 1];
    const before = [...sessionEvents].reverse().find((event) => event.ms <= baseMs);

    let deltaUsage = null;
    if (before) {
      deltaUsage = subtractTokenUsage(latestAfter.tokenUsage, before.tokenUsage);
    } else if (Number.isFinite(latestAfter.startedAtMs) && latestAfter.startedAtMs >= baseMs) {
      deltaUsage = latestAfter.tokenUsage;
    }

    if (!deltaUsage || tokenUsageTotal(deltaUsage) <= 0) continue;
    addTokenUsage(tokenUsage, deltaUsage);
    weightedTokens += weightedTokenUsage(deltaUsage, latestAfter.model);
    sessions += 1;
    if (latestAfter.ms > latestMs) {
      latestMs = latestAfter.ms;
      latestAt = latestAfter.timestamp;
    }
  }

  return { tokenUsage, weightedTokens, latestAt, sessions };
}

function buildWindowEstimate(baseWindow, coefficient, weightedTokens, sampleCount) {
  if (!baseWindow || !Number.isFinite(coefficient) || !Number.isFinite(weightedTokens)) return null;
  const baseUsed = Math.max(0, Math.min(100, Number(baseWindow.usedPercent || 0)));
  if (baseUsed >= 100) return null;
  const deltaPercent = coefficient * weightedTokens;
  if (!Number.isFinite(deltaPercent) || deltaPercent < 0.5) return null;
  const estimatedUsed = Math.max(baseUsed, Math.min(100, baseUsed + deltaPercent));
  return {
    estimatedUsedPercent: Math.round(estimatedUsed),
    estimatedRemainingPercent: Math.round(Math.max(0, 100 - estimatedUsed)),
    estimatedDeltaPercent: Math.round((estimatedUsed - baseUsed) * 10) / 10,
    estimateSamples: sampleCount,
  };
}

function fallbackQuotaCoefficient(planType, kind) {
  const plan = String(planType || "").toLowerCase();
  if (kind === "weekly") {
    if (plan === "team" || plan === "business") return 1 / 50000;
    return 1 / 50000;
  }
  if (plan === "team" || plan === "business") return 1 / 10000;
  return 1 / 10000;
}

function newerTokenDelta(left, right) {
  if (!left?.latestAt) return right ?? left;
  if (!right?.latestAt) return left;
  const leftMs = dateMs(left.latestAt);
  const rightMs = dateMs(right.latestAt);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  if (rightMs > leftMs) return right;
  if (rightMs === leftMs && Number(right.weightedTokens || 0) > Number(left.weightedTokens || 0)) return right;
  return left;
}

function quotaEstimateUnavailable(reason) {
  return {
    source: "local-estimate",
    available: false,
    reason,
  };
}

async function readQuotaEstimate(options = {}) {
  const baseQuota = options.baseQuota;
  if (!baseQuota || baseQuota.source !== "local") {
    return quotaEstimateUnavailable("\u7b49\u5f85\u672c\u5730\u989d\u5ea6\u5feb\u7167");
  }
  const baseMs = dateMs(baseQuota.checkedAt);
  if (!Number.isFinite(baseMs)) return quotaEstimateUnavailable("\u5feb\u7167\u65f6\u95f4\u4e0d\u53ef\u7528");

  const sinceMs = options.since ? dateMs(options.since) : null;
  const effectiveSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const files = options.files ?? (await walkSessionFiles(sessionsDir()));
  const recentFiles = files.slice(0, 40);
  const sessionEvents = [];

  for (const file of recentFiles) {
    try {
      sessionEvents.push(...(await parseQuotaEventFileCached(file)));
    } catch {
      // A session file can be mid-write; skip it and try again on the next refresh.
    }
  }

  const sqliteSinceMs =
    effectiveSinceMs && Number.isFinite(effectiveSinceMs) ? Math.min(effectiveSinceMs, baseMs) : baseMs;
  const sqliteEvents = await readSqliteResponseCompletedEvents({ sinceMs: sqliteSinceMs });
  const events = [...sessionEvents, ...sqliteEvents];
  if (!events.length) return quotaEstimateUnavailable("\u672a\u627e\u5230\u672c\u5730 token \u8bb0\u5f55");
  events.sort((a, b) => a.ms - b.ms);
  sessionEvents.sort((a, b) => a.ms - b.ms);
  sqliteEvents.sort((a, b) => a.ms - b.ms);

  const scopedSessionEvents = effectiveSinceMs ? sessionEvents.filter((event) => event.ms >= effectiveSinceMs) : sessionEvents;
  const scopedSqliteEvents = effectiveSinceMs ? sqliteEvents.filter((event) => event.ms >= effectiveSinceMs) : sqliteEvents;
  const delta = newerTokenDelta(
    tokenDeltaSinceBase(scopedSessionEvents, baseMs),
    tokenDeltaSinceBase(scopedSqliteEvents, baseMs)
  );
  if (!delta.latestAt) {
    const baseAgeMs = Date.now() - baseMs;
    if (Number.isFinite(baseAgeMs) && baseAgeMs < 5 * 60 * 1000) return null;
    return quotaEstimateUnavailable("\u7b49\u5f85\u5feb\u7167\u540e\u7684 token \u8bb0\u5f55");
  }
  if (delta.weightedTokens < 100) return quotaEstimateUnavailable("\u5feb\u7167\u540e\u589e\u91cf\u592a\u5c0f");

  const calibration = collectQuotaCalibration(sessionEvents, baseQuota.planType);
  const sessionCoefficient =
    calibration.sessionCoefficient ?? fallbackQuotaCoefficient(baseQuota.planType, "session");
  const weeklyCoefficient = calibration.weeklyCoefficient ?? fallbackQuotaCoefficient(baseQuota.planType, "weekly");
  const usedFallbackCoefficient =
    !Number.isFinite(calibration.sessionCoefficient) || !Number.isFinite(calibration.weeklyCoefficient);
  const sessionEstimate = buildWindowEstimate(
    baseQuota.session,
    sessionCoefficient,
    delta.weightedTokens,
    calibration.sessionSamples
  );
  const weeklyEstimate = buildWindowEstimate(
    baseQuota.weekly,
    weeklyCoefficient,
    delta.weightedTokens,
    calibration.weeklySamples
  );

  if (!sessionEstimate && !weeklyEstimate) return quotaEstimateUnavailable("\u7b49\u5f85\u5386\u53f2\u6821\u51c6\u6837\u672c");
  return {
    source: "local-estimate",
    available: true,
    checkedAt: delta.latestAt,
    baseCheckedAt: baseQuota.checkedAt,
    weightedTokens: Math.round(delta.weightedTokens),
    tokenUsage: delta.tokenUsage,
    sessions: delta.sessions,
    confidence: Math.max(calibration.sessionSamples, calibration.weeklySamples) >= 3
      ? "calibrated"
      : usedFallbackCoefficient
        ? "fallback"
        : "low-sample",
    session: sessionEstimate,
    weekly: weeklyEstimate,
  };
}

function attachQuotaEstimate(quota, estimate) {
  if (!quota || !estimate) return quota;
  let hasEstimate = false;
  const next = {
    ...quota,
    estimate: {
      source: estimate.source,
      available: estimate.available === true,
      reason: estimate.reason ?? null,
      checkedAt: estimate.checkedAt,
      baseCheckedAt: estimate.baseCheckedAt,
      weightedTokens: estimate.weightedTokens,
      tokenUsage: estimate.tokenUsage,
      sessions: estimate.sessions,
      confidence: estimate.confidence,
    },
  };
  if (quota.session && estimate.session) {
    next.session = { ...quota.session, ...estimate.session };
    hasEstimate = true;
  }
  if (quota.weekly && estimate.weekly) {
    next.weekly = { ...quota.weekly, ...estimate.weekly };
    hasEstimate = true;
  }
  return hasEstimate || estimate.available === false ? next : quota;
}

async function readLatestLocalQuota(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const files = options.files ?? (await walkSessionFiles(sessionsDir()));
  const recentFiles = files.slice(0, 24);

  for (const file of recentFiles) {
    let latest;
    try {
      latest = await parseLatestRateLimitFile(file, effectiveSinceMs);
    } catch {
      continue;
    }
    if (latest?.rateLimits) {
      return quotaFromLocalRateLimits(latest.rateLimits, latest.timestamp);
    }
  }
  return null;
}

async function readLocalUsage(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const files = options.files ?? (await walkSessionFiles(sessionsDir()));
  const indexMap = await readSessionIndexMap();
  const recentFiles = files.slice(0, 80);
  const sessions = [];
  let latestQuota = null;

  for (const file of recentFiles) {
    let parsed;
    try {
      parsed = await parseSessionFileCached(file, indexMap, { sinceMs: effectiveSinceMs });
    } catch {
      continue;
    }
    if (!parsed) continue;
    sessions.push(parsed);
    if (!latestQuota && parsed.rateLimits) {
      latestQuota = quotaFromLocalRateLimits(parsed.rateLimits, parsed.rateLimitsAt ?? parsed.updatedAt);
    }
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const total = emptyTokenUsage();
  const byModel = new Map();
  const byDay = new Map();

  for (const session of sessions) {
    addTokenUsage(total, session.tokenUsage);
    const model = session.model || "unknown";
    if (!byModel.has(model)) byModel.set(model, { model, sessions: 0, tokenUsage: emptyTokenUsage() });
    const modelEntry = byModel.get(model);
    modelEntry.sessions += 1;
    addTokenUsage(modelEntry.tokenUsage, session.tokenUsage);

    const day = localDayKey(session.updatedAt);
    if (!byDay.has(day)) byDay.set(day, { day, sessions: 0, tokenUsage: emptyTokenUsage() });
    const dayEntry = byDay.get(day);
    dayEntry.sessions += 1;
    addTokenUsage(dayEntry.tokenUsage, session.tokenUsage);
  }

  return {
    source: "local",
    scannedFiles: recentFiles.length,
    totalFiles: files.length,
    sessionsAnalyzed: sessions.length,
    tokenUsage: total,
    models: Array.from(byModel.values()).sort((a, b) => b.tokenUsage.totalTokens - a.tokenUsage.totalTokens),
    daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)).slice(-7),
    recentSessions: sessions.slice(0, 12),
    latestQuota,
    since: options.since ?? null,
    checkedAt: new Date().toISOString(),
  };
}

function emptyLocalUsage(since = null) {
  return {
    source: "local",
    scannedFiles: 0,
    totalFiles: 0,
    sessionsAnalyzed: 0,
    tokenUsage: emptyTokenUsage(),
    models: [],
    daily: [],
    recentSessions: [],
    latestQuota: null,
    since,
    checkedAt: new Date().toISOString(),
  };
}

async function dashboardScope() {
  await waitForIndexMutations();
  const index = await readIndex();
  let currentIdentityKey = null;
  try {
    const auth = await readCurrentAuth();
    currentIdentityKey = identityKey(auth.identity);
  } catch {
    currentIdentityKey = null;
  }

  const currentAccount = currentIdentityKey
    ? index.accounts.find((account) => identityKey(account.identity ?? {}) === currentIdentityKey)
    : null;
  const activeAccount = !currentIdentityKey
    ? index.accounts.find((account) => account.id === index.activeAccountId)
    : null;
  const account = currentAccount ?? activeAccount ?? null;

  return {
    account: account ? normalizePublicAccount(account, index.activeAccountId, currentIdentityKey) : null,
    accountId: account?.id ?? null,
    hasCurrentAuth: !!currentIdentityKey,
    accountPlanType: account?.identity?.planType ?? null,
    accountQuotaSnapshot: account?.quotaSnapshot ?? null,
    since: account?.lastSwitchedAt ?? null,
    mode: account?.lastSwitchedAt ? "since-account-switch" : "all-local",
  };
}

async function saveAccountQuotaSnapshot(accountId, quota) {
  if (!accountId || !quota || !["local", "local-error"].includes(quota.source)) return false;
  const nextSnapshot = {
    source: quota.source,
    checkedAt: quota.checkedAt,
    planType: quota.planType,
    session: quota.session,
    weekly: quota.weekly,
    credits: quota.credits,
    error: quota.error ?? null,
  };
  return mutateIndex(async (index) => {
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) return { value: false, write: false };
    if (!quotaMatchesAccount(account, quota)) return { value: false, write: false };
    const previous = JSON.stringify(account.quotaSnapshot ?? null);
    const next = JSON.stringify(nextSnapshot);
    if (previous === next) return { value: false, write: false };
    account.quotaSnapshot = nextSnapshot;
    account.quotaSnapshotUpdatedAt = new Date().toISOString();
    return { value: true };
  });
}

function quotaMatchesAccount(account, quota) {
  const accountPlan = account?.identity?.planType;
  const quotaPlan = quota?.planType;
  return !accountPlan || !quotaPlan || accountPlan === quotaPlan;
}

async function cleanupMismatchedQuotaSnapshots() {
  await mutateIndex(async (index) => {
    let changed = false;
    for (const account of index.accounts) {
      if (account.quotaSnapshot && !quotaMatchesAccount(account, account.quotaSnapshot)) {
        delete account.quotaSnapshot;
        delete account.quotaSnapshotUpdatedAt;
        changed = true;
      }
    }
    return changed ? {} : { write: false };
  });
}

function resolveQuota(scope, latestQuota) {
  if (!scope.hasCurrentAuth) {
    return {
      source: "unavailable",
      checkedAt: new Date().toISOString(),
      planType: null,
      session: null,
      weekly: null,
      credits: null,
      error: "未检测到当前登录账号，暂不显示本机历史额度。",
    };
  }
  const compatibleLatest =
    latestQuota && scope.accountPlanType && latestQuota.planType && latestQuota.planType !== scope.accountPlanType
      ? null
      : latestQuota;
  const cachedQuota =
    !compatibleLatest && scope.accountQuotaSnapshot
      ? {
          ...scope.accountQuotaSnapshot,
          source: "account-cache",
          error: scope.since
            ? "当前账号切换后还没有新的额度快照，显示此账号上次本地快照。"
            : null,
        }
      : null;
  return (
    compatibleLatest ??
    cachedQuota ?? {
      source: "unavailable",
      checkedAt: new Date().toISOString(),
      planType: null,
      session: null,
      weekly: null,
      credits: null,
      error: scope.since
        ? "切换后还没有新的本地额度快照。请在 Codex App 发起一次对话，生成本地日志后会自动更新。"
        : "本地 Codex 日志中暂未找到额度快照。",
    }
  );
}

async function getQuota() {
  const scope = await dashboardScope();
  if (!scope.hasCurrentAuth) {
    return { quota: resolveQuota(scope, null), scope, checkedAt: new Date().toISOString() };
  }
  const files = await walkSessionFiles(sessionsDir());
  const latestQuota = newerQuota(
    newerQuota(
      await readLatestLocalQuota({ since: scope.since, files }),
      await readLatestSqliteRateLimitQuota({ since: scope.since })
    ),
    await readLatestUsageLimitQuota({ since: scope.since })
  );
  const quotaEstimate = await readQuotaEstimate({ since: scope.since, files, baseQuota: latestQuota });
  if (latestQuota && scope.accountId) {
    await saveAccountQuotaSnapshot(scope.accountId, latestQuota);
  }
  return {
    quota: attachQuotaEstimate(resolveQuota(scope, latestQuota), quotaEstimate),
    scope,
    checkedAt: new Date().toISOString(),
  };
}

async function getDashboard() {
  const scope = await dashboardScope();
  if (!scope.hasCurrentAuth) {
    return { quota: resolveQuota(scope, null), usage: emptyLocalUsage(scope.since), scope };
  }
  const files = await walkSessionFiles(sessionsDir());
  const latestQuota = newerQuota(
    newerQuota(
      await readLatestLocalQuota({ since: scope.since, files }),
      await readLatestSqliteRateLimitQuota({ since: scope.since })
    ),
    await readLatestUsageLimitQuota({ since: scope.since })
  );
  if (latestQuota && scope.accountId) {
    await saveAccountQuotaSnapshot(scope.accountId, latestQuota);
  }
  const usage = await readLocalUsage({ since: scope.since, files });
  const baseQuota = latestQuota ?? usage.latestQuota;
  const quotaEstimate = await readQuotaEstimate({ since: scope.since, files, baseQuota });
  const quota = attachQuotaEstimate(resolveQuota(scope, baseQuota), quotaEstimate);
  return { quota, usage, scope };
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: APP_NAME,
    icon: appIconIcoPath(),
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  hardenWindowNavigation(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  return mainWindow;
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = WIDGET_WIDTH;
  const height = widgetHeightForAccounts(1);
  widgetWindow = new BrowserWindow({
    width,
    height,
    minWidth: WIDGET_MIN_WIDTH,
    minHeight: WIDGET_MIN_HEIGHT,
    maxWidth: WIDGET_MAX_WIDTH,
    maxHeight: WIDGET_MAX_HEIGHT,
    x: Math.max(workArea.x + 12, workArea.x + workArea.width - width - 24),
    y: workArea.y + 72,
    title: "Codex Quick View",
    icon: appIconIcoPath(),
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  hardenWindowNavigation(widgetWindow);
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  widgetWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    widgetWindow.hide();
  });
  widgetWindow.on("show", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.on("hide", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.loadFile(path.join(__dirname, "ui", "widget.html"));
  return widgetWindow;
}

function resizeWidgetForAccounts(accountCount) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  if (widgetManualSize) return { ok: true, skipped: true };
  const bounds = widgetWindow.getBounds();
  const nextHeight = widgetHeightForAccounts(accountCount);
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const maxY = workArea.y + workArea.height - nextHeight - 8;
  const nextY = Math.max(workArea.y + 8, Math.min(bounds.y, maxY));
  widgetWindow.setBounds(
    {
      x: bounds.x,
      y: nextY,
      width: WIDGET_WIDTH,
      height: nextHeight,
    },
    false
  );
  return { ok: true, height: nextHeight };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resizeWidgetBoundsFromSession(session) {
  const direction = String(session?.edge || "");
  if (!session || !direction) return null;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - session.startCursor.x;
  const dy = cursor.y - session.startCursor.y;
  const start = session.startBounds;
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (direction.includes("e")) right += dx;
  if (direction.includes("s")) bottom += dy;
  if (direction.includes("w")) left += dx;
  if (direction.includes("n")) top += dy;

  if (right - left < WIDGET_MIN_WIDTH) {
    if (direction.includes("w")) left = right - WIDGET_MIN_WIDTH;
    else right = left + WIDGET_MIN_WIDTH;
  }
  if (bottom - top < WIDGET_MIN_HEIGHT) {
    if (direction.includes("n")) top = bottom - WIDGET_MIN_HEIGHT;
    else bottom = top + WIDGET_MIN_HEIGHT;
  }
  if (right - left > WIDGET_MAX_WIDTH) {
    if (direction.includes("w")) left = right - WIDGET_MAX_WIDTH;
    else right = left + WIDGET_MAX_WIDTH;
  }
  if (bottom - top > WIDGET_MAX_HEIGHT) {
    if (direction.includes("n")) top = bottom - WIDGET_MAX_HEIGHT;
    else bottom = top + WIDGET_MAX_HEIGHT;
  }

  const display = screen.getDisplayMatching(start);
  const workArea = display.workArea;
  const width = clamp(right - left, WIDGET_MIN_WIDTH, WIDGET_MAX_WIDTH);
  const height = clamp(bottom - top, WIDGET_MIN_HEIGHT, WIDGET_MAX_HEIGHT);
  const x = clamp(left, workArea.x, workArea.x + workArea.width - width);
  const y = clamp(top, workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function startWidgetResize(edge) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  const direction = String(edge || "");
  if (!VALID_RESIZE_EDGES.has(direction)) return { ok: false };

  widgetManualSize = true;
  widgetResizeSession = {
    edge: direction,
    startBounds: widgetWindow.getBounds(),
    startCursor: screen.getCursorScreenPoint(),
  };
  return { ok: true, bounds: widgetResizeSession.startBounds };
}

function updateWidgetResize() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  if (!widgetResizeSession) return { ok: true, bounds: widgetWindow.getBounds() };
  const nextBounds = resizeWidgetBoundsFromSession(widgetResizeSession);
  if (!nextBounds) return { ok: false };
  widgetWindow.setBounds(nextBounds, false);
  return { ok: true, bounds: nextBounds };
}

function finishWidgetResize() {
  const bounds = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : null;
  widgetResizeSession = null;
  return { ok: true, bounds };
}

function registerIpc() {
  ipcMain.handle("state:get", () => currentState());
  ipcMain.handle("account:import-current", async (_event, displayName) => {
    const result = await importCurrentAccount(displayName);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("account:switch", async (_event, accountId, options) => {
    const result = await switchAccount(accountId, options);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("account:reauth", async (_event, accountId) => {
    const result = await startAccountReauth(accountId);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("account:update", async (_event, accountId, patch) => {
    const result = await updateAccount(accountId, patch);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("account:delete", async (_event, accountId) => {
    const result = await deleteAccount(accountId);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("codex:restart", () => restartCodexApp());
  ipcMain.handle("quota:get", () => getQuota());
  ipcMain.handle("dashboard:get", () => getDashboard());
  ipcMain.handle("path:open", (_event, targetPath) => openPath(targetPath));
  ipcMain.handle("window:show-main", () => {
    showMainWindow();
    return { ok: true };
  });
  ipcMain.handle("window:show-widget", () => {
    showWidgetWindow();
    return { ok: true };
  });
  ipcMain.handle("window:hide-widget", () => {
    hideWidgetWindow();
    return { ok: true };
  });
  ipcMain.handle("window:toggle-widget", () => {
    toggleWidgetWindow();
    return { ok: true };
  });
  ipcMain.handle("window:resize-widget", (_event, accountCount) => resizeWidgetForAccounts(accountCount));
  ipcMain.handle("window:resize-widget-start", (_event, edge) => startWidgetResize(edge));
  ipcMain.handle("window:resize-widget-update", () => updateWidgetResize());
  ipcMain.handle("window:resize-widget-end", () => finishWidgetResize());
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    if (isWindows) {
      app.setAppUserModelId(APP_ID);
    }
    Menu.setApplicationMenu(null);
    await ensureStoreDirs();
    await migratePlaintextBackups();
    await hydrateStoredAccountMetadata();
    await cleanupMismatchedQuotaSnapshots();
    registerIpc();
    installNetworkGuards();
    createWindow();
    createTray();
    await startAuthWatcher();
    await startLocalLogWatcher();
    await startSessionsWatcher();
    await startSessionsPolling();

    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (authSyncTimer) clearTimeout(authSyncTimer);
  if (authSyncInterval) clearInterval(authSyncInterval);
  if (authWatcher) authWatcher.close();
  if (localLogRefreshTimer) clearTimeout(localLogRefreshTimer);
  if (localLogWatcher) localLogWatcher.close();
  if (sessionsWatcher) sessionsWatcher.close();
  if (sessionsPollingInterval) clearInterval(sessionsPollingInterval);
  for (const timer of reauthCheckTimers.values()) clearTimeout(timer);
  reauthCheckTimers.clear();
});
