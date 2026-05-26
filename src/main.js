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
const WIDGET_DOCK_EDGE_THRESHOLD = 12;
const WIDGET_DOCK_VISIBLE_SIZE = 12;
const WIDGET_DOCK_SETTLE_MS = 180;
const WIDGET_DOCK_COLLAPSE_MS = 420;
const WIDGET_DOCK_SUPPRESS_MOVE_MS = 280;
const WIDGET_DOCK_POLL_MS = 90;
const WIDGET_DOCK_STRIP_GRACE = 4;
const WIDGET_DOCK_COLLAPSE_VERIFY_MS = 260;
const WIDGET_DOCK_COLLAPSE_RETRY_MS = 360;
const WIDGET_DOCK_COLLAPSE_RETRY_LIMIT = 8;
const QUOTA_CONFLICT_WINDOW_MS = 5 * 60 * 1000;
const QUOTA_ESTIMATE_ALGORITHM = 3;
const QUOTA_MODE_LOCAL = "local";
const QUOTA_MODE_ONLINE = "online";
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const LIVE_QUOTA_TIMEOUT_MS = 10000;
const QUOTA_RATE_CARD_BASE_INPUT_CREDITS = 125;
const CODEX_RATE_CARDS = [
  { pattern: /gpt[-_\s]?5\.5/, input: 125, cachedInput: 12.5, output: 750, fastMultiplier: 2.5 },
  { pattern: /gpt[-_\s]?5\.4[-_\s]?mini/, input: 18.75, cachedInput: 1.875, output: 113, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.4/, input: 62.5, cachedInput: 6.25, output: 375, fastMultiplier: 2 },
  { pattern: /gpt[-_\s]?5\.3[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5\.2/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
  { pattern: /gpt[-_\s]?5[-_\s]?codex/, input: 43.75, cachedInput: 4.375, output: 350, fastMultiplier: 1 },
];
const DEFAULT_CODEX_RATE_CARD = CODEX_RATE_CARDS[0];

let mainWindow;
let widgetWindow;
let tray;
let isQuitting = false;
let widgetManualSize = false;
let widgetResizeSession = null;
let widgetDockState = {
  edge: null,
  expandedBounds: null,
  collapsed: false,
  edgeHoverArmed: true,
  hintEdge: null,
  pointerInside: false,
  settleTimer: null,
  collapseTimer: null,
  verifyTimer: null,
  pollTimer: null,
  collapseRetryCount: 0,
  suppressMoveUntil: 0,
};
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

function defaultSettings() {
  return {
    quotaMode: QUOTA_MODE_LOCAL,
  };
}

function normalizeSettings(settings) {
  const quotaMode = settings?.quotaMode === QUOTA_MODE_ONLINE ? QUOTA_MODE_ONLINE : QUOTA_MODE_LOCAL;
  return {
    ...defaultSettings(),
    quotaMode,
  };
}

async function readIndex() {
  const fallback = { version: STORE_VERSION, activeAccountId: null, accounts: [], deletedIdentityKeys: [], settings: defaultSettings() };
  const data = await readJson(indexPath(), fallback);
  return {
    version: STORE_VERSION,
    activeAccountId: data.activeAccountId ?? null,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    deletedIdentityKeys: Array.isArray(data.deletedIdentityKeys) ? data.deletedIdentityKeys : [],
    settings: normalizeSettings(data.settings),
  };
}

async function writeIndex(index) {
  await writeJsonAtomic(indexPath(), {
    version: STORE_VERSION,
    activeAccountId: index.activeAccountId ?? null,
    accounts: index.accounts,
    deletedIdentityKeys: Array.isArray(index.deletedIdentityKeys) ? index.deletedIdentityKeys : [],
    settings: normalizeSettings(index.settings),
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

function stripWindowEstimate(window) {
  if (!window) return window;
  const {
    estimatedUsedPercent,
    estimatedRemainingPercent,
    estimatedDeltaPercent,
    estimatedWeightedTokens,
    estimateCoefficient,
    estimateSamples,
    estimateTokenUsage,
    estimateWeightedTokens,
    estimateLatestAt,
    ...rest
  } = window;
  return rest;
}

function normalizePublicQuotaSnapshot(snapshot) {
  if (!snapshot?.estimate || snapshot.estimate.algorithm === QUOTA_ESTIMATE_ALGORITHM) return snapshot ?? null;
  return {
    ...snapshot,
    session: stripWindowEstimate(snapshot.session),
    weekly: stripWindowEstimate(snapshot.weekly),
    estimate: {
      ...snapshot.estimate,
      available: false,
      reason: "等待新算法快照",
    },
  };
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
    quotaSnapshot: normalizePublicQuotaSnapshot(account.quotaSnapshot),
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
    settings: normalizeSettings(index.settings),
    current,
    accounts: index.accounts.map((account) =>
      normalizePublicAccount(account, index.activeAccountId, currentIdentityKey)
    ),
  };
}

async function updateSettings(patch) {
  await mutateIndex(async (index) => {
    const previous = JSON.stringify(normalizeSettings(index.settings));
    index.settings = normalizeSettings({ ...index.settings, ...patch });
    return previous === JSON.stringify(index.settings) ? { write: false } : {};
  });
  return currentState();
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
      const files = await walkSessionFiles(sessionsDir());
      const latestQuota = newerQuota(
        newerQuota(
          await readLatestLocalQuota({ since: scope.since, files }),
          await readLatestSqliteRateLimitQuota({ since: scope.since })
        ),
        await readLatestUsageLimitQuota({ since: scope.since })
      );
      const quotaEstimate = await readQuotaEstimate({
        since: scope.since,
        files,
        baseQuota: latestQuota,
        calibration: scope.accountQuotaCalibration,
      });
      const resolvedQuota = attachQuotaEstimate(resolveQuota(scope, latestQuota), quotaEstimate);
      const changed = await saveAccountQuotaSnapshot(scope.accountId, resolvedQuota);
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
  expandWidgetDock();
  widgetWindow.focus();
}

function hideWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    clearWidgetDockTimers();
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

function normalizeRateWindow(window, checkedAt = null, estimateBaseAt = checkedAt, estimateSeed = {}) {
  if (!window) return null;
  const seconds = Number(window.limit_window_seconds ?? window.window_minutes * 60);
  const resetRaw = window.reset_at ?? window.resets_at;
  const resetsAt = resetRaw ? Number(resetRaw) : null;
  const seedWeightedTokens = Number(estimateSeed.estimateWeightedTokens);
  const seed =
    Number.isFinite(seedWeightedTokens) && seedWeightedTokens > 0
      ? {
          estimateTokenUsage: estimateSeed.estimateTokenUsage ?? null,
          estimateWeightedTokens: Math.round(seedWeightedTokens),
          estimateLatestAt: estimateSeed.estimateLatestAt ?? checkedAt,
        }
      : {};
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(Number(window.used_percent ?? 0)))),
    windowMinutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : null,
    resetsAt,
    checkedAt,
    estimateBaseAt,
    ...seed,
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

function numericValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLiveRateWindow(window, checkedAt, fallbackWindowMinutes, usedPercentOverride = null) {
  if (!window && usedPercentOverride === null) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowMinutes = numericValue(window?.window_minutes);
  const seconds = numericValue(window?.limit_window_seconds) ?? (windowMinutes !== null ? windowMinutes * 60 : null);
  const resetAt = numericValue(window?.reset_at ?? window?.resets_at);
  const resetAfter = numericValue(window?.reset_after_seconds);
  const resetsAt = resetAt ?? (resetAfter !== null ? nowSec + resetAfter : null);
  const rawUsed = usedPercentOverride ?? numericValue(window?.used_percent);
  return {
    usedPercent: rawUsed !== null ? Math.max(0, Math.min(100, Math.round(rawUsed))) : null,
    windowMinutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : fallbackWindowMinutes,
    resetsAt,
    checkedAt,
    estimateBaseAt: checkedAt,
  };
}

function normalizeLiveAdditionalRateLimits(entries, checkedAt) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const limitName = typeof entry?.limit_name === "string" ? entry.limit_name : "";
      const label = limitName.replace(/^GPT-[\d.]+-Codex-/, "") || limitName || "模型额度";
      const rateLimit = entry?.rate_limit ?? null;
      const sessionWindow = rateLimit?.primary_window ?? null;
      const weeklyWindow = rateLimit?.secondary_window ?? null;
      return {
        label,
        session: normalizeLiveRateWindow(sessionWindow, checkedAt, 300),
        weekly: normalizeLiveRateWindow(weeklyWindow, checkedAt, 7 * 24 * 60),
      };
    })
    .filter((entry) => entry.session || entry.weekly);
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

function normalizePlanType(planType) {
  const value = String(planType || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!value) return null;
  if (value.includes("business") || value.includes("team")) return "business";
  if (value.includes("enterprise")) return "enterprise";
  if (value.includes("teacher") || value.includes("health") || value.includes("gov") || value.includes("edu")) {
    return "enterprise";
  }
  if (value.includes("plus")) return "plus";
  if (value.includes("pro")) return "pro";
  if (value.includes("go")) return "go";
  if (value.includes("free")) return "free";
  return value;
}

function planTypesMatch(left, right) {
  const leftPlan = normalizePlanType(left);
  const rightPlan = normalizePlanType(right);
  return !leftPlan || !rightPlan || leftPlan === rightPlan;
}

function normalizeHeaderMap(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = LIVE_QUOTA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value;
    });
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function readOnlineQuota(scope) {
  const auth = await readCurrentAuth();
  const accessToken = auth.parsed?.tokens?.access_token;
  if (!accessToken) {
    throw new Error("当前 auth.json 没有 access_token，无法联网读取额度。");
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": APP_NAME,
  };
  const accountId = auth.parsed?.tokens?.account_id ?? auth.identity?.userId ?? null;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const response = await fetchJsonWithTimeout(WHAM_USAGE_URL, { method: "GET", headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error("联网额度读取未授权，请在 Codex App 重新登录后再试。");
  }
  if (!response.ok) {
    throw new Error(`联网额度读取失败：HTTP ${response.status}`);
  }
  if (!response.body || typeof response.body !== "object") {
    throw new Error("联网额度响应不是有效 JSON。");
  }

  const checkedAt = new Date().toISOString();
  const data = response.body;
  const rateLimit = data.rate_limit ?? null;
  const primaryWindow = rateLimit?.primary_window ?? null;
  const secondaryWindow = rateLimit?.secondary_window ?? null;
  const reviewWindow = data.code_review_rate_limit?.primary_window ?? null;
  const headerPrimary = numberHeader(response.headers, "x-codex-primary-used-percent");
  const headerSecondary = numberHeader(response.headers, "x-codex-secondary-used-percent");
  const creditsBalance = numericValue(data.credits?.balance) ?? numberHeader(response.headers, "x-codex-credits-balance");

  return {
    source: "online",
    checkedAt,
    planType: data.plan_type ?? scope.accountPlanType ?? auth.identity?.planType ?? null,
    session: normalizeLiveRateWindow(primaryWindow, checkedAt, 300, headerPrimary),
    weekly: normalizeLiveRateWindow(secondaryWindow, checkedAt, 7 * 24 * 60, headerSecondary),
    review: normalizeLiveRateWindow(reviewWindow, checkedAt, 7 * 24 * 60),
    additional: normalizeLiveAdditionalRateLimits(data.additional_rate_limits, checkedAt),
    credits: data.credits
      ? normalizeCredits({ ...data.credits, balance: creditsBalance ?? data.credits.balance })
      : creditsBalance !== null
        ? { hasCredits: true, unlimited: null, balance: creditsBalance }
        : null,
    error: null,
  };
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
  const reasoning = Number(usage?.reasoningOutputTokens ?? 0);
  return Math.max(
    0,
    (Number.isFinite(input) ? input : 0) +
      (Number.isFinite(output) ? output : 0) +
      (Number.isFinite(reasoning) ? reasoning : 0)
  );
}

function codexRateCard(model) {
  const value = String(model || "").toLowerCase();
  return CODEX_RATE_CARDS.find((card) => card.pattern.test(value)) ?? DEFAULT_CODEX_RATE_CARD;
}

function quotaSpeedMultiplier(model, serviceTier = null) {
  const value = String(model || "").toLowerCase();
  const tier = String(serviceTier || "").toLowerCase();
  const isFast =
    /(^|[-_\s])fast($|[-_\s])|high[-_\s]?speed|speedy/.test(value) ||
    tier === "fast" ||
    tier === "priority";
  return isFast ? codexRateCard(model).fastMultiplier : 1;
}

function weightedTokenUsage(usage, model, serviceTier = null) {
  const input = Math.max(0, Number.isFinite(Number(usage?.inputTokens)) ? Number(usage.inputTokens) : 0);
  const cachedInput = Math.max(
    0,
    Number.isFinite(Number(usage?.cachedInputTokens)) ? Number(usage.cachedInputTokens) : 0
  );
  const output = Math.max(0, Number.isFinite(Number(usage?.outputTokens)) ? Number(usage.outputTokens) : 0);
  const hasBreakdown = [input, cachedInput, output].some((value) => Number.isFinite(value) && value > 0);
  const effectiveCachedInput = Math.min(cachedInput, input);
  const uncachedInput = Math.max(0, input - effectiveCachedInput);
  const rateCard = codexRateCard(model);
  const total = hasBreakdown
    ? (uncachedInput * rateCard.input +
        effectiveCachedInput * rateCard.cachedInput +
        output * rateCard.output) /
      QUOTA_RATE_CARD_BASE_INPUT_CREDITS
    : tokenUsageTotal(usage);
  return total * quotaSpeedMultiplier(model, serviceTier);
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

// Fast tail-based parser for usage statistics. Only reads the last ~128KB of
// each file to extract the final token_count (which contains cumulative totals),
// session metadata, and model info. Much faster than streaming the entire file
// for large sessions (100+ MB).
async function parseSessionFileFast(file, indexMap) {
  const maxTailBytes = 128 * 1024;
  const handle = await fs.open(file.path, "r");
  let headText = "";
  let tailText = "";
  try {
    const stat = await handle.stat();
    // Always read the first 8KB for session_meta and initial turn_context
    const headLen = Math.min(stat.size, 8192);
    const headBuf = Buffer.alloc(headLen);
    await handle.read(headBuf, 0, headLen, 0);
    headText = headBuf.toString("utf8");

    // Read the tail for the latest token_count
    const tailLen = Math.min(stat.size, maxTailBytes);
    const tailStart = Math.max(0, stat.size - tailLen);
    const tailBuf = Buffer.alloc(tailLen);
    await handle.read(tailBuf, 0, tailLen, tailStart);
    tailText = tailBuf.toString("utf8");
    if (tailStart > 0) {
      const firstBreak = tailText.indexOf("\n");
      tailText = firstBreak >= 0 ? tailText.slice(firstBreak + 1) : "";
    }
  } finally {
    await handle.close();
  }

  let sessionId = null;
  let cwd = null;
  let model = null;
  let startedAt = null;

  // Parse head for metadata
  for (const line of headText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id ?? sessionId;
      startedAt = entry.payload?.timestamp ?? startedAt;
      cwd = entry.payload?.cwd ?? cwd;
    } else if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
      cwd = entry.payload?.cwd ?? cwd;
    }
  }

  // Parse tail for latest token_count and model
  let lastTokenCount = null;
  let lastRateLimits = null;
  let lastTimestamp = new Date(file.mtimeMs).toISOString();
  for (const line of tailText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.timestamp) lastTimestamp = entry.timestamp;
    if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
      cwd = entry.payload?.cwd ?? cwd;
    } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      const info = entry.payload?.info ?? {};
      lastTokenCount = normalizeTokenUsage(info.total_token_usage ?? info.totalTokenUsage);
      if (entry.payload?.rate_limits) lastRateLimits = entry.payload.rate_limits;
    }
  }

  if (!lastTokenCount) return null;

  const indexed = sessionId ? indexMap.get(sessionId) : null;
  const title =
    indexed?.thread_name ||
    (cwd ? path.basename(cwd) || cwd : null) ||
    sessionId ||
    path.basename(file.path);
  const updatedAt = indexed?.updated_at ?? lastTimestamp;

  return {
    id: sessionId,
    title,
    cwd,
    model,
    startedAt,
    updatedAt,
    tokenUsage: lastTokenCount,
    rateLimits: lastRateLimits,
    tokenCountAt: lastTimestamp,
    rateLimitsAt: lastRateLimits ? lastTimestamp : null,
  };
}

