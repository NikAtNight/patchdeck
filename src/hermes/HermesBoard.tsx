import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  addHermesTaskLink,
  addHermesComment,
  createHermesTask,
  deleteHermesAttachment,
  downloadHermesAttachment,
  getHermesBoard,
  getHermesTask,
  getHermesTaskLog,
  listHermesHomeChannels,
  listHermesBoards,
  listHermesProfiles,
  patchHermesTaskStatus,
  removeHermesTaskLink,
  setHermesHomeSubscription,
  subscribeHermesEvents,
  unsubscribeHermesEvents,
  uploadHermesAttachment,
} from "./api";
import type {
  CreateHermesTask,
  HermesBoard as HermesBoardData,
  HermesBoardMeta,
  HermesHomeChannel,
  HermesProfile,
  HermesSessionController,
  HermesTask,
  HermesTaskDetail,
  HermesWorkerLog,
} from "./types";
import type { ReviewTarget } from "../review/inlineComments";
import { RefreshIcon } from "../components/icons";
import { errorMessage } from "../errors";

const LEGACY_BOARD_KEY = "branch-diff-viewer.hermes.selected-board";
const BOARD_SELECTIONS_KEY = "branch-diff-viewer.hermes.selected-boards";
const NO_REPOSITORY_SCOPE = "__no_repository__";
const CANONICAL_COLUMNS = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"];
// The UI uses the actionable subset of Rust's create allowlist. Terminal lanes
// are intentionally excluded even though Hermes can represent imported tasks there.
const CREATABLE_COLUMNS = new Set(["triage", "todo", "ready", "blocked"]);
const TASK_TRANSITIONS: Record<string, string[]> = {
  triage: ["todo", "ready", "archived"],
  todo: ["ready", "blocked", "archived"],
  scheduled: ["blocked", "archived"],
  ready: ["blocked", "archived"],
  running: ["blocked"],
  blocked: ["ready", "archived"],
  review: ["ready", "done"],
  done: ["archived"],
  archived: [],
};
const COLUMN_LABELS: Record<string, string> = {
  triage: "Triage",
  todo: "To do",
  scheduled: "Scheduled",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  archived: "Archived",
};

function boardSelectionScope(repositoryPath?: string) {
  return repositoryPath?.trim() || NO_REPOSITORY_SCOPE;
}

function readBoardSelections(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BOARD_SELECTIONS_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const selections: Record<string, string> = {};
    for (const [scope, board] of Object.entries(stored)) {
      if (scope && typeof board === "string" && board) selections[scope] = board;
    }
    return selections;
  } catch {
    return {};
  }
}

function readBoardSelection(repositoryPath?: string) {
  return readBoardSelections()[boardSelectionScope(repositoryPath)] ?? localStorage.getItem(LEGACY_BOARD_KEY) ?? "";
}

function persistBoardSelection(repositoryPath: string | undefined, board: string) {
  localStorage.setItem(BOARD_SELECTIONS_KEY, JSON.stringify({
    ...readBoardSelections(),
    [boardSelectionScope(repositoryPath)]: board,
  }));
  localStorage.removeItem(LEGACY_BOARD_KEY);
}

