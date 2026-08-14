# Patchdeck

A local-first desktop app for reviewing committed changes between Git branches and operating the native Hermes Agent Kanban beside the code. It provides a pull-request-style file tree, line counts, unified diffs, task lanes, agent activity, runs, logs, and human-to-agent comments without automatically publishing code.

The MVP targets macOS. It is built with Tauri 2, React, TypeScript, and Rust.

## What it does

- Opens a local Git working tree from any folder inside it.
- Opens a plain workspace folder and discovers Git repositories in its immediate child folders; the workspace root does not need Git.
- Loads workspace project metadata and comparisons only when each tab is first activated.
- Lists local branches and selects the checked-out branch for comparison.
- Suggests `main` or `master` as the base branch when available.
- Uses merge-base comparison semantics equivalent to `base...compare`.
- Shows the commits unique to the compare branch, with their graph order, author, short ID, and relative time.
- Shows changed paths in a collapsible folder tree with file statuses, additions, and deletions.
- Renders unified diffs with old and new line numbers and IDE-style syntax coloring.
- Wraps long diff lines by default, with a per-project toggle for horizontal scrolling.
- Tracks which changed files have been viewed for the exact repository, merge base, and compare commit.
- Handles added, modified, deleted, renamed, and binary files.
- Opens multiple repositories in tabs while preserving each project's comparison and selected file.
- Restores open project tabs and the active project after the app is relaunched.
- Keeps running when its macOS window is closed and restores the window from the Dock; **Quit** still exits.
- Remembers up to five recent repository paths on the local machine.
- Discovers a running local Hermes dashboard on its standard ports, starts a managed `hermes serve` process, or attaches to another loopback server with a session token.
- Shows Hermes connection health and active worker count in the top-right.
- Operates as a review-only branch viewer while Hermes is disconnected; Agent Board, task feedback, and editing controls appear only for an attached agent session.
- Renders Hermes' canonical Kanban lanes, boards, profiles, cards, Markdown task content, task details, comments, events, runs, and bounded worker logs.
- Creates tasks from each eligible lane with Hermes' native routing, priority, skills, workspace, parent, and goal-mode fields.
- Exposes workflow-safe task transitions, parent and child links, child results, attachments, home-channel notifications, and human comments.
- Links a Hermes task to the Review surface, stores file/line comments locally, and sends structured feedback back to that task.
- Opens and activates the repository named by a Hermes task when **Review code** points outside the currently selected project.
- Opens checked-out working-tree files in a guarded editor with path containment, symlink-escape checks, optimistic concurrency, and atomic saves.
- Keeps the selected Review or Agent Board surface across relaunches.

## Safety boundaries

Git inspection remains read-only. Its Rust commands invoke Git directly without a shell, disable optional locks, lazy fetching, external diffs, text-conversion helpers, and pathspec magic, and use only allowlisted read operations. A separate editor command can replace an explicitly selected working-tree file, but it cannot update the index, move refs, switch branches, or contact Git remotes.

Hermes is isolated behind a separate Rust-owned adapter:

- managed mode binds only to `127.0.0.1`, generates a session token in memory, and stops only the child process this app owns;
- attach mode accepts only loopback HTTP origins and never terminates the attached process;
- React receives normalized data, not the session credential;
- there is no generic command runner or arbitrary HTTP proxy exposed to the frontend;
- the app consumes Hermes' REST API and never reads or writes its Kanban SQLite files directly;
- task creation, state changes, and comments are explicit user actions;
- no Git commit, push, pull request, or remote publication happens automatically.

## Theming

Every color, font, and size comes from the design tokens in `src/theme.css`; component styles in `src/App.css` reference tokens only. The default scheme follows macOS dark-mode conventions: neutral gray surfaces, the system blue accent, Apple's semantic colors, and Xcode-style syntax highlighting. The window uses a macOS overlay title bar, with the app header acting as the draggable titlebar.

To add a color scheme, add a `:root[data-theme="name"]` override block in `theme.css` and set `document.documentElement.dataset.theme`. Diff colors and syntax highlighting (`src/prismTheme.ts` reads the `--syntax-*` tokens) follow automatically. A `purple` scheme ships as a working example.

## Requirements

- macOS
- Node.js 20 or newer
- Rust stable
- Git available on `PATH`
- Tauri's macOS prerequisites, including Xcode Command Line Tools

## Development

```bash
npm install
npm run tauri dev
```

Run `npm run dev` for frontend-only interface work. The repository picker and Git operations require the Tauri desktop process and are unavailable in a normal browser tab.

## Verification

```bash
npm test
npm run build
cd src-tauri && cargo test
```

Build a macOS application bundle with `npm run tauri build`.

The Rust integration test creates a temporary Git repository, compares a feature branch against `main`, verifies the file and line totals, loads a file diff, and asserts that repository state is unchanged before and after the read flow.

## Project structure

```text
src/
  App.tsx            Top-level state, project tabs, and surface routing
  components/        Welcome screen, header, file tree, diff view, project pane, shared UI
  theme.css          Design tokens and color schemes (single source of truth for colors and type)
  prismTheme.ts      Syntax-highlighting colors bound to the theme tokens
  api.ts             Typed Tauri command boundary
  session.ts         Tab, recent-repository, and surface persistence
  fileTree.ts        Changed-path tree construction
  types.ts           Shared frontend data contracts
  editor/            Guarded working-tree editor
  hermes/            Hermes connection, board, task drawer, and tests
  review/            Local task links and inline review anchors
src-tauri/src/
  editor.rs          Contained, hash-checked, atomic file writes
  lib.rs             Narrow Tauri command registration
  hermes.rs          Loopback-only managed/attached Hermes adapter
  repository.rs      Read-only Git operations and diff parsing
  workspace.rs       Immediate-child repository discovery
PRD.md               Product requirements and acceptance criteria
WORKSPACE-DESIGN.md  Saved-workspace options and recommendation
HERMES-WORKBENCH-PRD.md  Product boundary and delivery phases
docs/hermes-agent-integration-research.md  Source-backed upstream research
```

## Current MVP limits

- Local branches only
- Committed changes only
- Unified diff view
- Independent file-tree and diff scrolling
- Manual refresh
- Text patches up to 5 MB per file
- Repository paths and Git filenames must be valid UTF-8
- Project tab paths, order, source, and active project are restored after restart; branch and file selections currently reset to repository defaults
- Workspace discovery scans immediate child folders only
- Symlinked workspace children are ignored so discovery stays inside the selected folder
- A workspace child must own its Git working tree; it cannot resolve to the workspace root or another repository
- The editor operates on the checked-out working tree only and is available when the compare branch is currently checked out; saved edits are uncommitted
- Inline comments, the review target, and viewed-file progress persist to an app-owned JSON store in Application Support (with a localStorage mirror and automatic migration); the store assumes a single running app instance, so two copies of the app running at once can overwrite each other's review state
- Viewed-file progress also uses local browser storage and is keyed to the exact comparison, so a new head commit starts a fresh review state
- Hermes activity streams over the upstream board event WebSocket (Rust-owned, loopback, token never exposed to the frontend); polling remains as an automatic fallback and safety net when the socket is unavailable
- No staging, commits, fetching, pushing, GitHub authentication, or pull requests
- Hermes connections are loopback-only and attached session tokens are not persisted
