# Workspace View Design

## Current folder workspace

The app now supports opening a plain parent folder whose immediate child folders are Git repositories. The parent folder does not need Git and is not itself shown as a project. Each discovered repository becomes a tab, while repository metadata and comparisons load only when that tab is activated. Symlinked children are ignored to keep discovery inside the selected folder, and each child must resolve to a Git working tree rooted at that exact folder. Tab paths, order, origin, and the active project are restored after relaunch; richer saved workspace state remains a future feature.

## Recommendation

Treat a workspace as a saved, read-only collection of project sessions. The current project tabs are the first step: each tab owns its repository, branch comparison, selected file, collapsed folders, and in-memory diff cache.

The recommended next version adds a deep `WorkspaceTabs` module with a small interface:

- `open(path)` resolves a repository and activates or creates its tab.
- `activate(tabId)` and `close(tabId)` manage navigation.
- `dispatch(tabId, action)` changes a project's view state.
- `subscribe(listener)` publishes a single workspace snapshot to the interface.

The module should use two narrow adapters:

- `RepositoryReader`, backed by the existing read-only Tauri commands.
- `WorkspaceStore`, backed initially by local application storage.

Only user intent should be persisted: canonical repository paths, tab order, active tab, selected branches, selected file path, and collapsed folders. Diffs, commit identifiers, counts, and branch lists should be reloaded from Git. This keeps stale derived data out of storage and preserves the app's read-only boundary.

## Design 1: Minimal session module

**Module:** `WorkspaceTabs`

**Interface:** `open`, `activate`, `close`, `dispatch`, and `subscribe`

**Seam:** One session object per canonical repository path

**Adapter:** Existing Git reader only

**Depth:** High. A small interface hides tab identity, deduplication, request races, comparison caches, and close-selection rules.

**Tradeoff:** Lowest complexity, but no restore after restart and no named workspace view.

## Design 2: Persisted project tabs

**Module:** `useProjectTabs` or an equivalent framework-independent store

**Interface:** Optimized for opening a path, changing the active project, and updating one active project's view state

**Seam:** Persisted tab descriptors are separate from live Git-derived data

**Adapters:** `RepositoryReader` and a versioned local `WorkspaceStore`

**Leverage:** The same state supports tab navigation, restart restoration, and a basic project overview.

**Locality:** All restore, deduplication, migration, and stale-path handling remains in one module instead of leaking into screens.

**Tradeoff:** Moderate complexity and the best fit for the current product.

## Design 3: Full workspace model

**Module:** `Workspace`

**Interface:** Adds named workspaces, duplicate views of one repository, tab reorder, saved review modes, and preferences.

**Seam:** A versioned workspace document separates saved project identity from multiple live review sessions.

**Adapters:** Git reader, workspace file storage, and optional file-system change notifications

**Leverage:** Supports a dashboard, multiple comparison views per repository, import/export, and future workspace switching.

**Tradeoff:** Most flexible, but introduces schema migrations, recovery rules, and more product decisions before those features are needed.

## Suggested workspace interface

The first workspace screen should be an overview above the existing tabs, not a replacement for the diff viewer. It can show one card or row per saved repository:

- repository name and local path;
- selected base and compare branches;
- changed file, addition, and deletion totals;
- unavailable, stale, loading, or ready status; and
- an action to open or activate the project's review tab.

The app loads the active project first. Other project summaries can load with a small concurrency limit so a large workspace does not start many Git processes at once. Missing repositories remain visible with a recovery action to locate or remove the saved entry.

## Difficulty

The recommended persisted workspace is medium difficulty.

- Restoring the current tabs only: about 1 to 2 focused development days.
- Adding a polished overview with loading, unavailable-path recovery, and bounded background refresh: about 3 to 5 days.
- Adding named workspaces, import/export, duplicate repository views, and file watching: roughly 1 to 2 weeks.

The main engineering work is state restoration and stale-data handling, not the visual layout. No database or cloud backend is required.
