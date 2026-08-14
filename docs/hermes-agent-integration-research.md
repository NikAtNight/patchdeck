# Hermes Agent integration research

Research snapshot: 2026-08-14, against `NousResearch/hermes-agent` commit [`eca85e81d62660e377d442d6cfb482f341243aca`](https://github.com/NousResearch/hermes-agent/tree/eca85e81d62660e377d442d6cfb482f341243aca), package version [`0.20.1`](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/pyproject.toml#L1-L7).

## Conclusion

The project the product should integrate with is the official [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) repository. Its native Kanban feature is the exact match: a local, durable, multi-profile task board with task assignment, worker processes, comments, review iterations, live events, worker logs, and a human-facing React board. Hermes explicitly describes engineering pipelines as “decompose, implement in parallel worktrees, review, iterate, PR” and models human intervention through comments and review transitions. ([Hermes Kanban overview](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L11-L28), [core concepts](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L55-L70))

The closest plausible alternative is Nous Research's [`hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-paperclip-adapter#readme). That adapter runs Hermes as a Paperclip employee and uses Paperclip's issue, heartbeat, and comment-wake system. It is useful precedent for comment-driven agent wakeups, but it is not Hermes' native Kanban board and would add a second orchestration product. The native board is the better match for this local SCM application.

## What Hermes already provides

Hermes has one domain layer, `hermes_cli.kanban_db`, used by three surfaces:

- Humans and scripts use `hermes kanban`, slash commands, or the dashboard.
- Dispatcher-spawned agents use scoped `kanban_*` tools.
- The dashboard and official desktop client use a FastAPI REST and WebSocket facade over the same domain layer.

This keeps task behavior consistent across UI, CLI, and workers. ([surface architecture](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L13-L20), [dashboard architecture](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L626-L649))

### Persistence and lifecycle

The default board is SQLite at `~/.hermes/kanban.db`; named boards live under `~/.hermes/kanban/boards/<slug>/kanban.db`. Each board also owns its workspaces and logs, and workers are pinned to a board in their environment. ([board isolation](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L72-L89))

The schema persists tasks, dependency links, comments, append-only events, historical runs, attachments, and notification subscriptions. Tasks include the assignee, status, workspace kind/path, branch, PID, heartbeat, current run, model overrides, and failure state. ([current schema](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L1333-L1524))

The exact task-status set is:

`triage | todo | scheduled | ready | running | blocked | review | done | archived`

The official desktop client defines all nine lanes and their presentation. ([desktop task types and lanes](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/desktop/src/plugins/kanban/types.ts#L1-L38), [lane metadata](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/desktop/src/plugins/kanban/types.ts#L191-L204))

The gateway-embedded dispatcher promotes eligible work, atomically claims `ready` tasks, records a run, and spawns the assigned Hermes profile as a separate OS process. The claim is a compare-and-set transition from `ready` to `running`, with dependency checks and a run row. ([atomic claim](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L4580-L4690)) The worker is launched as `hermes -p <profile> ... chat -q`, receives task, board, run, branch, and workspace environment variables, and writes to a per-task rotating log. ([worker spawn and environment](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L10304-L10426), [command and log](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L10436-L10516))

Hermes Kanban is deliberately single-host. Its SQLite database, PID liveness checks, dispatcher, and workers are local to one machine. This is aligned with the proposed product, but it rules out treating this API as a distributed multi-host coordinator. ([single-host constraint](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L1157-L1159))

### Local API and event surface

Hermes provides `hermes serve`, a headless form of the same backend used by the web dashboard and official desktop app. It accepts host and port arguments, including port `0` for OS assignment. ([serve command architecture](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/subcommands/dashboard.py#L1-L30), [headless command](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/subcommands/dashboard.py#L127-L170))

The Kanban API is mounted at `/api/plugins/kanban`. The minimum product-facing calls are:

| Purpose | Endpoint |
|---|---|
| Connection/version probe | `GET /api/health` |
| Gateway/profile status | `GET /api/status?profile=<name>` |
| Boards | `GET /api/plugins/kanban/boards` |
| Agent profiles | `GET /api/plugins/kanban/profiles` |
| Board lanes and cards | `GET /api/plugins/kanban/board?board=<slug>` |
| Task, comments, events, links, runs | `GET /api/plugins/kanban/tasks/<id>?board=<slug>` |
| Create/assign work | `POST /api/plugins/kanban/tasks?board=<slug>` |
| Edit assignment or lifecycle | `PATCH /api/plugins/kanban/tasks/<id>?board=<slug>` |
| Add human feedback | `POST /api/plugins/kanban/tasks/<id>/comments?board=<slug>` |
| Wake dispatcher now | `POST /api/plugins/kanban/dispatch?board=<slug>` |
| Active workers | `GET /api/plugins/kanban/workers/active?board=<slug>` |
| Worker process inspection | `GET /api/plugins/kanban/runs/<run_id>/inspect?board=<slug>` |
| Worker output | `GET /api/plugins/kanban/tasks/<id>/log?tail=16384&board=<slug>` |
| Live task events | `WS /api/plugins/kanban/events?board=<slug>&since=<event_id>` |

The public health endpoint returns `ok`, the Hermes version, and whether gated authentication is active. ([health/status source](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/web_server.py#L3054-L3076)) The official desktop Kanban client uses the same REST router, persists board selection, refreshes the board every eight seconds and a task drawer every four seconds as fallbacks, and invalidates both immediately from event frames. ([desktop data layer](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/desktop/src/plugins/kanban/api.ts#L1-L10), [event invalidation](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/desktop/src/plugins/kanban/api.ts#L51-L67), [reads and writes](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/desktop/src/plugins/kanban/api.ts#L142-L216))

The Kanban event socket is board-pinned. It tails monotonic `task_events.id`, sends batches of up to 200 as `{events, cursor}`, and polls SQLite every 300 ms. Each event carries `id`, `task_id`, optional `run_id`, `kind`, payload, and timestamp. ([event socket implementation](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L2892-L2952))

For “what is the agent doing?”, the native Kanban surface already exposes:

- task status, profile, PID, start time, claim expiry, and last heartbeat through `/workers/active`;
- historical attempts, outcome, summaries, errors, and timestamps in task detail;
- live process CPU, memory, threads, descriptors, and command through `/runs/<id>/inspect`;
- bounded worker stdout/stderr through `/tasks/<id>/log`;
- lifecycle changes through the task event socket.

([active-worker API](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L1551-L1609), [run inspection](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L1612-L1650), [log endpoint](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L2241-L2274))

These are the correct MVP activity signals. The separate JSON-RPC `/api/ws` transport emits structured interactive-session events such as message deltas and `tool.start/progress/complete`, but it drives an attached chat session, not every detached Kanban worker. ([JSON-RPC event contract](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/apps/shared/src/json-rpc-gateway.ts#L1-L23), [chat socket purpose](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/web_server.py#L16291-L16318)) Therefore a full structured tool-call timeline for every Kanban worker would require a Hermes-side observability plugin or upstream API addition. It should not be assumed to exist in the Kanban event socket.

## Human feedback and local code review

Hermes comments are already a durable human-to-agent channel. A comment write inserts `task_comments`, appends a `commented` event, and appears in future worker context. ([comment persistence](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L3945-L4009))

Current Hermes also delivers comments to a running worker without restarting it. At agent activity points, the worker checks for comments newer than its per-task watermark. The poll is rate-limited to six seconds, skips the worker's own comments, and injects fresh operator notes through Hermes' out-of-band `steer` channel. This is best-effort and activity-driven, so it should be presented as “delivered to the running agent” rather than a guaranteed six-second SLA during a blocking operation. ([live comment bridge](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/tools/kanban_tools.py#L360-L436), [agent activity hook](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/run_agent.py#L3765-L3808))

Hermes task comments are not file/line review comments. The SCM app should own a separate local review model with at least:

- repository identity and canonical root;
- linked Hermes board and task id;
- base/head commit or worktree snapshot identifiers;
- file path, old/new side, line number, and a hunk/context fingerprint;
- body, author, created time, state (`open`, `addressed`, `outdated`), and optional reply/resolution metadata.

When the human submits review feedback, the app should render all newly open inline comments into one structured Hermes task comment containing stable file paths, lines, snippets, and local review-comment ids. Keep the line anchors in the app database, not in Hermes, and mirror only the actionable text into Hermes.

Use Hermes' same-card review lifecycle:

1. The implementation worker sends the task to `review`.
2. The app shows the local diff and accepts inline comments.
3. “Request changes” posts the structured comment, then patches the task to `ready`.
4. Hermes' PATCH handler routes `review -> ready` through `reopen_review_task`, preserving review history and returning work to the implementer.
5. The next run reads the comment thread; the app watches events/diffs and lets the human mark comments addressed.
6. Approval completes the review task. GitHub push/PR creation remains a separate explicit action.

This matches Hermes' first-class `review_requested -> changes_requested -> review_requested -> completed` flow. ([review tutorial](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban-tutorial.md#L146-L199), [dashboard review transition](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L856-L935)) For a task that is still `running`, post the comment only and let the live comment bridge steer the current run. Do not force a running task to `ready`.

## Recommended application architecture

### 1. Keep Hermes behind a Tauri backend adapter

Add one Rust-owned `HermesConnection` boundary instead of letting React call Hermes directly. It should own the child process, base URL, session credential, health/version probe, REST calls, event WebSocket, reconnection, and redaction. React receives typed state and Tauri events only. This prevents the session token from leaking into browser storage or frontend logs and avoids WebView CORS differences.

Do not read or write `kanban.db` directly. The schema is actively evolving, SQLite uses WAL and transactional claim rules, and dashboard writes intentionally pass through `kanban_db`. Going through REST preserves Hermes' concurrency and lifecycle invariants. ([single-writer dispatch lock](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/kanban_db.py#L9485-L9564), [thin API design](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L1-L12))

### 2. Provide two connection modes

For the local-first MVP:

- **Managed local Hermes:** locate the `hermes` executable, generate a random in-memory dashboard session token, spawn `hermes serve --host 127.0.0.1 --port 0`, wait for `/api/health`, and stop only the child process the app owns.
- **Attach to existing Hermes:** accept a loopback URL plus session token and verify it with `/api/health`, `/api/plugins/kanban/boards`, and a version/feature probe. Never kill an externally managed process.

Show the selected profile, Hermes version, transport state (`connecting`, `connected`, `degraded`, `disconnected`), and active worker count in the top-right connection control. A drawer can expose URL, profile, board, reconnect, disconnect, and diagnostic errors.

The upstream server supports an injected `HERMES_DASHBOARD_SESSION_TOKEN`. REST accepts `X-Hermes-Session-Token` and legacy `Authorization: Bearer`; WebSockets use a query token on loopback, or a single-use ticket in gated OAuth mode. ([REST authentication](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/web_server.py#L415-L475), [Kanban WebSocket authentication](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/plugins/kanban/dashboard/plugin_api.py#L64-L94)) Keep the first release loopback-only. Remote OAuth/password flows materially increase scope and should be designed separately.

### 3. Port behavior, not the Hermes plugin runtime

Use the official desktop implementation under `apps/desktop/src/plugins/kanban/` as the parity reference for columns, cards, filters, board switching, drawer sections, polling, cache invalidation, drag/drop, and dispatcher nudging. Its `api.ts`, `types.ts`, `board.tsx`, `drawer.tsx`, and `kanban.css` are the current executable design.

Do not import it directly into this app. It depends on Hermes' Electron host and `@hermes/plugin-sdk`. Reimplement the same behavior against the Tauri `HermesConnection` interface, sharing only domain-shaped TypeScript types. This reduces integration coupling while preserving the user-visible workflow.

### 4. Keep code editing separate from agent control

Turning the existing viewer into an editor should be a separate bounded module. It needs repository-root containment, symlink/path traversal checks, optimistic concurrency using the file's loaded hash, atomic writes, explicit dirty state, and diff refresh after save. Saving a file must not commit, push, change branches, or update a Hermes task automatically. “Send review feedback,” “save file,” “commit,” and “push/create PR” should remain distinct user actions.

## Compatibility, security, and license constraints

- Require or test against Hermes `0.20.1` for the current worker activity and mid-run comment behavior. Feature-probe `/workers/active`, `/tasks/<id>/log`, and the event socket rather than trusting version alone.
- The Kanban REST API is an internal dashboard plugin API, not a separately versioned public SDK. Keep all upstream shapes behind the adapter and tolerate unknown fields/statuses.
- Upstream documentation contains a security contradiction in this exact commit: the REST table says plugin routes are token-protected, while a later paragraph still says `/api/plugins` is skipped. Current code requires authentication for non-public `/api/*` routes, and the plugin source says the same. Follow code, not the stale paragraph. ([REST table](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L652-L675), [stale paragraph](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/website/docs/user-guide/features/kanban.md#L694-L700), [current middleware](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/web_server.py#L667-L688))
- Bind managed Hermes only to `127.0.0.1`. Non-loopback binds require the gated authentication system and should not be silently enabled. ([bind/auth rules](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/hermes_cli/web_server.py#L489-L508))
- Hermes is MIT licensed. Copying or adapting code is allowed, but the copyright and MIT notice must be retained in substantial copied portions. ([license](https://github.com/NousResearch/hermes-agent/blob/eca85e81d62660e377d442d6cfb482f341243aca/LICENSE#L1-L20))
- The repository does not publish a trademark grant or brand-asset policy alongside the MIT license. Use an original Hermes-myth-plus-SCM visual identity and describe the product as “integrates with Hermes Agent,” not as an official Nous Research product, unless separate permission is obtained.

## Suggested delivery order

1. `HermesConnection` with managed-local spawn, attach, health, auth, and top-right status.
2. Read-only board parity: boards, lanes, cards, filters, task drawer, runs, logs, active workers, and event refresh.
3. Task creation, assignment, drag/drop transitions, comments, and dispatcher nudge.
4. Link each repository/project tab to a Hermes board and task.
5. Local inline review-comment store and “Send feedback to agent.”
6. Same-card review loop and addressed/outdated comment reconciliation.
7. Guarded file editing and atomic save.
8. Explicit commit and GitHub push/PR integration as a later, separately authorized workflow.
