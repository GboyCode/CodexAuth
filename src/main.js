const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
  session: electronSession,
  dialog,
} = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { fileCredentialStoreConfig, resolveCodexHome } = require("./codex-config");
const {
  QUOTA_CONFLICT_WINDOW_MS,
  QUOTA_ESTIMATE_ALGORITHM,
  QUOTA_MODE_LOCAL,
  QUOTA_MODE_ONLINE,
  TOKEN_LEDGER_VERSION,
  TOKEN_LEDGER_SCAN_LIMIT,
  TOKEN_LEDGER_FILE_LIMIT,
  TOKEN_LEDGER_EVENT_LIMIT,
  SESSION_POLL_RECENT_FILE_LIMIT,
  SESSION_POLL_RECENT_WINDOW_MS,
} = require("./quota/constants");
const {
  emptyTokenUsage,
  normalizeTokenUsage,
  addTokenUsage,
  subtractTokenUsage,
  tokenUsageTotal,
  codexRateCard,
  quotaSpeedMultiplier,
  weightedTokenUsage,
  cloneTokenUsage,
  dateMs,
  median,
  normalizePlanType,
  fallbackQuotaCoefficient,
  quotaCoefficientBounds,
  isReasonableQuotaCoefficient,
} = require("./quota/token-math");
const { scopedTokenDelta } = require("./quota/usage-math");
const { createRecordCache, aggregateUsage, quotaFromRecords, normalizeBucket, combineBuckets, windowFor, normalizeResetCredits, numberOrNull } = require("./quota/local-records");
const { estimateLocalQuota } = require("./quota/local-estimate");
const { readBrowserResetCredits } = require("./quota/browser-reset-cache");
const { recoverAccountIndex } = require("./account-recovery");
const { encryptPortableCredentials, decryptPortableCredentials, validatePassword, MAX_BUNDLE_BYTES } = require("./portable-credentials");
const { createUpdateChecker } = require("./github-updates");
let updateChecker = null;
let updateDialogPending = false;
const readRecordFile = createRecordCache();
let detectedCodexVersion = null;
let selectedLogsDb = null;
let selectedLogsDbAt = 0;
const { createLocalDataCache } = require("./quota/local-data-cache");
const {
  MAC_CODEX_APP_NAMES,
  credentialFileExtension,
  credentialProtectionLabel,
  isEncryptedCredentialBackup,
  platformDisplayName,
} = require("./platform-support");

const APP_NAME = "CodexAuth Switch";
const APP_ID = "local.codexauth.switch";
const STARTUP_ARG = "--codexauth-startup";
const STORE_DIR_NAME = "codex-auth-switcher";
const STORE_VERSION = 1;
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const WIDGET_WIDTH = 340;
const WIDGET_MIN_WIDTH = 300;
const WIDGET_MAX_WIDTH = 620;
// Reserve the compact reset line above two complete account rows.
const WIDGET_BASE_HEIGHT = 445;
const WIDGET_ACCOUNT_ROW_DELTA = 49;
const WIDGET_MIN_ACCOUNT_ROWS = 2;
const WIDGET_MIN_HEIGHT = WIDGET_BASE_HEIGHT + (WIDGET_MIN_ACCOUNT_ROWS - 1) * WIDGET_ACCOUNT_ROW_DELTA;
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
const ATOMIC_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const AUTH_BACKUP_RETENTION_COUNT = 60;
const localDataCache = createLocalDataCache();

let mainWindow;
let widgetWindow;
let tray;
let isQuitting = false;
let widgetAlwaysOnTop = false;
let widgetManualSize = false;
let widgetAccountCount = WIDGET_MIN_ACCOUNT_ROWS;
let widgetResizeSession = null;
let widgetBoundsSaveTimer;
let runtimeSettings = null;
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
let lastKnownLocalQuotaMtimeMs = 0;
let indexMutationQueue = Promise.resolve();
let accountOperationQueue = Promise.resolve();
let tokenLedgerQueue = Promise.resolve();
const sessionParseCache = new Map();
const quotaEventParseCache = new Map();
const sqliteResponseEventCache = new Map();
const reauthCheckTimers = new Map();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let startupReady = false;
let pendingWindow = null;

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!startupReady) {
      pendingWindow = hasStartupArg(argv) ? "widget" : "main";
      return;
    }
    if (hasStartupArg(argv)) {
      showWidgetWindow();
      return;
    }
    showMainWindow();
  });
}

function codexDir() {
  return resolveCodexHome(process.env, os.homedir());
}

function authPath() {
  return path.join(codexDir(), "auth.json");
}

function codexConfigPath() {
  return path.join(codexDir(), "config.toml");
}

function sessionsDir() {
  return path.join(codexDir(), "sessions");
}

function sessionIndexPath() {
  return path.join(codexDir(), "session_index.jsonl");
}

function logsDbPath() {
  if (selectedLogsDb && Date.now() - selectedLogsDbAt < 30000) return selectedLogsDb;
  try {
    const names = fsSync.readdirSync(codexDir()).filter((name) => /^logs_\d+\.sqlite$/.test(name));
    names.sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    selectedLogsDb = path.join(codexDir(), names[0] ?? "logs_2.sqlite");
  } catch { selectedLogsDb = path.join(codexDir(), "logs_2.sqlite"); }
  selectedLogsDbAt = Date.now();
  return selectedLogsDb;
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
  return path.join(accountsDir(), `${id}.${credentialFileExtension()}`);
}

function backupsDir() {
  return path.join(storeRoot(), "backups");
}

function tokenLedgerPath() {
  return path.join(storeRoot(), "local-token-ledger.json");
}

function appIconPngPath() {
  return path.join(__dirname, "ui", "assets", "codex-color.png");
}

function appIconIcoPath() {
  return path.join(__dirname, "ui", "assets", "codex-color.ico");
}

function appIconPath() {
  return isWindows ? appIconIcoPath() : appIconPngPath();
}

function trayIconIcoPath() {
  return path.join(__dirname, "ui", "assets", "codex-color-tray.ico");
}

function widgetHeightForAccounts(accountCount) {
  const numericCount = Number(accountCount);
  const count = Number.isFinite(numericCount) ? Math.max(0, Math.floor(numericCount)) : 0;
  const visibleRows = Math.max(WIDGET_MIN_ACCOUNT_ROWS, count);
  return WIDGET_BASE_HEIGHT + (visibleRows - 1) * WIDGET_ACCOUNT_ROW_DELTA;
}

function widgetMaxHeightForBounds(bounds, accountCount = widgetAccountCount) {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const availableHeight = Math.max(WIDGET_MIN_HEIGHT, workArea.height - 16);
  return Math.max(
    WIDGET_MIN_HEIGHT,
    Math.min(widgetHeightForAccounts(accountCount), availableHeight)
  );
}

function normalizeWidgetBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const x = Math.round(Number(bounds.x));
  const y = Math.round(Number(bounds.y));
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x,
    y,
    width: clamp(width, WIDGET_MIN_WIDTH, WIDGET_MAX_WIDTH),
    height: Math.max(WIDGET_MIN_HEIGHT, height),
  };
}

async function ensureStoreDirs() {
  await fs.mkdir(accountsDir(), { recursive: true });
  await fs.mkdir(backupsDir(), { recursive: true });
}

async function pruneAuthBackups() {
  let entries;
  try {
    entries = await fs.readdir(backupsDir(), { withFileTypes: true });
  } catch {
    return { removedFiles: 0, removedBytes: 0 };
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isEncryptedCredentialBackup(entry.name)) continue;
    const filePath = path.join(backupsDir(), entry.name);
    try {
      const stat = await fs.stat(filePath);
      backups.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent cleanup may have already removed the file.
    }
  }

  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removedFiles = 0;
  let removedBytes = 0;
  for (const backup of backups.slice(AUTH_BACKUP_RETENTION_COUNT)) {
    try {
      await fs.rm(backup.filePath, { force: true });
      removedFiles += 1;
      removedBytes += backup.size;
    } catch {
      // Retention cleanup is best-effort and must not block account switching.
    }
  }
  return { removedFiles, removedBytes };
}

async function cleanupStoreArtifacts() {
  const cutoffMs = Date.now() - ATOMIC_TEMP_MAX_AGE_MS;
  let entries;
  try {
    entries = await fs.readdir(storeRoot(), { withFileTypes: true });
  } catch {
    entries = [];
  }

  let removedFiles = 0;
  let removedBytes = 0;
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^(?:accounts\.json|local-token-ledger\.json)\.tmp-[0-9a-f-]+$/i.test(entry.name)
    ) {
      continue;
    }
    const filePath = path.join(storeRoot(), entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > cutoffMs) continue;
      await fs.rm(filePath, { force: true });
      removedFiles += 1;
      removedBytes += stat.size;
    } catch {
      // Stale temporary files are harmless if a cleanup race occurs.
    }
  }

  const backupCleanup = await pruneAuthBackups();
  return {
    removedFiles: removedFiles + backupCleanup.removedFiles,
    removedBytes: removedBytes + backupCleanup.removedBytes,
  };
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

