const path = require("node:path");

const FILE_CREDENTIAL_STORE_LINE = 'cli_auth_credentials_store = "file"';

function resolveCodexHome(env = process.env, homeDir = "") {
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (configured) return path.resolve(configured);
  return path.join(homeDir, ".codex");
}

function isTomlTableHeader(line) {
  const trimmed = String(line ?? "").trim();
  return /^\[\[?.+\]\]?\s*(?:#.*)?$/.test(trimmed);
}

function fileCredentialStoreConfig(content = "") {
  const source = String(content);
  const hasBom = source.startsWith("\uFEFF");
  const body = hasBom ? source.slice(1) : source;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = body.endsWith("\n");
  const lines = body ? body.split(/\r?\n/) : [];
  if (hadFinalNewline) lines.pop();

  const firstTableIndex = lines.findIndex(isTomlTableHeader);
  const topLevelEnd = firstTableIndex < 0 ? lines.length : firstTableIndex;
  const settingIndexes = [];
  for (let index = 0; index < topLevelEnd; index += 1) {
    if (/^\s*cli_auth_credentials_store\s*=/.test(lines[index])) {
      settingIndexes.push(index);
    }
  }

  let changed = false;
  if (settingIndexes.length) {
    const firstIndex = settingIndexes[0];
    const existingLine = lines[firstIndex];
    const indent = existingLine.match(/^\s*/)?.[0] ?? "";
    const commentIndex = existingLine.indexOf("#");
    const comment = commentIndex >= 0 ? existingLine.slice(commentIndex).trimStart() : "";
    const replacement = `${indent}${FILE_CREDENTIAL_STORE_LINE}${comment ? ` ${comment}` : ""}`;
    if (existingLine !== replacement) {
      lines[firstIndex] = replacement;
      changed = true;
    }
    for (let index = settingIndexes.length - 1; index >= 1; index -= 1) {
      lines.splice(settingIndexes[index], 1);
      changed = true;
    }
  } else {
    lines.unshift(FILE_CREDENTIAL_STORE_LINE);
    changed = true;
  }

  const nextBody = `${lines.join(newline)}${hadFinalNewline || !lines.length ? newline : ""}`;
  return {
    changed,
    content: `${hasBom ? "\uFEFF" : ""}${nextBody}`,
  };
}

module.exports = {
  FILE_CREDENTIAL_STORE_LINE,
  fileCredentialStoreConfig,
  resolveCodexHome,
};
