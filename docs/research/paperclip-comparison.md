# Paperclip comparison for Patchdeck

Research snapshot: 2026-08-16. Paperclip repository evidence is pinned to [`fd472d02ba950519ca5eff75ed9fd55cf976f4c2`](https://github.com/paperclipai/paperclip/tree/fd472d02ba950519ca5eff75ed9fd55cf976f4c2). Only Paperclip-owned sources were used: its website, documentation, and source repository.

## Conclusion

Paperclip and Patchdeck overlap in their visible ingredients: a task board, multiple agent runtimes, persistent work history, live execution evidence, and human intervention. They do not need to have the same product thesis.

Paperclip is a company-level orchestration system. It models companies, goals, org charts, agent employees, budgets, approvals, and heartbeat-driven work. Its own positioning is “manage business goals, not pull requests,” and its product definition explicitly says it is not a code-review tool. ([README](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/README.md#L29-L45), [product boundary](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/PRODUCT.md#L112-L130))

Patchdeck can remain materially different by being the local developer workbench between assignment and publication: aggregate work from local and external boards, route a card to the right execution system, inspect the actual repository changes, leave file-and-line feedback, and approve another agent iteration before any commit, push, or pull request. That focus is already visible in the [README](../../README.md), [domain language](../../CONTEXT.md), and [Hermes workbench PRD](../../HERMES-WORKBENCH-PRD.md).

The product boundary should therefore be:

> Paperclip runs an AI organization. Patchdeck lets a developer direct and review AI work across repositories and runtimes.

## Confirmed Paperclip facts

### Product thesis

- Paperclip calls itself a control plane for autonomous AI companies. A company owns a goal, AI employees, an org structure, finances, and hierarchical work. One instance can contain multiple companies. ([product definition](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/PRODUCT.md#L3-L17))
- Its target loop is: define a company goal, create an agent org tree, execute tasks through heartbeats, track all work and costs, and allow the human board to intervene. ([V1 outcomes](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L14-L25))
- It is designed for autonomous, potentially continuous operation across business functions, rather than specifically for software development or local Git review. ([README audience](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/README.md#L68-L76))

### Board and task model

- The canonical work object is an issue with a project and goal link, parent/child hierarchy, blockers, one assignee, comments, documents, attachments, work products, and review/approval handoffs. All work must trace to the company goal through a goal, parent, or project link. ([task model](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/PRODUCT.md#L44-L59), [issue invariants](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L225-L265))
- Issue states are `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, and `cancelled`; checkout into active work is exclusive. ([issue lifecycle](https://docs.paperclip.ing/reference/api/issues/))
- A project groups a deliverable, linked goals, workspaces, runtime configuration, and issues. Its Issues tab is a project-filtered view of the same company issue collection, not an independent board database. ([Projects guide](https://docs.paperclip.ing/guides/projects-workflow/projects/))
- Multiple companies are isolated containers with separate agents, issues, goals, and budgets. The V1 contract explicitly excludes multiple board UIs for one company. ([company guide](https://docs.paperclip.ing/guides/getting-started/your-first-company/), [V1 scope boundary](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L80-L87))

### Agent, provider, and configuration model

- Paperclip assigns an issue to an **agent record**. The agent, not the issue, owns an adapter type and adapter configuration. Every agent can have its own runtime identity, instructions, model, working directory, execution settings, heartbeat policy, and budget. ([agent model](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/PRODUCT.md#L19-L31), [Agents guide](https://docs.paperclip.ing/guides/org/agents/))
- An adapter is the bridge from Paperclip orchestration to a runtime. Current built-ins include Claude Code, Codex, experimental Gemini CLI, OpenCode, Cursor, Pi, Hermes local, Hermes Gateway, OpenClaw Gateway, process, and HTTP. External adapters can be installed through plugins. ([adapter list and extension model](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/adapters/overview.md#L6-L31), [external adapters](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/adapters/overview.md#L68-L90))
- Local CLI adapters generally expect the CLI to be installed and authenticated on the host; gateway adapters connect to existing services. Adapter configuration includes runtime limits, working directory, environment, prompt/instruction configuration, and an environment test. ([runtime configuration](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/agents-runtime.md#L31-L80))
- Sensitive values are stored as encrypted secret references, configured under Company Settings and bound into agents, projects, environments, or plugins. Plaintext is not returned to the board UI. ([secrets custody and binding](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/deploy/secrets.md#L6-L52))

### Execution and orchestration

- Agents run in bounded heartbeat windows, triggered by a timer, assignment, an on-demand request, or automation. Concurrent wakeups for an already-running agent are coalesced. ([runtime guide](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/agents-runtime.md#L7-L29))
- On each heartbeat Paperclip invokes the configured adapter, supplies context, observes the run, and records status, logs, token usage, cost, and resumable session state. ([adapter flow](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/adapters/overview.md#L6-L15), [runs and session resume](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/docs/agents-runtime.md#L84-L120))
- The control plane is intended to be runtime-agnostic. Agent execution may be a local CLI session, a child process, an HTTP request, or an external adapter. ([execution options](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/PRODUCT.md#L33-L42))

### Human review and governance

- Paperclip provides `in_review` work, issue comments, review policies, atomic transitions, run attribution, and activity history. Its review gate can require anyone, someone other than the creator, or a human. ([review fields and invariants](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L225-L265))
- Separate board approvals govern agent hiring, CEO strategy, budget overrides, and explicit board requests. Agents can be paused, tasks overridden, and budget hard limits can stop work. ([governance contract](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L14-L23), [approval schema](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L308-L331), [Approvals guide](https://docs.paperclip.ing/guides/day-to-day/approvals/))
- Paperclip records costs by company, agent, issue, project, goal, provider, and model. This is organizational spend governance, not merely execution status. ([cost model](https://github.com/paperclipai/paperclip/blob/fd472d02ba950519ca5eff75ed9fd55cf976f4c2/doc/SPEC-implementation.md#L289-L306))

## Material comparison with Patchdeck

| Dimension | Paperclip | Patchdeck today | Product consequence |
|---|---|---|---|
| Primary user | Operator of an AI company or team | Developer working with local repositories | Keep Patchdeck optimized for one developer's code-work loop, not an org simulator. |
| Organizing unit | Company → goal → project → hierarchical issue | Repository → Local Board card/run, plus externally owned Hermes boards | A unified view should federate sources without inventing a company hierarchy. |
| Assignment | Issue is assigned to an agent; the agent owns its adapter | A local card optionally references a Codex or Claude Code execution profile; Hermes tasks reference Hermes-owned profiles | Preserve this distinction instead of treating Hermes itself as a provider. |
| Execution | Scheduled/event-driven heartbeats and autonomous delegation | User-started persistent Codex or Claude Code conversations; Hermes retains its own dispatcher | Patchdeck should route and observe execution, not recreate another scheduler. |
| Review | General issue review, approvals, comments, budgets, and audit | Branch comparison, changed-file tree, local file/line comments, guarded edits, and explicit feedback to the executing card/task | Repository-native verification is Patchdeck's strongest differentiator. |
| Source of truth | Paperclip owns its companies, agents, projects, issues, and runs | Patchdeck owns Local Board cards/runs; Hermes owns Hermes boards/tasks | “All work” should be a live projection, not copied or synchronized cards. |
| Publication | Can link outward to engineering workflows but is intentionally not a PR-review product | No automatic commit, push, or publication; review happens before code leaves the machine | Keep publication an explicit later boundary. |
| Scope | Business-wide and multi-company | Local-first software-development workbench | Avoid org charts, agent hiring, company missions, and budget governance unless Patchdeck deliberately changes category. |

Confirmed similarities are therefore substantial but horizontal: both need cards/issues, runtime adapters, status, history, comments, and human control. The differentiator is the vertical workflow and ownership boundary, not the existence of a Kanban UI.

## Inferences and recommendations for Patchdeck

Everything in this section is a design inference from the confirmed facts above and the current Patchdeck implementation. It is not a claim about Paperclip behavior.

### 1. Revise the unified-board model around two separate choices

The earlier creation concept should not present `Codex` and `Hermes` as equivalent providers. Hermes is an external orchestration source with boards and profiles; Codex is a runtime Patchdeck can invoke directly.

Model creation as:

1. **Destination**: Local Board or a named Hermes Board such as SXCL.
2. **Executor**: Unassigned, a Patchdeck execution profile such as Codex, or a Hermes-owned profile available on that board.

The form may collapse these into one friendly “Run with” control, but the stored reference should retain both dimensions. A local selection creates a Patchdeck card and optional run. A Hermes selection creates a native Hermes task and lets Hermes own dispatch and lifecycle.

### 2. Keep “All work” as a federated projection

Use stable origin references such as `{ source: "local", cardId }` and `{ source: "hermes", boardSlug, taskId }`. Normalize only the fields needed to render and filter the combined board. Open the source-specific drawer for deeper actions, and send every mutation to the original owner.

Do not silently drag a card from one source to another. An explicit **Send to Hermes** action can create a new Hermes task, record the relationship, confirm success, and ask whether to retain or archive the local card.

### 3. Add a settings gear, but call the information architecture “Connections”

A T3-style settings surface is compatible with the product, provided it distinguishes three layers:

- **Providers**: local runtimes or accounts Patchdeck can invoke directly, currently Codex and Claude Code, with Gemini or OpenCode as possible later additions. Show installed/authenticated/available state, executable or endpoint, default model, and a test action.
- **Orchestrators**: Hermes connections, including managed versus attached mode, endpoint, health, version, boards, and profiles. Hermes belongs here rather than in the provider list.
- **Execution profiles**: reusable Patchdeck-owned presets that combine provider, model, sandbox/approval policy, and optional instructions. Cards select a profile instead of accumulating raw provider configuration.

Provider connection state should be global to the app, while the chosen execution profile remains per card/run. Hermes profiles remain server-owned and should be selected by reference, not copied into Patchdeck.

### 4. Preserve the safety boundary

Reuse authenticated local CLIs where possible. If Patchdeck later stores API keys, keep them out of React state and local storage; use a Rust-owned credential boundary backed by macOS Keychain or another OS-protected store. Show capabilities and risk clearly per profile. A provider test should be read-only and should not start a billable task.

### 5. Protect the differentiated roadmap

The next valuable scope is:

1. Connections/settings foundation.
2. Provider and Hermes profile discovery.
3. Destination-plus-executor card creation.
4. Federated All Work projection with source badges and filters.
5. Source-correct drawers and mutations.
6. Explicit cross-source handoff.

Org charts, autonomous heartbeat scheduling, company goals, hiring approvals, and cross-company budgets would move Patchdeck directly into Paperclip's category. They are not needed to deliver the unified developer cockpit.
