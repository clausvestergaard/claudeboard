const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const WIDTH = 440;
const BASE_HEIGHT = 52; // drag region + footer
const ROW_HEIGHT = 38; // per session row
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;

const DATA_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".claudeboard.json",
);

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (!data.projects) data.projects = [];
    if (!data.archivedProjects) data.archivedProjects = [];
    if (!data.archivedSessions) data.archivedSessions = [];
    if (!data.sessionNames) data.sessionNames = {};
    return data;
  } catch {
    return { projects: [], archivedProjects: [], archivedSessions: [], sessionNames: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: MIN_HEIGHT,
    minWidth: 300,
    alwaysOnTop: true,
    frame: true,
    titleBarStyle: "hiddenInset",
    icon: path.join(__dirname, "build", "icon.icns"),
    backgroundColor: "#111111",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
}

// --- JSONL session scanning ---

const PROJECTS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "projects",
);

const WORKING_THRESHOLD_MS = 30 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

function encodePath(projectPath) {
  return projectPath.replace(/\//g, "-");
}

function discoverSessions() {
  const data = loadData();
  const results = [];

  for (const projectPath of data.projects || []) {
    const dirName = encodePath(projectPath);
    const projDir = path.join(PROJECTS_DIR, dirName);

    let files;
    try {
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");
      results.push({
        projectPath,
        projectName: path.basename(projectPath),
        sessionId,
        jsonlPath: path.join(projDir, file),
      });
    }
  }
  return results;
}

function getSessionStatus(jsonlPath) {
  let mtime;
  try {
    mtime = fs.statSync(jsonlPath).mtimeMs;
  } catch {
    return { status: "stopped", mtime: 0 };
  }

  const age = Date.now() - mtime;

  if (age < WORKING_THRESHOLD_MS) {
    return { status: "working", mtime };
  }
  if (age < IDLE_THRESHOLD_MS) {
    return { status: "idle", mtime };
  }
  return { status: "stopped", mtime };
}

function scanAll() {
  const data = loadData();
  const sessions = discoverSessions();
  const archivedSessions = new Set(data.archivedSessions);

  const results = [];
  for (const session of sessions) {
    if (archivedSessions.has(session.sessionId)) continue;

    const { status, mtime } = getSessionStatus(session.jsonlPath);
    if (mtime === 0) continue;

    results.push({
      key: `${session.projectName}:${session.sessionId}`,
      project: session.projectName,
      projectPath: session.projectPath,
      sessionId: session.sessionId,
      sessionName: data.sessionNames[session.sessionId] || null,
      status,
      mtime,
    });
  }

  results.sort((a, b) => {
    const cmp = a.project.localeCompare(b.project);
    if (cmp !== 0) return cmp;
    return b.mtime - a.mtime;
  });

  return results;
}

/**
 * Extract the project path (cwd) from a .jsonl session file.
 * Reads lines until it finds one with a "cwd" field.
 */
function extractCwdFromJsonl(jsonlPath) {
  let fd;
  try {
    fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);

    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.cwd) return entry.cwd;
      } catch {
        continue;
      }
    }
  } catch {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  return null;
}

function discoverUntracked() {
  const data = loadData();
  const tracked = new Set(data.projects);
  const archived = new Set(data.archivedProjects);
  const seen = new Set();
  const suggestions = [];

  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    const projDir = path.join(PROJECTS_DIR, dirName);

    let stat;
    try {
      stat = fs.statSync(projDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Find a .jsonl file to extract the real cwd
    let files;
    try {
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }

    const jsonlFile = files.find((f) => f.endsWith(".jsonl"));
    if (!jsonlFile) continue;

    const projectPath = extractCwdFromJsonl(path.join(projDir, jsonlFile));
    if (!projectPath) continue;

    // Skip duplicates, already tracked, or archived
    if (seen.has(projectPath)) continue;
    if (tracked.has(projectPath)) continue;
    if (archived.has(projectPath)) continue;
    seen.add(projectPath);

    // Verify path exists on disk
    try {
      fs.accessSync(projectPath);
    } catch {
      continue;
    }

    suggestions.push({
      projectPath,
      projectName: path.basename(projectPath),
    });
  }

  return suggestions;
}

// --- File watcher with debounce ---

let debounceTimer = null;
let watchers = [];

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-updated");
  }
}

function scheduleScan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    notifyRenderer();
  }, 2000);
}

