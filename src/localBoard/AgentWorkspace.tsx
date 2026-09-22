import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, UIEvent as ReactUIEvent } from "react";
import { listHermesBoards, listHermesProfiles } from "../hermes/api";
import type { HermesBoardMeta, HermesProfile, HermesSessionController } from "../hermes/types";
import type { ReviewTarget } from "../review/inlineComments";
import { listCardWorktrees } from "../providers/workspaces";
import { errorMessage } from "../errors";
import { LocalBoard } from "./LocalBoard";
import { NewWorkComposer } from "./NewWorkComposer";
import type { NewWorkResult } from "./NewWorkComposer";
import { RepositoryBoard } from "./RepositoryBoard";
import { addLocalCardHandoff, getLocalBoardDocument, latestRunForCard } from "./store";
import type { LocalCard, LocalLane } from "./types";
import "./boards.css";

const HermesBoard = lazy(() =>
  import("../hermes/HermesBoard").then((module) => ({ default: module.HermesBoard })),
);
export type BoardSource = "local" | "repository" | "all" | `hermes:${string}`;
export type WorkScope = "repository" | "all";
export type WorkSource = "all" | "local" | `hermes:${string}`;
export type WorkView = "board" | "list";
export type WorkFilter = "all" | "attention" | "active" | "completed" | "archived";
export interface WorkNavigationState {
  scope: WorkScope;
  source: WorkSource;
  view: WorkView;
  filter: WorkFilter;
  query: string;
}
export interface BoardViewState {
  scrollLeft: number;
  scrollTop: number;
  laneScrollTops: Record<string, number>;
  archived?: boolean;
}
export interface AgentWorkspaceOpenRequest {
  id: number;
  source: "local" | `hermes:${string}`;
  itemId: string;
}
interface ComposerState {
  lane: LocalLane;
  targetStatus: string;
  initialDestination: string;
  handoffCard: LocalCard | null;
}

