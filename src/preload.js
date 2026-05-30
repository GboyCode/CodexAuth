const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  getState: () => ipcRenderer.invoke("state:get"),
  importCurrent: (displayName) => ipcRenderer.invoke("account:import-current", displayName),
  switchAccount: (accountId, options) => ipcRenderer.invoke("account:switch", accountId, options),
  reauthAccount: (accountId) => ipcRenderer.invoke("account:reauth", accountId),
  updateAccount: (accountId, patch) => ipcRenderer.invoke("account:update", accountId, patch),
  deleteAccount: (accountId) => ipcRenderer.invoke("account:delete", accountId),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  restartCodex: () => ipcRenderer.invoke("codex:restart"),
  getQuota: () => ipcRenderer.invoke("quota:get"),
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  getAllAccountsQuota: () => ipcRenderer.invoke("dashboard:all-accounts"),
  getAllUsage: () => ipcRenderer.invoke("dashboard:all-usage"),
  openPath: (targetPath) => ipcRenderer.invoke("path:open", targetPath),
  showMainWindow: () => ipcRenderer.invoke("window:show-main"),
  showWidget: () => ipcRenderer.invoke("window:show-widget"),
  hideWidget: () => ipcRenderer.invoke("window:hide-widget"),
  toggleWidget: () => ipcRenderer.invoke("window:toggle-widget"),
  resizeWidget: (accountCount) => ipcRenderer.invoke("window:resize-widget", accountCount),
  getWidgetTopmost: () => ipcRenderer.invoke("window:get-widget-topmost"),
  setWidgetTopmost: (pinned) => ipcRenderer.invoke("window:set-widget-topmost", pinned),
  startWidgetResize: (edge) => ipcRenderer.invoke("window:resize-widget-start", edge),
  updateWidgetResize: () => ipcRenderer.invoke("window:resize-widget-update"),
  endWidgetResize: () => ipcRenderer.invoke("window:resize-widget-end"),
  collapseWidgetDock: () => ipcRenderer.invoke("window:collapse-widget-dock"),
  widgetPointerEnter: () => ipcRenderer.invoke("window:widget-pointer-enter"),
  widgetPointerLeave: () => ipcRenderer.invoke("window:widget-pointer-leave"),
  onWidgetDockHint: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("widget:dock-hint", handler);
    return () => ipcRenderer.removeListener("widget:dock-hint", handler);
  },
  onStateChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },
});
