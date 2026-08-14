# Local Hermes Workbench PRD

Status: first implementation slice
Product posture: local-first, human-in-the-loop source control for Hermes Agent
Reference integration: NousResearch Hermes Agent Kanban, researched 2026-08-14

## 1. Product summary

The app combines a local pull-request-style code review surface with the native Hermes Agent Kanban. A developer can open one repository or a non-Git workspace containing repositories, see the agent's assigned work and live activity, inspect local branch changes, give file-and-line feedback, and send that feedback back to the responsible Hermes task.

Nothing is published automatically. Saving a file, sending feedback, committing, pushing, and creating a GitHub pull request are separate, explicit actions.

## 2. Problem

Hermes can plan and execute work locally, but its Kanban does not provide a source-control review experience with branch comparisons and durable file/line comments. Traditional GitHub pull requests provide that review surface only after code has left the machine. The missing product is a local control plane where a human can observe the agent, review its changes, and request another iteration before anything is pushed.

## 3. Goals

- Preserve the existing local branch comparison experience: changed-file counts, additions/deletions, file tree, and unified diffs.
- Connect to a local Hermes Agent safely and show connection health in the top-right of every main screen.
- Reproduce the native Hermes Kanban workflow and exact statuses.
- Show the useful evidence of current agent activity that Hermes exposes: workers, task events, runs, diagnostics, heartbeats, and bounded worker logs.
- Let a human create and assign work, move eligible tasks through the Hermes lifecycle, and comment on tasks.
- Let a human leave durable file/line feedback and deliver a structured version of it to the linked Hermes task.
- Allow guarded local file editing and saving without implicitly staging, committing, pushing, or changing task state.
- Make GitHub publication a later explicit handoff, never a background side effect.

## 4. Non-goals for the first release

- Replacing Hermes' dispatcher or task database.
- Reading or writing Hermes' SQLite files directly.
- Connecting to Hermes on a non-loopback host.
- Mirroring every detached worker tool call as a structured timeline. Hermes does not currently expose that through its Kanban event API.
- Automatic commits, pushes, branch changes, pull requests, merges, or task approvals.
- Multi-user synchronization or hosted collaboration.
- Claiming to be an official Nous Research product.

## 5. Primary user journey

1. The developer reopens the app and returns to their prior repository, workspace, and selected surface.
2. They select **Connect Hermes** in the top-right.
3. They discover a running local Hermes dashboard, start a managed local Hermes server, or attach to an existing loopback server with its session token.
4. The connection control shows Hermes version, health, and active worker count. Board and profile choices stay in the Agent Board context.
5. In **Agent Board**, the developer creates a task from its intended lane with the native Hermes fields and moves it through workflow-safe transitions. The app nudges Hermes' dispatcher after writes.
6. The card moves through Hermes' native lifecycle while the task drawer shows formatted Markdown, dependencies, child results, attachments, notification subscriptions, comments, events, runs, heartbeats, diagnostics, and the worker log tail.
7. Selecting **Review code** opens or activates the task's own repository, even when another repository tab is currently selected.
8. In **Review**, the developer compares the task branch with its base, inspects syntax-colored diffs, marks files as viewed, and leaves inline feedback.
9. **Send feedback to agent** posts one structured Hermes task comment containing paths, lines, context, and stable local comment IDs.
10. If the task is in `review`, **Request changes** posts feedback and transitions the same card from `review` to `ready`. If it is still `running`, the app posts the comment only so Hermes can steer the active worker.
11. The human repeats review until satisfied, then explicitly chooses later Git and GitHub actions.

## 6. Information architecture

### App chrome

- Project tabs remain the top-level local SCM context.
- A surface switch exposes **Review** and **Agent Board** without opening a second app.
- Without an attached Hermes session, the app stays in review-only mode and hides the Agent Board, task-linked feedback, and file-editing controls.
- The top-right Hermes control is always visible when a project is open.
- The connection drawer contains mode, URL, version, connection diagnostics, reconnect, and disconnect.

### Review surface

- Repository/workspace tabs.
- Base and compare branch selectors.
- Changed-file totals and additions/deletions.
- Collapsible path tree.
- Wrapped unified diff by default, with a user-controlled no-wrap mode.
- IDE-style syntax coloring and viewed-file progress scoped to an exact comparison.
- Inline comments anchored to file, side, line, and context fingerprint.
- Explicit edit mode with dirty-file state and guarded save.

### Agent Board surface

The status model must preserve the upstream values exactly:

`triage | todo | scheduled | ready | running | blocked | review | done | archived`

The first eight columns are visible by default. Archived work is shown through an explicit archived filter. Eligible columns own their create action. Cards show title, assignee, priority, comments, child progress, warnings, and live worker state when available. A task drawer shows formatted description and comments, workspace/branch, explicit transitions, dependencies, child results, attachments, home-channel notifications, activity, runs, diagnostics, and bounded logs.

## 7. Hermes connection contract

React never calls Hermes directly. A Rust-owned `HermesConnection` adapter owns:

