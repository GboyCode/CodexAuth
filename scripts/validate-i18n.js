const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const i18n = require("../src/ui/i18n");
const english = require("../src/ui/locales/en");
const root = path.resolve(__dirname, "../src/ui");

// A missing translation or lost interpolation value must fail before shipping.
for (const [source, translated] of Object.entries(english)) {
  const slots = text => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
  assert.deepEqual(slots(translated), slots(source), `Interpolation mismatch: ${source}`);
  assert.ok(translated.trim(), `Empty translation: ${source}`);
}
for (const file of ["app.js", "widget.js", "shared-quota.js", "updates.js", "recovery-countdown.js", "../main.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
    const key = JSON.parse(match[1]);
    assert.ok(Object.hasOwn(english, key), `Missing translation in ${file}: ${key}`);
  }
}
for (const file of ["index.html", "widget.html", "message-dialog.html", "recovery-countdown.html"]) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of html.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]*)"/g)) {
    const key = match[1].replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&");
    assert.ok(Object.hasOwn(english, key), `Missing translation in ${file}: ${key}`);
  }
}
assert.equal(i18n.normalizeLanguage(undefined), "zh-CN");
assert.equal(i18n.normalizeLanguage("invalid"), "zh-CN");
assert.equal(i18n.translate("en", "账号 {0}", "中文 {1} $& <name>"), "Account 中文 {1} $& <name>");
assert.equal(i18n.translate("zh-CN", "账号 {0}", 2), "账号 2");
assert.equal(i18n.translate("en", "unknown diagnostic"), "unknown diagnostic");

const ui = { window: { CodexI18n: i18n }, Date, Intl };
vm.runInNewContext(fs.readFileSync(path.join(root, "shared-quota.js"), "utf8"), ui);
i18n.setLanguage("en");
const q = ui.window.CodexQuotaUI;
assert.equal(q.formatRemainingText({ usedPercent: 25 }), "Remaining 75%");
assert.equal(q.quotaWindowLabel("session", { windowMinutes: 300 }), "5-hour quota");
assert.equal(q.formatRemainingText({ usedPercent: null }), "--");
assert.equal(q.relativeReset(1), "Awaiting update");
assert.equal(q.subscriptionDisplay(null).label, "Expiry unknown");
i18n.setLanguage("zh-CN");
assert.equal(q.formatRemainingText({ usedPercent: 25 }), "剩余 75%");
console.log("Language validation passed: translation coverage, placeholders, user data preservation, defaults and quota formatting in both languages.");
