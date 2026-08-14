# Branch Diff Viewer

A local, read-only desktop app for reviewing the committed changes between two Git branches. It provides a pull-request-style file list, aggregate and per-file line counts, and unified text diffs without pushing code or creating a pull request.

The MVP targets macOS. It is built with Tauri 2, React, TypeScript, and Rust.

## What it does

- Opens a local Git working tree from any folder inside it.
- Opens a plain workspace folder and discovers Git repositories in its immediate child folders; the workspace root does not need Git.
- Loads workspace project metadata and comparisons only when each tab is first activated.
- Lists local branches and selects the checked-out branch for comparison.
- Suggests `main` or `master` as the base branch when available.
- Uses merge-base comparison semantics equivalent to `base...compare`.
- Shows changed paths in a collapsible folder tree with file statuses, additions, and deletions.
- Renders unified diffs with old and new line numbers.
- Wraps long diff lines by default, with a per-project toggle for horizontal scrolling.
- Handles added, modified, deleted, renamed, and binary files.
- Opens multiple repositories in tabs while preserving each project's comparison and selected file.
- Restores open project tabs and the active project after the app is relaunched.
- Keeps running when its macOS window is closed and restores the window from the Dock; **Quit** still exits.
- Remembers up to five recent repository paths on the local machine.

## Read-only boundary

The frontend can invoke only five Rust commands:

- `open_repository`
- `open_workspace`
- `open_workspace_project`
- `compare_branches`
- `load_file_diff`

The Rust layer invokes Git directly without a shell, disables optional locks, lazy fetching, external diffs, text-conversion helpers, and pathspec magic, and only runs allowlisted read operations. The app does not expose a generic command runner. It does not edit files, update the index, move refs, switch branches, or contact remotes.

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
  App.tsx            Application state and interface
  api.ts             Typed Tauri command boundary
  fileTree.ts        Changed-path tree construction
  types.ts           Shared frontend data contracts
src-tauri/src/
  lib.rs             Narrow Tauri command registration
  repository.rs      Read-only Git operations and diff parsing
  workspace.rs       Immediate-child repository discovery
PRD.md               Product requirements and acceptance criteria
WORKSPACE-DESIGN.md  Saved-workspace options and recommendation
```

## Current MVP limits

- Local branches only
- Committed changes only
- Unified diff view
- Independent file-tree and diff scrolling
- Manual refresh
- Text patches up to 5 MB per file
- Repository paths and Git filenames must be valid UTF-8
- No syntax highlighting
- Project tab paths, order, source, and active project are restored after restart; branch and file selections currently reset to repository defaults
- Workspace discovery scans immediate child folders only
- Symlinked workspace children are ignored so discovery stays inside the selected folder
- A workspace child must own its Git working tree; it cannot resolve to the workspace root or another repository
- No editing, staging, commits, comments, fetching, pushing, or pull requests
