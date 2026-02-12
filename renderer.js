
/** @type {Set<string>} collapsed project paths (in-memory only) */
const collapsed = new Set();

function resizeToContent(sessions) {
  const headerCount = new Set(sessions.map((s) => s.projectPath)).size;
  let visibleSessions = 0;
  for (const s of sessions) {
    if (!collapsed.has(s.projectPath)) visibleSessions++;
  }
  const rowCount = Math.max(headerCount + visibleSessions, 1);
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

  if (sessions.length === 0) {
    container.innerHTML =
      '<div class="empty">No tracked projects.<br><code>claudeboard add .</code></div>';
    window.api.resizeWindow(1);
    return;
  }

  const groups = groupByProject(sessions);

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

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "\u2212";
    removeBtn.title = `Stop tracking ${group.project}`;
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.removeProject(group.projectPath);
      refresh();
    });

    header.appendChild(arrow);
    header.appendChild(dot);
    header.appendChild(name);
    header.appendChild(removeBtn);

    header.addEventListener("click", () => {
      if (collapsed.has(group.projectPath)) {
        collapsed.delete(group.projectPath);
      } else {
        collapsed.add(group.projectPath);
      }
      render(sessions);
      resizeToContent(sessions);
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

      div.appendChild(dot);
      div.appendChild(label);
      sessionsEl.appendChild(div);
    }

    groupEl.appendChild(sessionsEl);
    container.appendChild(groupEl);
  }

  resizeToContent(sessions);
}

function updateFooter(sessions) {
  const total = sessions ? sessions.length : 0;
  document.getElementById("footer").textContent = `${total} sessions`;
}

async function refresh() {
  try {
    const sessions = await window.api.scan();
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

window.api.onSessionsUpdated(() => refresh());
refresh();
