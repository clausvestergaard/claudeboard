const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const scanner = require("./scanner");
const { diffStatuses } = require("./notify");
const { focusSession } = require("./focus");

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
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    data = {};
  }
  // Migrate legacy fields: archivedProjects -> archivedRepos.
  if (data.archivedProjects && !data.archivedRepos) {
    data.archivedRepos = data.archivedProjects;
  }
  delete data.archivedProjects;
  delete data.projects;
  if (!data.archivedRepos) data.archivedRepos = [];
  if (!data.archivedSessions) data.archivedSessions = [];
  if (!data.sessionNames) data.sessionNames = {};
  return data;
}

function saveData(data) {
  const tmpFile = path.join(
    path.dirname(DATA_FILE),
    `.claudeboard.json.tmp.${process.pid}`,
  );
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    throw err;
  }
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

// --- Session scanning ---

/** @type {Map<string, {mtime: number, aiTitle: string|null, lastPrompt: string|null}>} */
const titleCache = new Map();

/** @type {Map<string, string>} sessionId -> last-seen status */
const statusMap = new Map();
let seededStatus = false;

function sessionDisplayName(s) {
  return s.sessionName || s.aiTitle || s.sessionId.slice(0, 8);
}

function fireNotification(s) {
  if (!Notification.isSupported()) return;
  const title = s.repoName
    ? `${sessionDisplayName(s)} · ${s.repoName}`
    : sessionDisplayName(s);
  const body = s.message || "Needs your input";
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
}

/**
 * Diff the current results against the last-seen status map, firing
 * notifications on transitions into needs_input and updating the dock badge.
 * @param {Object[]} results filtered, decorated sessions
 */
function processNotifications(results) {
  const { toNotify, badgeCount, nextMap } = diffStatuses(
    statusMap,
    results,
    !seededStatus,
  );

  if (seededStatus) {
    for (const s of toNotify) fireNotification(s);
  }
  seededStatus = true;

  statusMap.clear();
  for (const [id, status] of nextMap) statusMap.set(id, status);

  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(badgeCount > 0 ? String(badgeCount) : "");
  }
}

function scanAll() {
  const data = loadData();
  const archivedSessions = new Set(data.archivedSessions);
  const archivedRepos = new Set(data.archivedRepos);

  const sessions = scanner.scanSessions({ titleCache });

  const results = [];
  for (const s of sessions) {
    if (archivedSessions.has(s.sessionId)) continue;
    if (archivedRepos.has(s.repoRoot)) continue;

    results.push({
      ...s,
      repoName: path.basename(s.repoRoot || s.cwd || s.sessionId),
      worktreeName:
        s.cwd && s.repoRoot && s.cwd !== s.repoRoot ? path.basename(s.cwd) : null,
      sessionName: data.sessionNames[s.sessionId] || null,
    });
  }

  processNotifications(results);

  return results;
}

// --- File watcher with debounce ---

let debounceTimer = null;
let stateWatcher = null;
let dataWatcher = null;

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sessions-updated");
  }
}

function scheduleScan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    notifyRenderer();
  }, 500);
}

function startWatchers() {
  if (stateWatcher) {
    try {
      stateWatcher.close();
    } catch {}
    stateWatcher = null;
  }

  if (dataWatcher) {
    try {
      dataWatcher.close();
    } catch {}
    dataWatcher = null;
  }

  const stateDir = scanner.getStateDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {}

  try {
    stateWatcher = fs.watch(stateDir, { recursive: false }, () => {
      scheduleScan();
    });
    stateWatcher.on("error", () => {});
  } catch {
    // Directory may not exist yet; fallback poll will cover it.
  }

  // Also watch the data file for archive/rename changes.
  try {
    dataWatcher = fs.watch(DATA_FILE, () => scheduleScan());
    dataWatcher.on("error", () => {});
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
    height: 360,
    resizable: false,
    alwaysOnTop: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111111",
  });
  helpWindow.loadFile("help.html");
  helpWindow.on("closed", () => {
    helpWindow = null;
  });
});

ipcMain.handle("archive-repo", (_event, repoRoot) => {
  const data = loadData();
  if (!data.archivedRepos.includes(repoRoot)) {
    data.archivedRepos.push(repoRoot);
  }
  saveData(data);
});

ipcMain.handle("unarchive-repo", (_event, repoRoot) => {
  const data = loadData();
  data.archivedRepos = data.archivedRepos.filter((p) => p !== repoRoot);
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
  const archivedRepoSet = new Set(data.archivedRepos);
  const archivedSessionIds = new Set(data.archivedSessions);

  // Scan raw sessions (ignoring archive filters) to source metadata.
  const allSessions = scanner.scanSessions({ titleCache });

  const archivedRepos = data.archivedRepos.map((repoRoot) => ({
    repoRoot,
    repoName: path.basename(repoRoot),
  }));

  const archivedSessions = [];
  const seen = new Set();
  for (const s of allSessions) {
    if (!archivedSessionIds.has(s.sessionId)) continue;
    if (seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    archivedSessions.push({
      sessionId: s.sessionId,
      repoRoot: s.repoRoot,
      repoName: path.basename(s.repoRoot || s.cwd || s.sessionId),
      sessionName: data.sessionNames[s.sessionId] || null,
      aiTitle: s.aiTitle || null,
      ts: s.ts,
    });
  }

  return { archivedRepos, archivedSessions, archivedRepoSet: [...archivedRepoSet] };
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

ipcMain.handle("focus-session", (_event, pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  // Fire-and-forget; never block the main process or surface errors.
  focusSession(pid).catch(() => {});
});

ipcMain.handle("resize-window", (_event, rowCount) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const h = Math.min(
    Math.max(BASE_HEIGHT + rowCount * ROW_HEIGHT, MIN_HEIGHT),
    MAX_HEIGHT,
  );
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

  // Fallback poll every 30s.
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
