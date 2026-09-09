import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloseIcon, PlusIcon, RefreshIcon } from "../components/icons";
import { errorMessage } from "../errors";
import { compareWorkingTree, openRepository } from "../api";
import { listAgentRuntimes } from "../providers/api";
import {
  executionProfileForRepository,
  useExecutionProfiles,
} from "../providers/profiles";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeId, AgentRuntimeStatus } from "../providers/types";
import { attachCardWorktree, createCardWorktree, listCardWorktrees } from "../providers/workspaces";
import type { CardWorktree, CardWorkspace } from "../providers/workspaces";
import type { ReviewTarget } from "../review/inlineComments";
import type { Branch } from "../types";
import { continueLocalRun, launchLocalCard, runtimeLabel, stopLocalRun } from "./runtime";
import {
  createLocalCard,
  latestRunForCard,
  patchLocalCard,
  useLocalBoardDocument,
} from "./store";
import { LOCAL_LANES } from "./types";
import type { LocalCard, LocalLane, LocalRun } from "./types";
import "./boards.css";

const LANE_LABELS: Record<LocalLane, string> = {
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export interface LocalBoardProps {
  repositoryPath?: string;
  initialCardId?: string | null;
  onCreateWork?: (lane: LocalLane) => void;
  onSendToHermes?: (card: LocalCard) => void;
  onOpenHermesBoard?: (board: string, taskId?: string) => void;
  onReviewTask?: (target: ReviewTarget) => void;
}

export function LocalBoard({
  repositoryPath,
  initialCardId,
  onCreateWork,
  onSendToHermes,
  onOpenHermesBoard,
  onReviewTask,
}: LocalBoardProps) {
  const board = useLocalBoardDocument();
  const profileDocument = useExecutionProfiles();
  const [createLane, setCreateLane] = useState<LocalLane | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(initialCardId ?? null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [checkingProviders, setCheckingProviders] = useState(true);
  const previousRepositoryPath = useRef(repositoryPath);
  const launchingCards = useRef(new Set<string>());
  const cards = useMemo(
    () => board.cards.filter((card) => card.repositoryPath === repositoryPath),
    [board.cards, repositoryPath],
  );
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;

  async function refreshProviders() {
    setCheckingProviders(true);
    try {
      setRuntimes(await listAgentRuntimes());
      setProviderError(null);
    } catch (error) {
      setRuntimes([]);
      setProviderError(errorMessage(error));
    } finally {
      setCheckingProviders(false);
    }
  }

  useEffect(() => {
    void refreshProviders();
  }, []);

  useEffect(() => {
    if (initialCardId) setSelectedCardId(initialCardId);
  }, [initialCardId]);

  useEffect(() => {
    if (previousRepositoryPath.current === repositoryPath) return;
    previousRepositoryPath.current = repositoryPath;
    setSelectedCardId((cardId) => cards.some((card) => card.id === cardId) ? cardId : null);
  }, [cards, repositoryPath]);

  if (!repositoryPath) {
    return <div className="board-loading">Open a repository to use the local board.</div>;
  }

  function requestCreate(lane: LocalLane) {
    if (onCreateWork) onCreateWork(lane);
    else setCreateLane(lane);
  }

  function dropCard(event: DragEvent, lane: LocalLane) {
    event.preventDefault();
    const cardId = event.dataTransfer.getData("application/x-patchdeck-card");
    if (cardId) patchLocalCard(cardId, { lane });
  }

  async function launchCard(card: LocalCard, requestedProfile?: ExecutionProfile) {
    const profile = requestedProfile
      ?? profileDocument.profiles.find((candidate) => candidate.id === card.executionProfileId)
      ?? executionProfileForRepository(card.repositoryPath);
    if (!profile || !runtimeReady(runtimes, profile.runtimeId) || launchingCards.current.has(card.id)) return;
    if (!card.workspace) {
      setProviderError("Create or attach the workspace before starting this card.");
      return;
    }
    launchingCards.current.add(card.id);
    try {
      await launchLocalCard(card, profile);
    } catch (reason) {
      setProviderError(errorMessage(reason));
    } finally {
      launchingCards.current.delete(card.id);
    }
  }

  const readyCount = runtimes.filter((runtime) => runtime.ready).length;

  return (
    <main className="agent-board local-board">
      <header className="agent-board-toolbar">
        <div className="agent-board-title">
          <span className="agent-kicker">Local board</span>
          <strong>{repositoryName(repositoryPath)}</strong>
        </div>
        <span className={`provider-health ${readyCount ? "available" : "unavailable"}`}>
          <span className="live-pulse" />
          {checkingProviders ? "Checking agents…" : `${readyCount} agent${readyCount === 1 ? "" : "s"} ready`}
        </span>
        <button className="icon-button" aria-label="Check agent providers" title="Check agent providers" onClick={() => void refreshProviders()} disabled={checkingProviders}><RefreshIcon /></button>
        {!onCreateWork && <button className="primary-button board-create-button" onClick={() => requestCreate("todo")}><PlusIcon /> New work</button>}
      </header>

      {!checkingProviders && providerError && <div className="board-error" role="alert">{providerError}</div>}

      <div className="kanban-scroll" aria-label="Local Kanban board">
        <div className="kanban-columns local-kanban-columns">
          {LOCAL_LANES.map((lane) => {
            const laneCards = cards.filter((card) => card.lane === lane);
            return (
              <section
                className={`kanban-column lane-${lane}`}
                key={lane}
                aria-label={`${LANE_LABELS[lane]} cards`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => dropCard(event, lane)}
              >
                <header>
                  <span className="lane-dot" />
                  <strong>{LANE_LABELS[lane]}</strong>
                  <span className="lane-count">{laneCards.length}</span>
                  <button className="lane-create-button" aria-label={`New card in ${LANE_LABELS[lane]}`} onClick={() => requestCreate(lane)}>+</button>
                </header>
                <div className="kanban-card-list">
                  {laneCards.map((card) => (
                    <LocalCardView
                      key={card.id}
                      card={card}
                      run={latestRunForCard(card.id)}
                      profile={profileDocument.profiles.find((candidate) => candidate.id === card.executionProfileId)}
                      onOpen={() => setSelectedCardId(card.id)}
                    />
                  ))}
                  {laneCards.length === 0 && <div className="empty-lane">Drop cards here</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {createLane && (
        <LocalCreateDialog
          lane={createLane}
          repositoryPath={repositoryPath}
          profiles={profileDocument.profiles}
          runtimes={runtimes}
          onClose={() => setCreateLane(null)}
          onCreated={(card, profile) => {
            setCreateLane(null);
            setSelectedCardId(card.id);
            if (profile) void (async () => {
              try {
                const info = await openRepository(card.repositoryPath);
                const baseBranch = info.suggestedBaseBranch ?? "main";
                const workspace = await createCardWorktree({ repositoryPath: card.repositoryPath, cardId: card.id, baseBranch });
                patchLocalCard(card.id, { workspace });
                await launchCard({ ...card, workspace }, profile);
              } catch (reason) {
                setProviderError(errorMessage(reason));
              }
            })();
          }}
        />
      )}
      {selectedCard && (
        <LocalCardDrawer
          key={selectedCard.id}
          card={selectedCard}
          run={latestRunForCard(selectedCard.id)}
          profiles={profileDocument.profiles}
          runtimes={runtimes}
          onClose={() => setSelectedCardId(null)}
          onLaunch={(profile) => void launchCard(selectedCard, profile)}
          onSendToHermes={onSendToHermes ? () => onSendToHermes(selectedCard) : undefined}
          onOpenHermesBoard={onOpenHermesBoard}
          onReviewTask={onReviewTask}
        />
      )}
    </main>
  );
}

function LocalCardView({ card, run, profile, onOpen }: {
  card: LocalCard;
  run: LocalRun | null;
  profile?: ExecutionProfile;
  onOpen: () => void;
}) {
  return (
    <button
      className="kanban-card local-kanban-card"
      draggable
      onDragStart={(event) => event.dataTransfer.setData("application/x-patchdeck-card", card.id)}
      onClick={onOpen}
    >
      <span className="task-source-badge source-local">Local</span>
      <span className="task-id">{shortId(card.id)}</span>
      <strong>{card.title}</strong>
      {card.body && <p>{card.body}</p>}
      <span className="task-card-footer">
        <span className="task-assignee">{profile?.name ?? (run ? runtimeLabel(run.runtimeId) : "No agent")}</span>
        {run && <RunStatus run={run} />}
      </span>
      <span className="task-card-footer">Last activity {formatActivity(run?.updatedAt ?? card.updatedAt)}</span>
    </button>
  );
}

function LocalCreateDialog({ lane, repositoryPath, profiles, runtimes, onClose, onCreated }: {
  lane: LocalLane;
  repositoryPath: string;
  profiles: ExecutionProfile[];
  runtimes: AgentRuntimeStatus[];
  onClose: () => void;
  onCreated: (card: LocalCard, profile: ExecutionProfile | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [profileId, setProfileId] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const profile = profiles.find((candidate) => candidate.id === profileId) ?? null;
    const card = createLocalCard({ repositoryPath, title, body, lane, executionProfileId: profile?.id ?? null });
    onCreated(card, profile);
  }

  return (
    <div className="modal-backdrop">
      <form className="task-create-dialog local-card-dialog" role="dialog" aria-modal="true" aria-label="Create local work" onSubmit={submit}>
        <header>
          <div><span>Local board</span><strong>New work in {LANE_LABELS[lane]}</strong></div>
          <button type="button" className="plain-close" onClick={onClose} aria-label="Close work form">×</button>
        </header>
        <label>Title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} /></label>
        <label>Instructions<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} placeholder="Describe the outcome, constraints, and checks…" /></label>
        <label>Executor
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">No agent yet</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id} disabled={!runtimeReady(runtimes, profile.runtimeId)}>
                {profile.name}{runtimeReady(runtimes, profile.runtimeId) ? "" : " (unavailable)"}
              </option>
            ))}
          </select>
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={!title.trim()}>{profileId ? "Create & run" : "Create work"}</button>
        </footer>
      </form>
    </div>
  );
}

function LocalCardDrawer({ card, run, profiles, runtimes, onClose, onLaunch, onSendToHermes, onOpenHermesBoard, onReviewTask }: {
  card: LocalCard;
  run: LocalRun | null;
  profiles: ExecutionProfile[];
  runtimes: AgentRuntimeStatus[];
  onClose: () => void;
  onLaunch: (profile: ExecutionProfile) => void;
  onSendToHermes?: () => void;
  onOpenHermesBoard?: (board: string, taskId?: string) => void;
  onReviewTask?: (target: ReviewTarget) => void;
}) {
  const [reply, setReply] = useState("");
  const [profileId, setProfileId] = useState(card.executionProfileId ?? executionProfileForRepository(card.repositoryPath)?.id ?? "");
  const busy = run?.status === "starting" || run?.status === "running";
  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const label = run ? runtimeLabel(run.runtimeId) : selectedProfile?.name ?? "Agent";
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [changedCount, setChangedCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    if (!card.workspace) {
      setChangedCount(null);
      return;
    }
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void compareWorkingTree(card.workspace!.worktreePath, card.workspace!.baseBranch)
        .then((comparison) => active && setChangedCount(comparison.files.length))
        .catch(() => active && setChangedCount(null))
        .finally(() => { inFlight = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [card.updatedAt, card.workspace]);

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    const message = reply.trim();
    if (!run?.sessionId || !message || busy) return;
    setReply("");
    await continueLocalRun(run, run.repositoryPath ?? card.workspace?.worktreePath ?? card.repositoryPath, message);
  }

  return (
    <div className="task-drawer-backdrop">
      <aside className="task-drawer local-card-drawer" aria-label={`${card.title} card details`}>
        <header className="task-drawer-header">
          <div><span>{shortId(card.id)} · Local card</span><strong>{card.title}</strong></div>
          <button className="plain-close" onClick={onClose} aria-label="Close card details"><CloseIcon /></button>
        </header>
        <div className="task-state-row">
          <span className={`status-pill status-${card.lane}`}>{LANE_LABELS[card.lane]}</span>
          <label>Lane
            <select value={card.lane} onChange={(event) => patchLocalCard(card.id, { lane: event.target.value as LocalLane })}>
              {LOCAL_LANES.map((lane) => <option key={lane} value={lane}>{LANE_LABELS[lane]}</option>)}
            </select>
          </label>
          <span className="drawer-assignee">{run ? runtimeLabel(run.runtimeId) : "No agent"}</span>
        </div>
        <div className="drawer-scroll local-run-scroll">
          <section className="drawer-section">
            <h3>Instructions</h3>
            {card.body ? <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{card.body}</ReactMarkdown></div> : <p className="section-empty">No extra instructions.</p>}
          </section>
          {card.hermesHandoffs.length > 0 && (
            <section className="drawer-section local-handoffs">
              <h3>Hermes handoffs</h3>
              {card.hermesHandoffs.map((handoff) => (
                <button key={`${handoff.board}:${handoff.taskId}`} className="handoff-link" onClick={() => onOpenHermesBoard?.(handoff.board, handoff.taskId)}>
                  <span>Hermes · {handoff.board}</span><strong>{handoff.taskId}</strong><em>Open source</em>
                </button>
              ))}
            </section>
          )}
          <section className="drawer-section local-run-section">
            <h3>Agent conversation {run && <RunStatus run={run} />}</h3>
            {run && !run.repositoryPath && <div className="drawer-error">This older conversation has no recorded workspace. Start a new card in an isolated workspace to continue safely.</div>}
            {!run ? (
              <div className="local-provider-empty">
                <p>Choose an execution profile and an isolated workspace. New work starts from the base branch. Uncommitted changes in the original checkout are not copied.</p>
                <WorkspacePicker card={card} disabled={busy} onError={setWorkspaceError} />
                {workspaceError && <div className="drawer-error" role="alert">{workspaceError}</div>}
                <select aria-label="Execution profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!runtimeReady(runtimes, profile.runtimeId)}>{profile.name}{runtimeReady(runtimes, profile.runtimeId) ? "" : " (unavailable)"}</option>)}
                </select>
                <button className="primary-button" onClick={() => selectedProfile && onLaunch(selectedProfile)} disabled={!card.workspace || !selectedProfile || !runtimeReady(runtimes, selectedProfile.runtimeId)}>Run with {selectedProfile ? runtimeLabel(selectedProfile.runtimeId) : "agent"}</button>
              </div>
            ) : (
              <>
                <div className="local-run-messages" aria-live="polite">
                  {run.messages.map((message) => (
                    <article className={`local-run-message role-${message.role}`} key={message.id}>
                      <strong>{message.role === "agent" ? label : message.role === "user" ? "You" : "Activity"}</strong>
                      {message.role === "agent" ? (
                        <div className="markdown-content compact"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown></div>
                      ) : <p>{message.body}</p>}
                    </article>
                  ))}
                  {busy && <div className="local-agent-thinking"><span className="live-pulse" />{runtimeLabel(run.runtimeId)} is working…</div>}
                </div>
                {run.error && <div className="drawer-error" role="alert">{run.error}</div>}
                {busy ? (
                  <button className="secondary-button stop-run-button" onClick={() => void stopLocalRun(run)}>Stop run</button>
                ) : run.sessionId && run.repositoryPath ? (
                  <form className="local-run-composer" onSubmit={sendReply}>
                    <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} placeholder={`Continue this ${runtimeLabel(run.runtimeId)} conversation…`} aria-label={`Message ${runtimeLabel(run.runtimeId)}`} />
                    <button className="primary-button" disabled={!reply.trim()}>Send</button>
                  </form>
                ) : !run.repositoryPath ? null : (
                  <button className="secondary-button" onClick={() => selectedProfile && onLaunch(selectedProfile)} disabled={!selectedProfile || !runtimeReady(runtimes, selectedProfile.runtimeId)}>Retry with {label}</button>
                )}
              </>
            )}
          </section>
          {card.workspace && onReviewTask && (
            <section className="drawer-section">
              <h3>Changes</h3>
              <p>{card.workspace.branch} from {card.workspace.baseBranch}</p>
              {changedCount !== null && <p>{changedCount} changed file{changedCount === 1 ? "" : "s"}</p>}
              <button className="primary-button" onClick={() => {
                const target = {
                  source: "local",
                  board: "local",
                  taskId: card.id,
                  title: card.title,
                  status: card.lane,
                  repositoryPath: card.workspace!.worktreePath,
                  baseBranch: card.workspace!.baseBranch,
                } as ReviewTarget;
                onReviewTask(target);
              }}>Review changes</button>
            </section>
          )}
          {onSendToHermes && (
            <section className="drawer-section send-to-hermes-section">
              <h3>Orchestrator</h3>
              <p>Send a copy to a Hermes board. This local card and its conversation will remain here.</p>
              <button className="secondary-button" onClick={onSendToHermes}>Send to Hermes…</button>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function RunStatus({ run }: { run: LocalRun }) {
  const label = run.status === "idle" ? "Awaiting review" : run.status;
  return <span className={`local-run-status run-${run.status}`}>{(run.status === "starting" || run.status === "running") && <span className="live-pulse" />}{label}</span>;
}

function WorkspacePicker({ card, disabled, onError }: { card: LocalCard; disabled: boolean; onError: (message: string | null) => void }) {
  const [mode, setMode] = useState<"new" | "branch" | "attach">("new");
  const [baseBranch, setBaseBranch] = useState("main");
  const [worktrees, setWorktrees] = useState<CardWorktree[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "branch") setSelection(branches[0]?.name ?? "");
    if (mode === "attach") setSelection(worktrees[0]?.path ?? "");
  }, [branches, mode, worktrees]);

  useEffect(() => {
    let active = true;
    void openRepository(card.repositoryPath).then((info) => {
      if (active) {
        setBaseBranch(info.suggestedBaseBranch ?? "main");
        setBranches(info.branches);
      }
    }).catch((reason) => active && onError(errorMessage(reason)));
    void listCardWorktrees(card.repositoryPath).then((items) => {
      if (active) {
        setWorktrees(items);
        setSelection(items[0]?.path ?? "");
      }
    }).catch((reason) => active && onError(errorMessage(reason)));
    return () => { active = false; };
  }, [card.repositoryPath]);

  async function bind() {
    setBusy(true);
    onError(null);
    try {
      let workspace: CardWorkspace;
      if (mode === "attach") {
        workspace = await attachCardWorktree({ repositoryPath: card.repositoryPath, worktreePath: selection, baseBranch });
      } else {
        const existingBranch = mode === "branch" ? selection : null;
        workspace = await createCardWorktree({ repositoryPath: card.repositoryPath, cardId: card.id, baseBranch, existingBranch });
      }
      patchLocalCard(card.id, { workspace });
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (card.workspace) return <p className="workspace-binding">Workspace: {card.workspace.worktreePath}<br />Branch: {card.workspace.branch} from {card.workspace.baseBranch}</p>;
  return <div className="workspace-picker">
    <label>Workspace policy<select aria-label="Workspace policy" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} disabled={disabled || busy}>
      <option value="new">New isolated workspace</option>
      <option value="branch">Existing local branch in a new worktree</option>
      <option value="attach">Attach an existing worktree</option>
    </select></label>
    <label>Base branch<input aria-label="Base branch" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} disabled={disabled || busy} /></label>
    {mode !== "new" && <label>{mode === "attach" ? "Worktree" : "Branch"}<select aria-label={mode === "attach" ? "Worktree" : "Existing branch"} value={selection} onChange={(event) => setSelection(event.target.value)} disabled={disabled || busy}>
      {(mode === "attach" ? worktrees.map((item) => ({ value: item.path, label: `${item.path}${item.branch ? ` · ${item.branch}` : ""}` })) : branches.map((branch) => ({ value: branch.name, label: branch.name }))).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>}
    <button type="button" className="secondary-button" onClick={() => void bind()} disabled={disabled || busy || !baseBranch.trim() || (mode !== "new" && !selection)}>{busy ? "Preparing…" : mode === "attach" ? "Attach workspace" : "Create workspace"}</button>
  </div>;
}

function runtimeReady(runtimes: AgentRuntimeStatus[], runtimeId: AgentRuntimeId) {
  return runtimes.some((runtime) => runtime.id === runtimeId && runtime.ready);
}

function repositoryName(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}

function shortId(id: string) {
  const parts = id.split("-");
  return parts[parts.length - 1]?.slice(0, 8) ?? id.slice(0, 8);
}

function formatActivity(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}
