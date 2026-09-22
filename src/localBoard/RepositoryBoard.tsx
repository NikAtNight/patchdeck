import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getHermesBoard } from "../hermes/api";
import type { HermesBoard, HermesBoardMeta, HermesTask } from "../hermes/types";
import { RefreshIcon } from "../components/icons";
import { errorMessage } from "../errors";
import { latestRunForCard, useLocalBoardDocument } from "./store";
import { LOCAL_LANES } from "./types";
import type { LocalCard, LocalLane } from "./types";
import { runtimeLabel } from "./runtime";

const LANE_LABELS: Record<LocalLane, string> = {
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

type RepositoryWorkItem =
  | { source: "local"; lane: LocalLane; sourceStatus: string; id: string; title: string; summary: string; card: LocalCard }
  | { source: "hermes"; lane: LocalLane; sourceStatus: string; id: string; title: string; summary: string; board: HermesBoardMeta; task: HermesTask };
type WorkFilter = "all" | "attention" | "active" | "completed" | "archived";

export function RepositoryBoard({ repositoryPath, repositoryPaths, boards, hermesConnected, filter = "all", query = "", onOpenLocal, onOpenHermes }: {
  repositoryPath?: string;
  repositoryPaths?: string[];
  boards: HermesBoardMeta[];
  hermesConnected: boolean;
  filter?: WorkFilter;
  query?: string;
  onOpenLocal: (cardId: string, repositoryPath: string) => void;
  onOpenHermes: (board: string, taskId: string) => void;
}) {
  const local = useLocalBoardDocument();
  const [hermesBoards, setHermesBoards] = useState<Record<string, HermesBoard>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (quiet = false) => {
    if (!hermesConnected) return;
    const current = ++request.current;
    if (!quiet) setLoading(true);
    try {
      const responses = await Promise.allSettled(boards.map(async (board) => [board.slug, await getHermesBoard(board.slug, filter === "archived")] as const));
      if (current === request.current) {
        const entries = responses.flatMap((response) => response.status === "fulfilled" ? [response.value] : []);
        const failed = responses.find((response): response is PromiseRejectedResult => response.status === "rejected");
        setHermesBoards(Object.fromEntries(entries));
        setError(failed ? `Some Hermes boards could not be loaded: ${errorMessage(failed.reason)}` : null);
      }
    } catch (reason) {
      if (current === request.current) setError(errorMessage(reason));
    } finally {
      if (!quiet && current === request.current) setLoading(false);
    }
  }, [boards, filter, hermesConnected]);

  useEffect(() => {
    if (!hermesConnected) {
      request.current += 1;
      return;
    }
    void load();
    const timer = window.setInterval(() => void load(true), 8_000);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
    };
  }, [hermesConnected, load]);

  const items = useMemo(
    () => normalizeFederatedWork(repositoryPath ?? null, local.cards, hermesConnected ? boards : [], hermesConnected ? hermesBoards : {}, { filter, query, repositoryPaths }),
    [boards, filter, hermesBoards, hermesConnected, local.cards, query, repositoryPath, repositoryPaths],
  );

  return (
    <main className="agent-board repository-board">
      <header className="agent-board-toolbar">
        <div className="agent-board-title"><span className="agent-kicker">Federated projection</span><strong>{repositoryPath ? "This Repository" : "All Work"}</strong></div>
        <span className="agent-worker-summary">{items.length} matching item{items.length === 1 ? "" : "s"}</span>
        {hermesConnected && <button className="icon-button" aria-label="Refresh repository board" onClick={() => void load()} disabled={loading}><RefreshIcon /></button>}
      </header>
      {hermesConnected && error && <div className="board-error" role="alert">{error}</div>}
      <div className="kanban-scroll" aria-label={repositoryPath ? "This Repository board" : "All Work board"}>
        <div className="kanban-columns local-kanban-columns">
          {LOCAL_LANES.map((lane) => {
            const laneItems = items.filter((item) => item.lane === lane);
            return (
              <section className={`kanban-column lane-${lane}`} key={lane} aria-label={`${LANE_LABELS[lane]} work`}>
                <header><span className="lane-dot" /><strong>{LANE_LABELS[lane]}</strong><span className="lane-count">{laneItems.length}</span></header>
                <div className="kanban-card-list">
                  {laneItems.map((item) => (
                    <button
                      key={`${item.source}:${item.source === "hermes" ? item.board.slug : "local"}:${item.id}`}
                      className="kanban-card federated-card"
                      onClick={() => item.source === "local" ? onOpenLocal(item.id, item.card.repositoryPath) : onOpenHermes(item.board.slug, item.id)}
                    >
                      <span className={`task-source-badge source-${item.source}`}>{item.source === "local" ? "Local" : `Hermes · ${item.board.name || item.board.slug}`}</span>
                      <span className={`federated-status status-${item.sourceStatus}`}>{statusLabel(item.sourceStatus)}</span>
                      {!repositoryPath && <span className="federated-repository">{repositoryName(item.source === "local" ? item.card.repositoryPath : item.task.workspace_path ?? "No repository")}</span>}
                      <span className="task-id">{item.id}</span>
                      <strong>{item.title}</strong>
                      {item.summary && <p>{item.summary}</p>}
                      <span className="task-card-footer">
                        <span className="task-assignee">{item.source === "local" ? localExecutor(item.card.id) : item.task.assignee || "Hermes"}</span>
                        <span className="federated-open">Open source</span>
                      </span>
                    </button>
                  ))}
                  {laneItems.length === 0 && <div className="empty-lane">No matching work</div>}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}

export function normalizeRepositoryWork(
  repositoryPath: string,
  localCards: LocalCard[],
  boardMetadata: HermesBoardMeta[],
  hermesBoards: Record<string, HermesBoard>,
): RepositoryWorkItem[] {
  return normalizeFederatedWork(repositoryPath, localCards, boardMetadata, hermesBoards);
}

export function normalizeFederatedWork(
  repositoryPath: string | null,
  localCards: LocalCard[],
  boardMetadata: HermesBoardMeta[],
  hermesBoards: Record<string, HermesBoard>,
  options: { filter?: WorkFilter; query?: string; repositoryPaths?: string[] } = {},
): RepositoryWorkItem[] {
  const repository = repositoryPath === null ? null : normalizePath(repositoryPath);
  const repositories = repository === null ? null : new Set((options.repositoryPaths ?? [repository]).map(normalizePath));
  const local: RepositoryWorkItem[] = localCards
    .filter((card) => repositories === null || repositories.has(normalizePath(card.repositoryPath)))
    .map((card) => ({ source: "local" as const, lane: card.lane, sourceStatus: card.archivedAt === undefined ? card.lane : "archived", id: card.id, title: card.title, summary: card.body, card }))
    .filter((item) => matchesWorkItem(item, options.filter ?? "all", options.query ?? ""));
  const hermes = boardMetadata.flatMap((metadata): RepositoryWorkItem[] => (
    hermesBoards[metadata.slug]?.columns.flatMap((column) => column.tasks
      .filter((task) => repositories === null || repositories.has(normalizePath(task.workspace_path ?? "")))
      .map((task) => ({
        source: "hermes" as const,
        lane: hermesLane(task.status),
        sourceStatus: task.status,
        id: task.id,
        title: task.title,
        summary: task.latest_summary ?? task.body ?? "",
        board: metadata,
        task,
      }))
      .filter((item) => matchesWorkItem(item, options.filter ?? "all", options.query ?? ""))) ?? []
  ));
  return [...local, ...hermes];
}

function matchesWorkItem(item: RepositoryWorkItem, filter: WorkFilter, query: string) {
  const archived = item.sourceStatus === "archived";
  if (filter === "archived") {
    if (!archived) return false;
  } else if (archived) {
    return false;
  } else if (filter === "attention") {
    if (item.source === "local") {
      if (item.sourceStatus !== "review" && latestRunForCard(item.id)?.status !== "failed") return false;
    } else if (item.sourceStatus !== "blocked" && item.sourceStatus !== "review") return false;
  } else if (filter === "active") {
    if (item.source === "local" ? item.sourceStatus !== "in_progress" : !["scheduled", "ready", "running"].includes(item.sourceStatus)) return false;
  } else if (filter === "completed" && item.sourceStatus !== "done") {
    return false;
  }
  const needle = query.trim().toLocaleLowerCase();
  const repository = item.source === "local" ? item.card.repositoryPath : item.task.workspace_path ?? "";
  return !needle || [item.id, item.title, item.summary, repository].some((value) => value.toLocaleLowerCase().includes(needle));
}

function hermesLane(status: string): LocalLane {
  if (status === "review") return "review";
  if (status === "done" || status === "archived") return "done";
  if (status === "running" || status === "blocked") return "in_progress";
  return "todo";
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function localExecutor(cardId: string) {
  const run = latestRunForCard(cardId);
  return run ? runtimeLabel(run.runtimeId) : "No agent";
}

function repositoryName(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
