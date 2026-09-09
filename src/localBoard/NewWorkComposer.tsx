import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { createHermesTask, getHermesBoard } from "../hermes/api";
import type { CreateHermesTask, HermesBoardMeta, HermesProfile, HermesTask } from "../hermes/types";
import { errorMessage } from "../errors";
import { listAgentRuntimes } from "../providers/api";
import { executionProfileForRepository, useExecutionProfiles } from "../providers/profiles";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeStatus } from "../providers/types";
import { openRepository } from "../api";
import { createCardWorktree } from "../providers/workspaces";
import { launchLocalCard } from "./runtime";
import { createLocalCard, deleteLocalCard, patchLocalCard } from "./store";
import type { LocalCard, LocalLane } from "./types";

export type NewWorkResult =
  | { source: "local"; card: LocalCard }
  | { source: "hermes"; board: string; taskId: string; warning?: string };

export interface NewWorkComposerProps {
  repositoryPath: string;
  boards: HermesBoardMeta[];
  hermesProfiles: HermesProfile[];
  lane?: LocalLane;
  targetStatus?: string;
  initialDestination?: string;
  handoffCard?: LocalCard | null;
  onClose: () => void;
  onCreated: (result: NewWorkResult) => void;
}

export function NewWorkComposer({
  repositoryPath,
  boards,
  hermesProfiles,
  lane = "todo",
  targetStatus = "todo",
  initialDestination = "local",
  handoffCard,
  onClose,
  onCreated,
}: NewWorkComposerProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const taskRequest = useRef(0);
  const submitting = useRef(false);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  onCloseRef.current = onClose;
  const profileDocument = useExecutionProfiles();
  const [destination, setDestination] = useState(() => handoffCard
    ? (initialDestination.startsWith("hermes:") ? initialDestination : boards[0] ? `hermes:${boards[0].slug}` : "")
    : initialDestination);
  const [executor, setExecutor] = useState("");
  const [title, setTitle] = useState(handoffCard?.title ?? "");
  const [body, setBody] = useState(handoffCard?.body ?? "");
  const [priority, setPriority] = useState("0");
  const [skills, setSkills] = useState("");
  const [workspaceKind, setWorkspaceKind] = useState<CreateHermesTask["workspace_kind"]>("scratch");
  const [workspacePath, setWorkspacePath] = useState("");
  const [parent, setParent] = useState("");
  const [parentTasks, setParentTasks] = useState<HermesTask[]>([]);
  const [goalMode, setGoalMode] = useState(false);
  const [goalMaxTurns, setGoalMaxTurns] = useState("");
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLocal = destination === "local";
  const destinationBoard = boards.find((board) => `hermes:${board.slug}` === destination) ?? null;

  useEffect(() => {
    void listAgentRuntimes().then(setRuntimes).catch(() => setRuntimes([]));
  }, []);

  useEffect(() => {
    const currentDialog = dialogRef.current;
    if (!currentDialog) return;
    const dialog: HTMLFormElement = currentDialog;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function containFocus(event: FocusEvent) {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        focusableElements(dialog)[0]?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", containFocus);
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", containFocus);
      returnFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (isLocal) {
      const preferred = executionProfileForRepository(repositoryPath);
      setExecutor((current) => current && profileDocument.profiles.some((profile) => profile.id === current)
        ? current
        : preferred?.id ?? "");
      return;
    }
    const preferred = hermesProfiles.find((profile) => profile.is_default) ?? hermesProfiles[0];
    setExecutor((current) => current && hermesProfiles.some((profile) => profile.name === current)
      ? current
      : preferred?.name ?? "");
  }, [destination, hermesProfiles, isLocal, profileDocument.profiles, repositoryPath]);

  useEffect(() => {
    const request = ++taskRequest.current;
    setParent("");
    setParentTasks([]);
    if (!destinationBoard) return;
    const workspace = hermesWorkspace(destinationBoard, repositoryPath);
    setWorkspaceKind(workspace.kind);
    setWorkspacePath(workspace.path ?? "");
    void getHermesBoard(destinationBoard.slug, false)
      .then((board) => {
        if (request === taskRequest.current) setParentTasks(board.columns.flatMap((column) => column.tasks));
      })
      .catch(() => {
        if (request === taskRequest.current) setParentTasks([]);
      });
    return () => {
      if (request === taskRequest.current) taskRequest.current += 1;
    };
  }, [destinationBoard, repositoryPath]);

  const selectedExecutionProfile = useMemo(
    () => profileDocument.profiles.find((profile) => profile.id === executor) ?? null,
    [executor, profileDocument.profiles],
  );
  const canSubmit = !!title.trim()
    && (isLocal
      ? !executor || (!!selectedExecutionProfile && isRuntimeReady(runtimes, selectedExecutionProfile))
      : !!destinationBoard);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      if (isLocal) {
        const card = createLocalCard({
          repositoryPath,
          title,
          body,
          lane,
          executionProfileId: selectedExecutionProfile?.id ?? null,
        });
        try {
          if (selectedExecutionProfile) {
            const info = await openRepository(repositoryPath);
            const baseBranch = info.suggestedBaseBranch ?? "main";
            const workspace = await createCardWorktree({ repositoryPath, cardId: card.id, baseBranch });
            patchLocalCard(card.id, { workspace });
            await launchLocalCard({ ...card, workspace }, selectedExecutionProfile);
          }
        } catch (reason) {
          deleteLocalCard(card.id);
          throw reason;
        }
        onCreated({ source: "local", card });
        return;
      }
      if (!destinationBoard) return;
      const workspace = hermesWorkspace(destinationBoard, repositoryPath);
      const payload: CreateHermesTask = {
        title: title.trim(),
        body: body.trim() || null,
        assignee: executor || null,
        triage: targetStatus === "triage",
        priority: Number(priority) || 0,
        parents: parent ? [parent] : [],
        skills: skills.split(",").map((skill) => skill.trim()).filter(Boolean),
        goal_mode: goalMode,
        goal_max_turns: goalMode && Number(goalMaxTurns) > 0 ? Number(goalMaxTurns) : null,
        workspace_kind: workspaceKind,
        workspace_path: workspaceKind === "scratch" ? null : workspacePath.trim() || workspace.path,
      };
      const response = await createHermesTask(destinationBoard.slug, payload, targetStatus);
      if (!response.task?.id) throw new Error("Hermes did not return the created task.");
      onCreated({ source: "hermes", board: destinationBoard.slug, taskId: response.task.id, warning: response.warning });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form ref={dialogRef} className="task-create-dialog shared-work-composer" role="dialog" aria-modal="true" aria-label={handoffCard ? "Send local card to Hermes" : "Create new work"} onSubmit={submit}>
        <header>
          <div>
            <span>{handoffCard ? "Explicit handoff" : "Agent board"}</span>
            <strong>{handoffCard ? "Send local card to Hermes" : "New work"}</strong>
          </div>
          <button type="button" className="plain-close" onClick={onClose} aria-label="Close work form">×</button>
        </header>
        {handoffCard && <p className="handoff-context">Hermes receives a new task. The local card, its lane, and its agent conversation stay unchanged.</p>}
        <div className="new-work-routing">
          <label>Destination
            <select aria-label="Destination" value={destination} onChange={(event) => setDestination(event.target.value)}>
              {!handoffCard && <option value="local">Local Board</option>}
              {boards.map((board) => <option key={board.slug} value={`hermes:${board.slug}`}>Hermes · {board.name || board.slug}</option>)}
            </select>
          </label>
          <label>Executor
            <select aria-label="Executor" value={executor} onChange={(event) => setExecutor(event.target.value)}>
              {isLocal ? (
                <>
                  <option value="">No agent yet</option>
                  {profileDocument.profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!isRuntimeReady(runtimes, profile)}>{profile.name}{isRuntimeReady(runtimes, profile) ? "" : " (unavailable)"}</option>)}
                </>
              ) : (
                <>
                  <option value="">Dispatcher picks</option>
                  {hermesProfiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}{profile.is_default ? " · default" : ""}</option>)}
                </>
              )}
            </select>
          </label>
        </div>
        <p className="new-work-context">
          {isLocal
            ? "Patchdeck owns this card. Selecting an execution profile starts its agent conversation immediately."
            : `Hermes owns this task on ${destinationBoard?.name || destinationBoard?.slug || "the selected board"}. Updates remain in Hermes.`}
        </p>
        <label>Title
          {isLocal ? (
            <input ref={titleRef as RefObject<HTMLInputElement>} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          ) : (
            <textarea
              ref={titleRef as RefObject<HTMLTextAreaElement>}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              required
              maxLength={200}
              rows={3}
              placeholder={targetStatus === "triage" ? "Rough idea — AI will spec it…" : "New task title…"}
            />
          )}
        </label>
        <label>Instructions<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} placeholder="Describe the outcome, constraints, and checks…" /></label>
        {!isLocal && (
          <div className="hermes-work-fields">
            <div className="form-grid task-routing-grid">
              <label>Priority<input aria-label="Priority" type="number" value={priority} onChange={(event) => setPriority(event.target.value)} /></label>
              <label>Skills <span>(optional, comma-separated)</span><input aria-label="Skills" value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="testing, code-review" /></label>
            </div>
            <label>Workspace
              <div className="workspace-fields">
                <select aria-label="Workspace" value={workspaceKind} onChange={(event) => setWorkspaceKind(event.target.value as CreateHermesTask["workspace_kind"])}>
                  <option value="scratch">Temporary — deleted on completion</option>
                  <option value="worktree">Git worktree — preserved</option>
                  <option value="dir">Directory — preserved</option>
                </select>
                {workspaceKind !== "scratch" && <input aria-label="Workspace path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Workspace path" />}
              </div>
            </label>
            <label>Parent task <span>(child stays blocked until the parent is done)</span>
              <select aria-label="Parent task" value={parent} onChange={(event) => setParent(event.target.value)}>
                <option value="">— no parent —</option>
                {parentTasks.map((task) => <option key={task.id} value={task.id}>{task.id} — {task.title}</option>)}
              </select>
            </label>
            <div className="goal-mode-row">
              <label className="goal-mode-check"><input type="checkbox" checked={goalMode} onChange={(event) => setGoalMode(event.target.checked)} aria-label="Goal mode" />Goal mode</label>
              {goalMode && <input aria-label="Goal max turns" type="number" min="1" value={goalMaxTurns} onChange={(event) => setGoalMaxTurns(event.target.value)} placeholder="max turns (default 20)" />}
            </div>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={saving || !canSubmit}>{saving ? "Creating…" : handoffCard ? "Confirm send" : isLocal && selectedExecutionProfile ? "Create & run" : "Create work"}</button>
        </footer>
      </form>
    </div>
  );
}

function isRuntimeReady(runtimes: AgentRuntimeStatus[], profile: ExecutionProfile) {
  return runtimes.some((runtime) => runtime.id === profile.runtimeId && runtime.ready);
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

export function hermesWorkspace(board: HermesBoardMeta, repositoryPath: string): {
  kind: CreateHermesTask["workspace_kind"];
  path: string | null;
} {
  if (repositoryPath) {
    return {
      kind: board.default_workspace_kind === "worktree" ? "worktree" : "dir",
      path: repositoryPath,
    };
  }
  const kind = board.default_workspace_kind ?? "scratch";
  return { kind, path: kind === "scratch" ? null : board.default_workdir ?? null };
}
