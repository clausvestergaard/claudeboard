/**
 * Terminal-focus logic for ClaudeBoard (macOS).
 *
 * Given the pid of a `claude` process, resolve its controlling TTY device and
 * bring the terminal window/tab hosting it to the foreground. iTerm2 and
 * Terminal.app support exact tab selection via AppleScript. For terminals
 * with no tab-level scripting API (Ghostty, WezTerm, kitty, Alacritty) we
 * fall back to walking the pid's ancestor chain to find the owning terminal
 * app and activating it — the right app comes forward, though the exact tab
 * can't be selected. Multiplexers (zellij, tmux) detach their server from the
 * terminal, so on hitting one we hop to the multiplexer's client processes
 * and walk their ancestors instead.
 *
 * The pure parts (tty parsing/validation, AppleScript generation, ps-output
 * parsing, ancestor matching) are exported for testing. `focusSession`
 * performs the async side effects.
 */

const path = require("path");
const { execFile } = require("child_process");

const TTY_DEVICE_RE = /^\/dev\/ttys[0-9]+$/;

const ANCESTOR_MAX_DEPTH = 10;

/**
 * Terminal apps without a tab-level scripting API, keyed by lowercased comm
 * basename. Value is the `open -a` application name.
 */
const KNOWN_TERMINAL_APPS = {
  ghostty: "Ghostty",
  wezterm: "WezTerm",
  "wezterm-gui": "WezTerm",
  kitty: "kitty",
  alacritty: "Alacritty",
};

/** Terminal multiplexers whose server process is detached from the terminal. */
const KNOWN_MULTIPLEXERS = new Set(["zellij", "tmux"]);

/**
 * Convert a `ps -o tty=` value into an absolute device path.
 * Returns null for missing/none ("??") or unparseable values.
 * @param {string|null|undefined} raw e.g. "ttys012" or "/dev/ttys012" or "??"
 * @returns {string|null} e.g. "/dev/ttys012"
 */
function ttyToDevicePath(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "??" || trimmed === "?") return null;
  const device = trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed}`;
  if (!TTY_DEVICE_RE.test(device)) return null;
  return device;
}

/**
 * @param {string} device
 * @returns {boolean}
 */
function isValidDevicePath(device) {
  return typeof device === "string" && TTY_DEVICE_RE.test(device);
}

/**
 * AppleScript that iterates iTerm2 windows/tabs/sessions, finds the session
 * whose tty matches `device`, selects its tab, raises its window, and
 * activates iTerm2. Returns "1" on match, "0" otherwise.
 * @param {string} device validated /dev/ttysNNN path
 * @returns {string}
 */
function buildITermScript(device) {
  if (!isValidDevicePath(device)) throw new Error(`invalid tty device: ${device}`);
  return `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${device}" then
          tell w to select t
          set index of w to 1
          activate
          return "1"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "0"
`;
}

/**
 * AppleScript that iterates Terminal.app windows/tabs, finds the tab whose tty
 * matches `device`, selects it, raises its window, and activates Terminal.
 * Returns "1" on match, "0" otherwise.
 * @param {string} device validated /dev/ttysNNN path
 * @returns {string}
 */
function buildTerminalScript(device) {
  if (!isValidDevicePath(device)) throw new Error(`invalid tty device: ${device}`);
  return `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${device}" then
        set selected of t to true
        set frontmost of w to true
        set index of w to 1
        activate
        return "1"
      end if
    end repeat
  end repeat
