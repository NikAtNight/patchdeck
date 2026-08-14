import { invoke } from "@tauri-apps/api/core";
import type { InlineReviewComment, ReviewTarget } from "./inlineComments";

export const COMMENTS_KEY = "branch-diff-viewer.inline-review-comments.v1";
export const TARGET_KEY = "branch-diff-viewer.review-target.v1";
export const REVIEWED_FILES_KEY = "branch-diff-viewer.reviewed-files.v1";
// Full-document localStorage mirror, so startup can pick whichever copy
// (native file or mirror) carries the newest write.
export const MIRROR_KEY = "branch-diff-viewer.review-store.v1";

// Stay under the backend's 5 MB save limit with room for growth between
// prunes; oversized documents are trimmed before persisting.
const MAX_PERSIST_BYTES = 4_500_000;
const MAX_SENT_COMMENTS_WHEN_PRUNING = 500;

export interface ReviewStoreDocument {
  version: 2;
  updatedAt: number;
  inlineComments: InlineReviewComment[];
  reviewTargets: Record<string, ReviewTarget>;
  reviewedFiles: Record<string, string[]>;
}

let document: ReviewStoreDocument = emptyDocument();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let queuedPersistContent: string | undefined;
let persistPromise: Promise<void> | undefined;
let persistenceError: Error | null = null;

export async function initReviewStore() {
  try {
    const content = await invoke<string | null>("load_review_store");
    const native = content ? readDocument(content) : null;
    const local = readLocalDocument();
    if (native || local) {
      // The debounced native save can lose the final pre-quit write; the
      // synchronous mirror cannot. Prefer whichever copy is newest.
      document = !native || (local && local.updatedAt > native.updatedAt) ? local ?? native! : native;
      if (!native || (local && local.updatedAt > native.updatedAt)) schedulePersist();
    } else {
      document = emptyDocument();
    }
  } catch {
    document = readLocalDocument() ?? emptyDocument();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", handlePagehide);
  }
}

// Re-reads state from the environment. Exists for test isolation: the module
// cache outlives localStorage.clear() between cases in a suite.
export function resetReviewStore() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  queuedPersistContent = undefined;
  persistPromise = undefined;
  persistenceError = null;
  document = readLocalDocument() ?? emptyDocument();
}

export function readStoredInlineComments() {
  return document.inlineComments;
}

export function writeStoredInlineComments(comments: InlineReviewComment[]) {
  document = touch({ ...document, inlineComments: sanitizeInlineComments(comments.slice(-2_000)) });
  writeLegacyValue(COMMENTS_KEY, JSON.stringify(document.inlineComments));
  mirrorAndPersist();
}

export function readStoredReviewTarget(repositoryPath: string) {
  return document.reviewTargets[repositoryPath] ?? null;
}

export function writeStoredReviewTarget(repositoryPath: string, target: ReviewTarget | null) {
  const reviewTargets = { ...document.reviewTargets };
  if (isReviewTarget(target)) reviewTargets[repositoryPath] = { ...target, repositoryPath };
  else delete reviewTargets[repositoryPath];
  document = touch({ ...document, reviewTargets });
  // A single legacy target cannot represent repository-keyed state.
  removeLegacyValue(TARGET_KEY);
  mirrorAndPersist();
}

export function readReviewStorePersistenceError() {
  return persistenceError;
}

export function readStoredReviewedFiles() {
  return document.reviewedFiles;
}

export function writeStoredReviewedFiles(reviewedFiles: Record<string, string[]>) {
  document = touch({ ...document, reviewedFiles: sanitizeReviewedFiles(reviewedFiles) });
  writeLegacyValue(REVIEWED_FILES_KEY, JSON.stringify(document.reviewedFiles));
  mirrorAndPersist();
}

export function isReviewTarget(value: unknown): value is ReviewTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["board", "taskId", "title", "status"].every((key) => typeof candidate[key] === "string")
    && (candidate.repositoryPath === undefined || typeof candidate.repositoryPath === "string");
}

export function isInlineComment(value: unknown): value is InlineReviewComment {
  const comment = sanitizeInlineComment(value);
  if (!comment || !value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.contextFingerprint === "string"
    && typeof candidate.author === "string"
    && (candidate.state === "open" || candidate.state === "addressed" || candidate.state === "outdated")
    && typeof candidate.updatedAt === "number";
}

function sanitizeInlineComment(value: unknown): InlineReviewComment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const valid = typeof candidate.id === "string"
    && typeof candidate.repositoryPath === "string"
    && typeof candidate.board === "string"
    && typeof candidate.taskId === "string"
    && typeof candidate.baseCommit === "string"
    && typeof candidate.compareCommit === "string"
    && typeof candidate.path === "string"
    && (candidate.side === "old" || candidate.side === "new")
    && typeof candidate.line === "number"
    && typeof candidate.context === "string"
    && typeof candidate.body === "string"
    && typeof candidate.createdAt === "number"
    && (candidate.sentAt === null || typeof candidate.sentAt === "number");
  if (!valid) return null;
  return {
    id: candidate.id as string,
    repositoryPath: candidate.repositoryPath as string,
    board: candidate.board as string,
    taskId: candidate.taskId as string,
    baseCommit: candidate.baseCommit as string,
    compareCommit: candidate.compareCommit as string,
    path: candidate.path as string,
    side: candidate.side as "old" | "new",
    line: candidate.line as number,
    context: candidate.context as string,
    contextFingerprint: typeof candidate.contextFingerprint === "string"
      ? candidate.contextFingerprint
      : `legacy:${candidate.context as string}`,
    body: candidate.body as string,
    author: typeof candidate.author === "string" ? candidate.author : "human-review",
    state: candidate.state === "addressed" || candidate.state === "outdated" ? candidate.state : "open",
    createdAt: candidate.createdAt as number,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : candidate.createdAt as number,
    sentAt: candidate.sentAt as number | null,
  };
}

