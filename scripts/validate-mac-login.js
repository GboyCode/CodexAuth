const assert = require("node:assert/strict");
const { createMacLogin } = require("../src/mac-login");
let status = "not-registered", openedAtLogin = false, writes = 0, refused = false;
const app = { isPackaged: true,
  getLoginItemSettings(options) {
    assert.deepEqual(options, {type:"mainAppService"});
    return {status, openAtLogin: status === "enabled", wasOpenedAtLogin: openedAtLogin};
  },
  setLoginItemSettings(options) {
    assert.deepEqual(Object.keys(options).sort(), ["openAtLogin", "type"]);
    writes++;
    if (!refused) status = options.openAtLogin ? "enabled" : "not-registered";
  },
};
const login = createMacLogin(app);
assert.equal(login.read().enabled, false);
assert.equal(writes, 0, "reading OS state must not silently register a login item");
assert.equal(login.set(true).enabled, true);
assert.equal(login.set(false).enabled, false);
status = "requires-approval"; refused = true;
assert.equal(login.set(true).pending, true);
assert.throws(() => login.set(false), /未关闭/);
status = "not-registered";
assert.throws(() => login.set(true), /未启用/);
assert.equal(login.read().enabled, false, "external system disable is authoritative");
openedAtLogin = true;
assert.equal(login.read().openedAtLogin, true);
app.isPackaged = false;
assert.throws(() => login.set(true), /Applications/);
console.log("macOS login items passed: enable/disable, OS approval, refusal, external disable and quiet startup detection.");
