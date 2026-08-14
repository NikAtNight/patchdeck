# Product Requirements Document: Branch Diff Viewer

**Status:** Implemented MVP  
**Product type:** Local, read-only developer tool  
**Primary platform:** macOS

## 1. Product summary

Branch Diff Viewer lets a developer review the committed changes on one local Git branch against another before opening a pull request.

The experience follows the core model of GitHub's **Files changed** view without requiring a remote repository or pull request. A user opens a local Git repository, selects a base branch and compare branch, and sees:

- the total changed files, additions, and deletions;
- the path, status, additions, and deletions for every affected file; and
- a readable, line-by-line unified diff for a selected file.

The application is strictly read-only. It must not edit files, stage changes, create commits, switch branches, modify Git data, or contact remotes.

## 2. Problem

Developers often want to review a local feature branch before pushing it. Command-line Git can provide this information, but it is less convenient for scanning many paths and navigating large diffs. GitHub provides a strong visual review experience only after changes have been pushed.

The product should answer four questions locally:

- Which files did this branch change?
- How many lines were added or removed?
- What changed inside each file?
- How does this branch compare with a different base branch?

## 3. Goal

Enable a developer to understand the complete committed delta between two local branches in under a minute, without changing the repository or sending its contents anywhere.

### Success statement

A user can open a repository, choose the intended base branch, and confidently review every file changed by the compare branch through a familiar pull-request-style interface.

## 4. Target user

The primary user is a developer who:

- works in a local Git repository;
- develops on feature branches;
- wants to review a branch before pushing or opening a pull request; and
- prefers a visual diff over terminal output.

The MVP is a single-user desktop tool. It is not a collaboration or code-hosting product.

## 5. Core user story

> As a developer working on a local feature branch, I want to compare it with another local branch so that I can see every changed file and review the exact additions and deletions before I push or open a pull request.

## 6. MVP requirements

### 6.1 Open a repository

- The user can select a folder on their machine.
- The folder may be the repository root or a folder inside a Git working tree.
- The app resolves and displays the repository root and name.
- The app shows an actionable error if the folder is not a readable Git working tree.
- The app remembers up to five recently opened repository paths locally.

### 6.2 Open a workspace folder

- The user can select a plain parent folder as a workspace.
- The workspace root does not need to be a Git repository.
- The app discovers Git repositories only in the workspace's immediate child folders.
- Each discovered repository opens as an independent project tab.
- The workspace root is never treated as a project, even if it happens to contain Git metadata.
- Child folders without their own Git repository are ignored.
- Symlinked child folders are ignored so discovery cannot leave the selected workspace.
- Each child must own the Git working tree rooted at that exact folder; resolving to the workspace root or another repository is rejected.
- A detected project that cannot be opened shows an error in its own tab and does not block valid siblings.
- Selecting a workspace with no direct child repositories produces a clear error.
- Only the active project loads repository metadata and its comparison initially; inactive projects load when first selected.

### 6.3 Select branches

- The app lists all local branches.
- The current checked-out branch is the default compare branch.
- The app suggests `main`, then `master`, as the base when available.
- The user can choose any local branch as the base or compare branch.
- The selectors are visibly labeled **Base** and **Compare**.
- Changing either selection recomputes the comparison.

### 6.4 Use pull-request comparison semantics

- The app compares the branches using the equivalent of Git's three-dot comparison: `base...compare`.
- It resolves the merge base and compares that commit with the compare branch tip.
- All data for one load uses resolved commit identifiers so totals and diffs come from one consistent snapshot.
- If the branches have no common ancestor, the app explains the problem and does not show a misleading diff.

### 6.5 Show comparison totals

- Display the selected base and compare branches.
- Display the number of changed files.
- Display total added lines.
- Display total deleted lines.
- Derive all totals from the same comparison used for the file list.
- Distinguish a valid zero-change result from a loading or error state.

### 6.6 Show changed files