- the managed child process, if the app started one;
- loopback URL validation;
- the in-memory session credential;
- health and capability probes;
- authenticated REST calls;
- event subscription and reconnect behavior;
- upstream response normalization and safe error redaction.

### Managed local mode

- First probe standard loopback dashboard ports and attach to an authenticated running dashboard when one is found.
- Resolve the `hermes` executable.
- Generate a random session token in memory.
- Spawn `hermes serve --host 127.0.0.1 --port 0 --skip-build`.
- Parse `HERMES_BACKEND_READY port=<port>` from stdout.
- Set Hermes' parent-process/watchdog environment where supported.
- Stop only the child process the app owns, and only on explicit disconnect or application quit.
- Hiding the macOS window must not stop Hermes or the app.

### Attach mode

- Accept only `http://127.0.0.1`, `http://localhost`, or `http://[::1]` URLs in the first release.
- Keep the token only in Rust memory.
- Probe health, boards, profiles, workers, task logs, and event support.
- Never terminate an attached process.

## 8. Agent feedback contract

Hermes task comments are the transport, not the source of truth for line anchors. The app stores local review comments with:

- repository canonical root;
- Hermes board and task ID;
- base/head commit or snapshot identifiers;
- file path, old/new side, and line number;
- surrounding-context fingerprint;
- body, author, timestamps, and `open | addressed | outdated` state.

When sent, the app renders new open comments into one structured task comment. A running worker can receive it through Hermes' activity-driven steer bridge. The UI says **Sent to Hermes** and does not promise a fixed delivery time.

## 9. Guarded editing contract

Editing is a separate module from agent control and Git operations.

- Resolve files relative to a canonical repository root.
- Reject absolute paths, traversal, and symlink escapes.
- Load a content hash with the file and require it on save.
- Reject saves when the on-disk hash changed since load.
- Write atomically and preserve explicit dirty state until success.
- Refresh the diff after save.
- Never stage, commit, push, switch branches, or update a task as a side effect.

## 10. GitHub publishing boundary

A future **Publish pull request** workflow may authenticate with GitHub, confirm branch and remote, push explicitly, and create a PR. It must show a final mutation summary and require a user confirmation. It is not part of the Hermes connection and is not required for local review or task completion.

## 11. Persistence

Persist locally:

- open repositories/workspaces and active tab;
- selected surface;
- repository-to-board and repository-to-task links;
- line wrapping and panel preferences;
- viewed files keyed by repository, merge base, and compare commit;
- inline review comments and resolution state.

Do not persist Hermes session tokens in frontend storage. A managed connection may be recreated on launch; an attached connection requires an OS-protected credential design before token persistence is allowed.

## 12. Security and trust requirements

- Loopback-only Hermes connections for the first release.
- No generic shell command or arbitrary HTTP proxy exposed to React.
- All repository write paths are canonicalized and contained.
- Hermes tokens and worker logs are redacted from application diagnostics where needed.
- Logs are bounded and loaded on demand.
- Unknown upstream fields and future statuses do not crash the app.
- UI copy clearly distinguishes local save, task feedback, Git commit, and remote publication.

## 13. First vertical slice acceptance criteria

- Existing branch review behavior remains functional.
- The new original Hermes + SCM icon is used by the app and macOS bundle.
- A top-right control shows disconnected, connecting, connected, and error states.
- Managed mode starts local `hermes serve` on an ephemeral loopback port and disconnect stops only the owned process.
- Attach mode rejects non-loopback URLs.
- The board lists Hermes boards/profiles and renders the canonical columns/cards.
- The board refreshes without restarting the app.
- Eligible columns expose their own create action and the modal includes native Hermes task fields.
- Selecting a card opens formatted descriptions and comments, transitions, dependencies, child results, attachments, home notifications, events, runs, and worker log evidence.
- **Review code** opens or activates the exact repository in the task's workspace path.
- Review diffs use syntax coloring and persist viewed-file progress for the exact comparison.
- A human can add a task comment and see it after refresh.
- Credentials do not cross into localStorage or appear in the React state contract.
- Frontend tests and Rust tests cover the connection boundary and core board interactions.

## 14. Delivery phases

1. **Connection and observation:** adapter, connection UI, board, task drawer, workers, runs, events, logs.
2. **Kanban control:** create, assign, workflow-safe moves, dispatcher nudge, comments.
3. **Review link:** repository/task association, local inline comment store, structured feedback, request-changes loop.
4. **Guarded editor:** edit mode, hash concurrency, atomic saves, diff refresh.
5. **Explicit Git operations:** user-confirmed commit and push boundaries.
6. **GitHub publication:** separate authenticated PR flow.

## 15. Open decisions

- Whether managed Hermes should reconnect automatically after a full app relaunch.
- Local database choice for inline review comments.
- How repository tabs map to named Hermes boards when one board spans several repositories.
- Whether a structured detached-worker tool timeline should be proposed upstream to Hermes.

## 16. Reference

The detailed source-backed upstream analysis is in [`docs/hermes-agent-integration-research.md`](docs/hermes-agent-integration-research.md).
