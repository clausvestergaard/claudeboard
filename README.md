# ClaudeBoard

Floating desktop monitor for [Claude Code](https://claude.ai/code) sessions. Track multiple projects, see which sessions are active, and rename them for easy identification.

## Features

- **Multi-project tracking** — add any number of project directories
- **Collapsible groups** — sessions grouped under project headers
- **Live status** — working (red pulse), idle (green), stopped (grey)
- **Session renaming** — double-click to give sessions meaningful names
- **Always-on-top** — stays visible while you work
- **Auto-updating** — file watchers detect session changes instantly

## Install

```bash
git clone https://github.com/youruser/claudeboard.git
cd claudeboard
npm install

# Make the CLI available globally
npm link

# Build the macOS app
npm run package

# Copy to Applications
cp -R dist/mac-arm64/ClaudeBoard.app /Applications/
```

**Note:** When rebuilding, quit ClaudeBoard and delete the old `.app` before copying — `cp -R` over an existing `.app` bundle can leave stale files.

## Usage

### CLI

```bash
# Add a project to track
node cli.js add /path/to/your/project

# List tracked projects
node cli.js list

# Remove a project
node cli.js remove /path/to/your/project
```

### App

- **+** button to add a project via folder picker
- **Click** a group header to collapse/expand
- **Double-click** a session label to rename it
- **−** button on a group header to stop tracking that project

## Status indicators

| Color | Status | Meaning |
|-------|--------|---------|
| Red (pulsing) | working | Session file modified in last 30s |
| Green | idle | Modified in last 5 minutes |
| Grey | stopped | Inactive for 5+ minutes |

## How it works

ClaudeBoard watches `.jsonl` session files in `~/.claude/projects/`. Each tracked project directory maps to a subfolder there. File modification times determine session status.

Configuration is stored in `~/.claudeboard.json`:

```json
{
  "projects": ["/path/to/project-a", "/path/to/project-b"],
  "sessionNames": {
    "session-uuid": "my custom name"
  }
}
```

## Development

```bash
npm start
```

## Acknowledgements

The approach of monitoring Claude Code's `.jsonl` session files was inspired by [claude-devtools](https://github.com/matt1398/claude-devtools).
