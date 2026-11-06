const path = require("node:path");

const FILE_CREDENTIAL_STORE_LINE = 'cli_auth_credentials_store = "file"';

function resolveCodexHome(env = process.env, homeDir = "") {
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (configured) return path.resolve(configured);
  return path.join(homeDir, ".codex");
}

// Find statement boundaries without interpreting text inside strings or arrays
// as configuration. Keep source offsets so unrelated TOML stays byte-for-byte.
function tomlStatement(source, start) {
  let quote = "", multiline = false, depth = 0, codeEnd = start;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
      } else if (char === quote) {
        if (!multiline) {
          quote = "";
        } else if (source.startsWith(quote.repeat(3), index)) {
          // Four/five closing quotes include one/two literal quote characters.
          let count = 3;
          while (count < 5 && source[index + count] === quote) count += 1;
          index += count - 1;
          quote = "";
        }
      } else if (char === "\n" && !multiline) {
        throw new Error("Cannot safely update Codex config: unterminated TOML string.");
      }
      codeEnd = index + 1;
      continue;
    }
    if (char === "#") {
      const newline = source.indexOf("\n", index);
      if (depth === 0) return { codeEnd, end: newline < 0 ? source.length : newline + 1 };
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (char === "\n" && depth === 0) return { codeEnd, end: index + 1 };
    if (char === '"' || char === "'") {
      quote = char;
      multiline = source.startsWith(char.repeat(3), index);
      if (multiline) index += 2;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
    if (!/[ \t\r\n]/.test(char)) codeEnd = index + 1;
  }
  if (quote || depth !== 0) throw new Error("Cannot safely update Codex config: unterminated TOML value.");
  return { codeEnd, end: source.length };
}

function tomlKeyName(key) {
  if (key.startsWith("'")) return key.slice(1, -1);
  if (!key.startsWith('"')) return key;
  const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  return key.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|[btnfr"\\])/g,
    (_match, escape) => escape.length === 1 ? escapes[escape] : String.fromCodePoint(parseInt(escape.slice(1), 16)));
}

function fileCredentialStoreConfig(content = "") {
  const source = String(content);
  const hasBom = source.startsWith("\uFEFF");
  const body = hasBom ? source.slice(1) : source;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const settings = [];
  for (let start = 0; start < body.length;) {
    if (/^[ \t]*\[/.test(body.slice(start))) break;
    const statement = tomlStatement(body, start);
    const assignment = body.slice(start, statement.codeEnd).match(
      /^[ \t]*([\w-]+|'[^'\r\n]*'|"(?:\\.|[^"\\\r\n])*")[ \t]*=[ \t]*/);
    if (assignment && tomlKeyName(assignment[1]) === "cli_auth_credentials_store") {
      settings.push({ start, ...statement, valueStart: start + assignment[0].length });
    }
    start = statement.end;
  }

  let nextBody = body;
  for (let index = settings.length - 1; index >= 0; index -= 1) {
    const setting = settings[index];
    nextBody = index === 0
      ? `${nextBody.slice(0, setting.valueStart)}"file"${nextBody.slice(setting.codeEnd)}`
      : nextBody.slice(0, setting.start) + nextBody.slice(setting.end);
  }
  if (!settings.length) nextBody = FILE_CREDENTIAL_STORE_LINE + (body ? newline + body : "");
  const next = `${hasBom ? "\uFEFF" : ""}${nextBody}`;
  return { changed: next !== source, content: next };
}

module.exports = {
  FILE_CREDENTIAL_STORE_LINE,
  fileCredentialStoreConfig,
  resolveCodexHome,
};
