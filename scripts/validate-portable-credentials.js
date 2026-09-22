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
    let confirmed = 1, canceled = false, selectedPaths = null, confirmations = 0;
    const exportParent = path.join(root, "exports"); await fs.mkdir(exportParent);
    const sandbox = vm.createContext({ require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit() {}, on() {}, getPath: () => root },
      dialog: { showSaveDialog: async () => ({ canceled, filePath: selectedFile }),
        showOpenDialog: async (_window, options) => ({ canceled, filePaths: options.properties.includes("openDirectory") ? [exportParent] : selectedPaths ?? [selectedFile] }), showMessageBox: async () => { confirmations++; return { response: confirmed }; } },
    } : realRequire(name), __dirname: path.dirname(filename), process: { ...process, env: { ...process.env, CODEX_HOME: home } },
      Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(await fs.readFile(filename, "utf8"), sandbox);
    // Replace only the OS vault adapter; inspect that portable plaintext is
    // handed to local protection before disk storage, without using real accounts.
    sandbox.protectText = async (text) => `local-vault:${Buffer.from(text).toString("base64")}`;
    sandbox.unprotectText = async (text) => Buffer.from(text.trim().slice("local-vault:".length), "base64").toString();
    sandbox.currentState = async () => ({ accounts: (await sandbox.readIndex()).accounts });
    async function importSelected(secret) {
      const selected = await sandbox.selectPortableCredentials();
      return selected.canceled ? { canceled: true } : sandbox.importPortableCredentials(secret, selected.selectionId);
    }
    await sandbox.ensureStoreDirs();
    await fs.writeFile(authFile, payload.auth);
    await sandbox.exportCurrentCredentials(password);
    assert.deepEqual(await decryptPortableCredentials(await fs.readFile(selectedFile, "utf8"), password), { ...payload, displayName: "a@example.test" });
    const onB = fixtureAuth("b"); await fs.writeFile(authFile, onB);
    const imported = await importSelected(password);
    assert.equal(imported.snapshot.accounts.length, 1);
    const account = imported.snapshot.accounts[0];
    assert.equal(account.lastSwitchedAt, null);
    assert.equal(await fs.readFile(authFile, "utf8"), onB, "import must not activate or replace the current login");
    const saved = await fs.readFile(sandbox.accountBlobPath(account.id), "utf8");
    assert.ok(saved.startsWith("local-vault:")); assert.ok(!saved.includes("fixture-access"));
    assert.equal(await sandbox.loadAccountAuth(account.id), payload.auth);
    const indexBefore = await fs.readFile(sandbox.indexPath(), "utf8");
    await assert.rejects(importSelected("wrong-password-123"), /密码错误/);
    assert.equal(await fs.readFile(sandbox.indexPath(), "utf8"), indexBefore);
    confirmed = 0;
    assert.equal((await importSelected(password)).canceled, true);
    assert.equal(await fs.readFile(sandbox.indexPath(), "utf8"), indexBefore);
    confirmed = 1;
    const duplicate = await importSelected(password);
    assert.equal(duplicate.snapshot.accounts.length, 1); assert.equal(duplicate.snapshot.accounts[0].id, account.id);
    assert.ok((await fs.readdir(sandbox.backupsDir())).some((name) => name.startsWith("auth-before-portable-import-")));
    await fs.writeFile(authFile, payload.auth);
    assert.equal((await importSelected(password)).alreadyActive, true);
    await fs.writeFile(authFile, onB);
    await fs.writeFile(selectedFile, await encryptPortableCredentials({ auth: "{}", displayName: "invalid" }, password));
    await assert.rejects(importSelected(password), /ChatGPT/);
    assert.equal((await sandbox.readIndex()).accounts.length, 1);
    const beforeAllIndex = await fs.readFile(sandbox.indexPath(), "utf8");
    const all = await sandbox.exportAllCredentials(password);
    assert.equal(all.count, 2, "all includes saved accounts and an unsaved current login");
    assert.equal(await fs.readFile(sandbox.indexPath(), "utf8"), beforeAllIndex, "export does not change account storage");
    assert.equal(await fs.readFile(authFile, "utf8"), onB, "export does not switch the active login");
    const batchFiles = [path.join(root,"batch-c.codexauth"),path.join(root,"batch-d.codexauth")];
    for (const [i,id] of ["c","d"].entries()) await fs.writeFile(batchFiles[i],await encryptPortableCredentials({auth:fixtureAuth(id),displayName:id},password));
    selectedPaths = batchFiles;
    const batchSelection = await sandbox.selectPortableCredentials();
    assert.equal(batchSelection.count,2);
    assert.equal((await sandbox.readIndex()).accounts.length,1,"selecting files does not import anything");
    await assert.rejects(sandbox.importPortableCredentials("wrong-password-123",batchSelection.selectionId),/本批次未导入/);
    assert.equal((await sandbox.readIndex()).accounts.length,1);
    const batchResult=await sandbox.importPortableCredentials(password,batchSelection.selectionId);
    assert.equal(batchResult.importedCount,2,"retry password without reselecting files");
    assert.equal(batchResult.snapshot.accounts.length,3);
    await assert.rejects(sandbox.importPortableCredentials(password,batchSelection.selectionId),/先选择/);
    confirmations=0;
    assert.equal((await importSelected(password)).importedCount,2);
    assert.equal(confirmations,1,"confirm overwrites once for the whole batch");
    // A failed second write must restore the first account's encrypted snapshot.
    const indexBeforeBatch=await fs.readFile(sandbox.indexPath(),"utf8");
    const savedBeforeBatch=new Map(await Promise.all((await sandbox.readIndex()).accounts.map(async a=>[a.id,await fs.readFile(sandbox.accountBlobPath(a.id),"utf8")])));
    const saveAuth=sandbox.saveAccountAuth;let batchWrites=0;
    sandbox.saveAccountAuth=async(...args)=>{if(++batchWrites===2)throw new Error("fixture write failure");return saveAuth(...args);};
    await assert.rejects(importSelected(password),/已恢复原凭证/);
    sandbox.saveAccountAuth=saveAuth;
    assert.equal(await fs.readFile(sandbox.indexPath(),"utf8"),indexBeforeBatch);
    for(const [id,value] of savedBeforeBatch)assert.equal(await fs.readFile(sandbox.accountBlobPath(id),"utf8"),value);
    await fs.writeFile(batchFiles[1],await encryptPortableCredentials({auth:fixtureAuth("d"),displayName:"d"},"another-password-123"));
    await assert.rejects(importSelected(password),/本批次未导入/);
    assert.equal(await fs.readFile(sandbox.indexPath(),"utf8"),indexBeforeBatch,"mixed passwords never partially import");
    const canceledSelection=await sandbox.selectPortableCredentials();sandbox.cancelPortableImport(canceledSelection.selectionId);
    await assert.rejects(sandbox.importPortableCredentials(password,canceledSelection.selectionId),/先选择/);
    selectedPaths=Array.from({length:101},(_,i)=>path.join(root,`${i}.codexauth`));
    await assert.rejects(sandbox.selectPortableCredentials(),/最多选择/);
    selectedPaths=null;
    // Restore the original isolated fixture for the remaining export tests.
    await sandbox.writeIndex(JSON.parse(beforeAllIndex));
    const folder = path.join(exportParent, (await fs.readdir(exportParent))[0]);
    const exports = [];
    for (const name of await fs.readdir(folder)) {
      assert.ok(name.endsWith(".codexauth"));
      const text = await fs.readFile(path.join(folder, name), "utf8");
      assert.ok(!text.includes("fixture-access") && !text.includes("example.test"), "files contain encrypted credentials only");
      exports.push({ text, payload: await decryptPortableCredentials(text, password) });
    }
    assert.deepEqual(exports.map((item) => item.payload.auth).sort(), [payload.auth, onB].sort());
    // Every all-export file is compatible with the existing single-file importer.
    await fs.writeFile(selectedFile, exports.find((item) => item.payload.auth === onB).text);
    await fs.writeFile(authFile, payload.auth);
    assert.equal((await importSelected(password)).snapshot.accounts.length, 2);
    const refreshed = JSON.parse(onB); refreshed.tokens.refresh_token = "fixture-refreshed-b";
    await fs.writeFile(authFile, JSON.stringify(refreshed));
    const beforeFolders = await fs.readdir(exportParent);
    assert.equal((await sandbox.exportAllCredentials(password)).count, 2, "current login is not duplicated");
    const freshFolder = (await fs.readdir(exportParent)).find((name) => !beforeFolders.includes(name));
    const freshPayloads = await Promise.all((await fs.readdir(path.join(exportParent, freshFolder))).map(async(name) =>
      decryptPortableCredentials(await fs.readFile(path.join(exportParent, freshFolder, name), "utf8"), password)));
    assert.ok(freshPayloads.some((item) => item.auth === JSON.stringify(refreshed)), "current account uses the latest auth instead of the saved token");
    await fs.unlink(authFile);
    assert.equal((await sandbox.exportAllCredentials(password)).count, 2, "saved accounts can be exported while logged out");
    const beforeFailure = await fs.readdir(exportParent);
    const originalWrite = sandbox.writeTextAtomic;
    let writes = 0;
    sandbox.writeTextAtomic = async (...args) => { if (++writes === 2) throw new Error("fixture disk failure"); return originalWrite(...args); };
    await assert.rejects(sandbox.exportAllCredentials(password), /fixture disk failure/);
    assert.deepEqual(await fs.readdir(exportParent), beforeFailure, "failed writes remove only the new partial export folder");
    sandbox.writeTextAtomic = originalWrite;
    await fs.writeFile(sandbox.accountBlobPath(account.id), "corrupt");
    await assert.rejects(sandbox.exportAllCredentials(password), /未导出任何账号/);
    assert.deepEqual(await fs.readdir(exportParent), beforeFailure, "unreadable credentials do not silently produce a partial export");
    canceled = true; assert.equal((await sandbox.exportCurrentCredentials(password)).canceled, true);
    assert.equal((await sandbox.exportAllCredentials(password)).canceled, true);
    assert.equal((await importSelected(password)).canceled, true);
    canceled = false;
    await sandbox.writeIndex({ version: 1, accounts: [] });
    await assert.rejects(sandbox.exportAllCredentials(password), /暂无可导出/);
    console.log("Portable credentials validation passed: encryption, tampering, latest-auth current/all export, importer compatibility, deduplication, logged-out/empty/corrupt accounts, failure cleanup, cancellation and inactive import.");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "codexauth-portable-test-")));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
