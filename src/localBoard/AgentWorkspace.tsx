import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listHermesBoards, listHermesProfiles } from "../hermes/api";
import type { HermesBoardMeta, HermesProfile, HermesSessionController } from "../hermes/types";
import type { ReviewTarget } from "../review/inlineComments";
import { errorMessage } from "../errors";
import { LocalBoard } from "./LocalBoard";
import { NewWorkComposer } from "./NewWorkComposer";
import type { NewWorkResult } from "./NewWorkComposer";
import { RepositoryBoard } from "./RepositoryBoard";
import { addLocalCardHandoff } from "./store";
import type { LocalCard, LocalLane } from "./types";
import "./boards.css";

const HermesBoard = lazy(() =>
  import("../hermes/HermesBoard").then((module) => ({ default: module.HermesBoard })),
);

type BoardSource = "local" | "repository" | "all" | `hermes:${string}`;
interface ComposerState {
  lane: LocalLane;
  targetStatus: string;
  initialDestination: string;
  handoffCard: LocalCard | null;
}

export function AgentWorkspace({ hermes, repositoryPath, onReviewTask, onOpenRepository }: {
  hermes: HermesSessionController;
  repositoryPath?: string;
  onReviewTask: (target: ReviewTarget) => void;
  onOpenRepository?: (repositoryPath: string) => void;
}) {
  const hermesConnected = hermes.status.state === "connected" || hermes.status.state === "degraded";
  const [source, setSource] = useState<BoardSource>("local");
  const [boards, setBoards] = useState<HermesBoardMeta[]>([]);
  const [hermesProfiles, setHermesProfiles] = useState<HermesProfile[]>([]);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localCardToOpen, setLocalCardToOpen] = useState<string | null>(null);
  const [hermesTaskToOpen, setHermesTaskToOpen] = useState<string | null>(null);
  const metadataRequest = useRef(0);
  const hermesConnectionKey = hermesConnected ? `${hermes.status.mode ?? ""}:${hermes.status.url ?? ""}` : null;

  useEffect(() => {
    const request = ++metadataRequest.current;
    setBoards([]);
    setHermesProfiles([]);
    setMetadataError(null);
    if (!hermesConnectionKey) return;
    void Promise.all([listHermesBoards(), listHermesProfiles()])
      .then(([boardResponse, profileResponse]) => {
        if (request !== metadataRequest.current) return;
        setBoards(boardResponse.boards);
        setHermesProfiles(profileResponse.profiles);
      })
      .catch((reason: unknown) => {
        if (request === metadataRequest.current) setMetadataError(errorMessage(reason));
      });
    return () => {
      if (request === metadataRequest.current) metadataRequest.current += 1;
    };
  }, [hermesConnectionKey]);

  useEffect(() => {
    if (!hermesConnected && source.startsWith("hermes:")) {
      setSource("local");
      return;
    }
    if (!source.startsWith("hermes:")) return;
    const selected = source.slice("hermes:".length);
    if (boards.length > 0 && !boards.some((board) => board.slug === selected)) setSource("local");
  }, [boards, hermesConnected, source]);

  function openComposer(input?: Partial<ComposerState>) {
    const sourceDestination = source.startsWith("hermes:") ? source : "local";
    setComposer({
      lane: input?.lane ?? "todo",
      targetStatus: input?.targetStatus ?? "todo",
      initialDestination: input?.initialDestination ?? sourceDestination,
      handoffCard: input?.handoffCard ?? null,
    });
  }

  function openLocalCard(cardId: string, cardRepositoryPath?: string) {
    setLocalCardToOpen(cardId);
    setSource("local");
    if (cardRepositoryPath && cardRepositoryPath !== repositoryPath) onOpenRepository?.(cardRepositoryPath);
  }

  function openHermesTask(board: string, taskId?: string) {
    setHermesTaskToOpen(taskId ?? null);
    setSource(`hermes:${board}`);
  }

  function handleCreated(result: NewWorkResult) {
    const handoffCard = composer?.handoffCard;
    setComposer(null);
    if (result.source === "local") {
      setNotice(`Created local card “${result.card.title}”.`);
      openLocalCard(result.card.id);
      return;
    }
    if (handoffCard) addLocalCardHandoff(handoffCard.id, { board: result.board, taskId: result.taskId });
    const outcome = handoffCard
      ? `Sent to Hermes · ${result.board} as ${result.taskId}. The local card was preserved.`
      : `Created ${result.taskId} on Hermes · ${result.board}.`;
    setNotice(result.warning ? `${outcome} ${result.warning}` : outcome);
    openHermesTask(result.board, result.taskId);
  }

  const selectedHermesBoard = source.startsWith("hermes:") ? source.slice("hermes:".length) : null;

  return (
    <div className="agent-workspace unified-agent-workspace">
      <nav className="board-navigator" aria-label="Board navigator">
        <button className={source === "local" ? "active" : ""} aria-pressed={source === "local"} onClick={() => setSource("local")}>Local Board</button>
        {repositoryPath && (
          <button className={source === "repository" ? "active" : ""} aria-pressed={source === "repository"} onClick={() => setSource("repository")}>This Repository</button>
        )}
        <button className={source === "all" ? "active" : ""} aria-pressed={source === "all"} onClick={() => setSource("all")}>All Work</button>
        {hermesConnected && boards.map((board) => (
          <button key={board.slug} className={source === `hermes:${board.slug}` ? "active" : ""} aria-pressed={source === `hermes:${board.slug}`} onClick={() => openHermesTask(board.slug)}>
            Hermes · {board.name || board.slug}
          </button>
        ))}
        <button className="board-navigator-create" onClick={() => openComposer()}>+ New work</button>
      </nav>
      {notice && <div className="board-error workspace-notice" role="status">{notice}</div>}
      {hermesConnected && metadataError && <div className="board-error workspace-notice" role="alert">{metadataError}</div>}

      {(source === "repository" || source === "all") && (source === "all" || repositoryPath) ? (
        <RepositoryBoard
          repositoryPath={source === "repository" ? repositoryPath : undefined}
          boards={boards}
          hermesConnected={hermesConnected}
          onCreateWork={() => openComposer()}
          onOpenLocal={openLocalCard}
          onOpenHermes={openHermesTask}
        />
      ) : selectedHermesBoard && hermesConnected ? (
        <Suspense fallback={<div className="board-loading">Loading Hermes board…</div>}>
          <HermesBoard
            session={hermes}
            repositoryPath={repositoryPath}
            onReviewTask={onReviewTask}
            boardSlug={selectedHermesBoard}
            initialTaskId={hermesTaskToOpen}
            onCreateTask={(board, targetStatus) => openComposer({ initialDestination: `hermes:${board}`, targetStatus })}
          />
        </Suspense>
      ) : (
        <LocalBoard
          repositoryPath={repositoryPath}
          initialCardId={localCardToOpen}
          onCreateWork={(lane) => openComposer({ lane, initialDestination: "local" })}
          onSendToHermes={hermesConnected && boards.length > 0 ? (card) => openComposer({ initialDestination: `hermes:${boards[0].slug}`, handoffCard: card }) : undefined}
          onOpenHermesBoard={openHermesTask}
        />
      )}

      {composer && repositoryPath && (
        <NewWorkComposer
          repositoryPath={repositoryPath}
          boards={boards}
          hermesProfiles={hermesProfiles}
          lane={composer.lane}
          targetStatus={composer.targetStatus}
          initialDestination={composer.initialDestination}
          handoffCard={composer.handoffCard}
          onClose={() => setComposer(null)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
