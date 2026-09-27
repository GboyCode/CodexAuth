const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexMessage", {
  ready: () => ipcRenderer.invoke("message-dialog:ready"),
  present: (height) => ipcRenderer.send("message-dialog:present", height),
  choose: (response) => ipcRenderer.send("message-dialog:choose", response),
  drag: (phase, cursor) => ipcRenderer.send("message-dialog:drag", phase, cursor),
});
