
/** @type {Set<string>} collapsed project paths (in-memory only) */
const collapsed = new Set();

/** @type {boolean} */
let showSuggestions = false;

/** @type {boolean} */
let showArchived = false;

/** @type {Array} cached suggestions */
let cachedSuggestions = [];

/** @type {{archivedProjects: Array, archivedSessions: Array}} */
let cachedArchived = { archivedProjects: [], archivedSessions: [] };

function resizeToContent(sessions, extraRows = 0) {
  const headerCount = new Set(sessions.map((s) => s.projectPath)).size;
  let visibleSessions = 0;
  for (const s of sessions) {
    if (!collapsed.has(s.projectPath)) visibleSessions++;
  }
  const rowCount = Math.max(headerCount + visibleSessions + extraRows, 1);
  window.api.resizeWindow(rowCount);
}

function groupByProject(sessions) {
  /** @type {Map<string, {project: string, projectPath: string, sessions: typeof sessions}>} */
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.projectPath)) {
      groups.set(s.projectPath, {
        project: s.project,
        projectPath: s.projectPath,
        sessions: [],
      });
    }
    groups.get(s.projectPath).sessions.push(s);
  }
  return [...groups.values()];
}

function startRename(labelEl, session) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = session.sessionName || "";
  input.placeholder = session.sessionId.slice(0, 8);

  const parent = labelEl.parentElement;
  parent.replaceChild(input, labelEl);
  input.focus();
  input.select();

  function commit() {
    const name = input.value.trim();
    window.api.renameSession(session.sessionId, name || null);
    session.sessionName = name || null;
    const newLabel = createSessionLabel(session);
    newLabel.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(newLabel, session);
    });
    parent.replaceChild(newLabel, input);
  }

  function cancel() {
    const newLabel = createSessionLabel(session);
    newLabel.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename(newLabel, session);
    });
    parent.replaceChild(newLabel, input);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", commit);
}

function createSessionLabel(session) {
  const label = document.createElement("span");
  label.className = "label";
  const displayName = session.sessionName || session.sessionId.slice(0, 8);
  label.textContent = `${displayName} · ${session.status}`;
  label.title = "Double-click to rename";
  return label;
}

