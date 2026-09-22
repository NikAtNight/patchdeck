import { useEffect, useMemo, useRef, useState } from "react";
import { compareWorkingTree, openRepository } from "../api";
import { errorMessage } from "../errors";
import { listCardWorktrees } from "../providers/workspaces";
import type { CardWorktree } from "../providers/workspaces";
import { readReviewProgress } from "../review/reviewedFiles";
import { readProjectView } from "../session";
import type { Comparison, RepositoryInfo } from "../types";
import { useLocalBoardDocument } from "../localBoard/store";
import type { LocalCard } from "../localBoard/types";
import { AlertIcon, CheckIcon, RefreshIcon } from "./icons";
import { Spinner } from "./ui";
import "./WorktreeReviewQueue.css";

const SUMMARY_CONCURRENCY = 4;

type QueueFilter = "awaiting" | "changed" | "all";
type QueueItem = {
  worktree: CardWorktree;
  repositoryPath: string;
  state: "loading" | "ready" | "needs-base" | "error";
  branch: string | null;
  branches: string[];
  baseBranch: string | null;
  comparison: Comparison | null;
  viewedCount: number;
  changedCount: number;
  error: string | null;
};

export interface WorktreeReviewSelection {
  repositoryPath: string;
  baseBranch: string;
}

export interface WorktreeReviewQueueProps {
  repository: Pick<RepositoryInfo, "name" | "path" | "suggestedBaseBranch">;
  opening?: boolean;
  onOpenReview: (selection: WorktreeReviewSelection) => void;
}

