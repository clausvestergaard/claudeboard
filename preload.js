const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  scan: () => ipcRenderer.invoke("scan-sessions"),
  openHelp: () => ipcRenderer.invoke("open-help"),
  renameSession: (sessionId, name) =>
    ipcRenderer.invoke("rename-session", sessionId, name),
  resizeWindow: (rowCount) => ipcRenderer.invoke("resize-window", rowCount),
  focusSession: (pid) => ipcRenderer.invoke("focus-session", pid),
  onSessionsUpdated: (callback) => ipcRenderer.on("sessions-updated", callback),
  archiveRepo: (repoRoot) => ipcRenderer.invoke("archive-repo", repoRoot),
  unarchiveRepo: (repoRoot) => ipcRenderer.invoke("unarchive-repo", repoRoot),
  archiveSession: (sessionId) => ipcRenderer.invoke("archive-session", sessionId),
  unarchiveSession: (sessionId) =>
    ipcRenderer.invoke("unarchive-session", sessionId),
  getArchived: () => ipcRenderer.invoke("get-archived"),
});
