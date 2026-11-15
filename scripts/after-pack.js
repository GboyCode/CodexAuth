const path = require("node:path");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "darwin") {
    const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents");
    const info = await fs.readFile(path.join(contents, "Info.plist"), "utf8");
    assert.match(info, /<key>LSUIElement<\/key>\s*<true\s*\/>/, "macOS bundle must launch as an accessory without flashing a Dock icon");
    assert.match(info, /<key>CFBundleIconName<\/key>\s*<string>Icon<\/string>/, "Tahoe must use the compiled asset catalog");
    const catalog = await fs.stat(path.join(contents, "Resources", "Assets.car"));
    assert.ok(catalog.size > 0, "native icon asset catalog must be packaged");
    const legacy = await fs.readFile(path.join(contents, "Resources", "icon.icns"));
    assert.equal(legacy.toString("ascii", 0, 4), "icns");
    assert.equal(legacy.readUInt32BE(4), legacy.length, "legacy icon must be complete");
    const preview = path.join(context.appOutDir, "icon-verification");
    await fs.mkdir(preview, { recursive: true });
    const finderPng = path.join(preview, "finder.png");
    const legacyPng = path.join(preview, "icns.png");
    const project = context.packager.projectDir;
    execFileSync("/usr/bin/swift", [path.join(project, "scripts", "render-mac-bundle-icon.swift"), path.dirname(contents), finderPng], { stdio: "inherit" });
    execFileSync("/usr/bin/swift", [path.join(project, "scripts", "render-mac-bundle-icon.swift"), path.join(contents, "Resources", "icon.icns"), legacyPng], { stdio: "inherit" });
    execFileSync(require("electron"), [path.join(project, "scripts", "validate-mac-compiled-icon.js"),
      path.join(project, "build", "CodexAuth.icon", "Assets", "codex.png"), finderPng, legacyPng], { stdio: "inherit" });
    console.log("Verified packaged macOS native icon catalog and ICNS fallback.");
    return;
  }
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