const sessionFastParseCache = new Map();
async function parseSessionFileFastCached(file, indexMap) {
  const cacheKey = `fast:${file.path}:${file.size}:${file.mtimeMs}`;
  if (sessionFastParseCache.has(cacheKey)) return sessionFastParseCache.get(cacheKey);
  const parsed = await parseSessionFileFast(file, indexMap);
  sessionFastParseCache.set(cacheKey, parsed);
  if (sessionFastParseCache.size > 200) {
    const firstKey = sessionFastParseCache.keys().next().value;
    sessionFastParseCache.delete(firstKey);
  }
  return parsed;
}

function quotaFromLocalRateLimits(rateLimits, checkedAt, windowCheckedAt = {}) {
  if (!rateLimits) return null;
  return {
    source: "local",
    checkedAt,
    planType: rateLimits.plan_type ?? null,
    session: normalizeRateWindow(
      rateLimits.primary,
      windowCheckedAt.session ?? checkedAt,
      windowCheckedAt.sessionEstimateBase ?? windowCheckedAt.session ?? checkedAt,
      {
        estimateTokenUsage: windowCheckedAt.sessionEstimateTokenUsage,
        estimateWeightedTokens: windowCheckedAt.sessionEstimateWeightedTokens,
        estimateLatestAt: windowCheckedAt.sessionEstimateLatestAt,
      }
    ),
    weekly: normalizeRateWindow(
      rateLimits.secondary,
      windowCheckedAt.weekly ?? checkedAt,
      windowCheckedAt.weeklyEstimateBase ?? windowCheckedAt.weekly ?? checkedAt,
      {
        estimateTokenUsage: windowCheckedAt.weeklyEstimateTokenUsage,
        estimateWeightedTokens: windowCheckedAt.weeklyEstimateWeightedTokens,
        estimateLatestAt: windowCheckedAt.weeklyEstimateLatestAt,
      }
    ),
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
      checkedAt,
    },
    weekly: {
      usedPercent: Math.max(0, Math.min(100, numberHeader(headers, "x-codex-secondary-used-percent") ?? 0)),
      windowMinutes: numberHeader(headers, "x-codex-secondary-window-minutes"),
      resetsAt: secondaryResetAt,
      checkedAt,
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
    session: normalizeRateWindow(message.rate_limits.primary, checkedAt),
    weekly: normalizeRateWindow(message.rate_limits.secondary, checkedAt),
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
  if (Math.abs(rightMs - leftMs) <= QUOTA_CONFLICT_WINDOW_MS && sameNormalizedQuotaWindow(left, right)) {
    return moreConstrainedNormalizedQuota(left, right);
  }
  return rightMs > leftMs ? right : left;
}

function sameWindowIdentity(leftWindow, rightWindow) {
  if (!leftWindow || !rightWindow) return true;
  const leftReset = Number(leftWindow.resetsAt);
  const rightReset = Number(rightWindow.resetsAt);
  if (Number.isFinite(leftReset) && Number.isFinite(rightReset) && leftReset !== rightReset) return false;
  const leftMinutes = Number(leftWindow.windowMinutes);
  const rightMinutes = Number(rightWindow.windowMinutes);
  if (Number.isFinite(leftMinutes) && Number.isFinite(rightMinutes) && leftMinutes !== rightMinutes) return false;
  return true;
}

function sameNormalizedQuotaWindow(left, right) {
  if (!planTypesMatch(left?.planType, right?.planType)) return false;
  return sameWindowIdentity(left?.session, right?.session) && sameWindowIdentity(left?.weekly, right?.weekly);
}

function moreConstrainedNormalizedQuota(left, right) {
  const leftSessionUsed = Number(left?.session?.usedPercent);
  const rightSessionUsed = Number(right?.session?.usedPercent);
  if (Number.isFinite(leftSessionUsed) && Number.isFinite(rightSessionUsed) && leftSessionUsed !== rightSessionUsed) {
    return leftSessionUsed > rightSessionUsed ? left : right;
  }
  const leftWeeklyUsed = Number(left?.weekly?.usedPercent);
  const rightWeeklyUsed = Number(right?.weekly?.usedPercent);
  if (Number.isFinite(leftWeeklyUsed) && Number.isFinite(rightWeeklyUsed) && leftWeeklyUsed !== rightWeeklyUsed) {
    return leftWeeklyUsed > rightWeeklyUsed ? left : right;
  }
  return dateMs(right?.checkedAt) > dateMs(left?.checkedAt) ? right : left;
}

function rawQuotaWindowIdentity(rateLimits, kind) {
  const window = quotaRawWindow(rateLimits, kind);
  const resetAt = Number(window?.reset_at ?? window?.resets_at);
  const seconds = Number(window?.limit_window_seconds ?? window?.window_minutes * 60);
  return {
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    seconds: Number.isFinite(seconds) ? seconds : null,
  };
}

function rawQuotaValueSignature(rateLimits, kind) {
  return JSON.stringify({
    ...rawQuotaWindowIdentity(rateLimits, kind),
    usedPercent: rawUsedPercent(rateLimits, kind),
  });
}

function sameRawWindowIdentity(leftRateLimits, rightRateLimits, kind) {
  const left = rawQuotaWindowIdentity(leftRateLimits, kind);
  const right = rawQuotaWindowIdentity(rightRateLimits, kind);
  if (left.resetAt !== null && right.resetAt !== null && left.resetAt !== right.resetAt) return false;
  if (left.seconds !== null && right.seconds !== null && left.seconds !== right.seconds) return false;
  return true;
}

function sameRawQuotaWindow(left, right) {
  if (!planTypesMatch(left?.rateLimits?.plan_type, right?.rateLimits?.plan_type)) return false;
  return (
    sameRawWindowIdentity(left?.rateLimits, right?.rateLimits, "session") &&
    sameRawWindowIdentity(left?.rateLimits, right?.rateLimits, "weekly")
  );
}

function moreConstrainedRawQuota(left, right) {
  const leftSessionUsed = rawUsedPercent(left?.rateLimits, "session");
  const rightSessionUsed = rawUsedPercent(right?.rateLimits, "session");
  if (Number.isFinite(leftSessionUsed) && Number.isFinite(rightSessionUsed) && leftSessionUsed !== rightSessionUsed) {
    return leftSessionUsed > rightSessionUsed ? left : right;
  }
  const leftWeeklyUsed = rawUsedPercent(left?.rateLimits, "weekly");
  const rightWeeklyUsed = rawUsedPercent(right?.rateLimits, "weekly");
  if (Number.isFinite(leftWeeklyUsed) && Number.isFinite(rightWeeklyUsed) && leftWeeklyUsed !== rightWeeklyUsed) {
    return leftWeeklyUsed > rightWeeklyUsed ? left : right;
  }
  return dateMs(right?.timestamp) > dateMs(left?.timestamp) ? right : left;
}

function selectBestLocalQuotaCandidate(candidates) {
  const valid = candidates
    .filter((candidate) => candidate?.rateLimits && Number.isFinite(dateMs(candidate.timestamp)))
    .sort((a, b) => dateMs(b.timestamp) - dateMs(a.timestamp));
  const latest = valid[0];
  if (!latest) return null;
  const latestMs = dateMs(latest.timestamp);
  const comparable = valid.filter(
    (candidate) => latestMs - dateMs(candidate.timestamp) <= QUOTA_CONFLICT_WINDOW_MS && sameRawQuotaWindow(candidate, latest)
  );
  return comparable.reduce((best, candidate) => moreConstrainedRawQuota(best, candidate), latest);
}

function quotaEstimateSeedFromUsage(latestUsage, baseUsage, model, serviceTier, timestamp) {
  if (!latestUsage || !baseUsage) return {};
  const deltaUsage = subtractTokenUsage(latestUsage, baseUsage);
  const weightedTokens = weightedTokenUsage(deltaUsage, model, serviceTier);
  if (!Number.isFinite(weightedTokens) || weightedTokens <= 0) return {};
  return {
    estimateTokenUsage: deltaUsage,
    estimateWeightedTokens: weightedTokens,
    estimateLatestAt: timestamp,
  };
}

async function parseLatestRateLimitFile(file, sinceMs) {
  let latest = null;
  let previousSessionSignature = null;
  let previousWeeklySignature = null;
  let latestSessionChangeTimestamp = null;
  let latestWeeklyChangeTimestamp = null;
  let latestSessionChangeTokenUsage = null;
  let latestWeeklyChangeTokenUsage = null;
  let model = null;
  let serviceTier = null;

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
    if (entry.type === "turn_context") {
      model = entry.payload?.model ?? model;
      serviceTier =
        entry.payload?.service_tier ?? entry.payload?.serviceTier ?? entry.payload?.collaboration_mode?.settings?.service_tier ?? serviceTier;
      continue;
    }
    if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
    if (!entry.payload?.rate_limits) continue;
    const timestamp = entry.timestamp ?? new Date(file.mtimeMs).toISOString();
    const eventMs = new Date(timestamp).getTime();
    const info = entry.payload?.info ?? {};
    const tokenUsage = normalizeTokenUsage(info.total_token_usage ?? info.totalTokenUsage);
    const sessionSignature = rawQuotaValueSignature(entry.payload.rate_limits, "session");
    const weeklySignature = rawQuotaValueSignature(entry.payload.rate_limits, "weekly");
    const sessionChanged = previousSessionSignature === null || sessionSignature !== previousSessionSignature;
    const weeklyChanged = previousWeeklySignature === null || weeklySignature !== previousWeeklySignature;
    previousSessionSignature = sessionSignature;
    previousWeeklySignature = weeklySignature;
    if (sinceMs && Number.isFinite(eventMs) && eventMs < sinceMs) continue;
    if (sessionChanged) {
      latestSessionChangeTimestamp = timestamp;
      latestSessionChangeTokenUsage = cloneTokenUsage(tokenUsage);
    }
    if (weeklyChanged) {
      latestWeeklyChangeTimestamp = timestamp;
      latestWeeklyChangeTokenUsage = cloneTokenUsage(tokenUsage);
    }
    const sessionSeed = quotaEstimateSeedFromUsage(
      tokenUsage,
      latestSessionChangeTokenUsage,
      model,
      serviceTier,
      timestamp
    );
    const weeklySeed = quotaEstimateSeedFromUsage(tokenUsage, latestWeeklyChangeTokenUsage, model, serviceTier, timestamp);
    latest = {
      rateLimits: entry.payload.rate_limits,
      timestamp,
      windowTimestamps: {
        session: timestamp,
        weekly: timestamp,
        sessionEstimateBase: latestSessionChangeTimestamp ?? timestamp,
        weeklyEstimateBase: latestWeeklyChangeTimestamp ?? timestamp,
        sessionEstimateTokenUsage: sessionSeed.estimateTokenUsage,
        sessionEstimateWeightedTokens: sessionSeed.estimateWeightedTokens,
        sessionEstimateLatestAt: sessionSeed.estimateLatestAt,
        weeklyEstimateTokenUsage: weeklySeed.estimateTokenUsage,
        weeklyEstimateWeightedTokens: weeklySeed.estimateWeightedTokens,
        weeklyEstimateLatestAt: weeklySeed.estimateLatestAt,
      },
    };
  }
  return latest;
}

