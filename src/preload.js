const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  getState: () => ipcRenderer.invoke("state:get"),
  importCurrent: (displayName) => ipcRenderer.invoke("account:import-current", displayName),
  switchAccount: (accountId, options) => ipcRenderer.invoke("account:switch", accountId, options),
  reauthAccount: (accountId) => ipcRenderer.invoke("account:reauth", accountId),
  updateAccount: (accountId, patch) => ipcRenderer.invoke("account:update", accountId, patch),
  deleteAccount: (accountId) => ipcRenderer.invoke("account:delete", accountId),
  restartCodex: () => ipcRenderer.invoke("codex:restart"),
  getQuota: () => ipcRenderer.invoke("quota:get"),
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  openPath: (targetPath) => ipcRenderer.invoke("path:open", targetPath),
  showMainWindow: () => ipcRenderer.invoke("window:show-main"),
  showWidget: () => ipcRenderer.invoke("window:show-widget"),
  hideWidget: () => ipcRenderer.invoke("window:hide-widget"),
  toggleWidget: () => ipcRenderer.invoke("window:toggle-widget"),
  resizeWidget: (accountCount) => ipcRenderer.invoke("window:resize-widget", accountCount),
  startWidgetResize: (edge) => ipcRenderer.invoke("window:resize-widget-start", edge),
  updateWidgetResize: () => ipcRenderer.invoke("window:resize-widget-update"),
  endWidgetResize: () => ipcRenderer.invoke("window:resize-widget-end"),
  onStateChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },
});