async function writeJsonAtomic(filePath, value, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${crypto.randomUUID()}`;
  const content = `${options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function writeTextAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function ensureCodexFileCredentialStore() {
  const configFile = codexConfigPath();
  let current = "";
  let existed = true;
  try {
    current = await fs.readFile(configFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existed = false;
  }

  const next = fileCredentialStoreConfig(current);
  if (!next.changed) return { changed: false, path: configFile };

  await fs.mkdir(codexDir(), { recursive: true });
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.copyFile(configFile, `${configFile}.codexauth-backup-${stamp}`);
  }
  await writeTextAtomic(configFile, next.content);
  return { changed: true, path: configFile };
}

function defaultSettings() {
  return {
    quotaMode: QUOTA_MODE_LOCAL,
    launchAtLogin: false,
    restartAfterSwitch: true,
    widgetBounds: null,
  };
}

function normalizeSettings(settings) {
  const normalized = {
    ...defaultSettings(),
    ...settings,
    quotaMode: QUOTA_MODE_LOCAL,
  };
  return {
    ...normalized,
    launchAtLogin: normalized.launchAtLogin === true,
    restartAfterSwitch: normalized.restartAfterSwitch !== false,
    widgetBounds: normalizeWidgetBounds(normalized.widgetBounds),
  };
}

function loginItemIdentityOptions() {
  const args = app.isPackaged ? [STARTUP_ARG] : [app.getAppPath(), STARTUP_ARG];
  const options = {
    name: APP_NAME,
    path: process.execPath,
    args,
  };
  return options;
}

function applyLaunchAtLogin(enabled) {
  const openAtLogin = enabled === true;
  app.setLoginItemSettings({
    ...loginItemIdentityOptions(),
    openAtLogin,
    openAsHidden: true,
  });
  return openAtLogin;
}

function hasStartupArg(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(STARTUP_ARG);
}

function wasOpenedFromLoginItem() {
  if (hasStartupArg()) return true;
  try {
    const loginSettings = app.getLoginItemSettings(loginItemIdentityOptions());
    return loginSettings.wasOpenedAtLogin === true || loginSettings.wasOpenedAsHidden === true;
  } catch {
    return false;
  }
}

function shouldStartWithWidgetOnly(settings) {
  return settings?.launchAtLogin === true && wasOpenedFromLoginItem();
}

function normalizeSettingsForState(settings) {
  return normalizeSettings(settings);
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
    recovery: data.recovery ?? null,
  };
}

async function writeIndex(index) {
  await writeJsonAtomic(indexPath(), {
    version: STORE_VERSION,
    activeAccountId: index.activeAccountId ?? null,
    accounts: index.accounts,
    deletedIdentityKeys: Array.isArray(index.deletedIdentityKeys) ? index.deletedIdentityKeys : [],
    settings: normalizeSettings(index.settings),
    recovery: index.recovery ?? null,
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

async function runAccountOperation(task) {
  const previous = accountOperationQueue;
  let release;
  accountOperationQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

async function runTokenLedgerOperation(task) {
  const previous = tokenLedgerQueue;
  let release;
  tokenLedgerQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

function runProcess(command, args = [], stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
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
      const error = new Error((stderr || stdout || `${command} exited with ${code}`).trim());
      error.exitCode = code;
      reject(error);
    });
    child.stdin.end(stdinText);
  });
}

function runPowerShell(script, stdinText = "") {
  return runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    stdinText
  );
}

async function protectText(plainText) {
  if (isMac) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable for the current user.");
    }
    return safeStorage.encryptString(plainText).toString("base64");
  }
  if (!isWindows) {
    throw new Error("Credential storage is supported on Windows and macOS only.");
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
  if (isMac) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable for the current user.");
    }
    return safeStorage.decryptString(Buffer.from(String(cipherText).trim(), "base64"));
  }
  if (!isWindows) {
    throw new Error("Credential storage is supported on Windows and macOS only.");
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
    refreshTokenFingerprint: refreshTokenFingerprint(auth.parsed),
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

async function recoverStoreIfNeeded() {
  return recoverAccountIndex({
    indexPath:indexPath(), accountsDir:accountsDir(), extension:credentialFileExtension(),
    decode:async (encrypted) => {
      const content=await unprotectText(encrypted);
      return {...validateAuthJson(content),content};
    },
    identify:identityKey,
    makeRecord:(auth) => createAccountRecord(auth,safeAccountName("",auth.identity),new Date().toISOString()),
    write:writeJsonAtomic,
  });
}

async function readLocalRecords(files, since = null) {
  const cutoff=since ? Date.parse(since) : null;
  const records=[];
  for(const file of files) {
    if(Number.isFinite(cutoff) && file.mtimeMs < cutoff) continue;
    try { records.push(await readRecordFile(file)); } catch { /* surfaced as failedFiles in statistics */ }
  }
  return records;
}

async function localDiagnostics(index, current) {
  if (!detectedCodexVersion) {
    detectedCodexVersion = (async () => {
      try {
        if (isWindows) {
          const output = await runPowerShell("$p = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if ($p) { $p.Version.ToString() }");
          return String(output).trim().slice(0,80) || null;
        }
      } catch { /* version detection is optional */ }
      return null;
    })();
  }
  const config=await fs.readFile(codexConfigPath(),"utf8").catch(()=>"");
  const files=await localDataCache.getSessionFiles(sessionsDir(),walkSessionFiles);
  let dbReadable=false;
  try {
    const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(logsDbPath(),{readOnly:true});
    try { const columns=db.prepare("pragma table_info(logs)").all().map((c)=>c.name);dbReadable=columns.includes("ts")&&columns.includes("feedback_log_body"); } finally {db.close();}
  } catch { /* sessions remain available without SQLite */ }
  const matching=index.accounts.find((a)=>a.authFingerprint===current?.fingerprint);
  return {version:app.getVersion(),codexVersion:await detectedCodexVersion,
    fileCredentials:!fileCredentialStoreConfig(config).changed,
    authRecognized:!!current?.exists&&!current?.error, authSynchronized:!!matching,
    accountCount:index.accounts.length,logDatabase:path.basename(logsDbPath()),dbReadable,
    sessionFiles:files.length,latestLogAt:files[0]?.mtimeMs?new Date(files[0].mtimeMs).toISOString():null,
    recovery:index.recovery??null, mode:"local-only"};
}

async function readLocalResetCredits(scope, records) {
  const since=Date.parse(scope.since);
  let latest=records.flatMap((r)=>r.resets).filter((r)=>Date.parse(r.checkedAt)>=since)
    .sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt))[0]??null;
  // Only structured Codex messages with matching account tags are accepted.
  // Assistant/tool transcripts (including quota queries pasted in a chat) are
  // intentionally not a data source for earned-reset balances.
  const fromDb=Number.isFinite(since) ? await localDataCache.cached(`reset:${scope.accountId}:${scope.since}`,async()=>{
    let db;
    try {
      const {DatabaseSync}=require("node:sqlite");db=new DatabaseSync(logsDbPath(),{readOnly:true});
      const rows=db.prepare("select ts, feedback_log_body from logs where ts >= ? and (feedback_log_body like '%rateLimitResetCredits%' or feedback_log_body like '%rate_limit_reset_credits%') order by ts desc, id desc limit 100").all(Math.floor(since/1000));
      const filter=normalizeAccountFilter(scope.account);
      for(const row of rows){
        const fields=parseLogKeyValues(row.feedback_log_body);
        if(responseEventAccountMatch({accountId:fields["user.account_id"],email:fields["user.email"]},filter)!=="match" || !fields["user.account_id"])continue;
        const message=extractCodexLogMessage(row.feedback_log_body);
        if(!["codex.rate_limits","account/rateLimits/updated"].includes(message?.type??message?.method))continue;
        const data=message.params??message;
        const result=normalizeResetCredits(data.rateLimitResetCredits??data.rate_limit_reset_credits,new Date(row.ts*1000).toISOString());
        if(result)return result;
      }
    }catch{/* an absent local reset record means unknown, never zero */}
    finally{db?.close();}
    return null;
  }) : null;
  if(fromDb&&(!latest||Date.parse(fromDb.checkedAt)>Date.parse(latest.checkedAt)))latest=fromDb;
  const browser = scope.hasCurrentAuth ? await localDataCache.cached(`browser-reset:${scope.accountId}`, () =>
    readBrowserResetCredits(app.getPath("appData"), scope.account)) : null;
  if (browser && (!latest || Date.parse(browser.checkedAt) > Date.parse(latest.checkedAt))) latest = browser;
  return latest;
}

async function loadAccountAuth(accountId) {
  const encrypted = await fs.readFile(accountBlobPath(accountId), "utf8");
  return unprotectText(encrypted);
}

async function saveAccountAuth(accountId, content) {
  await ensureStoreDirs();
  const encrypted = await protectText(content);
  await writeTextAtomic(accountBlobPath(accountId), `${encrypted}\n`);
}

function authLastRefresh(parsed) {
  return typeof parsed?.last_refresh === "string" ? parsed.last_refresh : null;
}

function refreshTokenFingerprint(parsed) {
  const refreshToken = parsed?.tokens?.refresh_token;
  return typeof refreshToken === "string" && refreshToken ? fingerprint(refreshToken) : null;
}