async function parseQuotaEventFile(file) {
  const events = [];
  let sessionId = null;
  let startedAtMs = null;
  let model = null;
  let serviceTier = null;

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
      serviceTier =
        entry.payload?.service_tier ?? entry.payload?.serviceTier ?? entry.payload?.collaboration_mode?.settings?.service_tier ?? serviceTier;
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
        serviceTier,
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
    const serviceTier = response.service_tier || response.serviceTier || response.metadata?.service_tier || null;
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
      serviceTier,
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
  const serviceTier = fields.service_tier || fields["service.tier"] || null;
  return {
    id: row?.id ?? null,
    sessionId: `sqlite:${conversationId}`,
    timestamp,
    ms,
    model,
    serviceTier,
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
          serviceTier: event.serviceTier,
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
  return planTypesMatch(eventPlan, planType);
}

function fallbackQuotaCreditUnitsPerPercent(planType, kind) {
  const plan = normalizePlanType(planType);
  if (kind === "weekly") {
    if (plan === "business" || plan === "enterprise") return 137000;
    if (plan === "plus") return 180000;
    return 100000;
  }
  if (plan === "business" || plan === "enterprise") return 24000;
  if (plan === "plus") return 36000;
  return 22000;
}

function quotaCoefficientBounds(planType, kind) {
  const fallbackUnits = fallbackQuotaCreditUnitsPerPercent(planType, kind);
  const minUnits = kind === "weekly" ? 25000 : 8000;
  const maxUnits = kind === "weekly" ? 4000000 : 1500000;
  return {
    min: Math.min(1 / maxUnits, 1 / (fallbackUnits * 25)),
    max: Math.max(1 / minUnits, 25 / fallbackUnits),
  };
}

function isReasonableQuotaCoefficient(coefficient, planType, kind) {
  if (!Number.isFinite(coefficient) || coefficient <= 0) return false;
  const bounds = quotaCoefficientBounds(planType, kind);
  return coefficient >= bounds.min && coefficient <= bounds.max;
}

function addCalibrationSample(samples, percentDelta, weightedTokens, planType, kind) {
  if (!Number.isFinite(percentDelta) || !Number.isFinite(weightedTokens)) return;
  if (percentDelta <= 0 || percentDelta > 40 || weightedTokens < 1000) return;
  const coefficient = percentDelta / weightedTokens;
  if (isReasonableQuotaCoefficient(coefficient, planType, kind)) samples.push(coefficient);
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

  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => a.ms - b.ms);
    const trackers = {
      session: { samples: sessionSamples, lastChangeEvent: null, maxTokensSinceChange: null },
      weekly: { samples: weeklySamples, lastChangeEvent: null, maxTokensSinceChange: null },
    };
    for (const event of sessionEvents) {
      if (!event.rateLimits || !rateLimitsMatchPlan(event.rateLimits, planType)) continue;
      for (const kind of ["session", "weekly"]) {
        const tracker = trackers[kind];
        const currentPercent = rawUsedPercent(event.rateLimits, kind);
        if (!Number.isFinite(currentPercent)) continue;

        if (!tracker.lastChangeEvent) {
          tracker.lastChangeEvent = event;
          tracker.maxTokensSinceChange = event;
          continue;
        }

        const previousPercent = rawUsedPercent(tracker.lastChangeEvent.rateLimits, kind);
        const changed = Number.isFinite(previousPercent) && currentPercent !== previousPercent;
        if (changed) {
          const deltaUsage = subtractTokenUsage(event.tokenUsage, tracker.lastChangeEvent.tokenUsage);
          const weightedTokens = weightedTokenUsage(
            deltaUsage,
            event.model || tracker.lastChangeEvent.model,
            event.serviceTier || tracker.lastChangeEvent.serviceTier
          );
          const sampleMs = event.ms ?? nowMs;
          const isRecent = nowMs - sampleMs <= sevenDaysMs;
          addTaggedCalibrationSample(tracker.samples, currentPercent - previousPercent, weightedTokens, isRecent, planType, kind);
          tracker.lastChangeEvent = event;
          tracker.maxTokensSinceChange = event;
        } else if (
          tokenUsageTotal(event.tokenUsage) > tokenUsageTotal(tracker.maxTokensSinceChange.tokenUsage)
        ) {
          tracker.maxTokensSinceChange = event;
        }
      }
    }
  }

  // Prefer recent samples (last 7 days) when we have enough of them.
  // Otherwise fall back to all samples for stability.
  const sessionRecent = sessionSamples.filter((s) => s.recent).map((s) => s.coeff);
  const sessionAll = sessionSamples.map((s) => s.coeff);
  const weeklyRecent = weeklySamples.filter((s) => s.recent).map((s) => s.coeff);
  const weeklyAll = weeklySamples.map((s) => s.coeff);

  const sessionPool = sessionRecent.length >= 5 ? sessionRecent : sessionAll;
  const weeklyPool = weeklyRecent.length >= 5 ? weeklyRecent : weeklyAll;

  return {
    sessionCoefficient: median(sessionPool),
    weeklyCoefficient: median(weeklyPool),
    sessionSamples: sessionPool.length,
    weeklySamples: weeklyPool.length,
    sessionRecentCount: sessionRecent.length,
    weeklyRecentCount: weeklyRecent.length,
  };
}