export function HermesBoard({ session, repositoryPath, onReviewTask }: {
  session: HermesSessionController;
  repositoryPath?: string;
  onReviewTask: (target: ReviewTarget) => void;
}) {
  const connected = session.status.state === "connected" || session.status.state === "degraded";
  const refreshConnection = session.refresh;
  const [boards, setBoards] = useState<HermesBoardMeta[]>([]);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [selectedBoard, setSelectedBoard] = useState(() => readBoardSelection(repositoryPath));
  const [board, setBoard] = useState<HermesBoardData | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [createColumn, setCreateColumn] = useState<string | null>(null);
  const [eventsLive, setEventsLive] = useState(false);
  const [taskEventNonce, setTaskEventNonce] = useState(0);
  const selectedTaskRef = useRef<string | null>(null);
  selectedTaskRef.current = selectedTaskId;
  const eventRefreshTimer = useRef<number | undefined>(undefined);
  const boardRequest = useRef(0);
  const metadataRequest = useRef(0);
  const repositoryScopeRef = useRef(boardSelectionScope(repositoryPath));

  const loadMetadata = useCallback(async () => {
    if (!connected) return;
    const request = ++metadataRequest.current;
    const scope = boardSelectionScope(repositoryPath);
    try {
      const [boardResponse, profileResponse] = await Promise.all([listHermesBoards(), listHermesProfiles()]);
      if (request !== metadataRequest.current || scope !== repositoryScopeRef.current) return;
      setBoards(boardResponse.boards);
      setProfiles(profileResponse.profiles);
      setSelectedBoard((current) => {
        const available = boardResponse.boards.some((candidate) => candidate.slug === current);
        const next = available ? current : boardResponse.current || boardResponse.boards[0]?.slug || "";
        if (next) persistBoardSelection(repositoryPath, next);
        return next;
      });
    } catch (reason) {
      if (request === metadataRequest.current && scope === repositoryScopeRef.current) setError(errorMessage(reason));
    }
  }, [connected, repositoryPath]);

  const loadBoard = useCallback(async (quiet = false) => {
    if (!connected || !selectedBoard) return;
    const request = ++boardRequest.current;
    if (!quiet) setLoading(true);
    try {
      const nextBoard = await getHermesBoard(selectedBoard, includeArchived);
      if (request === boardRequest.current) {
        setBoard(nextBoard);
        setError(null);
      }
    } catch (reason) {
      if (request === boardRequest.current) setError(errorMessage(reason));
    } finally {
      if (!quiet && request === boardRequest.current) setLoading(false);
    }
  }, [connected, includeArchived, selectedBoard]);

  // Scope the connection hook's status poll to this board (for the active
  // worker count) instead of issuing a second status request per board load.
  useEffect(() => {
    if (connected && selectedBoard) void refreshConnection(selectedBoard);
  }, [connected, refreshConnection, selectedBoard]);

  useEffect(() => {
    if (!connected) {
      setBoard(null);
      setBoards([]);
      setProfiles([]);
      return;
    }
    void loadMetadata();
  }, [connected, loadMetadata]);

  useEffect(() => {
    const nextScope = boardSelectionScope(repositoryPath);
    if (nextScope === repositoryScopeRef.current) return;
    repositoryScopeRef.current = nextScope;
    metadataRequest.current += 1;
    boardRequest.current += 1;
    setBoard(null);
    setSelectedTaskId(null);
    setSelectedBoard(readBoardSelection(repositoryPath));
    if (connected) void loadMetadata();
  }, [connected, loadMetadata, repositoryPath]);

  useEffect(() => {
    void loadBoard();
    if (!connected || !selectedBoard) return;
    // With a live event socket the interval is only a safety net.
    const timer = window.setInterval(() => void loadBoard(true), eventsLive ? 60_000 : 8_000);
    return () => {
      boardRequest.current += 1;
      window.clearInterval(timer);
    };
  }, [connected, eventsLive, loadBoard, selectedBoard]);

  useEffect(() => {
    if (!connected || !selectedBoard) return;
    let cancelled = false;

    const unlistenBatches = listen<{ events?: Array<{ task_id?: string }> }>("hermes-events", (event) => {
      if (cancelled) return;
      window.clearTimeout(eventRefreshTimer.current);
      eventRefreshTimer.current = window.setTimeout(() => void loadBoard(true), 250);
      const selected = selectedTaskRef.current;
      if (selected && event.payload?.events?.some((item) => item.task_id === selected)) {
        setTaskEventNonce((nonce) => nonce + 1);
      }
    });
    const unlistenLive = listen<boolean>("hermes-events-live", (event) => {
      if (!cancelled) setEventsLive(event.payload);
    });
    void Promise.resolve(subscribeHermesEvents(selectedBoard, 0)).catch(() => {
      // The polling interval remains the fallback transport.
    });

    return () => {
      cancelled = true;
      setEventsLive(false);
      window.clearTimeout(eventRefreshTimer.current);
      void Promise.resolve(unsubscribeHermesEvents()).catch(() => {});
      void unlistenBatches.then((unlisten) => unlisten());
      void unlistenLive.then((unlisten) => unlisten());
    };
  }, [connected, loadBoard, selectedBoard]);

  const columns = useMemo(() => {
    const byName = new Map((board?.columns ?? []).map((column) => [column.name, column.tasks]));
    const names = includeArchived ? [...CANONICAL_COLUMNS, "archived"] : CANONICAL_COLUMNS;
    const known = names.map((name) => ({ name, tasks: byName.get(name) ?? [] }));
    // Never drop tasks: lanes Hermes reports beyond the canonical set render
    // after them instead of silently disappearing.
    const extras = (board?.columns ?? [])
      .filter((column) => !names.includes(column.name) && column.name !== "archived")
      .map((column) => ({ name: column.name, tasks: column.tasks }));
    return [...known, ...extras];
  }, [board, includeArchived]);

  function chooseBoard(slug: string) {
    boardRequest.current += 1;
    setBoard(null);
    setSelectedBoard(slug);
    persistBoardSelection(repositoryPath, slug);
    setSelectedTaskId(null);
  }

  if (!connected) {
    return (
      <main className="agent-board disconnected-board">
        <div className="agent-empty-mark"><AgentIcon /></div>
        <p className="eyebrow">HERMES AGENT</p>
        <h1>Bring the work and the code together.</h1>
        <p>Use <strong>Connect Hermes</strong> in the top-right to open the native task board, worker activity, runs, logs, and human feedback loop.</p>
      </main>
    );
  }

  return (
    <main className="agent-board">
      <header className="agent-board-toolbar">
        <div className="agent-board-title">
          <span className="agent-kicker">Agent board</span>
          <strong>{boards.find((candidate) => candidate.slug === selectedBoard)?.name || selectedBoard || "Hermes Kanban"}</strong>
        </div>
        <label className="board-select-label">Board
          <select value={selectedBoard} onChange={(event) => chooseBoard(event.target.value)}>
            {boards.map((candidate) => <option key={candidate.slug} value={candidate.slug}>{candidate.name || candidate.slug} · {candidate.total ?? 0}</option>)}
          </select>
        </label>
        <label className="archive-toggle">
          <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
          Archived
        </label>
        <span className="agent-worker-summary"><span className="live-pulse" />{session.status.activeWorkers} active workers</span>
        <button className="icon-button" aria-label="Refresh agent board" title="Refresh agent board" onClick={() => void loadBoard()} disabled={loading}><RefreshIcon /></button>
      </header>

      {error && <div className="board-error" role="alert">{error}</div>}
      {notice && <div className="board-error" role="alert">{notice}</div>}
      {loading && !board ? (
        <div className="board-loading">Loading Hermes board…</div>
      ) : (
        <div className="kanban-scroll" aria-label="Hermes Kanban board">
          <div className="kanban-columns">
            {columns.map((column) => (
              <section className={`kanban-column lane-${column.name}`} key={column.name} aria-label={`${COLUMN_LABELS[column.name] ?? column.name} tasks`}>
                <header>
                  <span className="lane-dot" />
                  <strong>{COLUMN_LABELS[column.name] ?? column.name}</strong>
                  <span className="lane-count">{column.tasks.length}</span>
                  {CREATABLE_COLUMNS.has(column.name) && (
                    <button className="lane-create-button" aria-label={`New task in ${COLUMN_LABELS[column.name] ?? column.name}`} onClick={() => setCreateColumn(column.name)}>+</button>
                  )}
                </header>
                <div className="kanban-card-list">
                  {column.tasks.map((task) => <TaskCard key={task.id} task={task} onOpen={() => setSelectedTaskId(task.id)} />)}
                  {column.tasks.length === 0 && <div className="empty-lane">No tasks</div>}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {createColumn && (
        <CreateTaskDialog
          board={selectedBoard}
          targetColumn={createColumn}
          boardMeta={boards.find((candidate) => candidate.slug === selectedBoard)}
          profiles={profiles}
          tasks={columns.flatMap((column) => column.tasks)}
          onClose={() => setCreateColumn(null)}
          onCreated={(warning) => { setCreateColumn(null); setNotice(warning ?? null); void loadBoard(); }}
        />
      )}
      {selectedTaskId && (
        <TaskDrawer
          key={`${selectedBoard}:${selectedTaskId}`}
          board={selectedBoard}
          taskId={selectedTaskId}
          eventNonce={taskEventNonce}
          eventsLive={eventsLive}
          onClose={() => setSelectedTaskId(null)}
          onChanged={() => void loadBoard(true)}
          allTasks={columns.flatMap((column) => column.tasks)}
          onOpenTask={setSelectedTaskId}
          onReviewTask={(target) => { setSelectedTaskId(null); onReviewTask(target); }}
        />
      )}
    </main>
  );
}

function TaskCard({ task, onOpen }: { task: HermesTask; onOpen: () => void }) {
  return (
    <button className="kanban-card" onClick={onOpen}>
      <span className="task-id">{task.id}</span>
      <strong>{task.title}</strong>
      {task.latest_summary && <p>{task.latest_summary}</p>}
      <span className="task-card-footer">
        <span className="task-assignee">{task.assignee || "Unassigned"}</span>
        <span className="task-signals">
          {!!task.comment_count && <span title="Comments">◌ {task.comment_count}</span>}
          {task.progress && <span>{task.progress.done}/{task.progress.total}</span>}
          {!!task.warnings?.count && <span className="warning-count">⚠ {task.warnings.count}</span>}
          {task.status === "running" && <span className="running-label"><span className="live-pulse" />live</span>}
        </span>
      </span>
    </button>
  );
}

function CreateTaskDialog({ board, targetColumn, boardMeta, profiles, tasks, onClose, onCreated }: {
  board: string;
  targetColumn: string;
  boardMeta?: HermesBoardMeta;
  profiles: HermesProfile[];
  tasks: HermesTask[];
  onClose: () => void;
  onCreated: (warning?: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("0");
  const [skills, setSkills] = useState("");
  const [workspaceKind, setWorkspaceKind] = useState<"scratch" | "worktree" | "dir">(boardMeta?.default_workspace_kind ?? "scratch");
  const [workspacePath, setWorkspacePath] = useState(boardMeta?.default_workdir ?? "");
  const [parent, setParent] = useState("");
  const [goalMode, setGoalMode] = useState(false);
  const [goalMaxTurns, setGoalMaxTurns] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const payload: CreateHermesTask = {
      title: title.trim(),
      body: null,
      assignee: assignee || null,
      triage: targetColumn === "triage",
      priority: Number(priority) || 0,
      skills: skills.split(",").map((skill) => skill.trim()).filter(Boolean),
      parents: parent ? [parent] : [],
      goal_mode: goalMode,
      goal_max_turns: goalMode && Number(goalMaxTurns) > 0 ? Number(goalMaxTurns) : null,
      workspace_kind: workspaceKind,
      workspace_path: workspaceKind === "scratch" ? null : workspacePath.trim() || null,
    };
    try {
      const response = await createHermesTask(board, payload, targetColumn);
      onCreated(response.warning);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="task-create-dialog" role="dialog" aria-modal="true" aria-label="Create Hermes task" onSubmit={submit}>
        <header><strong>New task — {COLUMN_LABELS[targetColumn] ?? targetColumn}</strong><button type="button" className="plain-close" onClick={onClose} aria-label="Close task form">×</button></header>
        <label>Title<textarea autoFocus required rows={3} value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={targetColumn === "triage" ? "Rough idea — AI will spec it…" : "New task title…"} /></label>
        <div className="form-grid task-routing-grid">
          <label>{targetColumn === "triage" ? "Specifier" : "Assignee"} <span>(blank = dispatcher picks)</span>
            <input aria-label={targetColumn === "triage" ? "Specifier" : "Assignee"} list="hermes-profile-options" value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder={targetColumn === "triage" ? "specifier" : "assignee"} spellCheck={false} />
            <datalist id="hermes-profile-options">{profiles.map((profile) => <option key={profile.name} value={profile.name} />)}</datalist>
          </label>
          <label>Priority<input type="number" value={priority} onChange={(event) => setPriority(event.target.value)} /></label>
        </div>
        <label>Skills <span>(optional, comma-separated)</span><input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="testing, code-review" /></label>
        <label>Workspace<div className="workspace-fields"><select value={workspaceKind} onChange={(event) => setWorkspaceKind(event.target.value as typeof workspaceKind)}><option value="scratch">Temporary — deleted on completion</option><option value="worktree">Git worktree — preserved</option><option value="dir">Directory — preserved</option></select>{workspaceKind !== "scratch" && <input aria-label="Workspace path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Workspace path" />}</div></label>
        <label>Parent task <span>(child stays blocked until the parent is done)</span><select value={parent} onChange={(event) => setParent(event.target.value)}><option value="">— no parent —</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.id} — {task.title}</option>)}</select></label>
        <div className="goal-mode-row"><label className="goal-mode-check"><input type="checkbox" checked={goalMode} onChange={(event) => setGoalMode(event.target.checked)} aria-label="Goal mode" />Goal mode</label>{goalMode && <input aria-label="Goal max turns" type="number" min="1" value={goalMaxTurns} onChange={(event) => setGoalMaxTurns(event.target.value)} placeholder="max turns (default 20)" />}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !title.trim()}>{saving ? "Creating…" : "Create"}</button></footer>
      </form>
    </div>
  );
}

function TaskDrawer({ board, taskId, allTasks, eventNonce, eventsLive, onClose, onChanged, onReviewTask, onOpenTask }: {
  board: string;
  taskId: string;
  allTasks: HermesTask[];
  eventNonce: number;
  eventsLive: boolean;
  onClose: () => void;
  onChanged: () => void;
  onReviewTask: (target: ReviewTarget) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [detail, setDetail] = useState<HermesTaskDetail | null>(null);
  const [log, setLog] = useState<HermesWorkerLog | null>(null);
  const [section, setSection] = useState<"overview" | "activity" | "log">("overview");
  const [comment, setComment] = useState("");
  const [homeChannels, setHomeChannels] = useState<HermesHomeChannel[]>([]);
  const [selectedParent, setSelectedParent] = useState("");
  const [selectedChild, setSelectedChild] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const logRequest = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const request = ++detailRequest.current;
    try {
      const [task, channels] = await Promise.all([
        getHermesTask(board, taskId),
        listHermesHomeChannels(board, taskId).catch(() => ({ home_channels: [] })),
      ]);
      if (request === detailRequest.current) {
        setDetail(task);
        setHomeChannels(channels.home_channels);
        if (!quiet) setError(null);
      }
    } catch (reason) {
      if (!quiet && request === detailRequest.current) setError(errorMessage(reason));
    }
  }, [board, taskId]);

  const loadLog = useCallback(async (quiet = false) => {
    const request = ++logRequest.current;
    try {
      const next = await getHermesTaskLog(board, taskId);
      if (request === logRequest.current) {
        setLog(next);
        if (!quiet) setError(null);
      }
    } catch (reason) {
      if (!quiet && request === logRequest.current) setError(errorMessage(reason));
    }
  }, [board, taskId]);

  useEffect(() => {
    setDetail(null);
    setLog(null);
    void load();
    const timer = window.setInterval(() => void load(true), eventsLive ? 20_000 : 4_000);
    return () => window.clearInterval(timer);
  }, [eventsLive, load]);

  // A live event mentioning this task refreshes the drawer immediately.
  useEffect(() => {
    if (eventNonce > 0) void load(true);
  }, [eventNonce, load]);

  useEffect(() => {
    if (section !== "log") return;
    void loadLog();
    const timer = window.setInterval(() => void loadLog(true), 4_000);
    return () => window.clearInterval(timer);
  }, [loadLog, section]);

  async function sendComment(event: FormEvent) {
    event.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await addHermesComment(board, taskId, comment.trim());
      setComment("");
      await load();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: string) {
    if (!detail || status === detail.task.status) return;
    if (["blocked", "done", "archived"].includes(status)) {
      const label = COLUMN_LABELS[status]?.toLowerCase() ?? status;
      if (!window.confirm(`Move this task to ${label}?`)) return;
    }
    setBusy(true);
    try {
      await patchHermesTaskStatus(board, taskId, status);
      await load();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function mutateLink(parentId: string, childId: string, remove = false) {
    setBusy(true);
    setError(null);
    try {
      if (remove) await removeHermesTaskLink(board, parentId, childId);
      else await addHermesTaskLink(board, parentId, childId);
      setSelectedParent("");
      setSelectedChild("");
      await load();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function toggleHome(channel: HermesHomeChannel) {
    setBusy(true);
    setError(null);
    try {
      await setHermesHomeSubscription(board, taskId, channel.platform, !channel.subscribed);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAttachments() {
    const paths = await openDialog({ multiple: true, title: "Attach files to Hermes task" });
    const selected = typeof paths === "string" ? [paths] : paths;
    if (!selected?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const path of selected) await uploadHermesAttachment(board, taskId, path);
      await load();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function downloadAttachment(id: number, filename: string) {
    const destination = await saveDialog({ defaultPath: filename, title: "Save Hermes attachment" });
    if (!destination) return;
    try {
      await downloadHermesAttachment(board, id, destination);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function removeAttachment(id: number, filename: string) {
    if (!window.confirm(`Delete attachment ${filename}?`)) return;
    setBusy(true);
    try {
      await deleteHermesAttachment(board, id);
      await load();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="task-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="task-drawer" aria-label="Hermes task details">
        <header className="task-drawer-header">
          <div><span>{taskId}</span><strong>{detail?.task.title ?? "Loading task…"}</strong></div>
          <button className="plain-close" onClick={onClose} aria-label="Close task details">×</button>
        </header>
        {detail && (
          <>
            <div className="task-state-row">
              <span className={`status-pill status-${detail.task.status}`}>{COLUMN_LABELS[detail.task.status] ?? detail.task.status}</span>
              <span className="drawer-assignee">{detail.task.assignee || "Unassigned"}</span>
              <button className="review-code-button" disabled={!detail.task.workspace_path} title={!detail.task.workspace_path ? "Review code requires a workspace path recorded on this task." : undefined} onClick={() => detail.task.workspace_path && onReviewTask({ board, taskId, title: detail.task.title, status: detail.task.status, repositoryPath: detail.task.workspace_path })}>Review code</button>
              {!detail.task.workspace_path && <span className="section-hint">Task workspace unavailable</span>}
            </div>
            <div className="task-transition-actions" aria-label="Task transitions">
              {taskTransitionActions(detail.task.status).map((action) => (
                <button key={action.status} className={action.destructive ? "danger-button" : "secondary-button"} disabled={busy} aria-label={action.ariaLabel} onClick={() => void changeStatus(action.status)}>{action.label}</button>
              ))}
            </div>
          </>
        )}
        <nav className="drawer-tabs" aria-label="Task detail sections">
          {(["overview", "activity", "log"] as const).map((name) => <button key={name} className={section === name ? "active" : ""} onClick={() => setSection(name)}>{name}</button>)}
        </nav>
        {error && <div className="drawer-error" role="alert">{error}</div>}
        {!detail ? <div className="drawer-loading">Loading task evidence…</div> : (
          <div className="drawer-scroll">
            {section === "overview" && (
              <>
                <section className="drawer-section"><h3>Description</h3>{detail.task.body ? <MarkdownContent value={detail.task.body} /> : <p className="section-empty">No description.</p>}</section>
                <section className="drawer-section"><h3>Task details</h3><dl className="task-facts"><div><dt>Priority</dt><dd>{detail.task.priority ?? 0}</dd></div><div><dt>Workspace</dt><dd>{detail.task.workspace_kind || "Default"}{detail.task.workspace_path ? ` · ${detail.task.workspace_path}` : ""}</dd></div><div><dt>Branch</dt><dd>{detail.task.branch_name || "Pending"}</dd></div><div><dt>Last heartbeat</dt><dd>{formatTime(detail.task.last_heartbeat_at)}</dd></div><div><dt>Skills</dt><dd>{detail.task.skills?.join(", ") || "Default"}</dd></div><div><dt>Created by</dt><dd>{detail.task.created_by || "Hermes"}</dd></div></dl></section>
                {homeChannels.length > 0 && <section className="drawer-section"><h3>Notify home channels</h3><div className="home-channel-list">{homeChannels.map((channel) => <button key={channel.platform} className={channel.subscribed ? "home-channel active" : "home-channel"} disabled={busy} aria-label={`${channel.subscribed ? "Stop" : "Start"} ${channel.platform} notifications`} title={`${channel.name} (${channel.chat_id}${channel.thread_id ? ` / ${channel.thread_id}` : ""})`} onClick={() => void toggleHome(channel)}>{channel.subscribed ? "✓ " : ""}{channel.platform}</button>)}</div><p className="section-hint">Get completed, blocked, and gave-up updates in the selected Hermes home channels.</p></section>}
                <DependenciesSection detail={detail} allTasks={allTasks} selectedParent={selectedParent} selectedChild={selectedChild} busy={busy} onSelectParent={setSelectedParent} onSelectChild={setSelectedChild} onAddParent={() => selectedParent && void mutateLink(selectedParent, taskId)} onAddChild={() => selectedChild && void mutateLink(taskId, selectedChild)} onRemoveParent={(parentId) => void mutateLink(parentId, taskId, true)} onRemoveChild={(childId) => void mutateLink(taskId, childId, true)} onOpenTask={onOpenTask} />
                <section className="drawer-section"><h3>Attachments · {detail.attachments?.length ?? 0}</h3><button className="secondary-button attachment-upload" disabled={busy} onClick={() => void uploadAttachments()}>Upload file</button><div className="attachment-list">{detail.attachments?.map((attachment) => <div className="attachment-row" key={attachment.id}><button className="attachment-name" title={`Download ${attachment.filename}`} onClick={() => void downloadAttachment(attachment.id, attachment.filename)}>{attachment.filename}</button><span>{formatBytes(attachment.size)}</span><button className="plain-close" aria-label={`Delete ${attachment.filename}`} disabled={busy} onClick={() => void removeAttachment(attachment.id, attachment.filename)}>×</button></div>)}{!detail.attachments?.length && <p className="section-empty">No attachments.</p>}</div></section>
                {!!detail.task.diagnostics?.length && <section className="drawer-section"><h3>Diagnostics</h3>{detail.task.diagnostics.map((item, index) => <div className="diagnostic" key={`${item.title}-${index}`}><strong>{item.title}</strong><p>{item.detail}</p></div>)}</section>}
                <section className="drawer-section comments-section"><h3>Comments · {detail.comments.length}</h3>{detail.comments.map((item) => <article className="task-comment" key={item.id}><header><strong>{item.author}</strong><time>{formatTime(item.created_at)}</time></header><MarkdownContent value={item.body} compact /></article>)}{detail.comments.length === 0 && <p className="section-empty">No comments yet.</p>}
                  <form className="comment-composer" onSubmit={sendComment}><textarea rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Give the agent context or request a change…" /><div><span>{detail.task.status === "running" ? "Hermes will steer the running agent at its next activity point." : "Saved to the task discussion for the next run."}</span><button className="primary-button" disabled={busy || !comment.trim()}>Send to Hermes</button></div></form>
                </section>
              </>
            )}
            {section === "activity" && (
              <>
                <section className="drawer-section"><h3>Runs · {detail.runs.length}</h3>{detail.runs.map((run) => <article className="run-row" key={run.id}><div><strong>{run.profile || "Hermes"}</strong><span>{run.status}{run.outcome ? ` · ${run.outcome}` : ""}</span></div><time>{formatTime(run.started_at)}</time>{run.summary && <p>{run.summary}</p>}{run.error && <p className="run-error">{run.error}</p>}</article>)}{detail.runs.length === 0 && <p className="section-empty">No runs recorded.</p>}</section>
                <section className="drawer-section"><h3>Task events · {detail.events.length}</h3><div className="event-list">{[...detail.events].reverse().map((event) => <div className="event-row" key={event.id}><span className="event-dot" /><div><strong>{event.kind.replace(/_/g, " ")}</strong><time>{formatTime(event.created_at)}</time>{event.payload != null && <code>{formatPayload(event.payload)}</code>}</div></div>)}</div></section>
              </>
            )}
            {section === "log" && <section className="drawer-section log-section"><h3>Worker output {log?.truncated && <span>tail</span>}</h3>{log?.exists ? <pre>{log.content}</pre> : <p className="section-empty">No worker log is available for this task.</p>}</section>}
          </div>
        )}
      </aside>
    </div>
  );
}

function DependenciesSection({ detail, allTasks, selectedParent, selectedChild, busy, onSelectParent, onSelectChild, onAddParent, onAddChild, onRemoveParent, onRemoveChild, onOpenTask }: {
  detail: HermesTaskDetail;
  allTasks: HermesTask[];
  selectedParent: string;
  selectedChild: string;
  busy: boolean;
  onSelectParent: (taskId: string) => void;
  onSelectChild: (taskId: string) => void;
  onAddParent: () => void;
  onAddChild: () => void;
  onRemoveParent: (taskId: string) => void;
  onRemoveChild: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const parentOptions = allTasks.filter((task) => task.id !== detail.task.id && !detail.links.parents.includes(task.id));
  const childOptions = allTasks.filter((task) => task.id !== detail.task.id && !detail.links.children.includes(task.id));
  return (
    <section className="drawer-section dependencies-section">
      <h3>Dependencies</h3>
      <div className="dependency-kind"><span>Parents</span><div className="dependency-chips">{detail.links.parents.map((id) => <span className="dependency-chip" key={id}><button onClick={() => onOpenTask(id)}>{id}</button><button aria-label={`Remove parent ${id}`} disabled={busy} onClick={() => onRemoveParent(id)}>×</button></span>)}{detail.links.parents.length === 0 && <em>None</em>}</div><div className="dependency-add"><select aria-label="Add parent" value={selectedParent} onChange={(event) => onSelectParent(event.target.value)}><option value="">— add parent —</option>{parentOptions.map((task) => <option key={task.id} value={task.id}>{task.id} — {task.title}</option>)}</select><button className="secondary-button" disabled={busy || !selectedParent} onClick={onAddParent}>+ Parent</button></div></div>
      <div className="dependency-kind"><span>Children</span><div className="dependency-chips">{detail.links.children.map((id) => <span className="dependency-chip" key={id}><button onClick={() => onOpenTask(id)}>{id}</button><button aria-label={`Remove child ${id}`} disabled={busy} onClick={() => onRemoveChild(id)}>×</button></span>)}{detail.links.children.length === 0 && <em>None</em>}</div><div className="dependency-add"><select aria-label="Add child" value={selectedChild} onChange={(event) => onSelectChild(event.target.value)}><option value="">— add child —</option>{childOptions.map((task) => <option key={task.id} value={task.id}>{task.id} — {task.title}</option>)}</select><button className="secondary-button" disabled={busy || !selectedChild} onClick={onAddChild}>+ Child</button></div></div>
      {!!detail.child_results?.length && <div className="child-results"><h4>Child results · {detail.child_results.length}</h4>{detail.child_results.map((child) => <article key={child.id}><button onClick={() => onOpenTask(child.id)}>{child.id} · {child.title}</button><span className={`status-pill status-${child.status}`}>{COLUMN_LABELS[child.status] ?? child.status}</span>{child.result || child.latest_summary ? <MarkdownContent value={child.result || child.latest_summary || ""} compact /> : <p className="section-empty">No result recorded yet.</p>}</article>)}</div>}
    </section>
  );
}

function MarkdownContent({ value, compact = false }: { value: string; compact?: boolean }) {
  return <div className={`markdown-content${compact ? " compact" : ""}`}><Markdown remarkPlugins={[remarkGfm]} skipHtml>{normalizeHermesMarkdown(value)}</Markdown></div>;
}

function normalizeHermesMarkdown(value: string) {
  if (value.includes("\n") || !value.includes("\\n")) return value;
  return value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatTime(value?: number | null) {
  if (!value) return "Unknown time";
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(milliseconds);
}

function taskTransitionActions(current: string) {
  return (TASK_TRANSITIONS[current] ?? []).map((status) => {
    if (status === "ready" && current === "blocked") return { status, label: "Unblock", ariaLabel: "Unblock task" };
    if (status === "blocked") return { status, label: "Block", ariaLabel: "Block task", destructive: true };
    if (status === "done") return { status, label: "Complete", ariaLabel: "Complete task", destructive: true };
    if (status === "archived") return { status, label: "Archive", ariaLabel: "Archive task", destructive: true };
    return { status, label: `→ ${COLUMN_LABELS[status] ?? status}`, ariaLabel: `Move task to ${status}` };
  });
}

function formatPayload(payload: unknown) {
  if (typeof payload === "string") return payload;
  try { return JSON.stringify(payload); } catch { return String(payload); }
}

function AgentIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M8 10h.01M16 10h.01M7 17h10a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3Z"/><path d="M9 14h6M9 17l-2 3M15 17l2 3"/></svg>;
}