- Group every changed file into a collapsible tree that mirrors its repository-relative folder structure.
- Show folders before files and sort each group naturally.
- Display the filename and parent path.
- Display added, modified, deleted, renamed, type-changed, or unknown status with text or a symbol, not color alone.
- Display per-file additions and deletions when available.
- Identify binary files.
- Display both old and new paths for renamed files.
- Selecting a file opens its diff.
- The list remains navigable with hundreds of files.

### 6.7 Open multiple projects

- The user can open more than one repository in the same application window.
- Each repository appears as a closable project tab.
- Selecting a project that is already open activates its existing tab instead of creating a duplicate.
- Switching tabs preserves each project's branch selection, selected file, loaded comparison, and folder state for the current app session.
- Open tab paths, tab order, repository-versus-workspace origin, and the active project are restored after relaunch.
- Restored projects reload current Git-derived metadata instead of persisting stale comparisons or diffs.
- Closing a tab does not change the repository on disk.

### 6.8 Show file diffs

- Render a unified line-by-line diff for text files.
- Distinguish additions, deletions, context, and metadata.
- Show old and new line numbers where applicable.
- Display the file path, status, and line totals above the diff.
- Wrap long lines to the available width by default.
- Provide a visible control to disable wrapping when preserving the original line shape is more useful.
- Reset the diff viewport when the selected file or comparison snapshot changes.
- Added files display added content.
- Deleted files display removed content.
- Renamed files show the previous path.
- Binary files show a placeholder instead of text.
- Text patches larger than 5 MB show a clear large-diff fallback.

### 6.9 Refresh safely

- The user can manually refresh.
- Refresh re-reads branch refs and recomputes the summary, file list, and selected diff.
- If a selected branch no longer exists, the app shows an error and lets the user choose another branch.

### 6.10 Enforce read-only behavior

- Do not modify working-tree files.
- Do not stage or unstage files.
- Do not create, amend, or delete commits.
- Do not create, rename, delete, switch, merge, or rebase branches.
- Do not fetch, pull, push, or contact a remote.
- Do not write into `.git`.
- Do not expose a generic shell command interface to the frontend.
- Invoke Git without a shell and disable optional Git locks.

### 6.11 Follow macOS window lifecycle

- Closing the main window hides it while the application remains running.
- Clicking the application in the Dock shows and focuses the existing window with its in-memory state intact.
- Choosing **Quit** exits the application normally.

## 7. Out of scope

- Working-tree, staged, unstaged, or untracked changes
- Editing or inline code changes
- Staging and committing
- Pull request creation or merging
- Comments, approvals, review threads, and collaboration
- User accounts or authentication
- Remote repository hosting or synchronization
- Fetching remote branches
- Conflict resolution
- Branch creation, checkout, merge, rebase, or deletion
- Comparing arbitrary commits or tags
- Commit history
- Semantic diffs and syntax highlighting
- Side-by-side diff mode

Working-tree changes may become a distinct future mode, but they must not be mixed into a branch comparison without clear labeling.

## 8. Primary flow

1. The user launches the app.
2. The user opens a local repository, opens a workspace folder, or chooses a recent repository.
3. If a workspace was selected, each immediate child Git repository becomes a project tab.
4. The app selects the checked-out branch as compare.
5. The app suggests a base branch.
6. The app resolves both branch tips and their merge base.
7. The user sees aggregate file and line counts.
8. The user scans the changed-file list.
9. The user selects files and reviews their diffs.
10. After committing elsewhere, the user refreshes the comparison.

## 9. Interface structure

The MVP uses three regions:

1. **Comparison header**
   - repository identity and path;
   - base and compare selectors;
   - file, addition, and deletion totals;
   - refresh action; and
   - persistent read-only indicator.

2. **Changed-file sidebar**
   - collapsible repository-relative folder tree;
   - status indicators; and
   - per-file line counts;
   - an independent vertical scroll region.

3. **Diff viewer**
   - selected-file identity and status;
   - a line-wrapping toggle;
   - unified diff hunks;
   - old and new line numbers; and
   - binary, empty, loading, error, and large-file states;
   - an independent vertical scroll region, with horizontal scrolling only when wrapping is disabled.

