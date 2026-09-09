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

export function RepositoryBoard({ repositoryPath, boards, hermesConnected, onOpenLocal, onOpenHermes }: {
  repositoryPath?: string;
  boards: HermesBoardMeta[];
  hermesConnected: boolean;
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
      const responses = await Promise.allSettled(boards.map(async (board) => [board.slug, await getHermesBoard(board.slug, false)] as const));
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
  }, [boards, hermesConnected]);

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
    () => normalizeFederatedWork(repositoryPath ?? null, local.cards, hermesConnected ? boards : [], hermesConnected ? hermesBoards : {}),
    [boards, hermesBoards, hermesConnected, local.cards, repositoryPath],
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
): RepositoryWorkItem[] {
  const repository = repositoryPath === null ? null : normalizePath(repositoryPath);
  const local: RepositoryWorkItem[] = localCards
    .filter((card) => repository === null || normalizePath(card.repositoryPath) === repository)
    .map((card) => ({ source: "local", lane: card.lane, sourceStatus: card.lane, id: card.id, title: card.title, summary: card.body, card }));
  const hermes = boardMetadata.flatMap((metadata): RepositoryWorkItem[] => (
    hermesBoards[metadata.slug]?.columns.flatMap((column) => column.tasks
      .filter((task) => repository === null || normalizePath(task.workspace_path ?? "") === repository)
      .map((task) => ({
        source: "hermes" as const,
        lane: hermesLane(task.status),
        sourceStatus: task.status,
        id: task.id,
        title: task.title,
        summary: task.latest_summary ?? task.body ?? "",
        board: metadata,
        task,
      }))) ?? []
  ));
  return [...local, ...hermes];
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
