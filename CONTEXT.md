# Patchdeck Workbench

Patchdeck keeps planned repository work separate from the agent conversations that execute it, whether those conversations are local or managed by Hermes.

## Language

**Card**:
A persistent piece of planned work on a Patchdeck board. A card can exist without an agent or a run.
_Avoid_: Task, ticket

**Agent Runtime**:
A directly invokable coding environment, such as Codex or Claude Code, that can execute a Local Board card.
_Avoid_: Provider, agent, model, assignee

**Orchestrator**:
An external system, such as Hermes, that owns boards, execution profiles, dispatch, and task lifecycle.
_Avoid_: Provider, agent runtime

**Work Destination**:
The board that will own newly created work, either the Local Board or a named board owned by an orchestrator.
_Avoid_: Provider, executor

**Execution Profile**:
A reusable selection of an Agent Runtime and its execution policy. Orchestrator-owned profiles are referenced but remain owned by their orchestrator.
_Avoid_: Provider, model, assignee

**Work Projection**:
A combined view of work from multiple boards that preserves the owner and identity of every item.
_Avoid_: Synced board, copied board

**Run**:
A persistent Agent Runtime conversation attached to one card. A run may contain multiple user turns and can be resumed after it becomes idle.
_Avoid_: Chat, session, worker

**Turn**:
One user message and the provider work that follows within a run.
_Avoid_: Run, task

**Local Board**:
Patchdeck's own repository-scoped board, available without Hermes. Its cards and runs are owned and persisted by Patchdeck.
_Avoid_: Offline board, fallback board

**Hermes Board**:
A board owned by an attached Hermes server and displayed by Patchdeck without copying its cards into the Local Board.
_Avoid_: Remote board, synced board