export function AgentWorkspace({
  hermes,
  repositoryPath,
  initialSource = "local",
  initialNavigation,
  viewStates = {},
  openRequest,
  onSourceChange,
  onNavigationChange,
  onViewStateChange,
  onOpenRequestConsumed,
  onReviewTask,
  onOpenRepository,
}: {
  hermes: HermesSessionController;
  repositoryPath?: string;
  initialSource?: BoardSource;
  initialNavigation?: Partial<WorkNavigationState>;
  viewStates?: Record<string, BoardViewState>;
  openRequest?: AgentWorkspaceOpenRequest | null;
  onSourceChange?: (source: BoardSource) => void;
  onNavigationChange?: (state: WorkNavigationState) => void;
  onViewStateChange?: (key: string, state: BoardViewState) => void;
  onOpenRequestConsumed?: (id: number) => void;
  onReviewTask: (target: ReviewTarget) => void;
  onOpenRepository?: (repositoryPath: string) => void;
}) {
  const hermesConnected = hermes.status.state === "connected" || hermes.status.state === "degraded";
  const [navigation, setNavigation] = useState<WorkNavigationState>(() => initialWorkNavigation(initialSource, initialNavigation, repositoryPath));
  const [boards, setBoards] = useState<HermesBoardMeta[]>([]);
  const [hermesProfiles, setHermesProfiles] = useState<HermesProfile[]>([]);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localCardToOpen, setLocalCardToOpen] = useState<string | null>(null);
  const [hermesTaskToOpen, setHermesTaskToOpen] = useState<string | null>(null);
  const [repositoryScopePaths, setRepositoryScopePaths] = useState<string[]>(() => repositoryPath ? [repositoryPath] : []);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [scopeRefresh, setScopeRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const restoredElements = useRef(new WeakSet<HTMLElement>());
  const cancelViewRestore = useRef<(() => void) | null>(null);
  const metadataRequest = useRef(0);
  const hermesConnectionKey = hermesConnected ? `${hermes.status.mode ?? ""}:${hermes.status.url ?? ""}` : null;

  useEffect(() => {
    setNavigation(initialWorkNavigation(initialSource, initialNavigation, repositoryPath));
  }, [initialNavigation?.filter, initialNavigation?.query, initialNavigation?.scope, initialNavigation?.source, initialNavigation?.view, initialSource, repositoryPath]);

  useEffect(() => {
    let active = true;
    if (!repositoryPath) {
      setRepositoryScopePaths([]);
      setScopeError(null);
      return;
    }
    setRepositoryScopePaths([repositoryPath]);
    setScopeError(null);
    void listCardWorktrees(repositoryPath).then((worktrees) => {
      if (active) setRepositoryScopePaths([repositoryPath, ...worktrees.map((worktree) => worktree.path)]);
    }).catch(() => {
      if (active) setScopeError("Worktree paths could not be loaded. Repository scope currently shows the selected checkout only.");
    });
    return () => { active = false; };
  }, [repositoryPath, scopeRefresh]);

  useEffect(() => {
    if (!openRequest) return;
    const card = openRequest.source === "local"
      ? getLocalBoardDocument().cards.find((candidate) => candidate.id === openRequest.itemId)
      : undefined;
    const next = card
      ? navigationForLocalCard(navigation, card)
      : { ...navigation, source: openRequest.source };
    setNavigation(next);
    onNavigationChange?.(next);
    onSourceChange?.(openRequest.source);
    if (openRequest.source === "local") setLocalCardToOpen(openRequest.itemId);
    else setHermesTaskToOpen(openRequest.itemId);
    onOpenRequestConsumed?.(openRequest.id);
  }, [openRequest, onNavigationChange, onOpenRequestConsumed, onSourceChange]);

  // The destination ID is an instruction, not durable drawer state. Each board
  // consumes it once and keeps its own selected item until the user closes it.
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    restoredElements.current = new WeakSet();
    const key = boardViewKey(navigation, repositoryPath);
    const saved = viewStates[key];
    if (!saved) return;
    let observer: MutationObserver | undefined;
    let settleTimeout: number | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(settleTimeout);
      observer?.disconnect();
      if (cancelViewRestore.current === stop) cancelViewRestore.current = null;
    };
    const restore = () => {
      window.clearTimeout(settleTimeout);
      if (restoreViewState(container, saved, restoredElements.current)) {
        // The board may replace its lanes after an async refresh. Let the DOM
        // settle before disconnecting so the final elements receive the offsets.
        settleTimeout = window.setTimeout(stop, 250);
      }
    };
    const observerTimeout = window.setTimeout(stop, 5_000);
    observer = new MutationObserver(() => {
      if (!stopped) restore();
    });
    observer.observe(container, { childList: true, subtree: true });
    cancelViewRestore.current = stop;
    restore();
    return () => {
      window.clearTimeout(observerTimeout);
      stop();
    };
  }, [navigation.scope, navigation.source, navigation.view, repositoryPath]);

  function updateNavigation(patch: Partial<WorkNavigationState>) {
    const next = { ...navigation, ...patch };
    setNavigation(next);
    onNavigationChange?.(next);
    onSourceChange?.(legacyBoardSource(next));
  }

  function captureViewState(event: ReactUIEvent<HTMLDivElement>) {
    const container = root.current;
    if (!container) return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches(".kanban-scroll, .kanban-card-list")) return;
    // Scroll events produced while applying saved offsets can arrive after an
    // async board render. Do not replace the saved state with partial zeros.
    if (cancelViewRestore.current) return;
    restoredElements.current.add(event.target);
    const key = boardViewKey(navigation, repositoryPath);
    onViewStateChange?.(key, readViewState(container, viewStates[key]?.archived));
  }

  function beginUserScroll() {
    cancelViewRestore.current?.();
  }

  function beginKeyboardScroll(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)) {
      beginUserScroll();
    }
  }

  function updateArchived(archived: boolean) {
    const container = root.current;
    const key = boardViewKey(navigation, repositoryPath);
    const current = container ? readViewState(container, archived) : viewStates[key];
    onViewStateChange?.(key, current ?? { scrollLeft: 0, scrollTop: 0, laneScrollTops: {}, archived });
  }

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
    if (!hermesConnected && navigation.source.startsWith("hermes:")) {
      updateNavigation({ source: "local" });
      return;
    }
    if (!navigation.source.startsWith("hermes:")) return;
    const selected = navigation.source.slice("hermes:".length);
    if (boards.length > 0 && !boards.some((board) => board.slug === selected)) updateNavigation({ source: "local" });
  }, [boards, hermesConnected, navigation.source]);

  function openComposer(input?: Partial<ComposerState>) {
    const sourceDestination = navigation.source.startsWith("hermes:") ? navigation.source : "local";
    setComposer({
      lane: input?.lane ?? "todo",
      targetStatus: input?.targetStatus ?? "todo",
      initialDestination: input?.initialDestination ?? sourceDestination,
      handoffCard: input?.handoffCard ?? null,
    });
  }

  function openLocalCard(cardId: string, cardRepositoryPath?: string) {
    setLocalCardToOpen(cardId);
    const card = getLocalBoardDocument().cards.find((candidate) => candidate.id === cardId);
    updateNavigation(card ? navigationForLocalCard(navigation, card) : { source: "local" });
    if (cardRepositoryPath && cardRepositoryPath !== repositoryPath) onOpenRepository?.(cardRepositoryPath);
  }

  function openHermesTask(board: string, taskId?: string) {
    setHermesTaskToOpen(taskId ?? null);
    updateNavigation({ source: `hermes:${board}`, filter: taskId ? "all" : navigation.filter, query: taskId ? "" : navigation.query });
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

  const selectedHermesBoard = navigation.source.startsWith("hermes:") ? navigation.source.slice("hermes:".length) : null;
  const scopedRepositoryPath = navigation.scope === "repository" ? repositoryPath : undefined;
  const viewKey = boardViewKey(navigation, repositoryPath);

  return (
    <div
      ref={root}
      className={`agent-workspace unified-agent-workspace work-view-${navigation.view}`}
      onKeyDownCapture={beginKeyboardScroll}
      onPointerDownCapture={beginUserScroll}
      onScrollCapture={captureViewState}
      onTouchStartCapture={beginUserScroll}
      onWheelCapture={beginUserScroll}
    >
      <nav className="work-navigator" aria-label="Work navigation">
        <div className="work-navigation-group" aria-label="Repository scope">
          <span>Repository</span>
          <button className={navigation.scope === "repository" ? "active" : ""} disabled={!repositoryPath} aria-pressed={navigation.scope === "repository"} onClick={() => updateNavigation({ scope: "repository" })}>Current</button>
          <button className={navigation.scope === "all" ? "active" : ""} aria-pressed={navigation.scope === "all"} onClick={() => updateNavigation({ scope: "all" })}>All</button>
        </div>
        <label className="work-navigation-select">Source
          <select aria-label="Work source" value={navigation.source} onChange={(event) => updateNavigation({ source: event.target.value as WorkSource })}>
            <option value="all">All sources</option>
            <option value="local">Local</option>
            {hermesConnected && boards.map((board) => <option key={board.slug} value={`hermes:${board.slug}`}>Hermes · {board.name || board.slug}</option>)}
          </select>
        </label>
        <div className="work-navigation-group" aria-label="Work view">
          <span>View</span>
          <button className={navigation.view === "board" ? "active" : ""} aria-pressed={navigation.view === "board"} onClick={() => updateNavigation({ view: "board" })}>Board</button>
          <button className={navigation.view === "list" ? "active" : ""} aria-pressed={navigation.view === "list"} onClick={() => updateNavigation({ view: "list" })}>List</button>
        </div>
        <label className="work-navigation-select">Filter
          <select aria-label="Work filter" value={navigation.filter} onChange={(event) => updateNavigation({ filter: event.target.value as WorkFilter })}>
            <option value="all">All</option>
            <option value="attention">Needs attention</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <input className="work-search" type="search" aria-label="Search work" value={navigation.query} onChange={(event) => updateNavigation({ query: event.target.value })} placeholder="Search work" />
        {hermesConnected && boards.length > 0 && <button className="secondary-button capture-idea-button" title="Capture an idea in Hermes triage" onClick={() => openComposer({ initialDestination: selectedHermesBoard ? `hermes:${selectedHermesBoard}` : `hermes:${boards[0].slug}`, targetStatus: "triage" })}>Capture idea for Hermes</button>}
        <button className="primary-button board-navigator-create" onClick={() => openComposer()}>+ New work</button>
      </nav>
      {navigation.scope === "repository" && scopeError && <div className="board-error workspace-notice work-scope-warning" role="alert">{scopeError}<button className="secondary-button" onClick={() => setScopeRefresh((value) => value + 1)}>Retry</button></div>}
      {notice && <div className="board-error workspace-notice" role="status">{notice}</div>}
      {hermesConnected && metadataError && <div className="board-error workspace-notice" role="alert">{metadataError}</div>}

      {navigation.source === "all" ? (
        <RepositoryBoard
          repositoryPath={scopedRepositoryPath}
          repositoryPaths={navigation.scope === "repository" ? repositoryScopePaths : undefined}
          boards={boards}
          hermesConnected={hermesConnected}
          filter={navigation.filter}
          query={navigation.query}
          onOpenLocal={openLocalCard}
          onOpenHermes={openHermesTask}
        />
      ) : selectedHermesBoard && hermesConnected ? (
        <Suspense fallback={<div className="board-loading">Loading Hermes board…</div>}>
          <HermesBoard
            session={hermes}
            repositoryPath={repositoryPath}
            onReviewTask={(target) => onReviewTask({ ...target, source: "hermes" })}
            boardSlug={selectedHermesBoard}
            scopeRepositoryPaths={navigation.scope === "repository" ? repositoryScopePaths : undefined}
            workFilter={navigation.filter}
            query={navigation.query}
            initialTaskId={hermesTaskToOpen}
            initialIncludeArchived={navigation.filter === "archived" || viewStates[viewKey]?.archived}
            onInitialTaskOpened={() => setHermesTaskToOpen(null)}
            onIncludeArchivedChange={updateArchived}
            onCreateTask={(board, targetStatus) => openComposer({ initialDestination: `hermes:${board}`, targetStatus })}
          />
        </Suspense>
      ) : (
        <>
          <LocalBoard
            repositoryPath={repositoryPath}
            allRepositories={navigation.scope === "all"}
            scopeRepositoryPaths={navigation.scope === "repository" ? repositoryScopePaths : undefined}
            workFilter={navigation.filter}
            query={navigation.query}
            initialCardId={localCardToOpen}
            initialShowArchived={navigation.filter === "archived" || viewStates[viewKey]?.archived}
            onInitialCardOpened={() => setLocalCardToOpen(null)}
            onShowArchivedChange={updateArchived}
            onCreateWork={(lane) => openComposer({ lane, initialDestination: "local" })}
            onSendToHermes={hermesConnected && boards.length > 0 ? (card) => openComposer({ initialDestination: `hermes:${boards[0].slug}`, handoffCard: card }) : undefined}
            onOpenHermesBoard={openHermesTask}
            onReviewTask={onReviewTask}
          />
        </>
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

const DEFAULT_WORK_NAVIGATION: WorkNavigationState = {
  scope: "repository",
  source: "local",
  view: "board",
  filter: "all",
  query: "",
};

function initialWorkNavigation(initialSource: BoardSource, initialNavigation?: Partial<WorkNavigationState>, repositoryPath?: string): WorkNavigationState {
  const legacy = initialSource === "repository"
    ? { scope: "repository" as const, source: "all" as const }
    : initialSource === "all"
      ? { scope: "all" as const, source: "all" as const }
      : { source: initialSource as WorkSource };
  const navigation = { ...DEFAULT_WORK_NAVIGATION, ...legacy, ...initialNavigation };
  return repositoryPath ? navigation : { ...navigation, scope: "all" };
}

function legacyBoardSource(navigation: WorkNavigationState): BoardSource {
  if (navigation.source !== "all") return navigation.source;
  return navigation.scope === "repository" ? "repository" : "all";
}

function boardViewKey(navigation: Pick<WorkNavigationState, "scope" | "source" | "view">, repositoryPath?: string) {
  return `${navigation.scope}:${navigation.source}:${navigation.view}:${navigation.scope === "repository" ? repositoryPath ?? "" : ""}`;
}

function navigationForLocalCard(navigation: WorkNavigationState, card: LocalCard): WorkNavigationState {
  const run = latestRunForCard(card.id);
  const matchesFilter = navigation.filter === "all" ? card.archivedAt === undefined
    : navigation.filter === "archived" ? card.archivedAt !== undefined
      : card.archivedAt === undefined && (
        navigation.filter === "attention" ? card.lane === "review" || run?.status === "failed"
          : navigation.filter === "active" ? card.lane === "in_progress"
            : card.lane === "done"
      );
  const needle = navigation.query.trim().toLocaleLowerCase();
  const matchesQuery = !needle || [card.id, card.title, card.body, card.repositoryPath]
    .some((value) => value.toLocaleLowerCase().includes(needle));
  return {
    ...navigation,
    source: "local",
    filter: matchesFilter ? navigation.filter : card.archivedAt === undefined ? "all" : "archived",
    query: matchesQuery ? navigation.query : "",
  };
}

function laneKey(element: HTMLElement) {
  return element.closest<HTMLElement>(".kanban-column")?.getAttribute("aria-label") ?? "";
}

function readViewState(container: HTMLElement, archived?: boolean): BoardViewState {
  const board = container.querySelector<HTMLElement>(".kanban-scroll");
  const laneScrollTops = Object.fromEntries(
    [...container.querySelectorAll<HTMLElement>(".kanban-card-list")]
      .map((lane) => [laneKey(lane), lane.scrollTop] as const)
      .filter(([key]) => key.length > 0),
  );
  return {
    scrollLeft: board?.scrollLeft ?? 0,
    scrollTop: board?.scrollTop ?? 0,
    laneScrollTops,
    ...(archived !== undefined ? { archived } : {}),
  };
}

function restoreViewState(container: HTMLElement, saved: BoardViewState, restored: WeakSet<HTMLElement>) {
  const board = container.querySelector<HTMLElement>(".kanban-scroll");
  if (board && !restored.has(board)) {
    board.scrollLeft = saved.scrollLeft;
    board.scrollTop = saved.scrollTop;
    if (board.scrollLeft === saved.scrollLeft && board.scrollTop === saved.scrollTop) restored.add(board);
  }
  for (const lane of container.querySelectorAll<HTMLElement>(".kanban-card-list")) {
    if (restored.has(lane)) continue;
    const scrollTop = saved.laneScrollTops[laneKey(lane)] ?? 0;
    lane.scrollTop = scrollTop;
    if (lane.scrollTop === scrollTop) restored.add(lane);
  }
  const boardReady = Boolean(board && restored.has(board));
  const expectedLanes = Object.keys(saved.laneScrollTops).length;
  const restoredLanes = [...container.querySelectorAll<HTMLElement>(".kanban-card-list")]
    .filter((lane) => saved.laneScrollTops[laneKey(lane)] !== undefined && restored.has(lane)).length;
  return boardReady && restoredLanes >= expectedLanes;
}