The changed-files header and selected-file header use the same height so their content boundary remains aligned.

A project tab strip sits above these regions. Every tab owns one independent comparison session.

## 10. Required states

- No repository selected
- Recent repositories available
- Invalid or unreadable folder
- No local branches
- Same base and compare branch
- Loading repository
- Loading comparison
- Valid comparison with no changes
- Valid comparison with changes
- Branches with no common ancestor
- Selected branch removed after load
- Text file
- Binary file
- Renamed file
- Large diff
- Repository no longer available
- Git unavailable on `PATH`
- Multiple open project tabs
- Active project closed
- Already-open repository selected again
- Workspace root without Git metadata
- Workspace with multiple direct child repositories
- Workspace with no direct child repositories

Errors should explain what happened and offer a safe recovery action. Recovery must never mutate the repository.

## 11. Acceptance criteria

### AC1: Open repository

**Given** a valid local Git working tree  
**When** the user selects it  
**Then** the app shows its resolved root, local branches, and current branch.

### AC2: Reject invalid folder

**Given** a folder that is not part of a Git working tree  
**When** the app loads it  
**Then** the app shows an actionable error and does not alter the folder.

### AC3: Compare branches

**Given** two local branches with shared history  
**When** the user selects base and compare  
**Then** the app displays changes from their merge base through the compare tip.

### AC4: Accurate totals

**Given** a branch comparison containing text changes  
**When** the comparison loads  
**Then** file, addition, and deletion totals match Git for the same merge-base comparison.

### AC5: Every changed path

**Given** added, modified, deleted, and renamed files  
**When** the file list loads  
**Then** every changed path appears with the correct status and available line counts.

### AC6: Text diff

**Given** a changed text file  
**When** the user selects it  
**Then** additions, deletions, and context appear with old and new line numbers.

### AC7: Binary file

**Given** a changed binary file  
**When** the user selects it  
**Then** the app identifies it as binary and does not render it as text.

### AC8: Zero changes

**Given** no changes under the defined comparison  
**When** the result loads  
**Then** the app shows zero changed files and a clear empty state.

### AC9: Refresh

**Given** a new commit was added outside the app  
**When** the user refreshes  
**Then** totals, paths, and diffs update to include it.

### AC10: Preserve repository state

**Given** any supported flow  
**When** the app opens, compares, navigates, and refreshes  
**Then** the working tree, index, refs, configuration, and object database remain unchanged.

### AC11: Open a non-Git workspace

**Given** a parent folder without Git metadata whose immediate child folders are Git repositories  
**When** the user opens it as a workspace  
**Then** each child repository opens as a project tab and the parent folder is not treated as a repository.

**And** each project is accepted only when its resolved Git working tree is rooted at that exact child folder.

### AC12: Restore the project session

**Given** one or more open project tabs with an active project  
**When** the user quits and relaunches the app  
**Then** the app restores the tabs and active project instead of showing the landing screen.

### AC13: Close without quitting

**Given** the main application window is visible on macOS  
**When** the user closes the window  
**Then** the application remains running and reopens the same window from its Dock icon.

## 12. Non-functional requirements

### Performance

- A comparison of up to 500 changed files should begin displaying useful results within 2 seconds on a modern developer Mac.
- Selecting and scrolling files should remain responsive.
- Diff calculation must not freeze the interface.
- Load file patches on demand and cache them for the resolved comparison snapshot.

### Privacy and security

- Repository contents and metadata stay on the machine.
- The MVP makes no network requests for repository operations.
- No filenames, branch names, paths, diffs, or usage data are transmitted.
- Path parsing supports spaces, Unicode, and unusual valid Git path characters.
- Git arguments are passed without shell interpolation.
- External diff helpers, text-conversion commands, pathspec magic, and lazy remote fetching are disabled.
- Git paths that cannot be represented safely as UTF-8 fail explicitly instead of being altered or omitted.

### Reliability

- The same resolved commits produce the same results.
- One malformed file must not be silently omitted from totals.
- Branch movement during loading must not combine data from different snapshots.
- Missing Git, invalid repositories, and unrelated histories produce explicit errors.

