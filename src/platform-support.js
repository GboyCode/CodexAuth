const SUPPORTED_PLATFORMS = new Set(["win32", "darwin"]);
const MAC_CODEX_APP_NAMES = Object.freeze(["ChatGPT", "Codex"]);

function assertSupportedPlatform(platform = process.platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported platform: ${platform}.`);
  }
  return platform;
}

function credentialFileExtension(platform = process.platform) {
  return assertSupportedPlatform(platform) === "win32" ? "dpapi" : "keychain";
}

function credentialProtectionLabel(platform = process.platform) {
  return assertSupportedPlatform(platform) === "win32" ? "Windows DPAPI" : "macOS Keychain";
}

function platformDisplayName(platform = process.platform) {
  return assertSupportedPlatform(platform) === "win32" ? "Windows" : "macOS";
}

function isEncryptedCredentialBackup(filename) {
  return /\.json\.(?:dpapi|keychain)$/i.test(String(filename ?? ""));
}

module.exports = {
  MAC_CODEX_APP_NAMES,
  assertSupportedPlatform,
  credentialFileExtension,
  credentialProtectionLabel,
  isEncryptedCredentialBackup,
  platformDisplayName,
};
