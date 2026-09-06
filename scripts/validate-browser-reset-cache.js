const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { readBrowserResetCache, resetFromCachedUsage } = require("../src/quota/browser-reset-cache");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-cache-test-"));
  const identity = { userId: "account-a", chatgptUserId: "user-a" };
  const data = { account_id: "account-a", user_id: "user-a", rate_limit_reset_credits: { available_count: 2 } };
  const date = new Date(Date.now() - 60000).toUTCString();
  const header = `HTTP/1.1 200 OK\0date:${date}\0content-encoding:br\0`;
  async function fixture({ value = data, encoding = "br", indexed = true, state = 0, endpoint = "usage", corrupt = false } = {}) {
    const index = Buffer.alloc(368 + 4 * 8);
    index.writeUInt32LE(0xc103cac3, 0); index.writeUInt32LE(0x30000, 4); index.writeUInt32LE(8, 28);
    if (indexed) index.writeUInt32LE(0xa0010000, 368);
    const block = Buffer.alloc(8192 + 256);
    const entry = block.subarray(8192);
    const key = `1/0/_dk_https://chatgpt.com https://chatgpt.com https://chatgpt.com/backend-api/wham/${endpoint}`;
    entry.writeInt32LE(state, 20); entry.writeUInt32LE(Buffer.byteLength(key), 32); entry.write(key, 96);
    const headers = Buffer.from(header.replace("br", encoding));
    let body = Buffer.from(JSON.stringify(value));
    if (encoding === "br") body = zlib.brotliCompressSync(body);
    if (encoding === "gzip") body = zlib.gzipSync(body);
    if (corrupt) body = Buffer.from("truncated");
    entry.writeUInt32LE(headers.length, 40); entry.writeUInt32LE(body.length, 44);
    entry.writeUInt32LE(0x80000001, 56); entry.writeUInt32LE(0x80000002, 60);
    await Promise.all([fs.writeFile(path.join(root, "index"), index), fs.writeFile(path.join(root, "data_1"), block),
      fs.writeFile(path.join(root, "f_000001"), headers), fs.writeFile(path.join(root, "f_000002"), body)]);
  }
  try {
    await fixture();
    const reset = await readBrowserResetCache(root, identity);
    assert.equal(reset.availableCount, 2); assert.equal(reset.source, "local-browser-cache");
    assert.equal(reset.checkedAt, new Date(date).toISOString());
    const ui = vm.createContext({ window: {}, Date, Intl });
    vm.runInContext(await fs.readFile(path.join(__dirname, "../src/ui/shared-quota.js"), "utf8"), ui);
    assert.match(ui.window.CodexQuotaUI.resetCreditsLabel(reset), /重置次数：2 · 浏览器缓存/);
    assert.match(ui.window.CodexQuotaUI.resetCreditsLabel({ ...reset, checkedAt: "2020-01-01T00:00:00Z" }), /浏览器旧缓存，待更新/);
    assert.equal(await readBrowserResetCache(root, { ...identity, userId: "other" }), null);
    assert.equal(await readBrowserResetCache(root, { ...identity, chatgptUserId: "other" }), null);
    assert.equal(await readBrowserResetCache(root, { userId: "account-a" }), null);
    await fixture({ indexed: false }); assert.equal(await readBrowserResetCache(root, identity), null, "unindexed stale blocks are ignored");
    await fixture({ state: 1 }); assert.equal(await readBrowserResetCache(root, identity), null, "deleted entries are ignored");
    await fixture({ endpoint: "rate-limit-reset-credits", value: { available_count: 9 } });
    assert.equal(await readBrowserResetCache(root, identity), null, "unbound reset endpoint is ignored");
    await fixture({ corrupt: true }); assert.equal(await readBrowserResetCache(root, identity), null);
    await fixture({ encoding: "gzip" }); assert.equal((await readBrowserResetCache(root, identity)).availableCount, 2);
    await fixture({ encoding: "identity", value: { ...data, rate_limit_reset_credits: { available_count: 0 } } });
    assert.equal((await readBrowserResetCache(root, identity)).availableCount, 0);
    assert.equal(resetFromCachedUsage(data, header.replace(date, "invalid"), identity), null);
    assert.equal(resetFromCachedUsage(data, header.replace("200 OK", "401 Unauthorized"), identity), null);
    assert.equal(resetFromCachedUsage({ ...data, rate_limit_reset_credits: {} }, header, identity), null);
    console.log("Browser reset cache validation passed: indexed entries, account/user isolation, compression, missing/zero counts, timestamps and corrupt caches.");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "codexauth-cache-test-")));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