function sanitizeInlineComments(value: unknown[]): InlineReviewComment[] {
  return value.map(sanitizeInlineComment).filter((comment): comment is InlineReviewComment => comment !== null);
}

function emptyDocument(): ReviewStoreDocument {
  return { version: 2, updatedAt: 0, inlineComments: [], reviewTargets: {}, reviewedFiles: {} };
}

function touch(next: ReviewStoreDocument): ReviewStoreDocument {
  return { ...next, updatedAt: Date.now() };
}

function readDocument(content: string): ReviewStoreDocument | null {
  try {
    return sanitizeDocument(JSON.parse(content));
  } catch {
    return null;
  }
}

// The mirror carries the whole document; the individual legacy keys only
// matter for migrating installs that predate the native store.
function readLocalDocument(): ReviewStoreDocument | null {
  const mirror = readLegacyJson(MIRROR_KEY);
  if (mirror) {
    const parsed = sanitizeDocument(mirror);
    if (parsed) return parsed;
  }
  if (!hasLegacyValues()) return null;
  const comments = readLegacyJson(COMMENTS_KEY);
  const target = readLegacyJson(TARGET_KEY);
  return {
    version: 2,
    updatedAt: 0,
    inlineComments: Array.isArray(comments) ? sanitizeInlineComments(comments).slice(-2_000) : [],
    reviewTargets: targetToMap(target),
    reviewedFiles: sanitizeReviewedFiles(readLegacyJson(REVIEWED_FILES_KEY)),
  } satisfies ReviewStoreDocument;
}

function sanitizeDocument(value: unknown): ReviewStoreDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 && candidate.version !== 2) return null;
  return {
    version: 2,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
    inlineComments: Array.isArray(candidate.inlineComments)
      ? sanitizeInlineComments(candidate.inlineComments).slice(-2_000)
      : [],
    reviewTargets: candidate.version === 2
      ? sanitizeReviewTargets(candidate.reviewTargets)
      : targetToMap(candidate.reviewTarget),
    reviewedFiles: sanitizeReviewedFiles(candidate.reviewedFiles),
  };
}

function targetToMap(value: unknown): Record<string, ReviewTarget> {
  if (!isReviewTarget(value) || !value.repositoryPath) return {};
  return { [value.repositoryPath]: value };
}

function sanitizeReviewTargets(value: unknown): Record<string, ReviewTarget> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([repositoryPath, target]) => repositoryPath.length > 0 && isReviewTarget(target))
    .map(([repositoryPath, target]) => [repositoryPath, { ...(target as ReviewTarget), repositoryPath }]));
}

function sanitizeReviewedFiles(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, paths]) => [key, Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : []]));
}

function readLegacyJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function hasLegacyValues() {
  try {
    return [COMMENTS_KEY, TARGET_KEY, REVIEWED_FILES_KEY].some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

function writeLegacyValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local storage is unavailable in some browser contexts.
  }
}

function removeLegacyValue(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Local storage is unavailable in some browser contexts.
  }
}

function mirrorAndPersist() {
  writeLegacyValue(MIRROR_KEY, JSON.stringify(document));
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void flushReviewStore().catch(() => {});
  }, 300);
}

function handlePagehide() {
  void flushReviewStore().catch(() => {});
}

export function flushReviewStore(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  try {
    queuedPersistContent = persistableContent();
    persistenceError = null;
  } catch (error) {
    persistenceError = toError(error);
    return Promise.reject(persistenceError);
  }
  persistPromise ??= drainPersistQueue();
  return persistPromise;
}

async function drainPersistQueue(): Promise<void> {
  let lastError: Error | null = null;
  while (queuedPersistContent !== undefined) {
    const content = queuedPersistContent;
    queuedPersistContent = undefined;
    try {
      await invoke("save_review_store", { content });
      lastError = null;
    } catch (error) {
      lastError = toError(error);
    }
  }
  if (lastError) persistenceError = lastError;
  persistPromise = undefined;
  if (lastError) throw lastError;
}

// The backend rejects documents over 5 MB; rather than silently failing
// forever, shed the oldest sent comments and reviewed-file history first.
function persistableContent(): string {
  let content = JSON.stringify(document);
  if (utf8Bytes(content) <= MAX_PERSIST_BYTES) return content;

  const unsent = document.inlineComments.filter((comment) => comment.sentAt === null);
  const sent = document.inlineComments.filter((comment) => comment.sentAt !== null);
  const pruned: ReviewStoreDocument = {
    ...document,
    inlineComments: [...sent.slice(-MAX_SENT_COMMENTS_WHEN_PRUNING), ...unsent],
  };
  content = JSON.stringify(pruned);
  if (utf8Bytes(content) <= MAX_PERSIST_BYTES) return content;

  const reviewedEntries = Object.entries(pruned.reviewedFiles);
  content = JSON.stringify({ ...pruned, reviewedFiles: Object.fromEntries(reviewedEntries.slice(-100)) });
  if (utf8Bytes(content) <= MAX_PERSIST_BYTES) return content;
  throw new Error("Review store exceeds the native persistence limit; unsent comments remain available in the current review session.");
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