function markAccountAuthSnapshot(account, auth, content, now) {
  const nextRefreshTokenFingerprint = refreshTokenFingerprint(auth.parsed);
  if (
    account.refreshTokenFingerprint &&
    nextRefreshTokenFingerprint &&
    account.refreshTokenFingerprint !== nextRefreshTokenFingerprint
  ) {
    account.refreshTokenRotatedAt = now;
  }
  account.identity = auth.identity;
  account.updatedAt = now;
  account.lastRefresh = authLastRefresh(auth.parsed);
  account.authFingerprint = fingerprint(content);
  account.refreshTokenFingerprint = nextRefreshTokenFingerprint;
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
  const localSnapshot = localStoredQuotaSnapshot(snapshot);
  if (!localSnapshot) return null;
  if (!localSnapshot.estimate || localSnapshot.estimate.algorithm === QUOTA_ESTIMATE_ALGORITHM) return localSnapshot;
  return {
    ...localSnapshot,
    session: stripWindowEstimate(localSnapshot.session),
    weekly: stripWindowEstimate(localSnapshot.weekly),
    estimate: {
      ...localSnapshot.estimate,
      available: false,
      reason: "等待新算法快照",
    },
  };
}

function normalizePublicAccount(account, activeId, currentIdentityKey) {
  const key = identityKey(account.identity ?? {});
  const expiresAtMs = new Date(account.accessTokenExpiresAt ?? "").getTime();
  const accessTokenExpired = Number.isFinite(expiresAtMs)
    ? expiresAtMs <= Date.now()
    : account.accessTokenExpired ?? null;
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
    accessTokenExpired,
    refreshTokenRotatedAt: account.refreshTokenRotatedAt ?? null,
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
    version: app.getVersion(),
    diagnostics: await localDiagnostics(index, current),
    platform: process.platform,
    platformName: platformDisplayName(),
    credentialProtection: credentialProtectionLabel(),
    codexDir: codexDir(),
    authPath: authPath(),
    storeRoot: storeRoot(),
    settings: normalizeSettingsForState(index.settings),
    current,
    accounts: index.accounts.map((account) =>
      normalizePublicAccount(account, index.activeAccountId, currentIdentityKey)
    ),
  };
}

async function updateSettings(patch) {
  const nextPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(nextPatch, "launchAtLogin")) {
    nextPatch.launchAtLogin = applyLaunchAtLogin(nextPatch.launchAtLogin === true);
  }
  let nextSettings = null;
  await mutateIndex(async (index) => {
    const previous = JSON.stringify(normalizeSettings(index.settings));
    index.settings = normalizeSettings({ ...index.settings, ...nextPatch });
    nextSettings = index.settings;
    return previous === JSON.stringify(index.settings) ? { write: false } : {};
  });
  runtimeSettings = normalizeSettings(nextSettings ?? runtimeSettings);
  return currentState();
}

async function syncLaunchAtLoginFromSettings() {
  const index = await readIndex();
  const settings = normalizeSettings(index.settings);
  runtimeSettings = settings;
  applyLaunchAtLogin(settings.launchAtLogin === true);
  return settings;
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

async function exportCurrentCredentials(password) {
  validatePassword(password);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "导出当前账号凭证", defaultPath: `CodexAuth-account-${new Date().toISOString().slice(0, 10)}.codexauth`,
    filters: [{ name: "CodexAuth 加密迁移文件", extensions: ["codexauth"] }],
  });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  const exportPath = selected.filePath.toLowerCase().endsWith(".codexauth") ? selected.filePath : `${selected.filePath}.codexauth`;
  return runAccountOperation(async () => {
    const auth = await readCurrentAuth(); // Export the latest refreshed credential, not an old saved copy.
    const index = await readIndex();
    const account = index.accounts.find((a) => identityKey(a.identity) === identityKey(auth.identity));
    const encrypted = await encryptPortableCredentials({ auth: auth.content,
      displayName: safeAccountName(account?.displayName, auth.identity).slice(0, 200) }, password);
    await writeTextAtomic(exportPath, encrypted);
    return { canceled: false };
  });
}

async function importPortableCredentials(password) {
  validatePassword(password);
  const selected = await dialog.showOpenDialog(mainWindow, { title: "导入账号凭证", properties: ["openFile"],
    filters: [{ name: "CodexAuth 加密迁移文件", extensions: ["codexauth"] }],
  });
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true };
  const handle = await fs.open(selected.filePaths[0], "r");
  let encoded;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error("迁移文件过大或格式无效。");
    const buffer = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_BUNDLE_BYTES) throw new Error("迁移文件过大。");
    encoded = buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
  const payload = await decryptPortableCredentials(encoded, password);
  const auth = { content: payload.auth, ...validateAuthJson(payload.auth) };
  const key = identityKey(auth.identity);
  return runAccountOperation(async () => {
    const index = await readIndex();
    const existing = index.accounts.find((a) => identityKey(a.identity) === key);
    let currentKey = null;
    try { currentKey = identityKey((await readCurrentAuth()).identity); } catch { /* B may not be logged in. */ }
    if (existing && currentKey === key) return { canceled: false, alreadyActive: true, snapshot: await currentState() };
    if (existing) {
      const confirmation = await dialog.showMessageBox(mainWindow, { type: "question", title: "更新已保存的账号",
        message: `账号 ${identityLabel(auth.identity)} 已存在，是否用迁移文件更新它的凭证？`,
        detail: "原凭证会先在本机加密备份。当前正在使用的其他账号不会切换。", buttons: ["取消", "更新凭证"], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) return { canceled: true };
    }
    await mutateIndex(async (next) => {
      let account = next.accounts.find((a) => identityKey(a.identity) === key);
      const now = new Date().toISOString();
      if (account) {
        await fs.copyFile(accountBlobPath(account.id), path.join(backupsDir(), `auth-before-portable-import-${crypto.randomUUID()}.${credentialFileExtension()}`));
        markAccountAuthSnapshot(account, auth, auth.content, now);
      } else {
        account = createAccountRecord(auth, safeAccountName(payload.displayName, auth.identity), now);
        account.lastSwitchedAt = null;
        next.accounts.push(account);
      }
      await saveAccountAuth(account.id, auth.content);
      account.lastSyncedAt = now;
      next.deletedIdentityKeys = (next.deletedIdentityKeys ?? []).filter((item) => item !== key);
    });
    return { canceled: false, snapshot: await currentState() };
  });
}

async function backupCurrentAuth(content, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupsDir(),
    `auth-${reason}-${stamp}.json.${credentialFileExtension()}`
  );
  const encrypted = await protectText(content);
  await writeTextAtomic(backupPath, `${encrypted}\n`);
  await pruneAuthBackups();
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
    const target = `${source}.${credentialFileExtension()}`;
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
          refreshTokenFingerprint: account.refreshTokenFingerprint ?? null,
          refreshTokenRotatedAt: account.refreshTokenRotatedAt ?? null,
        });
        markAccountAuthSnapshot(account, { content, ...auth }, content, account.updatedAt ?? new Date().toISOString());
        const next = JSON.stringify({
          identity: account.identity ?? null,
          lastRefresh: account.lastRefresh ?? null,
          accessTokenExpiresAt: account.accessTokenExpiresAt ?? null,
          accessTokenExpired: account.accessTokenExpired ?? null,
          authFingerprint: account.authFingerprint ?? null,
          refreshTokenFingerprint: account.refreshTokenFingerprint ?? null,
          refreshTokenRotatedAt: account.refreshTokenRotatedAt ?? null,
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
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
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
        account.lastSwitchedAt = now;
        index.activeAccountId = account.id;
        return { value: true };
      }
      return { value: false, write: false };
    }

    await saveAccountAuth(account.id, current.content);
    if (index.activeAccountId !== account.id) account.lastSwitchedAt = now;
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
          if (currentKey && accountKey && currentKey === accountKey) {
            const now = new Date().toISOString();
            await saveAccountAuth(account.id, current.content);
            markAccountAuthSnapshot(account, current, current.content, now);
            account.lastSyncedAt = now;
            return { value: true };
          }
        } catch {
          // Fall through to the stale-snapshot check below.
        }

        const unchanged =
          account.authFingerprint === expectedFingerprint && account.lastRefresh === expectedLastRefresh;
        if (!unchanged) return { value: false, write: false };
        account.needsReauth = true;
        account.reauthReason = "切换后 Codex 未写回可用的新凭证，请重试切换或重新登录。";
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
  return /^logs_\d+\.sqlite(?:-wal|-shm)?$/.test(value);
}

function scheduleLocalLogRefresh() {
  if (localLogRefreshTimer) return;
  localLogRefreshTimer = setTimeout(() => {
    localLogRefreshTimer = null;
    localDataCache.invalidate();
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
      const files = await localDataCache.getSessionFiles(sessionsDir(), walkSessionFiles);
      await resolveQuotaWithMode(scope, files);
      broadcastStateChanged({ scope: "quota" });
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
      if (/\.jsonl(?:\.gz|\.zst)?$/.test(name)) scheduleLocalLogRefresh();
    });
  } catch {
    sessionsWatcher = null;
  }
}

