// Use macOS ServiceManagement through Electron; never install private agents
// or re-enable an item that the user disabled in System Settings.
function createMacLogin(app) {
  const options = { type: "mainAppService" };
  function read() {
    const item = app.getLoginItemSettings(options);
    const status = item.status || (item.openAtLogin ? "enabled" : "not-registered");
    return { enabled: status === "enabled", pending: status === "requires-approval", status,
      openedAtLogin: item.wasOpenedAtLogin === true };
  }
  function set(enabled) {
    if (!app.isPackaged) throw new Error("请先安装应用到 Applications 后再设置登录时启动。");
    app.setLoginItemSettings({ ...options, openAtLogin: enabled === true });
    const result = read();
    if (enabled && !result.enabled && !result.pending) {
      throw new Error("macOS 未启用登录项，请在系统设置的登录项中检查。");
    }
    if (!enabled && (result.enabled || result.pending)) {
      throw new Error("macOS 未关闭登录项，请在系统设置的登录项中检查。");
    }
    return result;
  }
  return { read, set };
}
module.exports = { createMacLogin };