function addTaggedCalibrationSample(samples, percentDelta, weightedTokens, isRecent, planType, kind) {
  if (!Number.isFinite(percentDelta) || !Number.isFinite(weightedTokens)) return;
  if (percentDelta <= 0 || percentDelta > 40 || weightedTokens < 1000) return;
  const coefficient = percentDelta / weightedTokens;
  if (isReasonableQuotaCoefficient(coefficient, planType, kind)) {
    samples.push({ coeff: coefficient, recent: !!isRecent });
  }
}

function tokenDeltaSinceBase(events, baseMs, kind = "session") {
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

    // Detect if rate_limits stayed constant throughout this session.
    // If so, the base quota snapshot is stale for the entire session and we
    // should measure token delta from the session's first event to the latest.
    const firstRL = rawUsedPercent(sessionEvents.find((e) => e.rateLimits)?.rateLimits, kind);
    const lastRL = rawUsedPercent([...sessionEvents].reverse().find((e) => e.rateLimits)?.rateLimits, kind);
    const rateLimitsStatic = firstRL !== null && firstRL === lastRL;

    let effectiveBaseMs = baseMs;
    if (rateLimitsStatic && sessionEvents.length >= 2) {
      // If the quota snapshot predates this session, use the first token event
      // as the local baseline. Do not move the baseline backward when the
      // snapshot was taken mid-session; doing so double-counts tokens already
      // covered by that snapshot and can greatly overestimate quota usage.
      effectiveBaseMs = baseMs < sessionEvents[0].ms ? sessionEvents[0].ms : baseMs;
    }

    const after = sessionEvents.filter((event) => event.ms > effectiveBaseMs);
    if (!after.length) continue;
    const latestAfter = after[after.length - 1];
    const before = [...sessionEvents].reverse().find((event) => event.ms <= effectiveBaseMs);

    let deltaUsage = null;
    if (before) {
      deltaUsage = subtractTokenUsage(latestAfter.tokenUsage, before.tokenUsage);
    } else if (after.length >= 2) {
      // No event before the base; use first event in after as the reference
      deltaUsage = subtractTokenUsage(latestAfter.tokenUsage, after[0].tokenUsage);
    } else if (Number.isFinite(latestAfter.startedAtMs) && latestAfter.startedAtMs >= effectiveBaseMs) {
      deltaUsage = latestAfter.tokenUsage;
    }

    if (!deltaUsage || tokenUsageTotal(deltaUsage) <= 0) continue;
    addTokenUsage(tokenUsage, deltaUsage);
    weightedTokens += weightedTokenUsage(deltaUsage, latestAfter.model, latestAfter.serviceTier);
    sessions += 1;
    if (latestAfter.ms >= latestMs) {
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
  if (!Number.isFinite(deltaPercent) || deltaPercent < 0.25) return null;
  const estimatedUsed = Math.max(baseUsed, Math.min(100, baseUsed + deltaPercent));
  return {
    estimatedUsedPercent: Math.ceil(estimatedUsed),
    estimatedRemainingPercent: Math.floor(Math.max(0, 100 - estimatedUsed)),
    estimatedDeltaPercent: Math.round((estimatedUsed - baseUsed) * 10) / 10,
    estimatedWeightedTokens: Math.round(weightedTokens),
    estimateCoefficient: coefficient,
    estimateSamples: sampleCount,
  };
}

function coefficientFromCalibration(calibration, kind, planType) {
  if (calibration?.algorithm !== QUOTA_ESTIMATE_ALGORITHM) return null;
  const window = calibration?.[kind];
  const value = Number(window?.coefficient);
  if (!isReasonableQuotaCoefficient(value, planType, kind)) return null;

  const lastSampleCoefficient = Number(window?.lastSample?.coefficient);
  const actualDelta = Number(window?.lastSample?.actualDelta);
  const predictedDelta = Number(window?.lastSample?.predictedDelta);
  if (
    Number.isFinite(lastSampleCoefficient) &&
    lastSampleCoefficient > 0 &&
    Number.isFinite(actualDelta) &&
    actualDelta > 0 &&
    Number.isFinite(predictedDelta) &&
    predictedDelta > actualDelta * 2
  ) {
    const capped = Math.min(value, lastSampleCoefficient * 1.5);
    return isReasonableQuotaCoefficient(capped, planType, kind) ? capped : null;
  }

  return value;
}

function fallbackQuotaCoefficient(planType, kind) {
  return 1 / fallbackQuotaCreditUnitsPerPercent(planType, kind);
}

function selectQuotaCoefficient(kind, planType, historicalCoefficient, historicalSamples, activeCoefficient, activeSamples) {
  const fallback = fallbackQuotaCoefficient(planType, kind);
  const hasHistorical = Number.isFinite(historicalCoefficient) && Number(historicalSamples || 0) >= 3;
  const hasActive = Number.isFinite(activeCoefficient) && Number(activeSamples || 0) >= 1;
  if (hasActive && hasHistorical) {
    const min = historicalCoefficient * 0.5;
    const max = historicalCoefficient * 2;
    if (activeCoefficient >= min && activeCoefficient <= max) {
      return {
        coefficient: activeSamples >= 2 ? activeCoefficient : activeCoefficient * 0.65 + historicalCoefficient * 0.35,
        source: activeSamples >= 2 ? "active-session" : "active-session-blended",
      };
    }
    return { coefficient: historicalCoefficient, source: "calibrated" };
  }
  if (hasHistorical) return { coefficient: historicalCoefficient, source: "calibrated" };
  if (hasActive && activeSamples >= 2) return { coefficient: activeCoefficient, source: "active-session" };
  if (hasActive) {
    return {
      coefficient: activeCoefficient * 0.75 + fallback * 0.25,
      source: "active-session-low-sample",
    };
  }
  if (Number.isFinite(historicalCoefficient)) return { coefficient: historicalCoefficient, source: "low-sample" };
  return { coefficient: fallback, source: "fallback" };
}

function blendLearnedCoefficient(kind, selected, learnedCoefficient, planType) {
  if (!Number.isFinite(learnedCoefficient) || learnedCoefficient <= 0) return selected;
  if (!isReasonableQuotaCoefficient(learnedCoefficient, planType, kind)) return selected;
  const base = Number(selected?.coefficient);
  if (!Number.isFinite(base) || base <= 0) return { coefficient: learnedCoefficient, source: "learned" };
  const min = base * 0.5;
  const max = base * 2;
  const bounded = Math.max(min, Math.min(max, learnedCoefficient));
  return {
    coefficient: bounded * 0.4 + base * 0.6,
    source: selected?.source ? `learned-${selected.source}` : "learned",
  };
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
    algorithm: QUOTA_ESTIMATE_ALGORITHM,
    available: false,
    reason,
  };
}

function tokenDeltaFromEstimateSeed(window) {
  const weightedTokens = Number(window?.estimateWeightedTokens);
  if (!Number.isFinite(weightedTokens) || weightedTokens <= 0) return null;
  const latestAt = window?.estimateLatestAt ?? window?.checkedAt;
  if (!latestAt) return null;
  return {
    tokenUsage: cloneTokenUsage(window?.estimateTokenUsage),
    weightedTokens,
    latestAt,
    sessions: 1,
  };
}

