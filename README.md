# Patchdeck

A local-first desktop app for reviewing Git branch and live working-tree changes, with agent work beside the code. It provides a pull-request-style file tree, line counts, unified diffs, a persistent local Kanban, Codex and Claude Code conversations, and optional Hermes boards without automatically publishing code.

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
- Reviews committed, staged, unstaged, and nonignored new files in Working tree mode, with live refresh and a pause control.
- Keeps Viewed marks for unchanged file content across commits and flags files changed since the last review.
- Handles added, modified, deleted, renamed, and binary files.
- Opens multiple repositories in tabs while preserving each project's comparison and selected file.
- Restores open project tabs and the active project after the app is relaunched.
- Keeps running when its macOS window is closed and restores the window from the Dock; **Quit** still exits.
- Remembers up to five recent repository paths on the local machine.
- Discovers a running local Hermes dashboard on its standard ports, starts a managed `hermes serve` process, or attaches to another loopback server with a session token.
- Shows Hermes connection health and active worker count in the top-right.
- Keeps a repository-scoped local Kanban available when Hermes is disconnected, with To do, In progress, Review, and Done lanes.
- Routes local cards through reusable Codex or Claude Code execution profiles and streams normalized agent messages and activity back into the card drawer.
- Binds local cards to isolated worktrees or explicitly attached existing work, and blocks simultaneous writable runs in the same worktree.
- Opens a local card's changes for review and sends inline feedback to its existing agent conversation. Successful turns move the card to Review; Done stays manual.
- Separates each new card's destination from its executor: Patchdeck can own it locally, or Hermes can own it on a named board with a Hermes profile or dispatcher assignment.
- Navigates the Local Board, every named Hermes board, a repository-scoped projection, and a federated All Work projection without copying source records.
- Sends a local card to Hermes only through an explicit handoff that preserves the local card and its conversation.
- Opens a global Settings panel for coding-agent connections, Hermes orchestration, execution profiles, safety boundaries, and build information.
- Renders Hermes' canonical Kanban lanes, boards, profiles, cards, Markdown task content, task details, comments, events, runs, and bounded worker logs.
- Creates tasks from each eligible lane with Hermes' native routing, priority, skills, workspace, parent, and goal-mode fields.
- Exposes workflow-safe task transitions, parent and child links, child results, attachments, home-channel notifications, and human comments.
- Links a Hermes task to the Review surface, stores file/line comments locally, and sends structured feedback back to that task.
- Opens and activates the repository named by a Hermes task when **Review code** points outside the currently selected project.
- Opens checked-out working-tree files in a guarded editor with path containment, symlink-escape checks, optimistic concurrency, and atomic saves.
- Keeps the selected Review or Agent Board surface across relaunches.

## Safety boundaries

Git inspection remains read-only. Its Rust commands invoke Git directly without a shell, disable optional locks, lazy fetching, external diffs, text-conversion helpers, and pathspec magic, and use only allowlisted read operations. A separate editor command can replace an explicitly selected working-tree file, but it cannot update the index, move refs, switch branches, or contact Git remotes.

Workspace creation is a separate write command. It creates a local branch and worktree under the app data directory, or attaches an existing worktree explicitly. Checkout disables Git hooks and configured content filters. Existing uncommitted changes are not copied; generated worktrees remain on disk until you remove them with Git.

Hermes is isolated behind a separate Rust-owned adapter:

- managed mode binds only to `127.0.0.1`, generates a session token in memory, and stops only the child process this app owns;
- attach mode accepts only loopback HTTP origins and never terminates the attached process;
- React receives normalized data, not the session credential;
- there is no generic command runner or arbitrary HTTP proxy exposed to the frontend;
- the app consumes Hermes' REST API and never reads or writes its Kanban SQLite files directly;
- task creation, state changes, and comments are explicit user actions;
- no Git commit, push, pull request, or remote publication happens automatically.

Local agent runs are launched by a narrow Rust runtime adapter. Codex uses App Server's structured stdio protocol; Claude Code uses its noninteractive streaming JSON interface. Both inherit their CLI's existing sign-in, are fixed to the run's recorded worktree, use the execution profile's read-only or workspace-write policy, and never commit or publish automatically. Credentials and raw provider protocol events are not exposed to React.

