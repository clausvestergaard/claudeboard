const path = require("path");
const fs = require("fs");
const os = require("os");

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

function getStateDir() {
  return process.env.CLAUDEBOARD_STATE_DIR || path.join(HOME, ".claudeboard", "state");
}

const VALID_STATUSES = new Set(["working", "needs_input", "waiting", "ended"]);

const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_WORKING_MS = 30 * 1000;
const PRUNE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TITLE_READ_BYTES = 64 * 1024;

/**
 * @typedef {Object} Session
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} repoRoot
 * @property {number|null} pid
 * @property {string|null} transcriptPath
 * @property {string} status
 * @property {string} message
 * @property {number} ts
 * @property {boolean} legacy
 * @property {string|null} aiTitle
 * @property {string|null} lastPrompt
 */

/**
 * Check whether a pid is a live process. Returns true if unknown (no pid).
 * @param {number|null} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (pid === null || pid === undefined) return true;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/**
 * Extract the cwd from a .jsonl session file by reading the first lines.
 * @param {string} jsonlPath
 * @returns {string|null}
 */
function extractCwdFromJsonl(jsonlPath) {
  let fd;
  try {
    fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    fd = undefined;

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
    // fall through
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

/**
 * Read the last `TITLE_READ_BYTES` of a transcript and extract the last
 * ai-title and last-prompt metadata entries. Cached per file mtime.
 * @param {string|null} transcriptPath
 * @param {Map<string, {mtime: number, aiTitle: string|null, lastPrompt: string|null}>} cache
 * @returns {{aiTitle: string|null, lastPrompt: string|null}}
 */
function extractTitles(transcriptPath, cache) {
  if (!transcriptPath) return { aiTitle: null, lastPrompt: null };

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { aiTitle: null, lastPrompt: null };
  }

  const cached = cache.get(transcriptPath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return { aiTitle: cached.aiTitle, lastPrompt: cached.lastPrompt };
  }

  let aiTitle = null;
  let lastPrompt = null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = stat.size;
    const readLen = Math.min(TITLE_READ_BYTES, size);
    const offset = size - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, offset);
    fs.closeSync(fd);
    fd = undefined;

    const chunk = buf.toString("utf-8");
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
        aiTitle = entry.aiTitle;
      } else if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string") {
        lastPrompt = entry.lastPrompt;
      }
    }
  } catch {
    // fall through
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  cache.set(transcriptPath, { mtime: stat.mtimeMs, aiTitle, lastPrompt });
  return { aiTitle, lastPrompt };
}

/**
 * Read and parse a single state file. Returns null on malformed/partial data.
 * @param {string} filePath
 * @returns {Object|null}
 */
function readStateFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
  if (!VALID_STATUSES.has(parsed.status)) return null;
  return parsed;
}

/**
 * Read all state files from the state dir. Creates the dir if missing.
 * @param {string} stateDir
 * @returns {Object[]}
 */
function readStateFiles(stateDir) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {}

  let files;
  try {
    files = fs.readdirSync(stateDir);
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const parsed = readStateFile(path.join(stateDir, file));
    if (parsed) out.push({ ...parsed, _file: path.join(stateDir, file) });
  }
  return out;
}

/**
 * Prune ended/dead state files older than PRUNE_AGE_MS.
 * @param {Object[]} rawStates state objects (with _file), post-liveness effectiveStatus
 * @param {number} now
 */
function pruneStale(prunable, now) {
  for (const { file, ts } of prunable) {
    if (typeof ts === "number" && now - ts * 1000 > PRUNE_AGE_MS) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}

/**
 * Legacy scan: find *.jsonl transcripts under ~/.claude/projects with no
 * state file, mtime < 24h old.
 * @param {Set<string>} knownSessionIds
 * @param {number} now
 * @returns {Object[]}
 */
function scanLegacy(knownSessionIds, now, projectsDir = PROJECTS_DIR) {
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  const results = [];
  for (const dirName of dirs) {
    const projDir = path.join(projectsDir, dirName);
    let files;
    try {
      const stat = fs.statSync(projDir);
      if (!stat.isDirectory()) continue;
      files = fs.readdirSync(projDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(/\.jsonl$/, "");
      if (knownSessionIds.has(sessionId)) continue;

      const jsonlPath = path.join(projDir, file);
      let mtime;
      try {
        mtime = fs.statSync(jsonlPath).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime >= LEGACY_MAX_AGE_MS) continue;

      const cwd = extractCwdFromJsonl(jsonlPath);
      if (!cwd) continue;

      const status = now - mtime < LEGACY_WORKING_MS ? "working" : "waiting";
      results.push({
        sessionId,
        cwd,
        repoRoot: cwd,
        pid: null,
        transcriptPath: jsonlPath,
        status,
        message: "",
        ts: Math.floor(mtime / 1000),
        legacy: true,
      });
    }
  }
  return results;
}

/**
 * Core scan: produce the full list of live (non-archived filtering happens in
 * the caller) session objects with effective status, titles, and grouping
 * fields. Also prunes stale state files.
 *
 * @param {Object} [opts]
 * @param {string} [opts.stateDir]
 * @param {string} [opts.projectsDir]
 * @param {Map} [opts.titleCache]
 * @param {number} [opts.now]
 * @returns {Session[]}
 */
function scanSessions(opts = {}) {
  const stateDir = opts.stateDir || getStateDir();
  const projectsDir = opts.projectsDir || PROJECTS_DIR;
  const titleCache = opts.titleCache || new Map();
  const now = opts.now || Date.now();

  const rawStates = readStateFiles(stateDir);
  const knownSessionIds = new Set();
  const sessions = [];
  const prunable = [];

  for (const raw of rawStates) {
    knownSessionIds.add(raw.sessionId);

    const pid = Number.isInteger(raw.pid) ? raw.pid : null;
    let status = raw.status;

    // Liveness: if not ended and pid dead, treat as ended.
    if (status !== "ended" && pid !== null && pid > 0 && !isPidAlive(pid)) {
      status = "ended";
    }

    if (status === "ended") {
      prunable.push({ file: raw._file, ts: raw.ts });
    }

    const { aiTitle, lastPrompt } = extractTitles(raw.transcriptPath || null, titleCache);

    sessions.push({
      sessionId: raw.sessionId,
      cwd: raw.cwd || raw.repoRoot || "",
      repoRoot: raw.repoRoot || raw.cwd || "",
      pid,
      transcriptPath: raw.transcriptPath || null,
      status,
      message: typeof raw.message === "string" ? raw.message : "",
      ts: typeof raw.ts === "number" ? raw.ts : 0,
      legacy: false,
      aiTitle,
      lastPrompt,
    });
  }

  // Legacy fallback for pre-hook sessions.
  const legacy = scanLegacy(knownSessionIds, now, projectsDir);
  for (const s of legacy) {
    const { aiTitle, lastPrompt } = extractTitles(s.transcriptPath, titleCache);
    sessions.push({ ...s, aiTitle, lastPrompt });
  }

  pruneStale(prunable, now);

  return sessions;
}

module.exports = {
  getStateDir,
  scanSessions,
  extractCwdFromJsonl,
  extractTitles,
  isPidAlive,
  readStateFiles,
  scanLegacy,
  VALID_STATUSES,
  PROJECTS_DIR,
};