async function readQuotaEstimate(options = {}) {
  const baseQuota = options.baseQuota;
  if (!baseQuota || baseQuota.source !== "local") {
    return quotaEstimateUnavailable("\u7b49\u5f85\u672c\u5730\u989d\u5ea6\u5feb\u7167");
  }
  const sessionBaseMs = dateMs(baseQuota.session?.estimateBaseAt ?? baseQuota.session?.checkedAt ?? baseQuota.checkedAt);
  const weeklyBaseMs = dateMs(baseQuota.weekly?.estimateBaseAt ?? baseQuota.weekly?.checkedAt ?? baseQuota.checkedAt);
  const baseTimes = [sessionBaseMs, weeklyBaseMs].filter(Number.isFinite);
  if (!baseTimes.length) return quotaEstimateUnavailable("\u5feb\u7167\u65f6\u95f4\u4e0d\u53ef\u7528");
  const earliestBaseMs = Math.min(...baseTimes);

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
    effectiveSinceMs && Number.isFinite(effectiveSinceMs) ? Math.min(effectiveSinceMs, earliestBaseMs) : earliestBaseMs;
  const sqliteEvents = await readSqliteResponseCompletedEvents({ sinceMs: sqliteSinceMs });
  const events = [...sessionEvents, ...sqliteEvents];
  if (!events.length) return quotaEstimateUnavailable("\u672a\u627e\u5230\u672c\u5730 token \u8bb0\u5f55");
  events.sort((a, b) => a.ms - b.ms);
  sessionEvents.sort((a, b) => a.ms - b.ms);
  sqliteEvents.sort((a, b) => a.ms - b.ms);

  const scopedSessionEvents = effectiveSinceMs ? sessionEvents.filter((event) => event.ms >= effectiveSinceMs) : sessionEvents;
  const scopedSqliteEvents = effectiveSinceMs ? sqliteEvents.filter((event) => event.ms >= effectiveSinceMs) : sqliteEvents;
  const seededSessionDelta = tokenDeltaFromEstimateSeed(baseQuota.session);
  const seededWeeklyDelta = tokenDeltaFromEstimateSeed(baseQuota.weekly);
  const eventSessionDelta = Number.isFinite(sessionBaseMs)
    ? newerTokenDelta(
        tokenDeltaSinceBase(scopedSessionEvents, sessionBaseMs, "session"),
        tokenDeltaSinceBase(scopedSqliteEvents, sessionBaseMs, "session")
      )
    : null;
  const eventWeeklyDelta = Number.isFinite(weeklyBaseMs)
    ? newerTokenDelta(
        tokenDeltaSinceBase(scopedSessionEvents, weeklyBaseMs, "weekly"),
        tokenDeltaSinceBase(scopedSqliteEvents, weeklyBaseMs, "weekly")
      )
    : null;
  const sessionDelta = seededSessionDelta ?? eventSessionDelta;
  const weeklyDelta = seededWeeklyDelta ?? eventWeeklyDelta;
  const freshestDelta = newerTokenDelta(sessionDelta, weeklyDelta);
  if (!sessionDelta?.latestAt && !weeklyDelta?.latestAt) {
    const baseAgeMs = Date.now() - earliestBaseMs;
    if (Number.isFinite(baseAgeMs) && baseAgeMs < 5 * 60 * 1000) return null;
    return quotaEstimateUnavailable("\u7b49\u5f85\u5feb\u7167\u540e\u7684 token \u8bb0\u5f55");
  }

  const calibration = collectQuotaCalibration(sessionEvents, baseQuota.planType);

  // Active-session calibration: if rate_limits changed within the most recent
  // active session, use that change as a high-confidence calibration sample
  // for predicting further consumption in the same session. This adapts to
  // the current task's actual token-to-quota ratio (which can vary 2-3x by
  // task type even within the same plan).
  const activeSessionCalibration = computeActiveSessionCalibration(scopedSessionEvents, baseQuota.planType);

  const sessionCoefficient = selectQuotaCoefficient(
    "session",
    baseQuota.planType,
    calibration.sessionCoefficient,
    calibration.sessionSamples,
    activeSessionCalibration.sessionCoefficient,
    activeSessionCalibration.sessionSamples
  );
  const weeklyCoefficient = selectQuotaCoefficient(
    "weekly",
    baseQuota.planType,
    calibration.weeklyCoefficient,
    calibration.weeklySamples,
    activeSessionCalibration.weeklyCoefficient,
    activeSessionCalibration.weeklySamples
  );
  const learned = options.calibration;
  const tunedSessionCoefficient = blendLearnedCoefficient(
    "session",
    sessionCoefficient,
    coefficientFromCalibration(learned, "session", baseQuota.planType),
    baseQuota.planType
  );
  const tunedWeeklyCoefficient = blendLearnedCoefficient(
    "weekly",
    weeklyCoefficient,
    coefficientFromCalibration(learned, "weekly", baseQuota.planType),
    baseQuota.planType
  );
  const sessionEstimateCoefficient = seededSessionDelta
    ? Math.min(tunedSessionCoefficient.coefficient, quotaCoefficientBounds(baseQuota.planType, "session").max)
    : tunedSessionCoefficient.coefficient;
  const sessionEstimate =
    sessionDelta?.weightedTokens >= 100
      ? buildWindowEstimate(baseQuota.session, sessionEstimateCoefficient, sessionDelta.weightedTokens, calibration.sessionSamples)
      : null;
  // Weekly quota moves slowly and local Codex logs normally include the latest
  // weekly rate_limit snapshot. Estimating between snapshots tends to be more
  // confusing than useful, so keep weekly display pinned to the observed value.
  const weeklyEstimate = null;

  if (!sessionEstimate && !weeklyEstimate) return quotaEstimateUnavailable("\u7b49\u5f85\u5386\u53f2\u6821\u51c6\u6837\u672c");
  return {
    source: "local-estimate",
    algorithm: QUOTA_ESTIMATE_ALGORITHM,
    available: true,
    checkedAt: freshestDelta?.latestAt,
    baseCheckedAt: baseQuota.checkedAt,
    weightedTokens: Math.round(Math.max(sessionDelta?.weightedTokens ?? 0, weeklyDelta?.weightedTokens ?? 0)),
    tokenUsage: freshestDelta?.tokenUsage ?? sessionDelta?.tokenUsage ?? weeklyDelta?.tokenUsage,
    sessions: Math.max(sessionDelta?.sessions ?? 0, weeklyDelta?.sessions ?? 0),
    confidence: [tunedSessionCoefficient.source, tunedWeeklyCoefficient.source].includes("active-session")
      ? "active-session"
      : [tunedSessionCoefficient.source, tunedWeeklyCoefficient.source].some((source) => String(source).startsWith("active-session"))
        ? "active-session-blended"
        : [tunedSessionCoefficient.source, tunedWeeklyCoefficient.source].some((source) => String(source).startsWith("learned"))
          ? "learned"
          : [tunedSessionCoefficient.source, tunedWeeklyCoefficient.source].includes("calibrated")
          ? "calibrated"
          : [tunedSessionCoefficient.source, tunedWeeklyCoefficient.source].includes("low-sample")
            ? "low-sample"
            : "fallback",
    session: sessionEstimate,
    weekly: weeklyEstimate,
  };
}

// Compute calibration coefficient from rate_limits changes that happened
// within the current (most recent) session. This captures the actual token
// consumption pattern of the running task, which is far more accurate than
// historical averages for long-running agentic work.
function computeActiveSessionCalibration(events, planType) {
  if (!events.length) return { sessionCoefficient: null, weeklyCoefficient: null };

  // Find the most recent session
  const bySession = new Map();
  for (const event of events) {
    const key = event.sessionId || event.filePath;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(event);
  }

  let mostRecentSessionEvents = null;
  let mostRecentMs = 0;
  for (const sessionEvts of bySession.values()) {
    const lastMs = Math.max(...sessionEvts.map((e) => e.ms));
    if (lastMs > mostRecentMs) {
      mostRecentMs = lastMs;
      mostRecentSessionEvents = sessionEvts;
    }
  }
  if (!mostRecentSessionEvents) return { sessionCoefficient: null, weeklyCoefficient: null };

  mostRecentSessionEvents.sort((a, b) => a.ms - b.ms);

  // Collect calibration samples within this session only
  const sessionSamples = [];
  const weeklySamples = [];
  const trackers = {
    session: { samples: sessionSamples, lastChangeEvent: null, maxTokensSinceChange: null },
    weekly: { samples: weeklySamples, lastChangeEvent: null, maxTokensSinceChange: null },
  };

  for (const event of mostRecentSessionEvents) {
    if (!event.rateLimits || !rateLimitsMatchPlan(event.rateLimits, planType)) continue;
    for (const kind of ["session", "weekly"]) {
      const tracker = trackers[kind];
      const currentPercent = rawUsedPercent(event.rateLimits, kind);
      if (!Number.isFinite(currentPercent)) continue;

      if (!tracker.lastChangeEvent) {
        tracker.lastChangeEvent = event;
        tracker.maxTokensSinceChange = event;
        continue;
      }

      const previousPercent = rawUsedPercent(tracker.lastChangeEvent.rateLimits, kind);
      const changed = Number.isFinite(previousPercent) && currentPercent !== previousPercent;
      if (changed) {
        const deltaUsage = subtractTokenUsage(event.tokenUsage, tracker.lastChangeEvent.tokenUsage);
        const weightedTokens = weightedTokenUsage(
          deltaUsage,
          event.model || tracker.lastChangeEvent.model,
          event.serviceTier || tracker.lastChangeEvent.serviceTier
        );
        addCalibrationSample(tracker.samples, currentPercent - previousPercent, weightedTokens, planType, kind);
        tracker.lastChangeEvent = event;
        tracker.maxTokensSinceChange = event;
      } else if (
        tokenUsageTotal(event.tokenUsage) > tokenUsageTotal(tracker.maxTokensSinceChange.tokenUsage)
      ) {
        tracker.maxTokensSinceChange = event;
      }
    }
  }

  // Need at least 1 in-session sample to use this; we trust it since it
  // comes from the actual running task.
  return {
    sessionCoefficient: sessionSamples.length >= 1 ? median(sessionSamples) : null,
    weeklyCoefficient: weeklySamples.length >= 1 ? median(weeklySamples) : null,
    sessionSamples: sessionSamples.length,
    weeklySamples: weeklySamples.length,
  };
}

