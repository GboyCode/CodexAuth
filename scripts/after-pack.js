const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const rcedit = path.join(context.packager.projectDir, "build", "rcedit", "rcedit-x64.exe");
  const icon = path.join(context.packager.projectDir, "src", "ui", "assets", "codex-color.ico");
  const exe = path.join(context.appOutDir, "CodexAuth Switch.exe");

  execFileSync(rcedit, [
    exe,
    "--set-icon",
    icon,
    "--set-version-string",
    "FileDescription",
    "CodexAuth Switch",
    "--set-version-string",
    "ProductName",
    "CodexAuth Switch",
  ]);
};