// Periodic polling fallback: checks if sqlite logs or session files changed
// since the last check. This catches writes that the filesystem watcher may
// miss (e.g. WAL checkpoints, or when Codex writes nested rollout JSONL files).
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
      const files = await localDataCache.getSessionFiles(sessionsDir(), walkSessionFiles);
      const recentCutoff = Date.now() - SESSION_POLL_RECENT_WINDOW_MS;
      const pollCandidates = files
        .filter((file) => file.mtimeMs >= recentCutoff)
        .slice(0, SESSION_POLL_RECENT_FILE_LIMIT);
      for (const file of pollCandidates.length ? pollCandidates : files.slice(0, SESSION_POLL_RECENT_FILE_LIMIT)) {
        if (file.mtimeMs > latestMtime) latestMtime = file.mtimeMs;
      }
      if (latestMtime > lastKnownLocalQuotaMtimeMs) {
        lastKnownLocalQuotaMtimeMs = latestMtime;
        scheduleLocalLogRefresh();
      }
    } catch {
      // Best-effort polling; errors are non-fatal.
    }
  }, 15000);
  sessionsPollingInterval.unref?.();
}

async function switchAccount(accountId, options = {}) {
  return runAccountOperation(() => switchAccountLocked(accountId, options));
}

async function switchAccountLocked(accountId, options = {}) {
  localDataCache.invalidate();
  await ensureCodexFileCredentialStore();
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
  return runAccountOperation(() => startAccountReauthLocked(accountId));
}