function attachQuotaEstimate(quota, estimate) {
  if (!quota || !estimate) return quota;
  let hasEstimate = false;
  const next = {
    ...quota,
    estimate: {
      source: estimate.source,
      algorithm: estimate.algorithm,
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

const rateLimitFileCache = new Map();

async function readLatestLocalQuota(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const files = options.files ?? (await walkSessionFiles(sessionsDir()));
  const recentFiles = files.slice(0, 24);
  const candidates = [];

  for (const file of recentFiles) {
    let parsed;
    try {
      const cacheKey = `rl:${file.path}:${file.size}:${file.mtimeMs}`;
      if (rateLimitFileCache.has(cacheKey)) {
        parsed = rateLimitFileCache.get(cacheKey);
      } else {
        parsed = await parseLatestRateLimitFile(file, null);
        rateLimitFileCache.set(cacheKey, parsed);
        if (rateLimitFileCache.size > 30) {
          const firstKey = rateLimitFileCache.keys().next().value;
          rateLimitFileCache.delete(firstKey);
        }
      }
    } catch {
      continue;
    }
    if (!parsed?.rateLimits) continue;
    // Apply since filter after cache lookup
    if (effectiveSinceMs && parsed.timestamp) {
      const parsedMs = new Date(parsed.timestamp).getTime();
      if (Number.isFinite(parsedMs) && parsedMs < effectiveSinceMs) continue;
    }
    candidates.push(parsed);
  }
  const latest = selectBestLocalQuotaCandidate(candidates);
  if (latest?.rateLimits) {
    return quotaFromLocalRateLimits(latest.rateLimits, latest.timestamp, latest.windowTimestamps);
  }
  return null;
}

async function readLocalUsage(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceMs = Number.isFinite(sinceMs) ? sinceMs : null;
  const files = options.files ?? (await walkSessionFiles(sessionsDir()));
  const indexMap = await readSessionIndexMap();
  const scanLimit = Number.isFinite(options.scanLimit) ? options.scanLimit : 80;
  const recentFiles = files.slice(0, scanLimit);
  const sessions = [];
  let latestQuota = null;

  // Use fast tail-based parser for usage statistics. The token_count events
  // contain cumulative totals, so reading only the tail gives us the final
  // values without streaming through hundreds of MB of JSONL.
  const useFastParser = true;

  for (const file of recentFiles) {
    let parsed;
    try {
      parsed = useFastParser
        ? await parseSessionFileFastCached(file, indexMap)
        : await parseSessionFileCached(file, indexMap, { sinceMs: effectiveSinceMs });
    } catch {
      continue;
    }
    if (!parsed) continue;
    // When using fast parser with a since filter, skip sessions that ended before since
    if (effectiveSinceMs && useFastParser) {
      const updatedMs = new Date(parsed.updatedAt).getTime();
      if (Number.isFinite(updatedMs) && updatedMs < effectiveSinceMs) continue;
    }
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

  // Per-project aggregation using session cwd
  const byProject = new Map();
  for (const session of sessions) {
    const project = session.cwd ? path.basename(session.cwd) || session.cwd : "未知项目";
    if (!byProject.has(project)) byProject.set(project, { project, cwd: session.cwd, sessions: 0, tokenUsage: emptyTokenUsage() });
    const projectEntry = byProject.get(project);
    projectEntry.sessions += 1;
    addTokenUsage(projectEntry.tokenUsage, session.tokenUsage);
  }

  return {
    source: "local",
    scannedFiles: recentFiles.length,
    totalFiles: files.length,
    sessionsAnalyzed: sessions.length,
    tokenUsage: total,
    models: Array.from(byModel.values()).sort((a, b) => b.tokenUsage.totalTokens - a.tokenUsage.totalTokens),
    daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)).slice(-7),
    projects: Array.from(byProject.values()).sort((a, b) => b.tokenUsage.totalTokens - a.tokenUsage.totalTokens).slice(0, 10),
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
    accountQuotaCalibration: account?.quotaCalibration ?? null,
    settings: normalizeSettings(index.settings),
    since: account?.lastSwitchedAt ?? null,
    mode: account?.lastSwitchedAt ? "since-account-switch" : "all-local",
  };
}

async function saveAccountQuotaSnapshot(accountId, quota) {
  if (!accountId || !quota || !["local", "local-error", "online"].includes(quota.source)) return false;
  return mutateIndex(async (index) => {
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) return { value: false, write: false };
    if (!quotaMatchesAccount(account, quota)) return { value: false, write: false };
    const learned = updateQuotaLearning(account, quota);
    const nextSnapshot = buildAccountQuotaSnapshot(quota, account.quotaSnapshot);
    const previous = JSON.stringify(account.quotaSnapshot ?? null);
    const next = JSON.stringify(nextSnapshot);
    if (previous === next && !learned) return { value: false, write: false };
    account.quotaSnapshot = nextSnapshot;
    account.quotaSnapshotUpdatedAt = new Date().toISOString();
    return { value: true };
  });
}

function quotaMatchesAccount(account, quota) {
  const accountPlan = account?.identity?.planType;
  const quotaPlan = quota?.planType;
  return planTypesMatch(accountPlan, quotaPlan);
}

function quotaWindowHasDisplayData(window) {
  if (!window) return false;
  const hasNumber = (value) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
  return (
    hasNumber(window.usedPercent) ||
    hasNumber(window.resetsAt) ||
    hasNumber(window.windowMinutes)
  );
}

function mergeAccountQuotaWindow(nextWindow, previousWindow) {
  if (quotaWindowHasDisplayData(nextWindow)) return nextWindow;
  return quotaWindowHasDisplayData(previousWindow) ? previousWindow : nextWindow ?? null;
}

function buildAccountQuotaSnapshot(quota, previousSnapshot = null) {
  const canReusePrevious =
    previousSnapshot &&
    planTypesMatch(previousSnapshot.planType, quota.planType) &&
    (quotaWindowHasDisplayData(previousSnapshot.session) || quotaWindowHasDisplayData(previousSnapshot.weekly));
  const session = canReusePrevious ? mergeAccountQuotaWindow(quota.session, previousSnapshot.session) : quota.session ?? null;
  const weekly = canReusePrevious ? mergeAccountQuotaWindow(quota.weekly, previousSnapshot.weekly) : quota.weekly ?? null;
  const reusedWindow =
    canReusePrevious &&
    ((!quotaWindowHasDisplayData(quota.session) && quotaWindowHasDisplayData(previousSnapshot.session)) ||
      (!quotaWindowHasDisplayData(quota.weekly) && quotaWindowHasDisplayData(previousSnapshot.weekly)));
  const hasFreshWindow = quotaWindowHasDisplayData(quota.session) || quotaWindowHasDisplayData(quota.weekly);
  return {
    source: quota.source,
    checkedAt: hasFreshWindow ? quota.checkedAt : previousSnapshot?.checkedAt ?? quota.checkedAt,
    planType: quota.planType ?? previousSnapshot?.planType ?? null,
    session,
    weekly,
    review: quota.review ?? previousSnapshot?.review ?? null,
    additional: Array.isArray(quota.additional) ? quota.additional : previousSnapshot?.additional ?? [],
    credits: quota.credits ?? previousSnapshot?.credits ?? null,
    error: quota.error ?? (reusedWindow ? "本次本地日志未写入完整额度窗口，保留此账号上次可用快照。" : null),
    estimate: quota.estimate ?? null,
  };
}

function windowLearningSample(previousSnapshot, nextQuota, kind) {
  const previousWindow = previousSnapshot?.[kind];
  const nextWindow = nextQuota?.[kind];
  const estimate = previousWindow?.estimatedDeltaPercent;
  const previousUsed = Number(previousWindow?.usedPercent);
  const nextUsed = Number(nextWindow?.usedPercent);
  const previousEstimateTokens = Number(
    previousWindow?.estimatedWeightedTokens ?? previousSnapshot?.estimate?.weightedTokens
  );
  if (!Number.isFinite(estimate) || estimate <= 0) return null;
  if (!Number.isFinite(previousUsed) || !Number.isFinite(nextUsed)) return null;
  if (!Number.isFinite(previousEstimateTokens) || previousEstimateTokens < 1000) return null;
  if (previousWindow?.resetsAt && nextWindow?.resetsAt && Number(previousWindow.resetsAt) !== Number(nextWindow.resetsAt)) {
    return null;
  }
  const actualDelta = nextUsed - previousUsed;
  if (!Number.isFinite(actualDelta) || actualDelta <= 0 || actualDelta > 40) return null;
  const coefficient = actualDelta / previousEstimateTokens;
  if (!Number.isFinite(coefficient) || coefficient <= 0 || coefficient >= 0.01) return null;
  return {
    coefficient,
    actualDelta: Math.round(actualDelta * 10) / 10,
    predictedDelta: Math.round(estimate * 10) / 10,
    weightedTokens: Math.round(previousEstimateTokens),
    observedAt: nextQuota.checkedAt ?? new Date().toISOString(),
  };
}

function updateLearningWindow(existing, sample) {
  if (!sample) return existing ?? null;
  const previous = Number(existing?.coefficient);
  const previousSamples = Number(existing?.samples || 0);
  const predictedDelta = Number(sample.predictedDelta);
  const actualDelta = Number(sample.actualDelta);
  const needsFastCorrection =
    Number.isFinite(predictedDelta) &&
    Number.isFinite(actualDelta) &&
    actualDelta > 0 &&
    (predictedDelta > actualDelta * 2 || actualDelta > predictedDelta * 1.5);
  const sampleWeight = needsFastCorrection ? 0.55 : 0.2;
  const coefficient = Number.isFinite(previous) && previous > 0
    ? previous * (1 - sampleWeight) + sample.coefficient * sampleWeight
    : sample.coefficient;
  return {
    coefficient,
    samples: Math.min(200, previousSamples + 1),
    updatedAt: sample.observedAt,
    lastSample: sample,
  };
}

function updateQuotaLearning(account, nextQuota) {
  if (!account?.quotaSnapshot || !nextQuota || nextQuota.source !== "local") return false;
  const currentLearning = account.quotaCalibration && typeof account.quotaCalibration === "object"
    ? account.quotaCalibration
    : {};
  const sessionSample = windowLearningSample(account.quotaSnapshot, nextQuota, "session");
  const weeklySample = windowLearningSample(account.quotaSnapshot, nextQuota, "weekly");
  if (!sessionSample && !weeklySample) return false;
  account.quotaCalibration = {
    ...currentLearning,
    algorithm: QUOTA_ESTIMATE_ALGORITHM,
    session: updateLearningWindow(currentLearning.session, sessionSample),
    weekly: updateLearningWindow(currentLearning.weekly, weeklySample),
  };
  return true;
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
    latestQuota && scope.accountPlanType && latestQuota.planType && !planTypesMatch(latestQuota.planType, scope.accountPlanType)
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

async function readBestLocalQuota(scope, files) {
  return newerQuota(
    newerQuota(
      await readLatestLocalQuota({ since: scope.since, files }),
      await readLatestSqliteRateLimitQuota({ since: scope.since })
    ),
    await readLatestUsageLimitQuota({ since: scope.since })
  );
}

async function resolveQuotaWithMode(scope, files, usage = null) {
  const quotaMode = normalizeSettings(scope.settings).quotaMode;
  if (quotaMode === QUOTA_MODE_ONLINE) {
    try {
      const onlineQuota = await readOnlineQuota(scope);
      const resolvedOnlineQuota = resolveQuota(scope, onlineQuota);
      if (scope.accountId) {
        await saveAccountQuotaSnapshot(scope.accountId, resolvedOnlineQuota);
      }
      return resolvedOnlineQuota;
    } catch (error) {
      const latestQuota = await readBestLocalQuota(scope, files);
      const baseQuota = latestQuota ?? usage?.latestQuota ?? null;
      const quotaEstimate = await readQuotaEstimate({
        since: scope.since,
        files,
        baseQuota,
        calibration: scope.accountQuotaCalibration,
      });
      const fallbackQuota = attachQuotaEstimate(resolveQuota(scope, baseQuota), quotaEstimate);
      return {
        ...fallbackQuota,
        error: `联网读取失败，已回退本地估算：${error.message}`,
      };
    }
  }

  const latestQuota = await readBestLocalQuota(scope, files);
  const baseQuota = latestQuota ?? usage?.latestQuota ?? null;
  const quotaEstimate = await readQuotaEstimate({
    since: scope.since,
    files,
    baseQuota,
    calibration: scope.accountQuotaCalibration,
  });
  const resolvedQuota = attachQuotaEstimate(resolveQuota(scope, baseQuota), quotaEstimate);
  if (latestQuota && scope.accountId) {
    await saveAccountQuotaSnapshot(scope.accountId, resolvedQuota);
  }
  return resolvedQuota;
}

async function getQuota() {
  const scope = await dashboardScope();
  if (!scope.hasCurrentAuth) {
    return { quota: resolveQuota(scope, null), scope, checkedAt: new Date().toISOString() };
  }
  const files = await walkSessionFiles(sessionsDir());
  const resolvedQuota = await resolveQuotaWithMode(scope, files);
  return {
    quota: resolvedQuota,
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
  const usage = await readLocalUsage({ since: scope.since, files });
  const quota = await resolveQuotaWithMode(scope, files, usage);
  return { quota, usage, scope };
}

async function getAllAccountsQuotaSummary() {
  await waitForIndexMutations();
  const index = await readIndex();
  let currentIdentityKey = null;
  try {
    const auth = await readCurrentAuth();
    currentIdentityKey = identityKey(auth.identity);
  } catch {
    currentIdentityKey = null;
  }

  const accounts = index.accounts.map((account) => {
    const key = identityKey(account.identity ?? {});
    const isActive = account.id === index.activeAccountId || (!!currentIdentityKey && key === currentIdentityKey);
    const snapshot = normalizePublicQuotaSnapshot(account.quotaSnapshot);
    return {
      id: account.id,
      displayName: account.displayName,
      planType: account.identity?.planType ?? null,
      isActive,
      quotaSnapshot: snapshot
        ? {
            checkedAt: snapshot.checkedAt,
            session: snapshot.session
              ? {
                  usedPercent: snapshot.session.usedPercent ?? null,
                  remainingPercent: snapshot.session.estimatedRemainingPercent ?? (snapshot.session.usedPercent != null ? Math.max(0, 100 - snapshot.session.usedPercent) : null),
                  windowMinutes: snapshot.session.windowMinutes ?? null,
                  resetsAt: snapshot.session.resetsAt ?? null,
                }
              : null,
            weekly: snapshot.weekly
              ? {
                  usedPercent: snapshot.weekly.usedPercent ?? null,
                  remainingPercent: snapshot.weekly.estimatedRemainingPercent ?? (snapshot.weekly.usedPercent != null ? Math.max(0, 100 - snapshot.weekly.usedPercent) : null),
                  windowMinutes: snapshot.weekly.windowMinutes ?? null,
                  resetsAt: snapshot.weekly.resetsAt ?? null,
                }
              : null,
          }
        : null,
    };
  });

  return { accounts, checkedAt: new Date().toISOString() };
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
  widgetWindow.on("move", () => scheduleWidgetDockCheck());
  widgetWindow.on("moved", () => scheduleWidgetDockCheck());
  widgetWindow.on("show", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.on("hide", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.loadFile(path.join(__dirname, "ui", "widget.html"));
  return widgetWindow;
}

function resizeWidgetForAccounts(accountCount) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  if (widgetManualSize) return { ok: true, skipped: true };
  const bounds = widgetDockState.collapsed && widgetDockState.expandedBounds ? widgetDockState.expandedBounds : widgetWindow.getBounds();
  const nextHeight = widgetHeightForAccounts(accountCount);
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const maxY = workArea.y + workArea.height - nextHeight - 8;
  const nextY = Math.max(workArea.y + 8, Math.min(bounds.y, maxY));
  const nextBounds = {
    x: bounds.x,
    y: nextY,
    width: WIDGET_WIDTH,
    height: nextHeight,
  };
  if (widgetDockState.edge && widgetDockState.collapsed) {
    widgetDockState.expandedBounds = expandedWidgetBoundsForDock(nextBounds, widgetDockState.edge);
    setWidgetDockBounds(
      collapsedWidgetBoundsForDock(widgetDockState.expandedBounds, widgetDockState.edge)
    );
  } else {
    if (widgetDockState.edge) {
      widgetDockState.expandedBounds = nextBounds;
      updateWidgetDockHint(widgetDockEdgeForBounds(nextBounds));
    }
    widgetWindow.setBounds(nextBounds, false);
  }
  return { ok: true, height: nextHeight };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clearWidgetDockTimers() {
  if (widgetDockState.settleTimer) {
    clearTimeout(widgetDockState.settleTimer);
    widgetDockState.settleTimer = null;
  }
  if (widgetDockState.collapseTimer) {
    clearTimeout(widgetDockState.collapseTimer);
    widgetDockState.collapseTimer = null;
  }
  if (widgetDockState.verifyTimer) {
    clearTimeout(widgetDockState.verifyTimer);
    widgetDockState.verifyTimer = null;
  }
  if (widgetDockState.pollTimer) {
    clearInterval(widgetDockState.pollTimer);
    widgetDockState.pollTimer = null;
  }
}

function resetWidgetDockState({ keepPointer = true } = {}) {
  clearWidgetDockTimers();
  setWidgetDockSizing(false);
  widgetDockState = {
    edge: null,
    expandedBounds: null,
    collapsed: false,
    edgeHoverArmed: true,
    hintEdge: null,
    pointerInside: keepPointer ? widgetDockState.pointerInside : false,
    settleTimer: null,
    collapseTimer: null,
    verifyTimer: null,
    pollTimer: null,
    collapseRetryCount: 0,
    suppressMoveUntil: 0,
  };
  sendWidgetDockHint(null);
}

function widgetWorkAreaForBounds(bounds) {
  return screen.getDisplayMatching(bounds).workArea;
}

function isWidgetDockEdge(edge) {
  return edge === "left" || edge === "right";
}

function widgetDockEdgeForBounds(bounds) {
  if (!bounds) return null;
  const workArea = widgetWorkAreaForBounds(bounds);
  const distances = [
    { edge: "left", value: Math.abs(bounds.x - workArea.x) },
    { edge: "right", value: Math.abs(workArea.x + workArea.width - (bounds.x + bounds.width)) },
  ].sort((a, b) => a.value - b.value);
  return distances[0]?.value <= WIDGET_DOCK_EDGE_THRESHOLD ? distances[0].edge : null;
}

function expandedWidgetBoundsForDock(bounds, edge) {
  const workArea = widgetWorkAreaForBounds(bounds);
  const width = clamp(bounds.width, WIDGET_MIN_WIDTH, WIDGET_MAX_WIDTH);
  const height = clamp(bounds.height, WIDGET_MIN_HEIGHT, WIDGET_MAX_HEIGHT);
  let x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - width);
  let y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);

  if (edge === "left") x = workArea.x;
  if (edge === "right") x = workArea.x + workArea.width - width;

  return { x, y, width, height };
}

function collapsedWidgetBoundsForDock(expandedBounds, edge) {
  const workArea = widgetWorkAreaForBounds(expandedBounds);
  const bounds = { ...expandedBounds };
  if (edge === "left") bounds.x = workArea.x - bounds.width + WIDGET_DOCK_VISIBLE_SIZE;
  if (edge === "right") bounds.x = workArea.x + workArea.width - WIDGET_DOCK_VISIBLE_SIZE;
  return bounds;
}

function boundsNear(left, right, tolerance = 2) {
  return (
    left &&
    right &&
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

function setWidgetDockBounds(bounds) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetDockState.suppressMoveUntil = Date.now() + WIDGET_DOCK_SUPPRESS_MOVE_MS;
  widgetWindow.setBounds(bounds, false);
}

function sendWidgetDockHint(edge) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const normalizedEdge = isWidgetDockEdge(edge) ? edge : null;
  widgetDockState.hintEdge = normalizedEdge;
  widgetWindow.webContents.send("widget:dock-hint", {
    available: Boolean(normalizedEdge && !widgetDockState.collapsed),
    edge: normalizedEdge,
  });
}

function updateWidgetDockHint(edge) {
  sendWidgetDockHint(edge || null);
}

function setWidgetDockSizing(collapsed) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (collapsed) {
    widgetWindow.setMinimumSize(WIDGET_DOCK_VISIBLE_SIZE, WIDGET_DOCK_VISIBLE_SIZE);
    return;
  }
  widgetWindow.setMinimumSize(WIDGET_MIN_WIDTH, WIDGET_MIN_HEIGHT);
}

function expandWidgetDock() {
  if (!isWidgetDockEdge(widgetDockState.edge) || !widgetDockState.expandedBounds) return;
  clearTimeout(widgetDockState.collapseTimer);
  widgetDockState.collapseTimer = null;
  if (widgetDockState.verifyTimer) {
    clearTimeout(widgetDockState.verifyTimer);
    widgetDockState.verifyTimer = null;
  }
  widgetDockState.collapsed = false;
  widgetDockState.edgeHoverArmed = true;
  widgetDockState.collapseRetryCount = 0;
  setWidgetDockSizing(false);
  setWidgetDockBounds(widgetDockState.expandedBounds);
  updateWidgetDockHint(widgetDockState.edge);
  startWidgetDockPointerPoll();
}

function collapseWidgetDock({ force = false } = {}) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (!isWidgetDockEdge(widgetDockState.edge) || !widgetDockState.expandedBounds) return;
  if (widgetDockState.pointerInside && !force) return;
  const cursor = screen.getCursorScreenPoint();
  widgetDockState.edgeHoverArmed = !pointOnCollapsedDockStrip(cursor, widgetDockState.expandedBounds, widgetDockState.edge);
  widgetDockState.collapsed = true;
  updateWidgetDockHint(null);
  setWidgetDockSizing(true);
  setWidgetDockBounds(collapsedWidgetBoundsForDock(widgetDockState.expandedBounds, widgetDockState.edge));
  startWidgetDockPointerPoll();
  scheduleWidgetDockCollapseVerify();
}

function scheduleWidgetDockCollapse({ force = false, delay = WIDGET_DOCK_COLLAPSE_MS } = {}) {
  if (!isWidgetDockEdge(widgetDockState.edge) || widgetDockState.collapsed) return;
  if (widgetDockState.collapseTimer) clearTimeout(widgetDockState.collapseTimer);
  widgetDockState.collapseTimer = setTimeout(() => {
    widgetDockState.collapseTimer = null;
    collapseWidgetDock({ force });
  }, delay);
}

function scheduleWidgetDockCollapseVerify() {
  if (!isWidgetDockEdge(widgetDockState.edge) || !widgetDockState.expandedBounds) return;
  if (widgetDockState.verifyTimer) clearTimeout(widgetDockState.verifyTimer);
  widgetDockState.verifyTimer = setTimeout(() => {
    widgetDockState.verifyTimer = null;
    verifyWidgetDockCollapsed();
  }, WIDGET_DOCK_COLLAPSE_VERIFY_MS);
}

function verifyWidgetDockCollapsed() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (!isWidgetDockEdge(widgetDockState.edge) || !widgetDockState.expandedBounds || !widgetDockState.collapsed) return;

  const actualBounds = widgetWindow.getBounds();
  const targetBounds = collapsedWidgetBoundsForDock(widgetDockState.expandedBounds, widgetDockState.edge);
  if (boundsNear(actualBounds, targetBounds)) {
    widgetDockState.collapseRetryCount = 0;
    return;
  }

  if (widgetDockState.collapseRetryCount >= WIDGET_DOCK_COLLAPSE_RETRY_LIMIT) return;
  widgetDockState.collapseRetryCount += 1;

  const edge = widgetDockEdgeForBounds(actualBounds) || widgetDockState.edge;
  widgetDockState.edge = edge;
  widgetDockState.expandedBounds = expandedWidgetBoundsForDock(actualBounds, edge);
  widgetDockState.collapsed = false;
  setWidgetDockSizing(false);
  scheduleWidgetDockCollapse({ force: true, delay: WIDGET_DOCK_COLLAPSE_RETRY_MS });
}

