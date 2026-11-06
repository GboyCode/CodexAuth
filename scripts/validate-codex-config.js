const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
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

function expectConfig(source, expected, label) {
  const result = fileCredentialStoreConfig(source);
  assert.equal(result.content, expected, label);
  assert.equal(result.changed, source !== expected, `${label}: change detection`);
  assert.deepEqual(fileCredentialStoreConfig(result.content), { changed: false, content: expected }, `${label}: idempotence`);
}

for (const key of ["cli_auth_credentials_store", '"cli_auth_credentials_store"', "'cli_auth_credentials_store'",
  String.raw`"cli_auth_credentials_stor\u0065"`, String.raw`"cli_auth_credentials_stor\U00000065"`]) {
  expectConfig(`\t${key} = 'auto'  # retain comment\r\n`, `\t${key} = "file"  # retain comment\r\n`, `quoted/escaped key: ${key}`);
}

for (const delimiter of ['"""', "'''"]) {
  const instructions = `developer_instructions = ${delimiter}\n[features]\ncli_auth_credentials_store = "auto"\n# text, not a comment\n${delimiter}\n`;
  expectConfig(instructions, `${FILE_CREDENTIAL_STORE_LINE}\n${instructions}`, `${delimiter}: insert outside instructions`);
  expectConfig(`${instructions}cli_auth_credentials_store = "auto"\n[agents]\nenabled = true\n`,
    `${instructions}${FILE_CREDENTIAL_STORE_LINE}\n[agents]\nenabled = true\n`, `${delimiter}: find real setting after instructions`);
  expectConfig(`cli_auth_credentials_store = ${delimiter}\nauto${delimiter} # retain\n`,
    `${FILE_CREDENTIAL_STORE_LINE} # retain\n`, `${delimiter}: replace whole multiline value`);
}

const containers = 'examples = [\n  # "cli_auth_credentials_store" = "auto"\n  """\n[features]\ncli_auth_credentials_store = "auto"\n""",\n  { cli_auth_credentials_store = "auto", nested = ["#", "[table]"] },\n]\n';
expectConfig(containers + 'cli_auth_credentials_store = "auto"\n', containers + FILE_CREDENTIAL_STORE_LINE + "\n", "nested containers and comments");
const quotedText = '"key=#\\\"" = "text # [table]"\nother.cli_auth_credentials_store = "keep"\n';
expectConfig(quotedText, FILE_CREDENTIAL_STORE_LINE + "\n" + quotedText, "quoted punctuation and dotted key");
const escapedQuotes = String.raw`developer_instructions = """
Escaped delimiter: \"""
cli_auth_credentials_store = "auto"
"""
`;
expectConfig(escapedQuotes, FILE_CREDENTIAL_STORE_LINE + "\n" + escapedQuotes, "escaped multiline delimiter");
for (const delimiter of ['"', "'"]) {
  for (const closingLength of [4, 5]) {
    const prefix = `developer_instructions = ${delimiter.repeat(3)}text${delimiter.repeat(closingLength)}\n`;
    expectConfig(prefix + 'cli_auth_credentials_store = "auto"\n', prefix + FILE_CREDENTIAL_STORE_LINE + "\n", "four/five closing quotes");
  }
}
expectConfig('cli_auth_credentials_store = "auto#value" # actual comment\n', FILE_CREDENTIAL_STORE_LINE + " # actual comment\n", "hash in value");
expectConfig('cli_auth_credentials_store = "auto"\n"cli_auth_credentials_store" = "keyring"\n[features]\n',
  FILE_CREDENTIAL_STORE_LINE + "\n[features]\n", "duplicate root settings");
expectConfig('\uFEFF"cli_auth_credentials_store" = "auto"\r\n[features]\nmemories = true',
  '\uFEFF"cli_auth_credentials_store" = "file"\r\n[features]\nmemories = true', "BOM, mixed newlines and no final newline");
expectConfig('[profiles.work]\n"cli_auth_credentials_store" = "auto"\n',
  FILE_CREDENTIAL_STORE_LINE + '\n[profiles.work]\n"cli_auth_credentials_store" = "auto"\n', "quoted setting remains scoped to table");
const modern = 'default_permissions = ":workspace"\nmodel = "gpt-6.1-sol"\n[agents]\nenabled = true\n[plugins."example@local-repo"]\nenabled = true\n';
expectConfig(modern, FILE_CREDENTIAL_STORE_LINE + "\n" + modern, "modern configuration preserved");
for (const malformed of ['developer_instructions = """\nunfinished', "examples = [\n'item',\n", 'model = "unfinished\n']) {
  assert.throws(() => fileCredentialStoreConfig(malformed), /Cannot safely update Codex config/, "stop on unterminated values");
}

async function validateConfigWrite() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-config-"));
  try {
    const filename = path.resolve(__dirname, "../src/main.js");
    const realRequire = createRequire(filename);
    const context = vm.createContext({ require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit() {}, on() {} },
    } : realRequire(name), __dirname: path.dirname(filename),
    process: { ...process, env: { ...process.env, CODEX_HOME: root } },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(await fs.readFile(filename, "utf8"), context);
    const configPath = path.join(root, "config.toml");
    const original = 'developer_instructions = """\ncli_auth_credentials_store = "auto"\n"""\n"cli_auth_credentials_store" = "auto"\n';
    const expected = original.replace('"cli_auth_credentials_store" = "auto"', '"cli_auth_credentials_store" = "file"');
    await fs.writeFile(configPath, original);
    assert.equal((await context.ensureCodexFileCredentialStore()).changed, true);
    assert.equal(await fs.readFile(configPath, "utf8"), expected);
    const backups = (await fs.readdir(root)).filter((name) => name.startsWith("config.toml.codexauth-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(root, backups[0]), "utf8"), original);
    assert.equal((await context.ensureCodexFileCredentialStore()).changed, false);
    assert.equal((await fs.readdir(root)).length, 2, "no extra backup or temporary files");
    const malformed = 'developer_instructions = """\nunfinished';
    await fs.writeFile(configPath, malformed);
    await assert.rejects(context.ensureCodexFileCredentialStore(), /Cannot safely update Codex config/);
    assert.equal(await fs.readFile(configPath, "utf8"), malformed, "unsafe input stays untouched");
    assert.equal((await fs.readdir(root)).length, 2, "unsafe input creates no backup or temporary file");
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codexauth-config-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}

validateConfigWrite().then(() => console.log("Codex config compatibility passed: quoted/escaped keys, multiline strings, containers, source preservation, idempotence and atomic backup/write."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
