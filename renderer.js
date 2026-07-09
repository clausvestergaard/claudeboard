/** @type {Set<string>} collapsed repo roots (in-memory only) */
const collapsed = new Set();

/** @type {boolean} */
let showArchived = false;

/** @type {{archivedRepos: Array, archivedSessions: Array}} */
let cachedArchived = { archivedRepos: [], archivedSessions: [] };

const STATUS_PRIORITY = { needs_input: 3, working: 2, waiting: 1, ended: 0 };
const STATUS_LABEL = {
  needs_input: "needs input",
  working: "working",
  waiting: "waiting",
  ended: "ended",
};

function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

/** Strip a leading "Claude " for narrow display. Returns "" for empty input. */
function shortMessage(message) {
  if (!message) return "";
  return message.replace(/^Claude\s+/, "");
}

function displayName(session) {
  return (
    session.sessionName || session.aiTitle || session.sessionId.slice(0, 8)
  );
}

function bestStatus(sessions) {
  return sessions.reduce(
    (best, s) =>
      (STATUS_PRIORITY[s.status] ?? -1) > (STATUS_PRIORITY[best] ?? -1)
        ? s.status
        : best,
    "ended",
  );
}

function resizeToContent(sessions, extraRows = 0) {
  const headerCount = new Set(sessions.map((s) => s.repoRoot)).size;
  let visibleSessions = 0;
  for (const s of sessions) {
    if (!collapsed.has(s.repoRoot)) visibleSessions++;
  }
  const rowCount = Math.max(headerCount + visibleSessions + extraRows, 1);
  window.api.resizeWindow(rowCount);
}

function groupByRepo(sessions) {
  /** @type {Map<string, {repoName: string, repoRoot: string, sessions: typeof sessions}>} */
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.repoRoot)) {
      groups.set(s.repoRoot, {
        repoName: s.repoName,
        repoRoot: s.repoRoot,
        sessions: [],
      });
    }
    groups.get(s.repoRoot).sessions.push(s);
  }

  const list = [...groups.values()];

  // Sort sessions within each group: status priority, then ts desc.
  for (const g of list) {
    g.sessions.sort((a, b) => {
      const cmp = (STATUS_PRIORITY[b.status] ?? -1) - (STATUS_PRIORITY[a.status] ?? -1);
      if (cmp !== 0) return cmp;
      return b.ts - a.ts;
    });
  }

  // Sort groups: best status priority, then name.
  list.sort((a, b) => {
    const cmp =
      (STATUS_PRIORITY[bestStatus(b.sessions)] ?? -1) -
      (STATUS_PRIORITY[bestStatus(a.sessions)] ?? -1);
    if (cmp !== 0) return cmp;
    return a.repoName.localeCompare(b.repoName);
  });

  return list;
}

function startRename(labelEl, session) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = session.sessionName || "";
  input.placeholder = displayName(session);

  // Clicks inside the rename input must not bubble to the row's
  // focus-terminal click handler.
  input.addEventListener("click", (e) => e.stopPropagation());

  const parent = labelEl.parentElement;
  parent.replaceChild(input, labelEl);
  input.focus();
  input.select();

  let done = false;

  function restore() {
    const newLabel = createSessionLabel(session);
    newLabel.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(newLabel, session);
    });
    parent.replaceChild(newLabel, input);
  }

  function commit() {
    const name = input.value.trim();
    window.api.renameSession(session.sessionId, name || null);
    session.sessionName = name || null;
    restore();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      done = true;
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      restore();
    }
  });
  input.addEventListener("blur", () => {
    if (!done) {
      done = true;
      commit();
    }
  });
}

function createSessionLabel(session) {
  const label = document.createElement("span");
  label.className = "label";

  if (session.worktreeName) {
    const wt = document.createElement("span");
    wt.className = "worktree";
    wt.textContent = `${session.worktreeName} · `;
    label.appendChild(wt);
  }

  const nameNode = document.createElement("span");
  nameNode.className = "name";
  nameNode.textContent = displayName(session);
  label.appendChild(nameNode);

  const statusNode = document.createElement("span");
  statusNode.className = "status-text";
  const short = shortMessage(session.message);
  const statusDisplay =
    session.status === "needs_input" && short
      ? short
      : statusLabel(session.status);
  statusNode.textContent = ` · ${statusDisplay}`;
  label.appendChild(statusNode);

  const tooltipParts = [];
  if (session.status === "needs_input" && session.message) {
    tooltipParts.push(session.message);
  }
  if (session.lastPrompt) tooltipParts.push(session.lastPrompt);
  tooltipParts.push(session.sessionId);
  label.title = tooltipParts.join("\n");

  return label;
}