export function WorktreeReviewQueue({ repository, opening = false, onOpenReview }: WorktreeReviewQueueProps) {
  const board = useLocalBoardDocument();
  const [filter, setFilter] = useState<QueueFilter>("awaiting");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadRequest = useRef(0);
  const rowRequests = useRef(new Map<string, number>());
  const linkedWorkspaceSignature = board.cards
    .filter((card) => card.workspace)
    .map((card) => `${card.id}:${card.workspace!.worktreePath}:${card.workspace!.baseBranch}`)
    .sort()
    .join("|");
  const linkedCards = useMemo(() => linkedCardsByWorktree(board.cards), [board.cards]);

  useEffect(() => {
    const request = ++loadRequest.current;
    rowRequests.current.clear();
    setLoading(true);
    setListError(null);
    setItems([]);

    void listCardWorktrees(repository.path)
      .then(async (worktrees) => {
        if (request !== loadRequest.current) return;
        const listed = uniqueWorktrees(worktrees);
        setItems(listed.map(loadingItem));
        await summarizeWithLimit(listed, SUMMARY_CONCURRENCY, async (worktree) => {
          if (request !== loadRequest.current) return;
          const rowRequest = nextRowRequest(rowRequests.current, worktree.path);
          const item = await summarizeWorktree(worktree, repository, linkedCards.get(normalizePath(worktree.path)) ?? []);
          if (request !== loadRequest.current || rowRequests.current.get(worktree.path) !== rowRequest) return;
          setItems((current) => replaceItem(current, item));
        });
        if (request === loadRequest.current) setLoading(false);
      })
      .catch((reason: unknown) => {
        if (request !== loadRequest.current) return;
        setListError(errorMessage(reason));
        setLoading(false);
      });

    return () => {
      if (request === loadRequest.current) loadRequest.current += 1;
    };
  }, [linkedWorkspaceSignature, refreshKey, repository.name, repository.path, repository.suggestedBaseBranch]);

  async function retryItem(item: QueueItem, explicitBase?: string) {
    const request = loadRequest.current;
    const rowRequest = nextRowRequest(rowRequests.current, item.worktree.path);
    setItems((current) => replaceItem(current, { ...item, state: "loading", error: null }));
    const next = await summarizeWorktree(
      item.worktree,
      repository,
      linkedCards.get(normalizePath(item.worktree.path)) ?? [],
      explicitBase ?? item.baseBranch ?? undefined,
    );
    if (request !== loadRequest.current || rowRequests.current.get(item.worktree.path) !== rowRequest) return;
    setItems((current) => replaceItem(current, next));
  }

  const visibleItems = items.filter((item) => matchesFilter(item, filter));
  const counts = {
    awaiting: items.filter((item) => matchesFilter(item, "awaiting")).length,
    changed: items.filter((item) => matchesFilter(item, "changed")).length,
    all: items.length,
  };

  return (
    <section className="worktree-review-queue" aria-label="Worktree review queue">
      <header className="worktree-review-header">
        <div>
          <span className="worktree-review-kicker">Review worktrees</span>
          <h1>{repository.name}</h1>
          <p>Review changes from any worktree attached to this repository.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh worktrees"
          title="Refresh worktrees"
          disabled={loading || opening}
          onClick={() => setRefreshKey((current) => current + 1)}
        >
          <RefreshIcon />
        </button>
      </header>

      <nav className="worktree-review-filters" aria-label="Worktree filter">
        <FilterButton active={filter === "awaiting"} count={counts.awaiting} onClick={() => setFilter("awaiting")}>Awaiting review</FilterButton>
        <FilterButton active={filter === "changed"} count={counts.changed} onClick={() => setFilter("changed")}>Changed since review</FilterButton>
        <FilterButton active={filter === "all"} count={counts.all} onClick={() => setFilter("all")}>All worktrees</FilterButton>
      </nav>

      {listError ? (
        <div className="worktree-review-message" role="alert">
          <AlertIcon />
          <div><strong>Could not list worktrees</strong><span>{listError}</span></div>
          <button type="button" className="secondary-button" onClick={() => setRefreshKey((current) => current + 1)}>Try again</button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="worktree-review-message"><Spinner /><span>Finding worktrees…</span></div>
      ) : items.length === 0 ? (
        <div className="worktree-review-empty"><CheckIcon /><strong>No worktrees found</strong><span>Refresh after checking the repository’s Git worktree configuration.</span></div>
      ) : loading && visibleItems.length === 0 ? (
        <div className="worktree-review-message"><Spinner /><span>Checking worktrees…</span></div>
      ) : visibleItems.length === 0 ? (
        <div className="worktree-review-empty"><CheckIcon /><strong>{emptyFilterTitle(filter)}</strong><span>Choose All worktrees to see the full list.</span></div>
      ) : (
        <ul className="worktree-review-list" aria-live="polite">
          {visibleItems.map((item) => (
            <WorktreeRow
              key={item.worktree.path}
              item={item}
              linkedCards={linkedCards.get(normalizePath(item.worktree.path)) ?? []}
              current={normalizePath(item.repositoryPath) === normalizePath(repository.path)}
              opening={opening}
              onRetry={(base) => void retryItem(item, base)}
              onOpen={() => item.baseBranch && onOpenReview({ repositoryPath: item.repositoryPath, baseBranch: item.baseBranch })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FilterButton({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: string }) {
  return <button type="button" aria-pressed={active} className={active ? "active" : ""} onClick={onClick}>{children}<span>{count}</span></button>;
}

function WorktreeRow({ item, linkedCards, current, opening, onRetry, onOpen }: {
  item: QueueItem;
  linkedCards: LocalCard[];
  current: boolean;
  opening: boolean;
  onRetry: (baseBranch?: string) => void;
  onOpen: () => void;
}) {
  const fileCount = item.comparison?.files.length ?? 0;
  const progress = fileCount > 0 ? Math.round((item.viewedCount / fileCount) * 100) : 100;
  return (
    <li className={`worktree-review-row state-${item.state}`}>
      <div className="worktree-review-identity">
        <div className="worktree-review-branch">
          <strong>{item.branch ?? "Detached HEAD"}</strong>
          {current && <span className="worktree-review-current">Current checkout</span>}
          {item.state === "ready" && item.changedCount > 0 && <span className="worktree-review-changed">Changed again</span>}
        </div>
        <code title={item.worktree.path}>{item.worktree.path}</code>
        {linkedCards.length > 0 && linkedCards.length <= 3 && (
          <div className="worktree-review-links" aria-label="Linked local cards">{linkedCards.map((card) => <span key={card.id}>Local · {card.title}</span>)}</div>
        )}
        {linkedCards.length > 3 && (
          <details className="worktree-review-linked-details">
            <summary>{linkedCards.length} linked local cards</summary>
            <div className="worktree-review-links" aria-label="Linked local cards">{linkedCards.map((card) => <span key={card.id}>Local · {card.title}</span>)}</div>
          </details>
        )}
      </div>

      {item.state === "loading" ? (
        <div className="worktree-review-summary"><Spinner /><span>Checking changes…</span></div>
      ) : item.state === "error" ? (
        <div className="worktree-review-row-error" role="alert"><AlertIcon /><span>{item.error}</span><button type="button" className="secondary-button" disabled={opening} onClick={() => onRetry()}>Try again</button></div>
      ) : item.state === "needs-base" ? (
        <label className="worktree-review-base">Choose a base branch
          <select aria-label={`Base branch for ${item.worktree.path}`} defaultValue="" disabled={opening} onChange={(event) => event.target.value && onRetry(event.target.value)}>
            <option value="" disabled>Select branch…</option>
            {item.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
          </select>
        </label>
      ) : (
        <>
          <div className="worktree-review-summary">
            <strong>{fileCount}</strong>
            <span>{fileCount === 1 ? "file changed" : "files changed"}</span>
            <span className="worktree-review-progress-label">{item.viewedCount} of {fileCount} viewed</span>
            <div className="worktree-review-progress" role="progressbar" aria-label={`Review progress for ${item.branch ?? item.worktree.path}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
          </div>
          <div className="worktree-review-actions">
            <span>from {item.baseBranch}</span>
            <button type="button" className="primary-button" aria-label={`Review ${item.branch ?? item.worktree.path}`} disabled={opening} onClick={onOpen}>{opening ? "Opening…" : "Review changes"}</button>
          </div>
        </>
      )}
    </li>
  );
}

function matchesFilter(item: QueueItem, filter: QueueFilter) {
  if (filter === "all") return true;
  if (filter === "changed") return item.state === "ready" && item.changedCount > 0;
  if (item.state === "loading" || item.state === "error" || item.state === "needs-base") return true;
  const fileCount = item.comparison?.files.length ?? 0;
  return item.state === "ready" && fileCount > 0 && item.viewedCount < fileCount;
}

function emptyFilterTitle(filter: QueueFilter) {
  return filter === "changed" ? "Nothing changed since review" : "No worktrees awaiting review";
}

function loadingItem(worktree: CardWorktree): QueueItem {
  return { worktree, repositoryPath: worktree.path, state: "loading", branch: worktree.branch, branches: [], baseBranch: null, comparison: null, viewedCount: 0, changedCount: 0, error: null };
}

async function summarizeWorktree(
  worktree: CardWorktree,
  repository: WorktreeReviewQueueProps["repository"],
  linkedCards: LocalCard[],
  explicitBase?: string,
): Promise<QueueItem> {
  try {
    const info = await openRepository(worktree.path);
    const branches = info.branches.map((branch) => branch.name);
    const validBranches = new Set(branches);
    const baseBranch = chooseBaseBranch(info, repository, linkedCards, validBranches, explicitBase);
    if (!baseBranch) {
      return { ...loadingItem(worktree), state: "needs-base", branch: worktree.branch ?? info.currentBranch, branches };
    }
    const comparison = await compareWorkingTree(info.path, baseBranch);
    const progress = readReviewProgress(info.path, comparison);
    return {
      worktree,
      repositoryPath: info.path,
      state: "ready",
      branch: worktree.branch ?? info.currentBranch,
      branches,
      baseBranch,
      comparison,
      viewedCount: progress.viewed.size,
      changedCount: progress.changed.size,
      error: null,
    };
  } catch (reason) {
    return { ...loadingItem(worktree), state: "error", error: errorMessage(reason) };
  }
}

function chooseBaseBranch(
  info: RepositoryInfo,
  repository: WorktreeReviewQueueProps["repository"],
  linkedCards: LocalCard[],
  validBranches: ReadonlySet<string>,
  explicitBase?: string,
) {
  if (explicitBase && validBranches.has(explicitBase)) return explicitBase;
  const storedBase = readProjectView(info.path)?.baseBranch;
  if (storedBase && validBranches.has(storedBase)) return storedBase;
  const linkedBases = [...new Set(linkedCards.map((card) => card.workspace?.baseBranch).filter((base): base is string => Boolean(base && validBranches.has(base))))];
  if (linkedBases.length === 1) return linkedBases[0];
  if (info.suggestedBaseBranch && validBranches.has(info.suggestedBaseBranch)) return info.suggestedBaseBranch;
  if (repository.suggestedBaseBranch && validBranches.has(repository.suggestedBaseBranch)) return repository.suggestedBaseBranch;
  return null;
}

function linkedCardsByWorktree(cards: LocalCard[]) {
  const linked = new Map<string, LocalCard[]>();
  for (const card of cards) {
    if (!card.workspace) continue;
    const path = normalizePath(card.workspace.worktreePath);
    const current = linked.get(path) ?? [];
    linked.set(path, [...current, card]);
  }
  return linked;
}

function uniqueWorktrees(worktrees: CardWorktree[]) {
  const seen = new Set<string>();
  return worktrees.filter((worktree) => {
    const path = normalizePath(worktree.path);
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function normalizePath(path: string) {
  return path.replace(/[\\/]+$/, "");
}

function replaceItem(items: QueueItem[], next: QueueItem) {
  return items.map((item) => normalizePath(item.worktree.path) === normalizePath(next.worktree.path) ? next : item);
}

function nextRowRequest(requests: Map<string, number>, path: string) {
  const request = (requests.get(path) ?? 0) + 1;
  requests.set(path, request);
  return request;
}

async function summarizeWithLimit<T>(items: T[], limit: number, summarize: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await summarize(item);
    }
  }));
}