The [agent review loop](docs/flows/agent-review-loop.md) records the implementation, checks, and current limits.

## Theming

Colors and typography come from the design tokens in `src/theme.css`. Settings → Appearance offers System, Light, and Dark. System follows the Mac's appearance changes; an explicit choice persists in this app's local storage. Syntax and diff colors follow the selected appearance. The window keeps its native macOS controls, with a persistent draggable toolbar above the scrolling content.

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
npm run local
```

`npm run local` runs **Patchdeck Local** with Vite live updates and Tauri's Rust rebuild watcher. It uses `com.local.patchdeck.dev`, a separate app data directory, and its own Cargo target directory at `src-tauri/target/local`. The production application can keep running alongside it. Local builds never check for or install production updates.

Install a Finder launcher once:

```bash
npm run local:install
open "/Applications/Patchdeck Local.app"
```

The launcher starts the same live development session without a Terminal window. Opening it again brings an existing Local window forward. It points to this checkout, so reinstall the launcher if the checkout or Node executable moves. Existing launchers are backed up before replacement. Startup and rebuild output goes to `~/Library/Logs/Patchdeck Local/development.log`. The first launch compiles the Rust dependencies and takes longer than later launches.

The native development process runs from `src-tauri/target/local/Patchdeck Local.app`, with its own Dock name and bundle identity. Use the launcher in `/Applications` to start it so the development server also starts. Quit Patchdeck Local to stop that session; closing its window keeps it available in the Dock. For a terminal session, Ctrl+C stops the development process and server. A duplicate session is refused. After a crash, if startup reports a stale `src-tauri/target/local/session.json` lock, check that no Local development session is running before removing that generated file and retrying.

Local and production keep separate app state, but opening the same repository points both apps at the same working tree. File saves and explicitly started agent work still affect that repository.

Run `npm run dev` for frontend-only interface work. The repository picker and Git operations require the Tauri desktop process and are unavailable in a normal browser tab.

Build a standalone development snapshot with:

```bash
npm run tauri:build:dev
```

This produces **Patchdeck Local.app** in the build output. It embeds a frontend snapshot and does not live reload. It shares the live app's development identity, so run only one Local instance at a time. Keep the Finder launcher in `/Applications` for live testing.

See [the desktop workflow record](docs/flows/local-app-and-desktop-ui.md) for implementation boundaries and verification.

## Verification

```bash
npm test
npm run build
cd src-tauri && cargo test
```

Build the production-named macOS application bundle with `npm run tauri build`.

## Releases and updates

Patchdeck checks the latest public GitHub release when it starts. When a newer signed version is available, an in-app card lets the user download it, install it, and restart. A failed background check stays silent so offline work is not interrupted; an installation failure remains visible and can be retried.

To publish a release:

1. Update the matching version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit and push the release changes.
3. Push a matching tag such as `v0.5.0`.

The `Release Patchdeck` GitHub Actions workflow builds a universal notarized macOS app and DMG, creates the GitHub release, and uploads `latest.json` plus the signed updater archive. It requires the repository secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The updater private key lives outside the repository at `~/.tauri/patchdeck-updater.key`; its password is stored in macOS Keychain under `com.patchdeck.updater-signing`. Keep both backed up. Losing that key prevents installed copies from trusting future releases.

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
  localBoard/        Local cards/runs plus local, repository, and federated board projections
  providers/         Agent-runtime contracts and reusable execution profiles
  settings/          Provider, orchestrator, profile, safety, and build settings
  review/            Local task links and inline review anchors
src-tauri/src/
  editor.rs          Contained, hash-checked, atomic file writes
  lib.rs             Narrow Tauri command registration
  hermes.rs          Loopback-only managed/attached Hermes adapter
  agent_runtime.rs   Codex and Claude Code lifecycle, protocol normalization, and cleanup
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
- Provider sign-in is owned by each CLI. If Codex or Claude Code is logged out, Settings gives the supported Terminal command; embedded browser/device authorization is not implemented yet.