function render(sessions) {
  const container = document.getElementById("sessions");
  container.innerHTML = "";

  if (sessions.length === 0 && !showArchived) {
    container.innerHTML =
      '<div class="empty">No active sessions.<br>Start Claude Code in any project.</div>';
    window.api.resizeWindow(1);
    return;
  }

  const groups = groupByRepo(sessions);
  let extraRows = 0;

  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "project-group";

    // --- group header ---
    const header = document.createElement("div");
    header.className = "group-header";

    const arrow = document.createElement("span");
    arrow.className = "group-arrow";
    arrow.textContent = collapsed.has(group.repoRoot) ? "▸" : "▾";

    const best = bestStatus(group.sessions);
    const dot = document.createElement("span");
    dot.className = "dot";
    header.classList.add(best);

    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.repoName;
    name.title = group.repoRoot;

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "archive-btn";
    archiveBtn.textContent = "↓";
    archiveBtn.title = `Archive ${group.repoName}`;
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.archiveRepo(group.repoRoot);
      refresh();
    });

    header.appendChild(arrow);
    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(archiveBtn);

    header.addEventListener("click", () => {
      if (collapsed.has(group.repoRoot)) {
        collapsed.delete(group.repoRoot);
      } else {
        collapsed.add(group.repoRoot);
      }
      render(sessions);
    });

    groupEl.appendChild(header);

    // --- session rows ---
    const sessionsEl = document.createElement("div");
    sessionsEl.className = `group-sessions${collapsed.has(group.repoRoot) ? " collapsed" : ""}`;

    for (const s of group.sessions) {
      const div = document.createElement("div");
      div.className = `session ${s.status}`;

      // Legacy sessions have pid === null — only wire the click for real pids.
      if (Number.isInteger(s.pid) && s.pid > 0) {
        div.classList.add("clickable");
        div.title = "Click to jump to this session's terminal";
        div.addEventListener("click", () => {
          window.api.focusSession(s.pid);
        });
      }

      const sdot = document.createElement("span");
      sdot.className = "dot";

      const label = createSessionLabel(s);
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(label, s);
      });

      const sessionArchiveBtn = document.createElement("button");
      sessionArchiveBtn.className = "session-archive-btn";
      sessionArchiveBtn.textContent = "↓";
      sessionArchiveBtn.title = "Archive session";
      sessionArchiveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await window.api.archiveSession(s.sessionId);
        refresh();
      });

      div.appendChild(sdot);
      div.appendChild(label);
      div.appendChild(sessionArchiveBtn);
      sessionsEl.appendChild(div);
    }

    groupEl.appendChild(sessionsEl);
    container.appendChild(groupEl);
  }

  // --- Archived section ---
  if (showArchived) {
    const { archivedRepos, archivedSessions } = cachedArchived;
    const totalArchived = archivedRepos.length + archivedSessions.length;

    if (totalArchived > 0) {
      const section = document.createElement("div");
      section.className = "archived-section";

      const sectionHeader = document.createElement("div");
      sectionHeader.className = "section-header";
      sectionHeader.textContent = "Archived";
      section.appendChild(sectionHeader);
      extraRows += 1;

      for (const r of archivedRepos) {
        const row = document.createElement("div");
        row.className = "archived-item";

        const name = document.createElement("span");
        name.className = "archived-name";
        name.textContent = r.repoName;
        name.title = r.repoRoot;

        const tag = document.createElement("span");
        tag.className = "archived-tag";
        tag.textContent = "repo";

        const restoreBtn = document.createElement("button");
        restoreBtn.className = "restore-btn";
        restoreBtn.textContent = "↩";
        restoreBtn.title = `Restore ${r.repoName}`;
        restoreBtn.addEventListener("click", async () => {
          await window.api.unarchiveRepo(r.repoRoot);
          refresh();
        });

        row.appendChild(name);
        row.appendChild(tag);
        row.appendChild(restoreBtn);
        section.appendChild(row);
        extraRows += 1;
      }

      for (const s of archivedSessions) {
        const row = document.createElement("div");
        row.className = "archived-item";

        const name = document.createElement("span");
        name.className = "archived-name";
        name.textContent = s.sessionName || s.aiTitle || s.sessionId.slice(0, 8);
        name.title = `${s.repoName} / ${s.sessionId}`;

        const tag = document.createElement("span");
        tag.className = "archived-tag";
        tag.textContent = s.repoName;

        const restoreBtn = document.createElement("button");
        restoreBtn.className = "restore-btn";
        restoreBtn.textContent = "↩";
        restoreBtn.title = "Restore session";
        restoreBtn.addEventListener("click", async () => {
          await window.api.unarchiveSession(s.sessionId);
          refresh();
        });

        row.appendChild(name);
        row.appendChild(tag);
        row.appendChild(restoreBtn);
        section.appendChild(row);
        extraRows += 1;
      }

      container.appendChild(section);
    }
  }

  resizeToContent(sessions, extraRows);
}

function updateFooter(sessions) {
  const footer = document.getElementById("footer");
  const total = sessions ? sessions.length : 0;
  const { archivedRepos, archivedSessions } = cachedArchived;
  const archivedCount = archivedRepos.length + archivedSessions.length;

  footer.innerHTML = "";

  const countSpan = document.createElement("span");
  countSpan.textContent = `${total} session${total === 1 ? "" : "s"}`;
  footer.appendChild(countSpan);

  if (archivedCount > 0) {
    footer.appendChild(document.createTextNode(" · "));

    const archivedLink = document.createElement("span");
    archivedLink.className = `footer-archived${showArchived ? " active" : ""}`;
    archivedLink.textContent = `${archivedCount} archived`;
    archivedLink.addEventListener("click", () => {
      showArchived = !showArchived;
      refresh();
    });
    footer.appendChild(archivedLink);
  }
}

async function refresh() {
  try {
    const [sessions, archived] = await Promise.all([
      window.api.scan(),
      window.api.getArchived(),
    ]);
    cachedArchived = archived;
    render(sessions);
    updateFooter(sessions);
  } catch (err) {
    document.getElementById("sessions").innerHTML =
      `<div class="empty">Error: ${err.message}</div>`;
  }
}

document.getElementById("help-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  window.api.openHelp();
});

window.api.onSessionsUpdated(() => refresh());
refresh();