function render(sessions) {
  const container = document.getElementById("sessions");
  container.innerHTML = "";

  if (sessions.length === 0 && !showSuggestions && !showArchived) {
    container.innerHTML =
      '<div class="empty">No tracked projects.<br><code>claudeboard add .</code></div>';
    window.api.resizeWindow(1);
    return;
  }

  const groups = groupByProject(sessions);
  let extraRows = 0;

  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "project-group";

    // --- group header ---
    const header = document.createElement("div");
    header.className = "group-header";

    const arrow = document.createElement("span");
    arrow.className = "group-arrow";
    arrow.textContent = collapsed.has(group.projectPath) ? "\u25b8" : "\u25be";

    const statusPriority = { working: 2, idle: 1, stopped: 0 };
    const bestStatus = group.sessions.reduce(
      (best, s) => (statusPriority[s.status] > statusPriority[best] ? s.status : best),
      "stopped",
    );
    const dot = document.createElement("span");
    dot.className = "dot";
    header.classList.add(bestStatus);

    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.project;

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "archive-btn";
    archiveBtn.textContent = "\u2193";
    archiveBtn.title = `Archive ${group.project}`;
    archiveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.archiveProject(group.projectPath);
      refresh();
    });

    header.appendChild(arrow);
    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(archiveBtn);

    header.addEventListener("click", () => {
      if (collapsed.has(group.projectPath)) {
        collapsed.delete(group.projectPath);
      } else {
        collapsed.add(group.projectPath);
      }
      render(sessions);
      resizeToContent(sessions, extraRows);
    });

    groupEl.appendChild(header);

    // --- session rows ---
    const sessionsEl = document.createElement("div");
    sessionsEl.className = `group-sessions${collapsed.has(group.projectPath) ? " collapsed" : ""}`;

    for (const s of group.sessions) {
      const div = document.createElement("div");
      div.className = `session ${s.status}`;

      const dot = document.createElement("span");
      dot.className = "dot";

      const label = createSessionLabel(s);
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(label, s);
      });

      const sessionArchiveBtn = document.createElement("button");
      sessionArchiveBtn.className = "session-archive-btn";
      sessionArchiveBtn.textContent = "\u2193";
      sessionArchiveBtn.title = "Archive session";
      sessionArchiveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await window.api.archiveSession(s.sessionId);
        refresh();
      });

      div.appendChild(dot);
      div.appendChild(label);
      div.appendChild(sessionArchiveBtn);
      sessionsEl.appendChild(div);
    }

    groupEl.appendChild(sessionsEl);
    container.appendChild(groupEl);
  }

  // --- Suggestions section ---
  if (showSuggestions && cachedSuggestions.length > 0) {
    const section = document.createElement("div");
    section.className = "suggestions-section";

    const sectionHeader = document.createElement("div");
    sectionHeader.className = "section-header";
    sectionHeader.textContent = "Suggestions";
    section.appendChild(sectionHeader);

    for (const s of cachedSuggestions) {
      const row = document.createElement("div");
      row.className = "suggestion-row";

      const name = document.createElement("span");
      name.className = "suggestion-name";
      name.textContent = s.projectName;
      name.title = s.projectPath;

      const addBtn = document.createElement("button");
      addBtn.className = "suggestion-add-btn";
      addBtn.textContent = "+";
      addBtn.title = `Track ${s.projectPath}`;
      addBtn.addEventListener("click", async () => {
        await window.api.addProjectPath(s.projectPath);
        refresh();
      });

      row.appendChild(name);
      row.appendChild(addBtn);
      section.appendChild(row);
    }

    container.appendChild(section);
    // +1 for header, +1 per suggestion
    extraRows += 1 + cachedSuggestions.length;
  }

  // --- Archived section ---
  if (showArchived) {
    const { archivedProjects, archivedSessions } = cachedArchived;
    const totalArchived = archivedProjects.length + archivedSessions.length;

    if (totalArchived > 0) {
      const section = document.createElement("div");
      section.className = "archived-section";

      const sectionHeader = document.createElement("div");
      sectionHeader.className = "section-header";
      sectionHeader.textContent = "Archived";
      section.appendChild(sectionHeader);
      extraRows += 1;

      for (const p of archivedProjects) {
        const row = document.createElement("div");
        row.className = "archived-item";

        const name = document.createElement("span");
        name.className = "archived-name";
        name.textContent = p.projectName;
        name.title = p.projectPath;

        const tag = document.createElement("span");
        tag.className = "archived-tag";
        tag.textContent = "project";

        const restoreBtn = document.createElement("button");
        restoreBtn.className = "restore-btn";
        restoreBtn.textContent = "\u21a9";
        restoreBtn.title = `Restore ${p.projectName}`;
        restoreBtn.addEventListener("click", async () => {
          await window.api.unarchiveProject(p.projectPath);
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
        const displayName = s.sessionName || s.sessionId.slice(0, 8);
        name.textContent = `${displayName}`;
        name.title = `${s.projectName} / ${s.sessionId}`;

        const tag = document.createElement("span");
        tag.className = "archived-tag";
        tag.textContent = s.projectName;

        const restoreBtn = document.createElement("button");
        restoreBtn.className = "restore-btn";
        restoreBtn.textContent = "\u21a9";
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
  const { archivedProjects, archivedSessions } = cachedArchived;
  const archivedCount = archivedProjects.length + archivedSessions.length;

  footer.innerHTML = "";

  const countSpan = document.createElement("span");
  countSpan.textContent = `${total} sessions`;
  footer.appendChild(countSpan);

  if (archivedCount > 0) {
    const sep = document.createTextNode(" \u00b7 ");
    footer.appendChild(sep);

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

    if (showSuggestions) {
      cachedSuggestions = await window.api.getSuggestions();
    }

    render(sessions);
    updateFooter(sessions);
  } catch (err) {
    document.getElementById("sessions").innerHTML =
      `<div class="empty">Error: ${err.message}</div>`;
  }
}

document.getElementById("add-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const added = await window.api.addProject();
  if (added) refresh();
});

document.getElementById("help-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  window.api.openHelp();
});

document.getElementById("suggest-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  showSuggestions = !showSuggestions;
  document.getElementById("suggest-btn").classList.toggle("active", showSuggestions);
  if (showSuggestions) {
    cachedSuggestions = await window.api.getSuggestions();
  }
  refresh();
});

window.api.onSessionsUpdated(() => refresh());
refresh();
