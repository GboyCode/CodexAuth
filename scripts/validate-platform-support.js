const assert = require("node:assert/strict");
const {
  MAC_CODEX_APP_NAMES,
  assertSupportedPlatform,
  credentialFileExtension,
  credentialProtectionLabel,
  isEncryptedCredentialBackup,
  platformDisplayName,
} = require("../src/platform-support");

assert.equal(assertSupportedPlatform("win32"), "win32");
assert.equal(assertSupportedPlatform("darwin"), "darwin");
assert.throws(() => assertSupportedPlatform("linux"), /Unsupported platform/);
assert.equal(credentialFileExtension("win32"), "dpapi");
assert.equal(credentialFileExtension("darwin"), "keychain");
assert.equal(credentialProtectionLabel("win32"), "Windows DPAPI");
assert.equal(credentialProtectionLabel("darwin"), "macOS Keychain");
assert.equal(platformDisplayName("win32"), "Windows");
assert.equal(platformDisplayName("darwin"), "macOS");
assert.equal(isEncryptedCredentialBackup("auth-before-switch.json.dpapi"), true);
assert.equal(isEncryptedCredentialBackup("auth-before-switch.json.keychain"), true);
assert.equal(isEncryptedCredentialBackup("auth-before-switch.json"), false);
assert.deepEqual(MAC_CODEX_APP_NAMES, ["ChatGPT", "Codex"]);

const { build } = require("../package.json");
for (const platform of ["win", "mac"]) {
  // electron-builder concatenates global and platform file associations.
  const associations = [...(build.fileAssociations ?? []), ...(build[platform].fileAssociations ?? [])];
  const credentialFiles = associations.filter((item) => item.ext === "codexauth");
  assert.equal(credentialFiles.length, 1, `${platform}: register the credential extension once`);
  if (platform === "win") assert.match(credentialFiles[0].icon, /\.ico$/);
  else assert.equal(credentialFiles[0].icon, undefined, "macOS must use its generated app icon instead of a Windows ICO resource");
}

console.log("Windows and macOS platform support validation passed.");