function markWidgetNearDockEdge(edge, bounds) {
  if (!isWidgetDockEdge(edge) || !widgetWindow || widgetWindow.isDestroyed()) return;
  widgetDockState.edge = edge;
  widgetDockState.expandedBounds = bounds;
  widgetDockState.collapsed = false;
  widgetDockState.edgeHoverArmed = true;
  widgetDockState.collapseRetryCount = 0;
  setWidgetDockSizing(false);
  updateWidgetDockHint(edge);
}

function collapseWidgetToDock() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  if (widgetDockState.collapsed) return { ok: true, collapsed: true };

  const bounds = widgetWindow.getBounds();
  const edge = widgetDockEdgeForBounds(bounds);
  if (!edge) return { ok: false, reason: "not-near-edge" };

  widgetDockState.edge = edge;
  widgetDockState.expandedBounds = expandedWidgetBoundsForDock(bounds, edge);
  widgetDockState.collapsed = false;
  widgetDockState.edgeHoverArmed = false;
  widgetDockState.collapseRetryCount = 0;
  collapseWidgetDock({ force: true });
  return { ok: true, edge };
}

function pointOnCollapsedDockStrip(point, expandedBounds, edge) {
  const workArea = widgetWorkAreaForBounds(expandedBounds);
  const padding = WIDGET_DOCK_STRIP_GRACE;
  if (edge === "left") {
    return (
      point.x <= workArea.x + WIDGET_DOCK_VISIBLE_SIZE + padding &&
      point.y >= expandedBounds.y - padding &&
      point.y <= expandedBounds.y + expandedBounds.height + padding
    );
  }
  if (edge === "right") {
    return (
      point.x >= workArea.x + workArea.width - WIDGET_DOCK_VISIBLE_SIZE - padding &&
      point.y >= expandedBounds.y - padding &&
      point.y <= expandedBounds.y + expandedBounds.height + padding
    );
  }
  return false;
}

