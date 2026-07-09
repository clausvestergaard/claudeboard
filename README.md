# ClaudeBoard

Floating desktop monitor for [Claude Code](https://claude.ai/code) sessions. See at a glance which sessions need your input, which are working, and which have finished their turn — across every repo you have open.

## Features

- **Automatic session discovery** — every Claude Code session shows up on its own, no manual project tracking
- **Authoritative status** — driven by a Claude Code hook, so long tool calls and permission prompts are reported correctly (not guessed from file timestamps)
- **Repo grouping** — sessions grouped under their repo, with worktree sessions labelled by their branch dir
- **AI titles** — shows the session's auto-generated title, or a custom name you set
- **Collapsible groups** — collapse repos you're not watching
- **Jump to terminal** — click a session to bring its terminal to the foreground: exact tab in iTerm2/Terminal.app; app-level for Ghostty, WezTerm, kitty, and Alacritty (macOS)
- **Session renaming** — double-click a session to give it a meaningful name
- **Archiving** — archive noisy repos or individual sessions; unarchive from the footer
- **Notifications** — a native macOS notification fires when a session flips to _needs input_; click it to bring the window forward
- **Dock badge** — the dock icon badge shows how many sessions currently need your input
- **Always-on-top** — stays visible while you work
- **Auto-updating** — a file watcher on the state dir refreshes instantly

## How it works

ClaudeBoard reads one JSON file per session from `~/.claudeboard/state/` (override with the `CLAUDEBOARD_STATE_DIR` env var). Each file is written atomically by a Claude Code hook on every lifecycle event and looks like:

```json
{
  "sessionId": "e66aa4f2-...",
  "cwd": "/Users/you/work/project-wt-feature-x",
  "repoRoot": "/Users/you/work/project",
  "pid": 12345,
  "transcriptPath": "/Users/you/.claude/projects/.../<sessionId>.jsonl",
  "lastEvent": "PreToolUse",
  "status": "working",
  "message": "",
  "ts": 1720512345
}
```

- `cwd` may be a git **worktree**; `repoRoot` is always the main repo root (equal to `cwd` for non-git directories). Sessions are grouped by `repoRoot`.
- If a session's process is gone (`process.kill(pid, 0)` fails) but no end event fired (e.g. the terminal was killed), ClaudeBoard reports it as **ended**.
- Session titles (`aiTitle`, `lastPrompt`) are read from the tail of the transcript `.jsonl`.

### Required hook

The state files are produced by a Claude Code hook. Install it from the dotfiles repo (`~/personal/dotfiles/claude/hooks/`) and symlink into `~/.claude/` per the dotfiles convention. Without the hook, ClaudeBoard falls back to a legacy heuristic (see below) and can only distinguish **working** from **waiting**.

### Legacy fallback

For sessions started before the hook was installed, ClaudeBoard scans `~/.claude/projects/` for `*.jsonl` transcripts modified in the last 24h that have no state file, and assigns them **working** (modified <30s ago) or **waiting**. It cannot detect **needs input** for these.

## Status indicators

| Color | Status | Meaning |
|-------|--------|---------|
| Red (pulsing) | needs input | Waiting on you — e.g. a permission prompt |
| Amber (subtle pulse) | working | Thinking or running tools |
| Green (steady) | waiting | Turn finished, the ball is in your court |
| Grey (dimmed) | ended | Session closed, or its process is gone |

## Usage

- **Click** a repo header to collapse/expand.
- **Click** a session to jump to its terminal. In iTerm2/Terminal.app the exact window and tab hosting that Claude process is selected (matched by the process's controlling TTY). For terminals without a tab-scripting API — Ghostty, WezTerm, kitty, Alacritty — ClaudeBoard finds the owning app by walking the process's ancestor chain (hopping through zellij/tmux clients when a multiplexer is in between) and brings that app to the foreground; it can't select the exact tab. Terminals it can't identify (e.g. the VS Code integrated terminal) do nothing. The first time an iTerm2/Terminal.app jump runs, macOS shows a permission prompt asking to allow ClaudeBoard to control the terminal — approve it (System Settings → Privacy & Security → Automation) for the feature to work.
- **Double-click** a session to rename it (custom name > AI title > short session id).
- **↓** on a repo header archives the whole repo; **↓** on a session archives just that session.
- Archived counts appear in the footer — click to reveal and restore.
- **?** opens the help window.

Local config (archives + custom names) is stored in `~/.claudeboard.json`:

```json
{
  "archivedRepos": ["/path/to/repo-a"],
  "archivedSessions": ["session-uuid"],
  "sessionNames": { "session-uuid": "my custom name" }
}
```

(Older configs with `archivedProjects` are migrated to `archivedRepos` automatically on load.)

## Install

```bash
git clone https://github.com/youruser/claudeboard.git
cd claudeboard
npm install

# Build the macOS app
npm run package

# Copy to Applications
cp -R dist/mac-arm64/ClaudeBoard.app /Applications/
```

**Note:** When rebuilding, quit ClaudeBoard and delete the old `.app` before copying — `cp -R` over an existing `.app` bundle can leave stale files.

## Development

```bash
npm start
```

## Acknowledgements

The original approach of monitoring Claude Code's `.jsonl` session files was inspired by [claude-devtools](https://github.com/matt1398/claude-devtools).
