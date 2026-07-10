const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FILE_CREDENTIAL_STORE_LINE,
  fileCredentialStoreConfig,
  resolveCodexHome,
} = require("../src/codex-config");

assert.equal(resolveCodexHome({}, "C:\\Users\\tester"), path.join("C:\\Users\\tester", ".codex"));
assert.equal(resolveCodexHome({ CODEX_HOME: "D:\\CodexData" }, "C:\\Users\\tester"), path.resolve("D:\\CodexData"));

const inserted = fileCredentialStoreConfig('model = "gpt-test"\r\n\r\n[features]\r\nmemories = true\r\n');
assert.equal(inserted.changed, true);
assert.equal(
  inserted.content,
  `${FILE_CREDENTIAL_STORE_LINE}\r\nmodel = "gpt-test"\r\n\r\n[features]\r\nmemories = true\r\n`
);

const replaced = fileCredentialStoreConfig('cli_auth_credentials_store = "auto" # keep file auth\n[features]\n');
assert.equal(replaced.changed, true);
assert.equal(replaced.content, 'cli_auth_credentials_store = "file" # keep file auth\n[features]\n');

const unchanged = fileCredentialStoreConfig('cli_auth_credentials_store = "file"\n[features]\n');
assert.equal(unchanged.changed, false);
assert.equal(unchanged.content, 'cli_auth_credentials_store = "file"\n[features]\n');

const scopedOnly = fileCredentialStoreConfig('[profile.work]\ncli_auth_credentials_store = "keyring"\n');
assert.equal(scopedOnly.changed, true);
assert.equal(
  scopedOnly.content,
  'cli_auth_credentials_store = "file"\n[profile.work]\ncli_auth_credentials_store = "keyring"\n'
);

const bom = fileCredentialStoreConfig('\uFEFFmodel = "gpt-test"\n');
assert.equal(bom.content, `\uFEFF${FILE_CREDENTIAL_STORE_LINE}\nmodel = "gpt-test"\n`);

const empty = fileCredentialStoreConfig("");
assert.equal(empty.content, FILE_CREDENTIAL_STORE_LINE);

const commentedTable = fileCredentialStoreConfig("[features] # current settings\nmemories = true\n");
assert.equal(
  commentedTable.content,
  `${FILE_CREDENTIAL_STORE_LINE}\n[features] # current settings\nmemories = true\n`
);

console.log("Codex config compatibility validation passed.");