function startWidgetDockPointerPoll() {
  if (widgetDockState.pollTimer || !widgetDockState.edge || !widgetDockState.expandedBounds) return;
  widgetDockState.pollTimer = setInterval(() => {
    if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) {
      resetWidgetDockState({ keepPointer: false });
      return;
    }
    if (!widgetDockState.edge || !widgetDockState.expandedBounds || widgetResizeSession) return;

    const cursor = screen.getCursorScreenPoint();
    const stripActive = pointOnCollapsedDockStrip(cursor, widgetDockState.expandedBounds, widgetDockState.edge);

    if (widgetDockState.collapsed) {
      if (!stripActive) {
        widgetDockState.edgeHoverArmed = true;
        return;
      }
      if (widgetDockState.edgeHoverArmed) {
        expandWidgetDock();
      }
      return;
    }
  }, WIDGET_DOCK_POLL_MS);
}

function scheduleWidgetDockCheck() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (widgetResizeSession) return;
  if (widgetDockState.settleTimer) clearTimeout(widgetDockState.settleTimer);
  const runDockCheck = () => {
    widgetDockState.settleTimer = null;
    if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return;
    if (widgetResizeSession) return;
    const waitMs = widgetDockState.suppressMoveUntil - Date.now();
    if (waitMs > 0) {
      widgetDockState.settleTimer = setTimeout(runDockCheck, waitMs + WIDGET_DOCK_SETTLE_MS);
      return;
    }

    const bounds = widgetWindow.getBounds();
    const edge = widgetDockEdgeForBounds(bounds);
    if (!edge) {
      if (widgetDockState.edge && !widgetDockState.collapsed) resetWidgetDockState();
      else if (!widgetDockState.collapsed) updateWidgetDockHint(null);
      return;
    }

    if (!widgetDockState.edge || widgetDockState.edge !== edge) {
      markWidgetNearDockEdge(edge, bounds);
      return;
    }

    if (!widgetDockState.collapsed) {
      widgetDockState.expandedBounds = bounds;
      updateWidgetDockHint(edge);
    }
  };
  widgetDockState.settleTimer = setTimeout(runDockCheck, WIDGET_DOCK_SETTLE_MS);
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

  expandWidgetDock();
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
  if (bounds && widgetDockState.edge) {
    const edge = widgetDockEdgeForBounds(bounds);
    if (edge) {
      widgetDockState.edge = edge;
      widgetDockState.expandedBounds = expandedWidgetBoundsForDock(bounds, edge);
    } else {
      resetWidgetDockState();
    }
  }
  return { ok: true, bounds };
}

function handleWidgetPointerEnter() {
  widgetDockState.pointerInside = true;
  if (widgetDockState.edge && widgetDockState.collapsed && widgetDockState.edgeHoverArmed) {
    const cursor = screen.getCursorScreenPoint();
    if (pointOnCollapsedDockStrip(cursor, widgetDockState.expandedBounds, widgetDockState.edge)) expandWidgetDock();
  }
  return { ok: true };
}

function handleWidgetPointerLeave() {
  widgetDockState.pointerInside = false;
  return { ok: true };
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
  ipcMain.handle("settings:update", async (_event, patch) => {
    const result = await updateSettings(patch);
    broadcastStateChanged();
    return result;
  });
  ipcMain.handle("codex:restart", () => restartCodexApp());
  ipcMain.handle("quota:get", () => getQuota());
  ipcMain.handle("dashboard:get", () => getDashboard());
  ipcMain.handle("dashboard:all-accounts", () => getAllAccountsQuotaSummary());
  ipcMain.handle("dashboard:all-usage", () => readLocalUsage({ since: null, scanLimit: 200 }));
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
  ipcMain.handle("window:collapse-widget-dock", () => collapseWidgetToDock());
  ipcMain.handle("window:widget-pointer-enter", () => handleWidgetPointerEnter());
  ipcMain.handle("window:widget-pointer-leave", () => handleWidgetPointerLeave());
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
  clearWidgetDockTimers();
  for (const timer of reauthCheckTimers.values()) clearTimeout(timer);
  reauthCheckTimers.clear();
});
