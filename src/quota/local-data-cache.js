const { LOCAL_DATA_CACHE_TTL_MS } = require("./constants");

function createLocalDataCache(ttlMs = LOCAL_DATA_CACHE_TTL_MS) {
  let sessionFilesCache = null;
  let sessionFilesDir = null;
  let sessionFilesExpiresAt = 0;
  const entries = new Map();

  function invalidate() {
    sessionFilesCache = null;
    sessionFilesDir = null;
    sessionFilesExpiresAt = 0;
    entries.clear();
  }

  function isFresh(expiresAt) {
    return Date.now() < expiresAt;
  }

  async function getSessionFiles(dir, loader) {
    const now = Date.now();
    if (sessionFilesCache && sessionFilesDir === dir && isFresh(sessionFilesExpiresAt)) {
      return sessionFilesCache;
    }
    const files = await loader(dir);
    sessionFilesCache = files;
    sessionFilesDir = dir;
    sessionFilesExpiresAt = now + ttlMs;
    return files;
  }

  async function cached(key, loader) {
    const hit = entries.get(key);
    if (hit && isFresh(hit.expiresAt)) return hit.value;
    const value = await loader();
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (entries.size > 24) {
      const firstKey = entries.keys().next().value;
      entries.delete(firstKey);
    }
    return value;
  }

  function buildDashboardKey(scope) {
    return [
      "dashboard",
      scope?.accountId ?? "none",
      scope?.since ?? "all",
      scope?.hasCurrentAuth ? "auth" : "no-auth",
    ].join(":");
  }

  function buildQuotaKey(scope) {
    return ["quota", scope?.accountId ?? "none", scope?.since ?? "all", scope?.hasCurrentAuth ? "auth" : "no-auth"].join(
      ":"
    );
  }

  function buildUsageKey(options) {
    return ["usage", options?.since ?? "all", String(options?.scanLimit ?? "default")].join(":");
  }

  return {
    invalidate,
    getSessionFiles,
    cached,
    buildDashboardKey,
    buildQuotaKey,
    buildUsageKey,
  };
}

module.exports = { createLocalDataCache };
