const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { encryptPortableCredentials, decryptPortableCredentials, MAX_BUNDLE_BYTES } = require("../src/portable-credentials");

const password = "fixture-password-123";
function fixtureAuth(id) {
  const claims = { sub: `fixture-${id}`, email: `${id}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: `workspace-${id}` } };
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `fixture-access-${id}`, refresh_token: `fixture-refresh-${id}`,
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture` } });
}

async function main() {
  const payload = { auth: fixtureAuth("a"), displayName: "电脑 A 账号" };
  const encrypted = await encryptPortableCredentials(payload, password);
  assert.ok(!encrypted.includes("fixture-access") && !encrypted.includes("example.test"));
  assert.deepEqual(await decryptPortableCredentials(encrypted, password), payload);
  assert.notEqual(encrypted, await encryptPortableCredentials(payload, password));
  await assert.rejects(decryptPortableCredentials(encrypted, "wrong-password-123"), /密码错误/);
  for (const field of ["salt", "iv", "tag", "ciphertext"]) {
    const tampered = JSON.parse(encrypted), bytes = Buffer.from(tampered[field], "base64");
    bytes[0] ^= 1; tampered[field] = bytes.toString("base64");
    await assert.rejects(decryptPortableCredentials(JSON.stringify(tampered), password));
  }
  await assert.rejects(decryptPortableCredentials(JSON.stringify({ ...JSON.parse(encrypted), version: 999 }), password), /版本/);
  await assert.rejects(decryptPortableCredentials("x".repeat(MAX_BUNDLE_BYTES + 1), password), /过大/);
  await assert.rejects(encryptPortableCredentials(payload, "short"), /10/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-portable-test-"));
  try {
    const filename = path.resolve(__dirname, "../src/main.js"), realRequire = createRequire(filename);
    const home = path.join(root, "codex-home"); await fs.mkdir(home);
    const authFile = path.join(home, "auth.json"), selectedFile = path.join(root, "transfer.codexauth");
    let confirmed = 1, canceled = false;
    const sandbox = vm.createContext({ require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => root },
      dialog: { showSaveDialog: async () => ({ canceled, filePath: selectedFile }),
        showOpenDialog: async () => ({ canceled, filePaths: [selectedFile] }), showMessageBox: async () => ({ response: confirmed }) },
    } : realRequire(name), __dirname: path.dirname(filename), process: { ...process, env: { ...process.env, CODEX_HOME: home } },
      Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(await fs.readFile(filename, "utf8"), sandbox);
    // Replace only the OS vault adapter; inspect that portable plaintext is
    // handed to local protection before disk storage, without using real accounts.
    sandbox.protectText = async (text) => `local-vault:${Buffer.from(text).toString("base64")}`;
    sandbox.unprotectText = async (text) => Buffer.from(text.trim().slice("local-vault:".length), "base64").toString();
    sandbox.currentState = async () => ({ accounts: (await sandbox.readIndex()).accounts });
    await sandbox.ensureStoreDirs();
    await fs.writeFile(authFile, payload.auth);
    await sandbox.exportCurrentCredentials(password);
    assert.deepEqual(await decryptPortableCredentials(await fs.readFile(selectedFile, "utf8"), password), { ...payload, displayName: "a@example.test" });
    const onB = fixtureAuth("b"); await fs.writeFile(authFile, onB);
    const imported = await sandbox.importPortableCredentials(password);
    assert.equal(imported.snapshot.accounts.length, 1);
    const account = imported.snapshot.accounts[0];
    assert.equal(account.lastSwitchedAt, null);
    assert.equal(await fs.readFile(authFile, "utf8"), onB, "import must not activate or replace the current login");
    const saved = await fs.readFile(sandbox.accountBlobPath(account.id), "utf8");
    assert.ok(saved.startsWith("local-vault:")); assert.ok(!saved.includes("fixture-access"));
    assert.equal(await sandbox.loadAccountAuth(account.id), payload.auth);
    const indexBefore = await fs.readFile(sandbox.indexPath(), "utf8");
    await assert.rejects(sandbox.importPortableCredentials("wrong-password-123"), /密码错误/);
    assert.equal(await fs.readFile(sandbox.indexPath(), "utf8"), indexBefore);
    confirmed = 0;
    assert.equal((await sandbox.importPortableCredentials(password)).canceled, true);
    assert.equal(await fs.readFile(sandbox.indexPath(), "utf8"), indexBefore);
    confirmed = 1;
    const duplicate = await sandbox.importPortableCredentials(password);
    assert.equal(duplicate.snapshot.accounts.length, 1); assert.equal(duplicate.snapshot.accounts[0].id, account.id);
    assert.ok((await fs.readdir(sandbox.backupsDir())).some((name) => name.startsWith("auth-before-portable-import-")));
    await fs.writeFile(authFile, payload.auth);
    assert.equal((await sandbox.importPortableCredentials(password)).alreadyActive, true);
    await fs.writeFile(authFile, onB);
    await fs.writeFile(selectedFile, await encryptPortableCredentials({ auth: "{}", displayName: "invalid" }, password));
    await assert.rejects(sandbox.importPortableCredentials(password), /ChatGPT/);
    assert.equal((await sandbox.readIndex()).accounts.length, 1);
    canceled = true; assert.equal((await sandbox.exportCurrentCredentials(password)).canceled, true);
    assert.equal((await sandbox.importPortableCredentials(password)).canceled, true);
    console.log("Portable credentials validation passed: encrypted roundtrip, tampering, password/size validation, latest-auth export, local re-encryption, duplicate handling, cancellation and inactive import.");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "codexauth-portable-test-")));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
