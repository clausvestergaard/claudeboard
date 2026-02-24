const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  scan: () => ipcRenderer.invoke("scan-sessions"),
  addProject: () => ipcRenderer.invoke("add-project"),
  removeProject: (projectPath) => ipcRenderer.invoke("remove-project", projectPath),
  openHelp: () => ipcRenderer.invoke("open-help"),
  renameSession: (sessionId, name) => ipcRenderer.invoke("rename-session", sessionId, name),
  resizeWindow: (rowCount) => ipcRenderer.invoke("resize-window", rowCount),
  onSessionsUpdated: (callback) => ipcRenderer.on("sessions-updated", callback),
  getSuggestions: () => ipcRenderer.invoke("get-suggestions"),
  addProjectPath: (projectPath) => ipcRenderer.invoke("add-project-path", projectPath),
  archiveProject: (projectPath) => ipcRenderer.invoke("archive-project", projectPath),
  unarchiveProject: (projectPath) => ipcRenderer.invoke("unarchive-project", projectPath),
  archiveSession: (sessionId) => ipcRenderer.invoke("archive-session", sessionId),
  unarchiveSession: (sessionId) => ipcRenderer.invoke("unarchive-session", sessionId),
  getArchived: () => ipcRenderer.invoke("get-archived"),
});
