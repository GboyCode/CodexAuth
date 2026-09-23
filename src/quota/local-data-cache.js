const { LOCAL_DATA_CACHE_TTL_MS } = require("./constants");

function createLocalDataCache(ttlMs = LOCAL_DATA_CACHE_TTL_MS) {
  let sessionFilesCache = null;
  let sessionFilesDir = null;
  let sessionFilesExpiresAt = 0;
  const entries = new Map();
  const pending = new Map();
  let generation = 0;
  let sessionFilesPending = null;

  function invalidate() {
    generation++;
    sessionFilesCache = null;
    sessionFilesDir = null;
    sessionFilesExpiresAt = 0;
    entries.clear();
    pending.clear();
    sessionFilesPending = null;
  }

  function isFresh(expiresAt) {
    return Date.now() < expiresAt;
  }

  async function getSessionFiles(dir, loader) {
    if (sessionFilesCache && sessionFilesDir === dir && isFresh(sessionFilesExpiresAt)) {
      return sessionFilesCache;
    }
    if (sessionFilesPending?.dir === dir) return sessionFilesPending.promise;
    const revision = generation;
    const job = { dir, promise: null };
    job.promise = Promise.resolve().then(() => loader(dir)).then((files) => {
      if (generation === revision && sessionFilesPending === job) {
        sessionFilesCache = files;
        sessionFilesDir = dir;
        sessionFilesExpiresAt = Date.now() + ttlMs;
      }
      return files;
    }).finally(() => { if (sessionFilesPending === job) sessionFilesPending = null; });
    sessionFilesPending = job;
    return job.promise;
  }

  async function cached(key, loader) {
    const hit = entries.get(key);
    if (hit && isFresh(hit.expiresAt)) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const revision = generation;
    const job = Promise.resolve().then(loader).then((value) => {
      if (revision === generation) {
        entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        if (entries.size > 24) entries.delete(entries.keys().next().value);
      }
      return value;
    }).finally(() => { if (pending.get(key) === job) pending.delete(key); });
    pending.set(key, job);
    return job;
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