function startWatchers() {
  // Close existing watchers
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];

  const data = loadData();
  for (const projectPath of data.projects || []) {
    const dirName = encodePath(projectPath);
    const projDir = path.join(PROJECTS_DIR, dirName);
    try {
      const watcher = fs.watch(projDir, { recursive: false }, (_eventType, filename) => {
        if (filename && filename.endsWith(".jsonl")) {
          scheduleScan();
        }
      });
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Directory may not exist yet
    }
  }

  // Also watch the data file for project list changes
  try {
    const dataWatcher = fs.watch(DATA_FILE, () => {
      scheduleScan();
      // Restart watchers since project list may have changed
      setTimeout(() => startWatchers(), 500);
    });
    dataWatcher.on("error", () => {});
    watchers.push(dataWatcher);
  } catch {}
}

// --- IPC ---

ipcMain.handle("scan-sessions", () => {
  return scanAll();
});

let helpWindow = null;

ipcMain.handle("open-help", () => {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }
  helpWindow = new BrowserWindow({
    width: 300,
    height: 340,
    resizable: false,
    alwaysOnTop: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111111",
  });
  helpWindow.loadFile("help.html");
  helpWindow.on("closed", () => { helpWindow = null; });
});

ipcMain.handle("add-project", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    message: "Choose a project directory to track",
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const dir = result.filePaths[0];
  const data = loadData();
  if (!data.projects) data.projects = [];
  if (!data.projects.includes(dir)) {
    data.projects.push(dir);
    saveData(data);
  }
  return dir;
});

ipcMain.handle("remove-project", (_event, projectPath) => {
  const data = loadData();
  data.projects = data.projects.filter((p) => p !== projectPath);
  saveData(data);
});

ipcMain.handle("get-suggestions", () => {
  return discoverUntracked();
});

ipcMain.handle("add-project-path", (_event, projectPath) => {
  const data = loadData();
  if (!data.projects.includes(projectPath)) {
    data.projects.push(projectPath);
    saveData(data);
  }
  return projectPath;
});

ipcMain.handle("archive-project", (_event, projectPath) => {
  const data = loadData();
  data.projects = data.projects.filter((p) => p !== projectPath);
  if (!data.archivedProjects.includes(projectPath)) {
    data.archivedProjects.push(projectPath);
  }
  saveData(data);
});

ipcMain.handle("unarchive-project", (_event, projectPath) => {
  const data = loadData();
  data.archivedProjects = data.archivedProjects.filter((p) => p !== projectPath);
  if (!data.projects.includes(projectPath)) {
    data.projects.push(projectPath);
  }
  saveData(data);
});

ipcMain.handle("archive-session", (_event, sessionId) => {
  const data = loadData();
  if (!data.archivedSessions.includes(sessionId)) {
    data.archivedSessions.push(sessionId);
  }
  saveData(data);
});

ipcMain.handle("unarchive-session", (_event, sessionId) => {
  const data = loadData();
  data.archivedSessions = data.archivedSessions.filter((id) => id !== sessionId);
  saveData(data);
});

ipcMain.handle("get-archived", () => {
  const data = loadData();

  const archivedProjects = data.archivedProjects.map((projectPath) => ({
    projectPath,
    projectName: path.basename(projectPath),
  }));

  const archivedSessions = [];
  const archivedSessionIds = new Set(data.archivedSessions);

  // Scan all project dirs to find metadata for archived sessions
  for (const projectPath of [...data.projects, ...data.archivedProjects]) {
    const dirName = encodePath(projectPath);
    const projDir = path.join(PROJECTS_DIR, dirName);

    let files;
    try {
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");
      if (!archivedSessionIds.has(sessionId)) continue;

      const jsonlPath = path.join(projDir, file);
      let mtime = 0;
      try {
        mtime = fs.statSync(jsonlPath).mtimeMs;
      } catch {}

      archivedSessions.push({
        projectPath,
        projectName: path.basename(projectPath),
        sessionId,
        sessionName: data.sessionNames[sessionId] || null,
        mtime,
      });
    }
  }

  return { archivedProjects, archivedSessions };
});

ipcMain.handle("rename-session", (_event, sessionId, name) => {
  const data = loadData();
  if (!data.sessionNames) data.sessionNames = {};
  if (name) {
    data.sessionNames[sessionId] = name;
  } else {
    delete data.sessionNames[sessionId];
  }
  saveData(data);
});

ipcMain.handle("resize-window", (_event, rowCount) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const h = Math.min(Math.max(BASE_HEIGHT + rowCount * ROW_HEIGHT, MIN_HEIGHT), MAX_HEIGHT);
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: WIDTH, height: h });
});

// --- App lifecycle ---

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const { nativeImage } = require("electron");
    const icon = nativeImage.createFromPath(
      path.join(__dirname, "build", "icon.png"),
    );
    app.dock.setIcon(icon);
  }
  app.setName("ClaudeBoard");
  createWindow();
  startWatchers();

  // Fallback poll every 30s
  setInterval(() => {
    notifyRenderer();
  }, 30000);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
