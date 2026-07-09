const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

const scanner = require("../scanner.js");

// --- Set up temp dirs ---
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));
const stateDir = path.join(tmpBase, "state");
const projectsDir = path.join(tmpBase, "projects");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(projectsDir, { recursive: true });

const nowSec = Math.floor(Date.now() / 1000);

// Live pid = this test process. Dead pid = an unused high pid.
const livePid = process.pid;
const deadPid = 999999;

// --- Fixture: a transcript with ai-title / last-prompt entries ---
const transcriptDir = path.join(projectsDir, "-Users-me-repo-a");
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = path.join(transcriptDir, "sess-working.jsonl");
const transcriptLines = [
  JSON.stringify({ type: "user", cwd: "/Users/me/repo-a" }),
  JSON.stringify({ type: "ai-title", aiTitle: "Old title", sessionId: "sess-working" }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "Old prompt", sessionId: "sess-working" }),
  JSON.stringify({ type: "ai-title", aiTitle: "Review project", sessionId: "sess-working" }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "Please review the project", sessionId: "sess-working" }),
];
fs.writeFileSync(transcriptPath, transcriptLines.join("\n") + "\n");

function writeState(name, obj) {
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify(obj));
}

// working (live pid, has transcript with titles)
writeState("sess-working.json", {
  sessionId: "sess-working",
  cwd: "/Users/me/repo-a",
  repoRoot: "/Users/me/repo-a",
  pid: livePid,
  transcriptPath,
  lastEvent: "PreToolUse",
  status: "working",
  message: "",
  ts: nowSec,
});

// needs_input
writeState("sess-needs.json", {
  sessionId: "sess-needs",
  cwd: "/Users/me/repo-b",
  repoRoot: "/Users/me/repo-b",
  pid: livePid,
  transcriptPath: null,
  status: "needs_input",
  message: "Approve edit?",
  ts: nowSec,
});

// waiting
writeState("sess-waiting.json", {
  sessionId: "sess-waiting",
  cwd: "/Users/me/repo-b",
  repoRoot: "/Users/me/repo-b",
  pid: livePid,
  status: "waiting",
  ts: nowSec,
});

// ended (recent — should NOT be pruned)
writeState("sess-ended.json", {
  sessionId: "sess-ended",
  cwd: "/Users/me/repo-c",
  repoRoot: "/Users/me/repo-c",
  pid: livePid,
  status: "ended",
  ts: nowSec,
});

// worktree session: cwd != repoRoot
writeState("sess-worktree.json", {
  sessionId: "sess-worktree",
  cwd: "/Users/me/repo-a-wt-feature-x",
  repoRoot: "/Users/me/repo-a",
  pid: livePid,
  status: "working",
  ts: nowSec,
});

// dead-pid working session -> should become "ended"
writeState("sess-deadpid.json", {
  sessionId: "sess-deadpid",
  cwd: "/Users/me/repo-d",
  repoRoot: "/Users/me/repo-d",
  pid: deadPid,
  status: "working",
  ts: nowSec,
});

// malformed file -> skipped
fs.writeFileSync(path.join(stateDir, "sess-bad.json"), "{ not json ");

// partial file (missing status) -> skipped
fs.writeFileSync(
  path.join(stateDir, "sess-partial.json"),
  JSON.stringify({ sessionId: "sess-partial", cwd: "/x" }),
);

// ended + very old -> should be PRUNED
const oldTs = nowSec - 15 * 24 * 60 * 60; // 15 days
writeState("sess-oldended.json", {
  sessionId: "sess-oldended",
  cwd: "/Users/me/repo-e",
  repoRoot: "/Users/me/repo-e",
  pid: null,
  status: "ended",
  ts: oldTs,
});

// --- Legacy fallback: a transcript with NO state file, recent mtime ---
const legacyDir = path.join(projectsDir, "-Users-me-repo-legacy");
fs.mkdirSync(legacyDir, { recursive: true });
const legacyPath = path.join(legacyDir, "sess-legacy.jsonl");
fs.writeFileSync(
  legacyPath,
  JSON.stringify({ type: "user", cwd: "/Users/me/repo-legacy" }) + "\n",
);
// make it a bit old so it's "waiting" not "working" (deterministic)
const past = new Date(Date.now() - 5 * 60 * 1000);
fs.utimesSync(legacyPath, past, past);

let passed = 0;
function check(desc, fn) {
  fn();
  passed++;
  console.log("  ok -", desc);
}

try {
  // --- Run scan ---
  const sessions = scanner.scanSessions({ stateDir, projectsDir, now: Date.now() });
  const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));

  // --- Assertions ---
  check("working session present with status working", () => {
    assert.strictEqual(byId["sess-working"].status, "working");
  });
  check("needs_input status preserved", () => {
    assert.strictEqual(byId["sess-needs"].status, "needs_input");
  });
  check("waiting status preserved", () => {
    assert.strictEqual(byId["sess-waiting"].status, "waiting");
  });
  check("ended status preserved", () => {
    assert.strictEqual(byId["sess-ended"].status, "ended");
  });
  check("dead-pid working session becomes ended", () => {
    assert.strictEqual(byId["sess-deadpid"].status, "ended");
  });
  check("malformed file skipped", () => {
    assert.ok(!("sess-bad" in byId));
  });
  check("partial file (no status) skipped", () => {
    assert.ok(!("sess-partial" in byId));
  });
  check("worktree session: cwd != repoRoot, repoRoot is main repo", () => {
    const s = byId["sess-worktree"];
    assert.strictEqual(s.repoRoot, "/Users/me/repo-a");
    assert.notStrictEqual(s.cwd, s.repoRoot);
  });
  check("title extraction: last ai-title and last-prompt win", () => {
    const s = byId["sess-working"];
    assert.strictEqual(s.aiTitle, "Review project");
    assert.strictEqual(s.lastPrompt, "Please review the project");
  });
  check("legacy session discovered with repoRoot=cwd and legacy=true", () => {
    const s = byId["sess-legacy"];
    assert.ok(s, "legacy session found");
    assert.strictEqual(s.legacy, true);
    assert.strictEqual(s.cwd, "/Users/me/repo-legacy");
    assert.strictEqual(s.repoRoot, "/Users/me/repo-legacy");
    assert.strictEqual(s.status, "waiting");
  });
  check("old ended state file was pruned from disk", () => {
    assert.ok(!fs.existsSync(path.join(stateDir, "sess-oldended.json")));
  });
  check("recent ended state file NOT pruned", () => {
    assert.ok(fs.existsSync(path.join(stateDir, "sess-ended.json")));
  });
  check("title cache reuse (second scan returns same titles)", () => {
    const cache = new Map();
    scanner.scanSessions({ stateDir, projectsDir, titleCache: cache });
    const again = scanner.scanSessions({ stateDir, projectsDir, titleCache: cache });
    const s = again.find((x) => x.sessionId === "sess-working");
    assert.strictEqual(s.aiTitle, "Review project");
    assert.ok(cache.has(transcriptPath));
  });

  console.log(`\nAll ${passed} assertions passed.`);
} finally {
  // cleanup
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
