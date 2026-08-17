import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloseIcon, PlusIcon, RefreshIcon } from "../components/icons";
import { errorMessage } from "../errors";
import { listAgentRuntimes } from "../providers/api";
import {
  executionProfileForRepository,
  useExecutionProfiles,
} from "../providers/profiles";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeId, AgentRuntimeStatus } from "../providers/types";
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
}

export function LocalBoard({
  repositoryPath,
  initialCardId,
  onCreateWork,
  onSendToHermes,
  onOpenHermesBoard,
}: LocalBoardProps) {
  const board = useLocalBoardDocument();
  const profileDocument = useExecutionProfiles();
  const [createLane, setCreateLane] = useState<LocalLane | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(initialCardId ?? null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [checkingProviders, setCheckingProviders] = useState(true);
  const previousRepositoryPath = useRef(repositoryPath);
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
    if (!profile || !runtimeReady(runtimes, profile.runtimeId)) return;
    await launchLocalCard(card, profile);
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
        <button className="primary-button board-create-button" onClick={() => requestCreate("todo")}><PlusIcon /> New work</button>
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
            if (profile) void launchCard(card, profile);
          }}
        />
      )}
      {selectedCard && (
        <LocalCardDrawer
          card={selectedCard}
          run={latestRunForCard(selectedCard.id)}
          profiles={profileDocument.profiles}
          runtimes={runtimes}
          onClose={() => setSelectedCardId(null)}
          onLaunch={(profile) => void launchCard(selectedCard, profile)}
          onSendToHermes={onSendToHermes ? () => onSendToHermes(selectedCard) : undefined}
          onOpenHermesBoard={onOpenHermesBoard}
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

function LocalCardDrawer({ card, run, profiles, runtimes, onClose, onLaunch, onSendToHermes, onOpenHermesBoard }: {
  card: LocalCard;
  run: LocalRun | null;
  profiles: ExecutionProfile[];
  runtimes: AgentRuntimeStatus[];
  onClose: () => void;
  onLaunch: (profile: ExecutionProfile) => void;
  onSendToHermes?: () => void;
  onOpenHermesBoard?: (board: string, taskId?: string) => void;
}) {
  const [reply, setReply] = useState("");
  const [profileId, setProfileId] = useState(card.executionProfileId ?? executionProfileForRepository(card.repositoryPath)?.id ?? "");
  const busy = run?.status === "starting" || run?.status === "running";
  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  const label = run ? runtimeLabel(run.runtimeId) : selectedProfile?.name ?? "Agent";

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    const message = reply.trim();
    if (!run?.sessionId || !message || busy) return;
    setReply("");
    await continueLocalRun(run, card.repositoryPath, message);
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
            {!run ? (
              <div className="local-provider-empty">
                <p>Choose an execution profile. The run stays attached to this local card and repository.</p>
                <select aria-label="Execution profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!runtimeReady(runtimes, profile.runtimeId)}>{profile.name}{runtimeReady(runtimes, profile.runtimeId) ? "" : " (unavailable)"}</option>)}
                </select>
                <button className="primary-button" onClick={() => selectedProfile && onLaunch(selectedProfile)} disabled={!selectedProfile || !runtimeReady(runtimes, selectedProfile.runtimeId)}>Run with {selectedProfile ? runtimeLabel(selectedProfile.runtimeId) : "agent"}</button>
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
                ) : run.sessionId ? (
                  <form className="local-run-composer" onSubmit={sendReply}>
                    <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={3} placeholder={`Continue this ${runtimeLabel(run.runtimeId)} conversation…`} aria-label={`Message ${runtimeLabel(run.runtimeId)}`} />
                    <button className="primary-button" disabled={!reply.trim()}>Send</button>
                  </form>
                ) : (
                  <button className="secondary-button" onClick={() => selectedProfile && onLaunch(selectedProfile)} disabled={!selectedProfile || !runtimeReady(runtimes, selectedProfile.runtimeId)}>Retry with {label}</button>
                )}
              </>
            )}
          </section>
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
  const label = run.status === "idle" ? "ready" : run.status;
  return <span className={`local-run-status run-${run.status}`}>{(run.status === "starting" || run.status === "running") && <span className="live-pulse" />}{label}</span>;
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
