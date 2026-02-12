const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  scan: () => ipcRenderer.invoke("scan-sessions"),
  addProject: () => ipcRenderer.invoke("add-project"),
  removeProject: (projectPath) => ipcRenderer.invoke("remove-project", projectPath),
  openHelp: () => ipcRenderer.invoke("open-help"),
  renameSession: (sessionId, name) => ipcRenderer.invoke("rename-session", sessionId, name),
  resizeWindow: (rowCount) => ipcRenderer.invoke("resize-window", rowCount),
  onSessionsUpdated: (callback) => ipcRenderer.on("sessions-updated", callback),
});