### Accessibility

- Color is not the only status indicator.
- Primary actions and branch selectors are keyboard accessible.
- Added and deleted lines have visible symbols.
- Long paths preserve the distinguishing filename and expose the full path as a tooltip.
- Reduced-motion system preferences are respected.

## 13. Data model

The app uses transient, derived data:

- repository path and name;
- local branch names and commit identifiers;
- selected base and compare branches;
- merge-base commit identifier;
- changed paths and statuses;
- per-file and aggregate line counts; and
- parsed diff hunks and lines.

Recent repository paths and a versioned project-session descriptor are persisted in local application storage. The session descriptor contains only tab names, canonical paths, tab order, repository-versus-workspace origin, and the active path. Branch metadata, commit identifiers, comparisons, file selections, collapsed folders, and diff contents remain transient and are reloaded from Git.

## 14. Test strategy

Automated and fixture testing should cover:

- a simple feature branch ahead of `main`;
- base and compare branches that both advanced;
- added, modified, deleted, and renamed files;
- binary files;
- empty files and files without trailing newlines;
- spaces and Unicode in paths;
- no changes;
- unrelated histories;
- hundreds of changed files;
- a text patch larger than 5 MB; and
- a branch that moves during loading.

Reference results against direct Git output. Capture repository state before and after supported flows and assert that the working tree, index, refs, configuration, and object database are unchanged.

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Comparison direction is misunderstood | Incorrect review conclusion | Label base and compare and document merge-base behavior |
| Large diffs reduce responsiveness | App becomes difficult to use | Load patches on demand, cache them, and enforce a 5 MB display limit |
| Binary data is treated as text | Broken display | Use Git classification and show a binary placeholder |
| Branch changes during loading | Totals and patches disagree | Resolve immutable commit IDs at load start |
| A Git operation mutates state | Violates the core promise | Allowlist read commands, set `GIT_OPTIONAL_LOCKS=0`, and assert state invariance in tests |
| Rename parsing is inconsistent | Incorrect paths or totals | Use the same rename-detection option and NUL-delimited parsing for status and counts |

## 16. Success measures

- At least 90% of test users reach the intended comparison without help.
- At least 90% correctly identify the changed-file count and locate a requested file.
- Fixture totals match Git reference output.
- No supported test flow modifies repository state.
- A user can review a representative 20-file branch without the command line.

The MVP has no telemetry. Any future telemetry must be opt-in and may not collect repository contents, branch names, filenames, or paths.

## 17. Release criteria

- All functional acceptance criteria pass on macOS.
- Comparison results match Git fixtures.
- The app remains responsive on the 500-file target.
- Automated tests demonstrate read-only behavior.
- Loading, error, binary, large-diff, and empty states are implemented.
- Keyboard access and non-color indicators are verified.
- Git requirements, comparison semantics, and known limits are documented.
- A distributable macOS application bundle builds successfully.

## 18. Resolved implementation decisions

1. The first release targets macOS.
2. The app uses Tauri 2, React, TypeScript, Vite, and Rust.
3. The installed Git CLI is the comparison engine.
4. Text patches larger than 5 MB use a large-diff fallback.
5. Manual refresh is sufficient for the MVP.
6. `main` or `master` is suggested as the base branch when available.
7. The app does not use a database, backend server, cloud service, or authentication.
8. Changed paths use a collapsible folder tree.
9. Multiple repositories can be open in session-scoped project tabs.
10. Open project tabs and the active project are restored after relaunch.
11. Closing the macOS window keeps the application running until the user explicitly quits.

## 19. Future considerations

- Separate staged, unstaged, and untracked views
- Side-by-side diffs
- Compare commits and tags
- Optional remote-tracking branches and fetching
- Syntax highlighting
- Whitespace options
- File search and filters
- Commit list for the comparison
- Image previews
- Export or copy a patch
- Named workspaces that restore a set of project tabs and their view state

Any future write capability is a separate product direction and must not weaken the viewer's read-only guarantees.