end tell
return "0"
`;
}

/**
 * Parse one line of `ps -o ppid=,comm= -p <pid>` output.
 * @param {string|null|undefined} stdout e.g. " 1755 /bin/zsh"
 * @returns {{ppid: number, comm: string}|null}
 */
function parsePpidComm(stdout) {
  if (typeof stdout !== "string") return null;
  const m = stdout.trim().match(/^(\d+)\s+(.+)$/s);
  if (!m) return null;
  const ppid = parseInt(m[1], 10);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  return { ppid, comm: m[2].trim() };
}

/**
 * Lowercased basename of a comm value, tolerating the login-shell "-" prefix
 * (e.g. "-/bin/zsh" -> "zsh", "/Applications/Ghostty.app/.../ghostty" -> "ghostty").
 * @param {string} comm
 * @returns {string}
 */
function commBasename(comm) {
  if (typeof comm !== "string") return "";
  const stripped = comm.replace(/^-/, "");
  return path.basename(stripped).toLowerCase();
}

/**
 * Match a comm against the known scripting-API-less terminal apps.
 * @param {string} comm
 * @returns {{appName: string, bundlePath: string|null}|null}
 */
function matchTerminalApp(comm) {
  const appName = KNOWN_TERMINAL_APPS[commBasename(comm)];
  if (!appName) return null;
  // Prefer the concrete .app bundle from the process path when present,
  // e.g. /Applications/Ghostty.app/Contents/MacOS/ghostty -> /Applications/Ghostty.app
  const m = typeof comm === "string" ? comm.match(/^(.*?\.app)\//) : null;
  return { appName, bundlePath: m ? m[1] : null };
}

/**
 * @param {string} comm
 * @returns {string|null} multiplexer name ("zellij"/"tmux") or null
 */
function matchMultiplexer(comm) {
  const base = commBasename(comm);
  return KNOWN_MULTIPLEXERS.has(base) ? base : null;
}

/**
 * Default impure reader for the ancestor walk: `ps -o ppid=,comm= -p <pid>`.
 * @param {number} pid
 * @returns {Promise<{ppid: number, comm: string}|null>}
 */
function readPpidComm(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,comm=", "-p", String(pid)], (err, stdout) => {
      resolve(err ? null : parsePpidComm(stdout));
    });
  });
}

/**
 * Walk a pid's ancestor chain (up to maxDepth levels) looking for a known
 * terminal app. Records the first multiplexer seen along the way so the
 * caller can hop to its client processes when the chain dead-ends (zellij and
 * tmux servers are children of launchd, not the terminal).
 *
 * Pure given an injected reader — testable with a fake process table.
 *
 * @param {number} pid
 * @param {Object} [opts]
 * @param {(pid: number) => Promise<{ppid: number, comm: string}|null>} [opts.read]
 * @param {number} [opts.maxDepth]
 * @returns {Promise<{terminal: {appName: string, bundlePath: string|null}|null, multiplexer: string|null}>}
 */
async function findTerminalAncestor(pid, opts = {}) {
  const read = opts.read || readPpidComm;
  const maxDepth = opts.maxDepth || ANCESTOR_MAX_DEPTH;

  let multiplexer = null;
  let cur = pid;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!Number.isInteger(cur) || cur <= 1) break;
    const info = await read(cur);
    if (!info) break;

    const terminal = matchTerminalApp(info.comm);
    if (terminal) return { terminal, multiplexer };

    if (!multiplexer) multiplexer = matchMultiplexer(info.comm);

    cur = info.ppid;
  }
  return { terminal: null, multiplexer };
}

/**
 * List pids whose process name matches exactly (pgrep -x).
 * @param {string} name
 * @returns {Promise<number[]>}
 */
function listPidsByName(name) {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", name], (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(
        stdout
          .trim()
          .split("\n")
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
  });
}

/**
 * Activate a terminal app found via the ancestor walk. Prefers opening the
 * concrete .app bundle; falls back to `open -a <name>`.
 * @param {{appName: string, bundlePath: string|null}} terminal
 * @returns {Promise<boolean>}
 */
function activateApp(terminal) {
  const args = terminal.bundlePath ? [terminal.bundlePath] : ["-a", terminal.appName];
  return new Promise((resolve) => {
    execFile("open", args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * App-level fallback: find the terminal app hosting `pid` via its ancestor
 * chain (hopping through multiplexer clients if needed) and activate it.
 * Cannot select the exact tab — just raises the right app.
 * @param {number} pid
 * @returns {Promise<boolean>} true if a terminal app was activated
 */
async function focusOwningTerminalApp(pid) {
  const { terminal, multiplexer } = await findTerminalAncestor(pid);
  if (terminal) return activateApp(terminal);

  if (multiplexer) {
    // The multiplexer server is detached from the terminal; its client
    // processes are children of the terminal. Walk each client's ancestors.
    const clientPids = await listPidsByName(multiplexer);
    for (const clientPid of clientPids) {
      const res = await findTerminalAncestor(clientPid);
      if (res.terminal) return activateApp(res.terminal);
    }
  }

  return false;
}

/**
 * Resolve the controlling tty device of a pid via `ps`.
 * @param {number} pid
 * @returns {Promise<string|null>} device path or null
 */
function resolveTty(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(null);
      return;
    }
    execFile("ps", ["-o", "tty=", "-p", String(pid)], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(ttyToDevicePath(stdout));
    });
  });
}

/**
 * @param {string} appName e.g. "iTerm2" or "Terminal"
 * @returns {Promise<boolean>}
 */
function isAppRunning(appName) {
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", appName], (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * Run an AppleScript and resolve with its trimmed stdout ("1"/"0"), or null on error.
 * @param {string} script
 * @returns {Promise<string|null>}
 */
function runOsascript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Bring the terminal hosting `pid`'s claude session to the foreground.
 * Fails silently (no throw, no dialog) if the tty can't be resolved or no
 * supported terminal hosts it.
 * @param {number} pid
 * @returns {Promise<boolean>} true if a terminal was focused
 */
async function focusSession(pid) {
  const device = await resolveTty(pid);

  if (device) {
    if (await isAppRunning("iTerm2")) {
      const result = await runOsascript(buildITermScript(device));
      if (result === "1") return true;
    }

    if (await isAppRunning("Terminal")) {
      const result = await runOsascript(buildTerminalScript(device));
      if (result === "1") return true;
    }
  }

  // Neither scriptable terminal owns the tty (or there is no tty) — fall back
  // to raising the owning terminal app found via the ancestor chain.
  return focusOwningTerminalApp(pid);
}

module.exports = {
  ttyToDevicePath,
  isValidDevicePath,
  buildITermScript,
  buildTerminalScript,
  parsePpidComm,
  commBasename,
  matchTerminalApp,
  matchMultiplexer,
  findTerminalAncestor,
  focusOwningTerminalApp,
  resolveTty,
  focusSession,
  TTY_DEVICE_RE,
  KNOWN_TERMINAL_APPS,
  KNOWN_MULTIPLEXERS,
};
