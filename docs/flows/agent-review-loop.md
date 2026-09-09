# Agent review loop

## Requirement source and owner

Requested on 2026-09-09 after merging the existing desktop work into main: show live working-tree changes against main, review and send feedback from local cards, bind writable tasks to isolated worktrees, clarify board lifecycle, and preserve review progress across revisions. Primary agent owns integration and this record. Starting base: `31bf81d`, merged PR #1. Work branch: `feature/agent-review-loop`.

## Intended behavior and acceptance examples

- Working tree mode includes committed, staged, unstaged, and nonignored new files against the merge-base with the selected base branch. Live updates preserve the selected path and scroll position; inactive views do not poll. Branch mode remains available.
- A local card opens its bound worktree review. Inline feedback resumes that card's existing provider session, without routing through Hermes. Failed dispatch leaves feedback unsent and retryable.
- A new writable task creates a separate branch/worktree or explicitly attaches existing work. The source checkout stays untouched. Two writable runs cannot use the same worktree simultaneously. Existing cards and histories migrate without data loss.
- Runs expose active, awaiting-review, failed, and stopped outcomes. Successful turns move to Review; Done remains an explicit user choice. Unreported checks are never shown as passed.
- Viewed state follows file content within the same branch/base review context. An unrelated commit preserves it; changes to a reviewed file clear Viewed and show that it changed again.

## Implementation and verification plan

Git comparison owner: `live_git_review`, repository.rs. Workspace owner: `isolated_workspaces`, card_workspaces.rs and agent_runtime.rs. Board owner: `board_review_flow`, localBoard modules and workspace frontend API. Primary owns command wiring, review components, review persistence, integration tests, docs, and final review.

Use real temporary Git repositories for working-tree enumeration, binary/deleted/renamed/new files, fingerprints, worktree creation/attachment, and concurrent-writer guards. Frontend tests cover live polling and stale responses, card review routing, feedback success/failure, migration, lane transitions, and review fingerprints. Run focused tests first, then the full frontend suite, build, and Rust suite. Inspect the assembled interface in the native Local app and browser fixtures. Provider execution and live Hermes integration require explicit test fixtures or a user-authorized real task; do not infer success from mocks.

## Observed path and failure handling

- `src/components/ProjectPane.tsx` selects branch or working-tree comparison through `src/api.ts` and `src-tauri/src/lib.rs`. `repository::compare_working_tree` compares current files against the merge-base, including untracked recreation of deleted paths. Fingerprints key diff caches and review progress. Polls run every two seconds while active and visible, and pause during editing, comment drafts, and feedback dispatch. Metadata changes still refresh when file content stays identical.
- `src/localBoard/LocalBoard.tsx` prepares or attaches a workspace through `src/providers/workspaces.ts` and `src-tauri/src/card_workspaces.rs`. `NewWorkComposer` creates a default isolated workspace for Create & run. Preparation failures retain the form and remove the partial card. Workspaces are never deleted automatically.
- `src/localBoard/runtime.ts` launches and resumes using the immutable run workspace snapshot in `store.ts`. Successful completion moves the card to Review. Failed or stopped runs stay In progress. The Rust runtime holds a writable-workspace lease across startup, cancellation, and process cleanup; read-only runs do not claim one.
- Review changes opens the bound worktree. `ProjectPane::sendReviewFeedback` validates the card/run path, idle session, base snapshot, and current file fingerprints. Failed sends stay unsent; repeated clicks are blocked. Feedback uses the existing provider session, while Hermes feedback retains its separate adapter.
- `src/review/reviewedFiles.ts` stores reviewed fingerprints by repository, base branch, compare branch, and mode. The review store prunes old fingerprint history under its native size limit while retaining unsent comments. Older exact-commit Viewed marks seed content identities when read.
- `CardWorkspace` is shared by workspace commands, local cards, and review routing. Per-file fingerprints serve both diff caching and review progress. No provider framework or general command runner was added.

## Verified behavior

Base commit `31bf81d`, with uncommitted changes on `feature/agent-review-loop`. Environment: macOS, local Node/Rust/Git. Dirty patch evidence: `/tmp/patchdeck-ui-review/agent-review-loop.patch`; new-file copies accompany it in `/tmp/patchdeck-ui-review/agent-review-loop-new/`.

- PASS: `npm test`, 164 tests across 24 files. `ProjectPane.live.test.tsx` covers scroll-container preservation, pause/inactive/draft polling, late responses, metadata-only changes, feedback retry, duplicate dispatch, and stale comments. App routing tests cover returning to a card without reopening it on later visits. Board/runtime tests cover explicit binding and lifecycle. Review-store tests cover persisted fingerprints and oversized-history pruning.
- PASS: `npm run build`, TypeScript and Vite production build. An initial test-only use of `Array.at` failed the project's TypeScript target; replaced with indexed slicing and reran successfully.
- PASS: `CARGO_TARGET_DIR=/tmp/patchdeck-review-20260909-target cargo test --manifest-path src-tauri/Cargo.toml --lib`, 76 passed, 2 ignored. Temporary real Git fixtures cover staged/unstaged/untracked files, rename/delete/recreation, binary/gitlink paths, containment, symlink recreation, owner-only temporary blobs, bounded output, workspace creation and attachment, ID collisions, filter suppression, and writer cancellation guards.
- PASS: `cargo fmt --check --manifest-path src-tauri/Cargo.toml` and `git diff --check`.
- PASS: Native Patchdeck Local loaded Working tree mode against an open repository. Screenshot: `/tmp/patchdeck-ui-review/agent-review-live-native.png`. Its Rust watcher rebuilt the assembled implementation successfully. Browser fixtures inspected the compact review at 920 and 1280 pixels and the workspace picker; fixture files were removed and prior browser storage restored.
- Independent reviews found and resolved recreation statistics, directory entries, oversized hashing, cancellation ordering, workspace collisions, Git checkout filters, metadata refresh, store pruning, and one-shot card routing.

## Limits and unverified gaps

- NOT RUN: real Codex/Claude paid turns or live Hermes integration. Provider dispatch is exercised through mocked boundary tests; two environment-dependent Hermes tests remain ignored.
- Files above 5 MiB use bounded metadata identities instead of full content hashing. On macOS these include device, inode, size, modification time, and change time; the regression covers a same-size rewrite with its modification time restored. Normal renderable files use full content hashes.
- Gitlinks and embedded repositories appear as nontext changes. The app does not recursively review their contents.
- Legacy conversations without a recorded worktree cannot resume safely. The drawer directs users to create a new card; existing history remains readable.
- Worktrees remain after card completion or deletion. There is no automatic cleanup, merge, commit, push, or publication in this flow.


## Searchable branch selection

Requested on 2026-09-09. `src/components/BranchPicker.tsx` is shared by the Base and Compare fields in `ProjectPane.tsx`. Typing filters local branch names without updating the comparison. Click or Enter selects a branch; arrows move through results; Escape or blur restores the current value. No-result and no-branch states do not accept arbitrary refs. Toolbar height stays unchanged.

PASS: picker, App, and live-review tests plus `npm run build`. Native Local smoke test filtered the open repository's branches with a lowercase query and dismissed without changing the selection. Evidence: `/tmp/patchdeck-ui-review/searchable-branches-native.png`.