async function startAccountReauthLocked(accountId) {
  await ensureCodexFileCredentialStore();
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

async function reorderAccounts(accountIds) {
  if (!Array.isArray(accountIds)) throw new Error("Invalid account order.");
  await mutateIndex(async (index) => {
    const currentIds = index.accounts.map((account) => account.id);
    const nextIds = accountIds.map((accountId) => String(accountId));
    if (
      nextIds.length !== currentIds.length ||
      new Set(nextIds).size !== nextIds.length ||
      currentIds.some((accountId) => !nextIds.includes(accountId))
    ) {
      throw new Error("Account list changed. Refresh and try again.");
    }
    if (currentIds.every((accountId, indexPosition) => accountId === nextIds[indexPosition])) {
      return { write: false };
    }
    const accountsById = new Map(index.accounts.map((account) => [account.id, account]));
    index.accounts = nextIds.map((accountId) => accountsById.get(accountId));
    return {};
  });
  return currentState();
}

async function deleteAccount(accountId) {
  return runAccountOperation(() => deleteAccountLocked(accountId));
}

async function deleteAccountLocked(accountId) {
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

async function restartCodexAppQueued() {
  return runAccountOperation(() => restartCodexApp());
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function macProcessIsRunning(processName) {
  try {
    await runProcess("/usr/bin/pgrep", ["-x", processName]);
    return true;
  } catch (error) {
    if (error?.exitCode === 1) return false;
    throw error;
  }
}

async function restartCodexAppMac() {
  for (const processName of MAC_CODEX_APP_NAMES) {
    if (!(await macProcessIsRunning(processName))) continue;
    try {
      await runProcess("/usr/bin/pkill", ["-x", processName]);
    } catch (error) {
      if (error?.exitCode !== 1) throw error;
    }
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const running = await Promise.all(MAC_CODEX_APP_NAMES.map(macProcessIsRunning));
    if (!running.some(Boolean)) break;
    await wait(150);
  }
  const stillRunning = await Promise.all(MAC_CODEX_APP_NAMES.map(macProcessIsRunning));
  if (stillRunning.some(Boolean)) {
    throw new Error("Codex App did not fully exit before restart.");
  }

  const launchErrors = [];
  for (const appName of MAC_CODEX_APP_NAMES) {
    try {
      await runProcess("/usr/bin/open", ["-a", appName]);
      return { ok: true, application: appName };
    } catch (error) {
      launchErrors.push(error.message);
    }
  }
  throw new Error(`Cannot find Codex App launcher. ${launchErrors.join(" ")}`.trim());
}

async function restartCodexApp() {
  if (isMac) return restartCodexAppMac();
  if (!isWindows) throw new Error("Restart is supported on Windows and macOS only.");
  const script = `
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
$installRoot = if ($package -and $package.InstallLocation) { [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\\') } else { $null }

function Get-CodexAppProcesses {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try {
      $processPath = $_.Path
      if (-not $processPath) { return $false }
      $fullPath = [IO.Path]::GetFullPath($processPath)
      if ($installRoot -and $fullPath.StartsWith($installRoot + '\\', [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
      return ($_.ProcessName -in @('ChatGPT', 'Codex')) -and ($fullPath -like '*\\OpenAI\\Codex\\*')
    } catch {
      return $false
    }
  }
}

$targets = @(Get-CodexAppProcesses)
if ($targets.Count -gt 0) {
  $targets | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 150
    $remaining = @(Get-CodexAppProcesses)
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
  if ($remaining.Count -gt 0) {
    throw 'Codex App did not fully exit before restart.'
  }
}
Start-Sleep -Milliseconds 300
$startApp = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' } | Select-Object -First 1
if ($startApp -and $startApp.AppID) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$($startApp.AppID)"
  exit 0
}
if ($package -and $package.PackageFamilyName) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$($package.PackageFamilyName)!App"
  exit 0
}
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\Codex.exe'
if (Test-Path $alias) {
  Start-Process -FilePath $alias
  exit 0
}
throw 'Cannot find Codex App launcher.'
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

function trayMenuItem(label, options = {}) {
  const { active = false, ...item } = options;
  return {
    label: `${active ? "\u25cf" : "\u2007"}  ${label}`,
    ...item,
  };
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

function broadcastStateChanged(payload = { scope: "accounts" }) {
  const message = payload && typeof payload === "object" ? payload : { scope: "accounts" };
  for (const win of [mainWindow, widgetWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("state:changed", message);
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
  const launchAtLogin = snapshot?.settings?.launchAtLogin === true;
  const widgetVisible = widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible();
  const accountItems = accounts.length
    ? accounts.map((account) =>
        trayMenuItem(account.displayName, {
          active: account.isActive,
          enabled: !account.isActive,
          click: async () => {
            await switchAccount(account.id, { restartCodex: true });
            broadcastStateChanged();
          },
        })
      )
    : [trayMenuItem("暂无已保存账号", { enabled: false })];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      trayMenuItem(APP_NAME, { enabled: false }),
      trayMenuItem(`当前：${currentLabel}`, { enabled: false }),
      { type: "separator" },
      trayMenuItem("打开主窗口", { click: () => showMainWindow() }),
      trayMenuItem(widgetVisible ? "隐藏浮窗" : "显示浮窗", {
        click: () => {
          toggleWidgetWindow();
          rebuildTrayMenu().catch(() => {});
        },
      }),
      { type: "separator" },
      trayMenuItem("切换账号并重启", { submenu: accountItems }),
      trayMenuItem("重启 Codex App", { click: () => restartCodexAppQueued().catch(() => {}) }),
      trayMenuItem("开机自启动", {
        active: launchAtLogin,
        click: async () => {
          await updateSettings({ launchAtLogin: !launchAtLogin });
          broadcastStateChanged();
        },
      }),
      { type: "separator" },
      trayMenuItem("退出", {
        click: () => {
          isQuitting = true;
          app.quit();
        },
      }),
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

function rateWindowSeconds(window) {
  const direct = numberOrNull(window?.limit_window_seconds);
  if (Number.isFinite(direct)) return direct;
  const minutes = numberOrNull(window?.window_minutes ?? window?.windowMinutes ?? window?.windowDurationMins);
  return Number.isFinite(minutes) ? minutes * 60 : null;
}

function rateWindowResetsAt(window) {
  const value = numberOrNull(window?.reset_at ?? window?.resets_at ?? window?.resetsAt);
  return Number.isFinite(value) ? value : null;
}

function rateWindowUsedPercent(window) {
  const value = numberOrNull(window?.used_percent ?? window?.usedPercent);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function rateWindowHasPositiveSpan(window) {
  const seconds = rateWindowSeconds(window);
  return !Number.isFinite(seconds) || seconds > 0;
}

function rateWindowHasDisplayData(window) {
  if (!window || !rateWindowHasPositiveSpan(window)) return false;
  return (
    Number.isFinite(rateWindowUsedPercent(window)) ||
    Number.isFinite(rateWindowSeconds(window)) ||
    Number.isFinite(rateWindowResetsAt(window))
  );
}

function rateWindowIsCurrent(window, checkedAt) {
  if (!rateWindowHasDisplayData(window)) return false;
  const resetAt = rateWindowResetsAt(window);
  const checkedMs = checkedAt === undefined || checkedAt === null || checkedAt === "" ? Date.now() : dateMs(checkedAt);
  const effectiveCheckedMs = Number.isFinite(checkedMs) ? checkedMs : Date.now();
  return !Number.isFinite(resetAt) || resetAt * 1000 > effectiveCheckedMs;
}

function rateLimitsHaveCurrentWindow(rateLimits, checkedAt) {
  return rateWindowIsCurrent(rateLimits?.primary, checkedAt) || rateWindowIsCurrent(rateLimits?.secondary, checkedAt);
}

function normalizeRateWindow(window, checkedAt = null, estimateBaseAt = checkedAt, estimateSeed = {}) {
  if (!rateWindowIsCurrent(window, checkedAt)) return null;
  const seconds = rateWindowSeconds(window);
  const resetsAt = rateWindowResetsAt(window);
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
    usedPercent: Math.round(rateWindowUsedPercent(window) ?? 0),
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

function planTypesMatch(left, right) {
  const leftPlan = normalizePlanType(left);
  const rightPlan = normalizePlanType(right);
  return !leftPlan || !rightPlan || leftPlan === rightPlan;
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
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && /\.jsonl(?:\.gz|\.zst)?$/.test(entry.name)) {
        const stat = await fs.stat(fullPath).catch(() => null);
        result.push({ path: fullPath, mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 });
      }
    }
  }
  await walk(dir);
  if (path.resolve(dir) === path.resolve(sessionsDir())) await walk(path.join(codexDir(), "archived_sessions"));
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

async function fileCachePart(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
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
  let afterSinceRateLimitEvent = null;
  let previousTokenUsage = null;
  const usageSegments = [];

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
        const delta = scopedTokenDelta(tokenCount.tokenUsage, previousTokenUsage, {
          sinceMs,
          eventMs,
          sessionStartedMs: new Date(summary.startedAt ?? "").getTime(),
        });
        if (delta) {
          usageSegments.push({
            timestamp,
            model: summary.model,
            tokenUsage: delta,
          });
        }
        if (tokenCount.rateLimits) afterSinceRateLimitEvent = tokenCount;
      }
      previousTokenUsage = tokenCount.tokenUsage;
    }
  }

  if (sinceMs && !usageSegments.length) return null;
  if (!sinceMs && !lastTokenCount) return null;
  const quotaEvent = sinceMs ? afterSinceRateLimitEvent : lastRateLimitEvent;
  if (sinceMs) {
    summary.tokenUsage = emptyTokenUsage();
    for (const segment of usageSegments) addTokenUsage(summary.tokenUsage, segment.tokenUsage);
    summary.usageSegments = usageSegments;
  } else {
    summary.tokenUsage = lastTokenCount.tokenUsage;
  }
  summary.rateLimits = quotaEvent?.rateLimits ?? null;
  summary.tokenCountAt = sinceMs ? usageSegments.at(-1).timestamp : lastTokenCount.timestamp;
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
      : summary.tokenCountAt ?? summary.updatedAt;
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

function quotaFromLocalRateLimits(rateLimits, checkedAt) {
  return normalizeBucket(rateLimits, checkedAt);
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
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const numberHeader = (values, key) => numberOrNull(values[key]);
  const boolHeader = (values, key) => {
    const value = values[key];
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return null;
  };
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
  const bucket = normalizeBucket({
    plan_type: planType,
    primary: {
      used_percent: numberHeader(headers, "x-codex-primary-used-percent"),
      window_minutes: numberHeader(headers, "x-codex-primary-window-minutes"),
      resets_at: primaryResetAt,
    },
    secondary: {
      used_percent: numberHeader(headers, "x-codex-secondary-used-percent"),
      window_minutes: numberHeader(headers, "x-codex-secondary-window-minutes"),
      resets_at: secondaryResetAt,
    },
    credits: {
      hasCredits: boolHeader(headers, "x-codex-credits-has-credits"),
      unlimited: boolHeader(headers, "x-codex-credits-unlimited"),
      balance: numberHeader(headers, "x-codex-credits-balance"),
    },
  }, checkedAt);
  return {
    ...bucket,
    source: "local-error",
    error: "Codex 返回 usage_limit_reached；未记录的额度窗口保持未知。",
  };
}

function quotaFromCodexRateLimitsMessage(message, timestampSeconds) {
  if (message?.type !== "codex.rate_limits" || !message.rate_limits) return null;
  const checkedAt = new Date(timestampSeconds * 1000).toISOString();
  return quotaFromLocalRateLimits(
    {
      ...message.rate_limits,
      plan_type: message.plan_type ?? message.rate_limits?.plan_type ?? null,
      credits: message.credits ?? message.rate_limits?.credits,
      rateLimitResetCredits: message.rateLimitResetCredits ?? message.rate_limit_reset_credits,
    },
    checkedAt
  );
}

async function readLatestSqliteRateLimitQuota(options = {}) {
  const sinceMs = options.since ? new Date(options.since).getTime() : null;
  const effectiveSinceSeconds = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000)
    : Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
  const accountFilter = normalizeAccountFilter(options.accountIdentity);
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
    const buckets = [];
    for (const row of filterRowsByAccount(rows, accountFilter)) {
      const quota = quotaFromCodexRateLimitsMessage(extractCodexLogMessage(row.feedback_log_body), row.ts);
      if (quota) buckets.push(quota);
    }
    return combineBuckets(buckets);
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
  const accountFilter = normalizeAccountFilter(options.accountIdentity);
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
    for (const row of filterRowsByAccount(rows, accountFilter)) {
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
  const resetAt = rateWindowResetsAt(window);
  const seconds = rateWindowSeconds(window);
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
    .filter(
      (candidate) =>
        candidate?.rateLimits &&
        Number.isFinite(dateMs(candidate.timestamp)) &&
        rateLimitsHaveCurrentWindow(candidate.rateLimits, candidate.timestamp)
    )
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
    serviceTier =
      entry.payload?.service_tier ?? entry.payload?.serviceTier ??
      entry.payload?.rate_limits?.service_tier ?? entry.payload?.rate_limits?.serviceTier ??
      serviceTier;
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
      const eventServiceTier =
        entry.payload?.service_tier ?? entry.payload?.serviceTier ??
        entry.payload?.rate_limits?.service_tier ?? entry.payload?.rate_limits?.serviceTier ??
        serviceTier;
      events.push({
        filePath: file.path,
        sessionId: sessionId ?? file.path,
        startedAtMs,
        timestamp,
        ms,
        model,
        serviceTier: eventServiceTier,
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

function normalizeLedgerEvent(raw, fallbackPath) {
  const ms = Number(raw?.ms);
  const timestamp = raw?.timestamp ?? (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const resolvedMs = Number.isFinite(ms) ? ms : dateMs(timestamp);
  if (!Number.isFinite(resolvedMs)) return null;
  return {
    filePath: raw?.filePath ?? fallbackPath ?? null,
    sessionId: raw?.sessionId ?? fallbackPath ?? null,
    startedAtMs: Number.isFinite(Number(raw?.startedAtMs)) ? Number(raw.startedAtMs) : null,
    timestamp: timestamp ?? new Date(resolvedMs).toISOString(),
    ms: resolvedMs,
    model: raw?.model ?? null,
    serviceTier: raw?.serviceTier ?? null,
    tokenUsage: cloneTokenUsage(raw?.tokenUsage),
    rateLimits: raw?.rateLimits ?? null,
  };
}

function compactQuotaEventForLedger(event) {
  return normalizeLedgerEvent(
    {
      filePath: event.filePath,
      sessionId: event.sessionId,
      startedAtMs: event.startedAtMs,
      timestamp: event.timestamp,
      ms: event.ms,
      model: event.model,
      serviceTier: event.serviceTier,
      tokenUsage: event.tokenUsage,
      rateLimits: event.rateLimits,
    },
    event.filePath
  );
}

function normalizeTokenLedger(raw) {
  const files = {};
  const sourceFiles = raw?.version === TOKEN_LEDGER_VERSION && raw.files && typeof raw.files === "object" ? raw.files : {};
  for (const [filePath, entry] of Object.entries(sourceFiles)) {
    const pathKey = typeof entry?.path === "string" && entry.path ? entry.path : filePath;
    const events = Array.isArray(entry?.events)
      ? entry.events.map((event) => normalizeLedgerEvent(event, pathKey)).filter(Boolean)
      : [];
    files[pathKey] = {
      path: pathKey,
      size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : 0,
      mtimeMs: Number.isFinite(Number(entry?.mtimeMs)) ? Number(entry.mtimeMs) : 0,
      latestAt: entry?.latestAt ?? events.at(-1)?.timestamp ?? null,
      eventCount: events.length,
      events,
    };
  }
  return {
    version: TOKEN_LEDGER_VERSION,
    updatedAt: raw?.updatedAt ?? null,
    files,
  };
}

async function readLocalTokenLedger() {
  return normalizeTokenLedger(await readJson(tokenLedgerPath(), { version: TOKEN_LEDGER_VERSION, files: {} }));
}

function pruneTokenLedgerFiles(filesByPath) {
  const sorted = Object.values(filesByPath)
    .filter((entry) => entry?.path)
    .sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  const kept = {};
  let eventCount = 0;
  for (const entry of sorted) {
    if (Object.keys(kept).length >= TOKEN_LEDGER_FILE_LIMIT) break;
    if (eventCount >= TOKEN_LEDGER_EVENT_LIMIT) break;
    kept[entry.path] = entry;
    eventCount += Array.isArray(entry.events) ? entry.events.length : 0;
  }
  return kept;
}

function ledgerFileUnchanged(entry, file) {
  return (
    entry &&
    Number(entry.size) === Number(file.size) &&
    Math.round(Number(entry.mtimeMs || 0)) === Math.round(Number(file.mtimeMs || 0))
  );
}

async function readLocalTokenLedgerEvents(files, options = {}) {
  return runTokenLedgerOperation(async () => {
    const scanLimit = Number.isFinite(options.scanLimit) ? options.scanLimit : TOKEN_LEDGER_SCAN_LIMIT;
    const recentFiles = files.slice(0, scanLimit);
    const ledger = await readLocalTokenLedger();
    let changed = false;

    for (const file of recentFiles) {
      const existing = ledger.files[file.path];
      if (ledgerFileUnchanged(existing, file)) continue;
      try {
        const events = (await parseQuotaEventFile(file)).map(compactQuotaEventForLedger).filter(Boolean);
        ledger.files[file.path] = {
          path: file.path,
          size: file.size,
          mtimeMs: file.mtimeMs,
          latestAt: events.at(-1)?.timestamp ?? null,
          eventCount: events.length,
          events,
        };
        changed = true;
      } catch {
        if (!existing) {
          ledger.files[file.path] = {
            path: file.path,
            size: file.size,
            mtimeMs: file.mtimeMs,
            latestAt: null,
            eventCount: 0,
            events: [],
          };
          changed = true;
        }
      }
    }

    const prunedFiles = pruneTokenLedgerFiles(ledger.files);
    const pruned = Object.keys(prunedFiles).length !== Object.keys(ledger.files).length;
    ledger.files = prunedFiles;
    ledger.updatedAt = new Date().toISOString();
    if (changed || pruned) {
      await writeJsonAtomic(tokenLedgerPath(), ledger, { pretty: false });
    }

    const allowed = new Set(recentFiles.map((file) => file.path));
    return Object.values(ledger.files)
      .filter((entry) => allowed.has(entry.path))
      .flatMap((entry) => entry.events.map((event) => normalizeLedgerEvent(event, entry.path)).filter(Boolean))
      .sort((a, b) => a.ms - b.ms);
  });
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

function normalizeAccountFilter(identity) {
  const ids = new Set();
  const emails = new Set();
  for (const value of [identity?.userId, identity?.accountUserId, identity?.chatgptUserId, identity?.subject]) {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (text) ids.add(text);
  }
  const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
  if (email) emails.add(email);
  return ids.size || emails.size ? { ids, emails } : null;
}

function responseEventAccountMatch(event, accountFilter) {
  if (!accountFilter) return "match";
  const accountId = typeof event?.accountId === "string" ? event.accountId.trim().toLowerCase() : "";
  const email = typeof event?.email === "string" ? event.email.trim().toLowerCase() : "";
  if (!accountId && !email) return "unknown";
  if (accountId && accountFilter.ids.has(accountId)) return "match";
  if (email && accountFilter.emails.has(email)) return "match";
  return "mismatch";
}

function filterRowsByAccount(rows, accountFilter) {
  if (!accountFilter) return rows;
  const parsed = rows.map((row) => {
    const fields = parseLogKeyValues(row?.feedback_log_body);
    return {
      row,
      accountId: fields["user.account_id"] || null,
      email: fields["user.email"] || null,
    };
  });
  const hasTaggedRows = parsed.some((entry) => entry.accountId || entry.email);
  if (!hasTaggedRows) return rows;
  return parsed
    .filter((entry) => responseEventAccountMatch(entry, accountFilter) === "match")
    .map((entry) => entry.row);
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
      accountId: null,
      email: null,
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
  const toolTokenCount = numberField(fields, "tool_token_count");
  const totalTokens = Math.max(0, inputTokens + outputTokens);
  const eventTotalTokens = totalTokens > 0 ? totalTokens : toolTokenCount;
  if (eventTotalTokens <= 0) return null;

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
      totalTokens: eventTotalTokens,
    },
    signature: [
      Math.floor(ms / 1000),
      model ?? "",
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
    ].join("|"),
    accountId: fields["user.account_id"] || null,
    email: fields["user.email"] || null,
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
  const accountFilter = normalizeAccountFilter(options.accountIdentity);
  const accountCacheKey = accountFilter
    ? `${Array.from(accountFilter.ids).join(",")}|${Array.from(accountFilter.emails).join(",")}`
    : "all";
  const cacheKey = [
    await fileCachePart(logsDbPath()),
    await fileCachePart(logsDbWalPath()),
    await fileCachePart(logsDbShmPath()),
    sinceSeconds,
    accountCacheKey,
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

    const parsedEvents = [];
    let hasAccountTaggedEvents = false;
    for (const row of rows) {
      const event = responseCompletedEventFromLogRow(row);
      if (!event) continue;
      if (event.accountId || event.email) hasAccountTaggedEvents = true;
      parsedEvents.push(event);
    }

    const filteredEvents =
      accountFilter && hasAccountTaggedEvents
        ? parsedEvents.filter((event) => responseEventAccountMatch(event, accountFilter) === "match")
        : parsedEvents;

    const seen = new Set();
    const rawEvents = [];
    for (const event of filteredEvents) {
      if (seen.has(event.signature)) continue;
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
  return windowFor(rateLimits, kind);
}

function rawUsedPercent(rateLimits, kind) {
  return rateWindowUsedPercent(quotaRawWindow(rateLimits, kind));
}

function rateLimitsMatchPlan(rateLimits, planType) {
  const eventPlan = rateLimits?.plan_type ?? null;
  return planTypesMatch(eventPlan, planType);
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

function calibrationWindowFromLearning(calibration, kind, planType) {
  if (calibration?.algorithm !== QUOTA_ESTIMATE_ALGORITHM) return null;
  const window = calibration?.[kind];
  const value = Number(window?.coefficient);
  return isReasonableQuotaCoefficient(value, planType, kind) ? window : null;
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
    if (!Number.isFinite(fallback)) {
      return {
        coefficient: activeCoefficient,
        source: "active-session-low-sample",
      };
    }
    return {
      coefficient: activeCoefficient * 0.75 + fallback * 0.25,
      source: "active-session-low-sample",
    };
  }
  if (Number.isFinite(historicalCoefficient)) return { coefficient: historicalCoefficient, source: "low-sample" };
  if (Number.isFinite(fallback)) return { coefficient: fallback, source: "fallback" };
  return { coefficient: null, source: "unsupported-plan" };
}

function blendLearnedCoefficient(kind, selected, learnedCoefficient, planType, learnedWindow = null) {
  if (!Number.isFinite(learnedCoefficient) || learnedCoefficient <= 0) return selected;
  if (!isReasonableQuotaCoefficient(learnedCoefficient, planType, kind)) return selected;
  const base = Number(selected?.coefficient);
  if (!Number.isFinite(base) || base <= 0) return { coefficient: learnedCoefficient, source: "learned" };
  const min = base * 0.5;
  const max = base * 2;
  const bounded = Math.max(min, Math.min(max, learnedCoefficient));
  const samples = Number(learnedWindow?.samples || 0);
  const errorRatio = Number(learnedWindow?.lastSample?.errorRatio);
  const selectedSource = String(selected?.source || "");
  let learnedWeight = samples >= 5 ? 0.72 : samples >= 2 ? 0.64 : 0.55;
  if (Number.isFinite(errorRatio) && errorRatio > 0 && (errorRatio >= 1.25 || errorRatio <= 0.8)) {
    learnedWeight = Math.max(learnedWeight, 0.82);
  }
  if (selectedSource.startsWith("active-session") && samples < 3) {
    learnedWeight = Math.min(learnedWeight, Number.isFinite(errorRatio) && (errorRatio >= 1.35 || errorRatio <= 0.7) ? 0.62 : 0.45);
  }
  return {
    coefficient: bounded * learnedWeight + base * (1 - learnedWeight),
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
  const files = options.files ?? await walkSessionFiles(sessionsDir());
  const records = await readLocalRecords(files, options.since);
  return estimateLocalQuota(options.baseQuota, records, options);
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
  const files = options.files ?? await walkSessionFiles(sessionsDir());
  const records = await readLocalRecords(files, options.since);
  return quotaFromRecords(records, options.since);
}

async function readLocalUsage(options = {}) {
  const files = options.files ?? await localDataCache.getSessionFiles(sessionsDir(), walkSessionFiles);
  const records = await readLocalRecords(files);
  const usage = aggregateUsage(records, {...options, indexMap:await readSessionIndexMap()});
  return {...usage, scannedFiles:files.length, totalFiles:files.length, failedFiles:files.length-records.length, latestQuota:null};
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

function localStoredQuotaSnapshot(snapshot) {
  if (!snapshot || snapshot.source === QUOTA_MODE_ONLINE || snapshot.schemaVersion !== 2) return null;
  const session = rateWindowHasDisplayData(snapshot.session) ? snapshot.session : null;
  const weekly = rateWindowHasDisplayData(snapshot.weekly) ? snapshot.weekly : null;
  const strippedSession = !!snapshot.session && !session;
  const strippedWeekly = !!snapshot.weekly && !weekly;
  if (!session && !weekly && !snapshot.credits && !normalizeResetCredits(snapshot.resetCredits, snapshot.resetCredits?.checkedAt)) return null;
  return {
    ...snapshot,
    session,
    weekly,
    estimate:
      strippedSession || strippedWeekly
        ? {
            ...snapshot.estimate,
            available: false,
            reason: "\u7b49\u5f85\u65b0\u7684\u672c\u5730\u989d\u5ea6\u5feb\u7167",
          }
        : snapshot.estimate ?? null,
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
    accountQuotaSnapshot: localStoredQuotaSnapshot(account?.quotaSnapshot),
    accountQuotaCalibration: account?.quotaCalibration ?? null,
    settings: normalizeSettingsForState(index.settings),
    since: account?.lastSwitchedAt ?? null,
    mode: account?.lastSwitchedAt ? "since-account-switch" : "all-local",
  };
}

async function saveAccountQuotaSnapshot(accountId, quota) {
  if (!accountId || !quota || !["local", "local-error"].includes(quota.source)) return false;
  return mutateIndex(async (index) => {
    if (index.activeAccountId !== accountId) return {value:false,write:false};
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) return { value: false, write: false };
    if (!quotaMatchesAccount(account, quota)) return { value: false, write: false };
    const learned = quota.calibration && JSON.stringify(account.quotaCalibration) !== JSON.stringify(quota.calibration);
    if (learned) account.quotaCalibration = quota.calibration;
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
  return rateWindowHasDisplayData(window);
}

function mergeAccountQuotaWindow(nextWindow, previousWindow) {
  if (quotaWindowHasDisplayData(nextWindow)) return nextWindow;
  return quotaWindowHasDisplayData(previousWindow) ? previousWindow : nextWindow ?? null;
}

function newestResetCredits(...resets) {
  return resets.filter((reset) => normalizeResetCredits(reset, reset?.checkedAt) && Number.isFinite(Date.parse(reset.checkedAt)))
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] ?? null;
}

async function saveAccountResetCredits(accountId, reset) {
  if (!accountId || !newestResetCredits(reset)) return false;
  return mutateIndex(async (index) => {
    if (index.activeAccountId !== accountId) return { value: false, write: false };
    const account = index.accounts.find((item) => item.id === accountId);
    if (!account) return { value: false, write: false };
    const previous = localStoredQuotaSnapshot(account.quotaSnapshot);
    const latest = newestResetCredits(reset, previous?.resetCredits);
    if (JSON.stringify(latest) === JSON.stringify(previous?.resetCredits)) return { value: false, write: false };
    account.quotaSnapshot = buildAccountQuotaSnapshot({
      ...(previous ?? { source: "local", planType: account.identity?.planType ?? null, session: null, weekly: null, credits: null, checkedAt: reset.checkedAt }),
      resetCredits: latest,
    });
    account.quotaSnapshotUpdatedAt = new Date().toISOString();
    return { value: true };
  });
}

function buildAccountQuotaSnapshot(quota, previous) {
  const {calibration, ...snapshot} = quota;
  return {...snapshot, resetCredits: newestResetCredits(snapshot.resetCredits, previous?.schemaVersion === 2 ? previous.resetCredits : null), schemaVersion:2};
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
  const predictedDelta = Number(estimate);
  const errorRatio = predictedDelta > 0 ? actualDelta / predictedDelta : null;
  return {
    coefficient,
    actualDelta: Math.round(actualDelta * 10) / 10,
    predictedDelta: Math.round(estimate * 10) / 10,
    errorRatio: Number.isFinite(errorRatio) && errorRatio > 0 ? Math.round(errorRatio * 100) / 100 : null,
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
    (predictedDelta > actualDelta * 1.35 || actualDelta > predictedDelta * 1.25);
  const severeMiss =
    Number.isFinite(predictedDelta) &&
    Number.isFinite(actualDelta) &&
    actualDelta > 0 &&
    (predictedDelta > actualDelta * 2 || actualDelta > predictedDelta * 1.5);
  const sampleWeight = severeMiss ? 0.85 : needsFastCorrection ? 0.65 : 0.42;
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
      if (
        account.quotaSnapshot &&
        (account.quotaSnapshot.source === QUOTA_MODE_ONLINE || !quotaMatchesAccount(account, account.quotaSnapshot))
      ) {
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
  if (!scope.hasCurrentAuth || !scope.since) return null;
  const local = await readLatestLocalQuota({since:scope.since, files});
  const sqlite = await readLatestSqliteRateLimitQuota({since:scope.since, accountIdentity:scope.account});
  // Structured bucket snapshots outrank legacy errors that do not name a bucket.
  return combineBuckets([local, sqlite]) ?? await readLatestUsageLimitQuota({since:scope.since, accountIdentity:scope.account});
}

async function resolveQuotaWithMode(scope, files) {
  const latestQuota = await readBestLocalQuota(scope, files);
  const baseQuota = resolveQuota(scope, latestQuota);
  const records = await readLocalRecords(files, scope.since);
  const estimated = latestQuota ? estimateLocalQuota(baseQuota, records, {since:scope.since, calibration:scope.accountQuotaCalibration}) : baseQuota;
  const reset = await readLocalResetCredits(scope, records);
  const savedReset = scope.accountQuotaSnapshot?.resetCredits;
  estimated.resetCredits = newestResetCredits(reset, savedReset);
  if (latestQuota && scope.accountId) await saveAccountQuotaSnapshot(scope.accountId, estimated);
  else if (reset && scope.accountId) await saveAccountResetCredits(scope.accountId, reset);
  const {calibration, ...publicQuota} = estimated;
  return publicQuota;
}

async function getQuota() {
  const scope = await dashboardScope();
  if (!scope.hasCurrentAuth) {
    return { quota: resolveQuota(scope, null), scope, checkedAt: new Date().toISOString() };
  }
  return localDataCache.cached(localDataCache.buildQuotaKey(scope), async () => {
    const files = await localDataCache.getSessionFiles(sessionsDir(), walkSessionFiles);
    const resolvedQuota = await resolveQuotaWithMode(scope, files);
    return {
      quota: resolvedQuota,
      scope,
      checkedAt: new Date().toISOString(),
    };
  });
}

async function getDashboard() {
  const scope = await dashboardScope();
  if (!scope.hasCurrentAuth) {
    return { quota: resolveQuota(scope, null), usage: emptyLocalUsage(scope.since), scope };
  }
  return localDataCache.cached(localDataCache.buildDashboardKey(scope), async () => {
    const files = await localDataCache.getSessionFiles(sessionsDir(), walkSessionFiles);
    const usage = await readLocalUsage({ since: scope.since, files });
    const quota = await resolveQuotaWithMode(scope, files, usage);
    return { quota, usage, scope };
  });
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
            isCachedSnapshot: !isActive,
            resetCredits: snapshot.resetCredits ?? null,
            additional: snapshot.additional ?? [],
            session: snapshot.session
              ? {
                  usedPercent: snapshot.session.usedPercent ?? null,
                  estimatedUsedPercent: snapshot.session.estimatedUsedPercent ?? null,
                  estimatedRemainingPercent:
                    snapshot.session.estimatedRemainingPercent ??
                    (snapshot.session.usedPercent != null ? Math.max(0, 100 - snapshot.session.usedPercent) : null),
                  estimatedDeltaPercent: snapshot.session.estimatedDeltaPercent ?? null,
                  windowMinutes: snapshot.session.windowMinutes ?? null,
                  resetsAt: snapshot.session.resetsAt ?? null,
                }
              : null,
            weekly: snapshot.weekly
              ? {
                  usedPercent: snapshot.weekly.usedPercent ?? null,
                  estimatedUsedPercent: snapshot.weekly.estimatedUsedPercent ?? null,
                  estimatedRemainingPercent:
                    snapshot.weekly.estimatedRemainingPercent ??
                    (snapshot.weekly.usedPercent != null ? Math.max(0, 100 - snapshot.weekly.usedPercent) : null),
                  estimatedDeltaPercent: snapshot.weekly.estimatedDeltaPercent ?? null,
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
    icon: appIconPath(),
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

function defaultWidgetBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = WIDGET_WIDTH;
  const height = WIDGET_MIN_HEIGHT;
  return {
    x: Math.max(workArea.x + 12, workArea.x + workArea.width - width - 24),
    y: workArea.y + 72,
    width,
    height,
  };
}

function clampWidgetBoundsToDisplay(bounds) {
  const normalized = normalizeWidgetBounds(bounds);
  if (!normalized) return defaultWidgetBounds();
  const workArea = screen.getDisplayMatching(normalized).workArea;
  const width = Math.min(normalized.width, workArea.width);
  const height = Math.min(normalized.height, workArea.height);
  return {
    x: clamp(normalized.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(normalized.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function currentWidgetBoundsForPersistence() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return null;
  if (widgetDockState.collapsed && widgetDockState.expandedBounds) return widgetDockState.expandedBounds;
  return widgetWindow.getBounds();
}

async function saveWidgetBoundsNow() {
  const bounds = normalizeWidgetBounds(currentWidgetBoundsForPersistence());
  if (!bounds) return;
  const serializedBounds = JSON.stringify(bounds);
  widgetManualSize = true;
  runtimeSettings = normalizeSettings({ ...(runtimeSettings ?? defaultSettings()), widgetBounds: bounds });
  await mutateIndex(async (index) => {
    const previousBounds = JSON.stringify(normalizeSettings(index.settings).widgetBounds);
    if (previousBounds === serializedBounds) return { write: false };
    index.settings = normalizeSettings({ ...index.settings, widgetBounds: bounds });
    return {};
  });
}

function scheduleWidgetBoundsSave(delayMs = 350) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (widgetBoundsSaveTimer) clearTimeout(widgetBoundsSaveTimer);
  widgetBoundsSaveTimer = setTimeout(() => {
    widgetBoundsSaveTimer = null;
    saveWidgetBoundsNow().catch(() => {});
  }, delayMs);
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;
  const savedBounds = normalizeWidgetBounds(runtimeSettings?.widgetBounds);
  const bounds = clampWidgetBoundsToDisplay(savedBounds);
  const initialMaxHeight = Math.max(
    WIDGET_MIN_HEIGHT,
    screen.getDisplayMatching(bounds).workArea.height
  );
  if (savedBounds) widgetManualSize = true;
  widgetWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: WIDGET_MIN_WIDTH,
    minHeight: WIDGET_MIN_HEIGHT,
    maxWidth: WIDGET_MAX_WIDTH,
    maxHeight: initialMaxHeight,
    x: bounds.x,
    y: bounds.y,
    title: "Codex Quick View",
    icon: appIconPath(),
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: widgetAlwaysOnTop,
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
  widgetWindow.setVisibleOnAllWorkspaces(widgetAlwaysOnTop, { visibleOnFullScreen: false });
  widgetWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    widgetWindow.hide();
  });
  widgetWindow.on("move", () => {
    scheduleWidgetDockCheck();
    scheduleWidgetBoundsSave();
  });
  widgetWindow.on("moved", () => {
    scheduleWidgetDockCheck();
    scheduleWidgetBoundsSave(120);
  });
  widgetWindow.on("resize", () => scheduleWidgetBoundsSave());
  widgetWindow.on("show", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.on("hide", () => rebuildTrayMenu().catch(() => {}));
  widgetWindow.loadFile(path.join(__dirname, "ui", "widget.html"));
  return widgetWindow;
}

function setWidgetTopmost(pinned) {
  widgetAlwaysOnTop = pinned === true;
  const win = createWidgetWindow();
  win.setAlwaysOnTop(widgetAlwaysOnTop);
  win.setVisibleOnAllWorkspaces(widgetAlwaysOnTop, { visibleOnFullScreen: false });
  return { ok: true, pinned: widgetAlwaysOnTop };
}

function resizeWidgetForAccounts(accountCount) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return { ok: false };
  const numericCount = Number(accountCount);
  widgetAccountCount = Number.isFinite(numericCount) ? Math.max(0, Math.floor(numericCount)) : 0;
  const bounds = widgetDockState.collapsed && widgetDockState.expandedBounds ? widgetDockState.expandedBounds : widgetWindow.getBounds();
  const maxHeight = widgetMaxHeightForBounds(bounds);
  const nextHeight = widgetManualSize ? Math.min(bounds.height, maxHeight) : WIDGET_MIN_HEIGHT;
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const maxY = workArea.y + workArea.height - nextHeight - 8;
  const nextY = Math.max(workArea.y + 8, Math.min(bounds.y, maxY));
  const nextBounds = {
    x: bounds.x,
    y: nextY,
    width: widgetManualSize ? bounds.width : WIDGET_WIDTH,
    height: nextHeight,
  };
  widgetWindow.setMaximumSize(WIDGET_MAX_WIDTH, maxHeight);
  if (widgetResizeSession) return { ok: true, height: bounds.height, maxHeight, skipped: true };
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
    if (!boundsNear(bounds, nextBounds)) widgetWindow.setBounds(nextBounds, false);
  }
  return { ok: true, height: nextHeight, maxHeight };
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
  const height = clamp(bounds.height, WIDGET_MIN_HEIGHT, widgetMaxHeightForBounds(bounds));
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
  const maxHeight = widgetMaxHeightForBounds(start);
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
  if (bottom - top > maxHeight) {
    if (direction.includes("n")) top = bottom - maxHeight;
    else bottom = top + maxHeight;
  }

  const display = screen.getDisplayMatching(start);
  const workArea = display.workArea;
  const width = clamp(right - left, WIDGET_MIN_WIDTH, WIDGET_MAX_WIDTH);
  const height = clamp(bottom - top, WIDGET_MIN_HEIGHT, maxHeight);
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
  scheduleWidgetBoundsSave(120);
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

async function checkForUpdates(event) {
  if (updateDialogPending) return { ok: true, busy: true };
  updateDialogPending = true;
  const parent = BrowserWindow.fromWebContents(event.sender);
  const show = (options) => parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  try {
    updateChecker ??= createUpdateChecker({ currentVersion: app.getVersion() });
    const result = await updateChecker.check();
    const newer = result.comparison > 0;
    const canDownload = newer && result.installer;
    const buttons = canDownload ? ["下载安装包", "查看更新说明", "关闭"] : ["查看更新说明", "关闭"];
    const detail = [`当前版本：v${result.currentVersion}`, `GitHub 最新正式版：v${result.latestVersion}`];
    if (canDownload) detail.push(`安装包：${result.installer.name}（${(result.installer.size / 1024 / 1024).toFixed(1)} MB）`, "点击下载会打开浏览器；下载完成后运行安装包更新。");
    else if (newer) detail.push("该版本暂未提供适用于本机的安装包，请在发布页查看。");
    else if (result.comparison < 0) detail.push("本机版本比 GitHub 已发布版本更新，无需降级。");
    detail.push("仅查询公开 GitHub 发布信息，不发送账号、凭证或用量数据。");
    const choice = await show({ type: "info", title: "CodexAuth 更新",
      message: newer ? `发现新版本 v${result.latestVersion}` : result.comparison === 0 ? "当前已是最新正式版" : "本机版本更新",
      detail: detail.join("\n\n"), buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    if (canDownload && choice.response === 0) await shell.openExternal(result.installer.url);
    else if (choice.response === (canDownload ? 1 : 0)) await shell.openExternal(result.releaseUrl);
    return { ok: true, latestVersion: result.latestVersion };
  } catch (error) {
    await show({ type: "warning", title: "CodexAuth 更新", message: "暂时无法检查更新",
      detail: error.message, buttons: ["关闭"], noLink: true });
    return { ok: false };
  } finally { updateDialogPending = false; }
}

function registerIpc() {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("updates:check", checkForUpdates);
  ipcMain.handle("diagnostics:get", async () => (await currentState()).diagnostics);
  ipcMain.handle("state:get", () => currentState());
  ipcMain.handle("account:export-portable", (_event, password) => exportCurrentCredentials(password));
  ipcMain.handle("account:import-portable", async (_event, password) => {
    const result = await importPortableCredentials(password);
    if (!result.canceled) broadcastStateChanged();
    return result;
  });
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
  ipcMain.handle("account:reorder", async (_event, accountIds) => {
    const result = await reorderAccounts(accountIds);
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
  ipcMain.handle("codex:restart", () => restartCodexAppQueued());
  ipcMain.handle("quota:get", () => getQuota());
  ipcMain.handle("dashboard:get", () => getDashboard());
  ipcMain.handle("dashboard:all-accounts", () => getAllAccountsQuotaSummary());
  ipcMain.handle("dashboard:all-usage", () =>
    localDataCache.cached(localDataCache.buildUsageKey({ since: null, scanLimit: 200 }), () =>
      readLocalUsage({ since: null })
    )
  );
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
  ipcMain.handle("window:get-widget-topmost", () => ({ ok: true, pinned: widgetAlwaysOnTop }));
  ipcMain.handle("window:set-widget-topmost", (_event, pinned) => setWidgetTopmost(pinned));
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
    await recoverStoreIfNeeded();
    await ensureCodexFileCredentialStore();
    const settings = await syncLaunchAtLoginFromSettings();
    await migratePlaintextBackups();
    await cleanupStoreArtifacts();
    await hydrateStoredAccountMetadata();
    await cleanupMismatchedQuotaSnapshots();
    registerIpc();
    installNetworkGuards();
    createTray();
    startupReady = true;
    if (pendingWindow === "widget" || (!pendingWindow && shouldStartWithWidgetOnly(settings))) {
      showWidgetWindow();
    } else {
      createWindow();
    }
    pendingWindow = null;
    await startAuthWatcher();
    await startLocalLogWatcher();
    await startSessionsWatcher();
    await startSessionsPolling();

    app.on("activate", () => {
      showMainWindow();
    });
  }).catch((error) => {
    console.error("CodexAuth initialization failed:", error);
    dialog.showErrorBox("CodexAuth 启动失败", "初始化未完成，请重新打开 CodexAuth。已保存的账号不会因此被清空。");
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (widgetBoundsSaveTimer) {
    clearTimeout(widgetBoundsSaveTimer);
    widgetBoundsSaveTimer = null;
    saveWidgetBoundsNow().catch(() => {});
  }
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
