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

## Board scrolling, bulk archive, and review return

Requested on 2026-09-21 after the UI workflow audit. The user authorized these three fixes in parallel. The primary agent owns integration and this record. Starting revision: `de9ca9b9b3bd2e5d26ab74856ec244b8fac92470`. Changes remain uncommitted.

### Intended behavior and acceptance examples

- A long lane scrolls independently inside the available board height. Its header stays visible, neighboring lanes keep their positions, and horizontal scrolling reaches all lanes at 920 by 600 and 1280 by 800 window sizes.
- Users select multiple Local or Hermes cards and archive them in one action. Local archive preserves cards and conversations, supports restore, and excludes archived cards from active combined views. Active local runs and Hermes transitions that do not allow archive remain protected.
- Hermes batch archive reports partial success and leaves failed cards available for retry. Repeated clicks cannot dispatch duplicate batches, and changing boards cannot apply an old result to the new selection.
- Opening Review and returning preserves the source board, task or card, repository context, horizontal board position, and vertical lane positions. Both Local and Hermes reviews have a return action. Workspace-backed Hermes review opens Working tree mode.
- Local review actions remain visible above a long agent conversation.

Non-goals: new board/list modes, navigation redesign, global search, new runtime capabilities, automatic worktree cleanup, commits, publication, and the separate review-wide feedback count issue.

### Verification plan

Use store tests for archive round trips and retained conversation history; component tests for selection, eligibility, partial failures, retries, and scope changes; App and AgentWorkspace tests for navigation and review mode. Inspect populated browser fixtures for real scroll geometry and review controls. Run `npm test`, `npm run build`, and `git diff --check` after integration. No Rust implementation or command contract changes are planned. Live Hermes mutations and paid agent runs are not part of verification.

### Observed implementation and verification

- `App.css` bounds the board to the viewport and gives each lane its own vertical scroll container. Lane headers remain outside that container.
- `LocalBoard` and `HermesBoard` expose selection mode, per-lane selection, and a batch action. Local `archivedAt` preserves cards, runs, workspaces, and handoffs; restore removes the archive marker. Store and runtime guards protect active runs and prevent execution of archived cards. Combined boards omit archived local cards.
- Hermes archives use the existing transition rules and serialized API calls. Successful tasks leave the selection; failures remain selected for retry. A board change, connection change, or unmount stops further requests. An already dispatched request may still complete on Hermes.
- `App` retains the originating repository, board source, and view state while the board unmounts during Review. `BoardViewState` and the one-shot open request are shared with `AgentWorkspace`; they do not add a separate navigation framework. Both Local and Hermes offer an explicit return action. Saved offsets survive asynchronous lane replacement, and user input cancels restoration. Local Review changes stays above the scrolling conversation.
- PASS: `npm test`, 180 tests across 25 files, compared with 169 baseline tests. Coverage includes retained history, archive/restore, active-run protection, partial failures and retry, duplicate dispatch, board/session/unmount changes, local and Hermes review round trips, original repository selection, one-shot drawer opening, and scroll restoration.
- PASS: `npm run build` and `git diff --check`. Integration initially exposed a TypeScript inference error in the return destination; an explicit source type fixed it before the passing build.
- PASS: populated browser fixtures checked independent lane scrolling, fixed headers, last-card reachability, and horizontal overflow for Local, Hermes, This Repository, and All Work at 920 by 600 and 1280 by 800. Browser archive/restore preserved local history; a simulated Hermes failure retried only the failed task. Local and Hermes review round trips restored the originating repository, drawer, source, and measured lane offsets; Hermes opened Working tree mode and retained the Archived toggle. Review changes stayed visible above a 40-message local conversation.
- Evidence: `/tmp/patchdeck-ux-validation-20260921/` contains the browser fixture, baseline geometry, and integration hashes. Checks use synthetic data and mocked native commands. The primary agent reviewed and integrated the three worktree diffs; no tool-enforced independent read-only review was available.
- NOT RUN: live Hermes mutations, paid agent turns, or Rust tests. No Rust files or native command contracts changed. The collaborative browser intermittently lost its connection; successful browser checks are listed above, while the final scroll-event guard is covered by the regression suite and build.
- Preview cleanup could not restore browser storage after the preview lost access to localhost. Its original storage is retained with owner-only permissions in `preview-storage-backup.json` in the evidence directory. Native application data was not changed. The temporary verification server was stopped; the existing development server was left running.

## Worktree discovery, Work navigation, and deliberate creation

Requirement: the user asked to implement the remaining three numbered recommendations from the 2026-09-21 UX audit, items 4 through 6. The primary agent owns integration and this record. Implementation starts from the uncommitted scrolling, archive, and review-navigation fixes above.

Intended behavior:

- Review offers an attention queue for existing Git worktrees, including those created outside Patchdeck. Rows show branch, path, changed-file count, review progress, and linked local-card context when available. Awaiting review, Changed since review, and All worktrees filters narrow the queue. Opening a row directly reviews its working tree against an explicit base without creating a card or starting an agent.
- Work separates repository scope, source, Board/List view, and workflow filters. Those choices survive a trip to Review. Existing source-specific task editing and archive behavior remain available.
- Creating local work has separate Create card and Create & run actions. Selecting a profile alone never starts execution. Hermes creation keeps title, description, destination, and executor prominent, places optional fields under Advanced, summarizes defaults, and provides a Capture idea for Hermes entry point.

Non-goals: Git publication, worktree deletion, new Hermes transitions, paid agent verification, and the separately identified review-wide feedback controls. This work reuses native discovery and comparison commands where possible.

Verification plan: queue component tests cover external worktrees, review progress, filters, isolated failures, and stale responses; App tests cover queue landing and direct Working tree review; Work tests cover scope/source/view/filter combinations and preserved navigation; composer tests verify explicit dispatch, Advanced options, failures, and duplicate submission. Run the assembled frontend suite, production build, and diff checks. Native command contracts will be rechecked if changed.

### Observed implementation and verification

- `WorktreeReviewQueue` discovers attached worktrees through the existing native API, summarizes up to four concurrently, and reads the same content fingerprints used by file review. Each row handles its own errors and base selection. Stale responses cannot replace a newer repository or refresh. Long linked-card lists collapse into a disclosure.
- `App` adds Worktrees and Changes under Review. Opening a queue row requests Working tree mode and clears any stale card feedback target. This path creates neither a card nor an agent run. `WorkingTreeReviewRequest` carries the one-shot base and path from App to ProjectPane.
- `AgentWorkspace` owns `WorkNavigationState`, shared with App to retain scope, source, Board/List view, filter, and search across Review. Current repository scope includes discovered worktree paths; discovery failure shows a retryable warning. Local, Hermes, and combined boards apply the selected filters. The toolbar wraps at smaller window sizes, and List uses compact rows with a single vertical scroll area.
- `NewWorkComposer` separates Create card from Create & run. Enter in the local title creates a card without preparing a workspace or dispatching an agent. Explicit execution retains the existing preparation and failure handling. Hermes optional fields live under Advanced; Capture idea targets Triage with the dispatcher choosing the executor by default. The header and actions stay visible while the fields scroll.
- PASS: `npm test`, 202 tests across 26 files. Coverage includes queue errors, explicit base selection, stale requests, viewed fingerprints, direct worktree routing, preserved navigation and scroll state, filtering, safe card creation, explicit dispatch, duplicate submission, and retry after preparation failure.
- PASS: `npm run build` and `git diff --check`. The final production build compiles 339 modules. No Rust files or native command contracts changed.
- PASS: synthetic browser checks at 920 by 600 and 1280 by 800. External worktree review opened Working tree mode without card creation or execution. Marking a file viewed removed it from Awaiting review; a changed fingerprint appeared under Changed since review. Work navigation wrapped without horizontal clipping, List rows remained compact, and 25 selected Local cards archived and restored through the new filters. Capture idea opened Triage with no assigned executor. Advanced stayed collapsed initially; opening it kept the footer below the scrollable body at both sizes.
- Browser inspection found and fixed two layout problems: many linked cards made queue rows too tall, and Hermes fields overlapped the footer at 920 by 600. The final form body ends at y=492 and the footer begins at y=509 at that size; at 1280 by 800 they are y=692 and y=709.
- Evidence: `/var/folders/s7/6ctmdy055ml8vds23sr3qtnc0000gn/T/patchdeck-remaining-y5ebaamm/` contains the seeded baseline, integration hashes, browser fixture, and final patch/new-file copies. Final form screenshot: `/Users/nikhlkapadia/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-muc1p1x0-f9bacead.png`.
- NOT RUN: live Hermes mutations, paid agent turns, or Rust tests. Browser checks used mocked native commands and sample data on a separate temporary server; they do not prove live provider behavior. Changes remain uncommitted on main, based on `de9ca9b9b3bd2e5d26ab74856ec244b8fac92470`.

- Cleanup: removed the synthetic browser fixture and its storage from the separate port 1432 origin, then stopped the temporary verification server. The existing development server and native application data were left untouched.
- Final scope correction: Local now uses the same discovered checkout paths as Hermes and combined views. A regression test includes main-checkout and worktree cards while excluding another repository. The full 202-test suite and production build passed after integration.
- Read-only second-agent review found no blocking issues in App/ProjectPane routing, explicit creation, and navigation/filter handling. That reviewer excluded the queue component they authored and relied on the integration test and browser evidence above. The primary reviewed the queue and final scope correction.
