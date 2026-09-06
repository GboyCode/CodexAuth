const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { normalizeResetCredits } = require("./local-records");

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_FILE = 32 * 1024 * 1024;
const MAX_STREAM = 1024 * 1024;

function browserCacheDirectories(appData) {
  const codex = path.join(appData, "Codex");
  return [
    codex,
    path.join(codex, "Partitions", "codex-browser-app"),
    path.join(codex, "web", "Codex", "Default"),
    path.join(codex, "web", "Codex", "codex-browser-app"),
    path.join(codex, "web", "Codex", "Default", "Partitions", "codex-browser-app"),
  ].map((dir) => path.join(dir, "Cache", "Cache_Data"));
}

async function discoverBrowserCacheDirectories(appData, localAppData = process.env.LOCALAPPDATA) {
  const roots = [appData];
  // Store/MSIX installs can redirect Codex's roaming profile into LocalCache.
  if (localAppData) {
    const packages = path.join(localAppData, "Packages");
    try {
      const entries = await fs.readdir(packages, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory() && /^OpenAI\.Codex_[\w]+$/i.test(item.name)).slice(0, 8)) {
        roots.push(path.join(packages, entry.name, "LocalCache", "Roaming"));
      }
    } catch { /* The unpackaged app and non-Windows platforms have no Packages directory. */ }
  }
  return [...new Set(roots.flatMap(browserCacheDirectories))];
}

function resetFromCachedUsage(data, headers, identity, now = Date.now()) {
  // The separate reset-credit endpoint has no account identity. Never use it.
  if (!identity?.userId || !identity?.chatgptUserId ||
      data?.account_id !== identity.userId || data?.user_id !== identity.chatgptUserId) return null;
  if (!/HTTP\/\d(?:\.\d)? 200(?: |\0)/.test(headers)) return null;
  const date = headers.match(/(?:^|\0)date:\s*([^\0]+)/i)?.[1];
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || timestamp > now + 60000) return null;
  const reset = normalizeResetCredits(data.rate_limit_reset_credits, new Date(timestamp).toISOString());
  return reset ? { ...reset, source: "local-browser-cache" } : null;
}

async function readBrowserResetCache(directory, identity) {
  // Read Chromium's indexed block-cache entries only, never loose JSON fragments
  // or deleted blocks. All cache access is read-only and bounded.
  const buffers = new Map();
  async function file(name) {
    if (!buffers.has(name)) {
      const filename = path.join(directory, name);
      const stat = await fs.stat(filename);
      if (stat.size > MAX_FILE) throw new Error("Cache file exceeds read limit");
      buffers.set(name, await fs.readFile(filename));
    }
    return buffers.get(name);
  }
  async function stream(address, length) {
    if (!(address >>> 31) || length < 0 || length > MAX_STREAM) throw new Error("Invalid cache address");
    const type = (address >>> 28) & 7;
    let name, offset;
    if (type === 0) {
      name = `f_${(address & 0xfffffff).toString(16).padStart(6, "0")}`;
      offset = 0;
    } else {
      const blockSize = { 2: 256, 3: 1024, 4: 4096 }[type];
      if (!blockSize || length > (((address >>> 24) & 3) + 1) * blockSize) throw new Error("Invalid cache block");
      name = `data_${(address >>> 16) & 255}`;
      offset = 8192 + (address & 65535) * blockSize;
    }
    const data = await file(name);
    if (offset + length > data.length) throw new Error("Incomplete cache stream");
    return data.subarray(offset, offset + length);
  }
  let latest = null;
  try {
    const index = await file("index");
    if (index.length < 368 || index.readUInt32LE(0) !== 0xc103cac3 || index.readUInt32LE(4) !== 0x30000) return null;
    const tableSize = index.readUInt32LE(28);
    if (!tableSize || tableSize > 1048576 || index.length < 368 + tableSize * 4) return null;
    const visited = new Set();
    for (let slot = 0; slot < tableSize; slot++) {
      let address = index.readUInt32LE(368 + slot * 4);
      while (address && !visited.has(address) && visited.size < 10000) {
        visited.add(address);
        let nextAddress = 0;
        try {
          const entry = await stream(address, 256);
          nextAddress = entry.readUInt32LE(4);
          address = nextAddress;
          const keyLength = entry.readUInt32LE(32);
          if (entry.readInt32LE(20) !== 0 || keyLength < USAGE_URL.length || keyLength > 160 || entry.readUInt32LE(36)) continue;
          const key = entry.subarray(96, 96 + keyLength).toString("utf8");
          if (key !== USAGE_URL && !key.endsWith(` ${USAGE_URL}`)) continue;
          const headers = (await stream(entry.readUInt32LE(56), entry.readUInt32LE(40))).toString("latin1");
          let body = await stream(entry.readUInt32LE(60), entry.readUInt32LE(44));
          const encoding = headers.match(/(?:^|\0)content-encoding:\s*([^\0]+)/i)?.[1].trim().toLowerCase();
          const options = { maxOutputLength: MAX_STREAM };
          if (encoding === "br") body = zlib.brotliDecompressSync(body, options);
          else if (encoding === "gzip") body = zlib.gunzipSync(body, options);
          else if (encoding === "deflate") body = zlib.inflateSync(body, options);
          else if (encoding && encoding !== "identity") continue;
          const reset = resetFromCachedUsage(JSON.parse(body.toString("utf8")), headers, identity);
          if (reset && (!latest || Date.parse(reset.checkedAt) > Date.parse(latest.checkedAt))) latest = reset;
        } catch {
          // A replaced body must not hide other entries in the same hash chain.
          address = nextAddress;
        }
      }
    }
  } catch { /* Missing, locked or unsupported caches do not imply zero credits. */ }
  return latest;
}

async function readBrowserResetCredits(appData, identity, localAppData = process.env.LOCALAPPDATA) {
  if (!identity?.userId || !identity?.chatgptUserId) return null;
  const directories = await discoverBrowserCacheDirectories(appData, localAppData);
  const results = await Promise.all(directories.map((dir) => readBrowserResetCache(dir, identity)));
  return results.filter(Boolean).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0] ?? null;
}

module.exports = { browserCacheDirectories, discoverBrowserCacheDirectories, resetFromCachedUsage, readBrowserResetCache, readBrowserResetCredits };
