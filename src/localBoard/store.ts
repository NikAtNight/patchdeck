import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeId, AgentSandbox } from "../providers/types";
import { LOCAL_LANES } from "./types";
import type {
  LocalBoardDocument,
  LocalCard,
  LocalCardHandoff,
  LocalLane,
  LocalRun,
  LocalRunMessage,
  LocalRunStatus,
} from "./types";

export const LOCAL_BOARD_MIRROR_KEY = "patchdeck.local-board.v1";
const MAX_CARDS = 2_000;
const MAX_RUNS = 2_000;
const MAX_MESSAGES_PER_RUN = 1_000;

let document: LocalBoardDocument = emptyLocalBoard();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export async function initLocalBoardStore() {
  const mirrorContent = readMirrorContent();
  const local = readLocalBoard(mirrorContent);
  try {
    const content = await invoke<string | null>("load_local_board_store");
    const native = content ? readLocalBoard(content) : null;
    const localIsNewer = Boolean(local && native && local.updatedAt > native.updatedAt);
    const nativeIsNewer = Boolean(native && (!local || native.updatedAt > local.updatedAt));
    const persisted = !native || localIsNewer ? local ?? native ?? emptyLocalBoard() : native;
    document = reconcileInterruptedRuns(persisted);
    const shouldPersistNative = document !== persisted
      || localIsNewer
      || (!native && Boolean(local))
      || isLegacyBoardContent(content)
      || isLegacyBoardContent(mirrorContent);
    if (shouldPersistNative || nativeIsNewer) {
      writeMirror();
    }
    if (shouldPersistNative) {
      schedulePersist();
    }
  } catch {
    const persisted = local ?? emptyLocalBoard();
    document = reconcileInterruptedRuns(persisted);
    if (document !== persisted || isLegacyBoardContent(mirrorContent)) {
      writeMirror();
      schedulePersist();
    }
  }
  emitChange();
}

export function resetLocalBoardStore() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  document = readMirror() ?? emptyLocalBoard();
  listeners.clear();
}

export function useLocalBoardDocument() {
  return useSyncExternalStore(subscribe, getLocalBoardDocument, getLocalBoardDocument);
}

export function getLocalBoardDocument() {
  return document;
}

export function createLocalCard(input: {
  repositoryPath: string;
  title: string;
  body?: string;
  lane?: LocalLane;
  executionProfileId?: string | null;
}) {
  const now = Date.now();
  const card: LocalCard = {
    id: newId("card"),
    repositoryPath: input.repositoryPath,
    title: input.title.trim(),
    body: input.body?.trim() ?? "",
    lane: input.lane ?? "todo",
    executionProfileId: input.executionProfileId ?? null,
    hermesHandoffs: [],
    createdAt: now,
    updatedAt: now,
  };
  updateDocument({ ...document, cards: [...document.cards, card].slice(-MAX_CARDS) });
  return card;
}

export function patchLocalCard(cardId: string, patch: Partial<Pick<LocalCard, "title" | "body" | "lane" | "executionProfileId">>) {
  updateDocument({
    ...document,
    cards: document.cards.map((card) => card.id === cardId
      ? { ...card, ...patch, title: patch.title?.trim() || card.title, updatedAt: Date.now() }
      : card),
  });
}

export function addLocalCardHandoff(cardId: string, handoff: Omit<LocalCardHandoff, "createdAt">) {
  updateDocument({
    ...document,
    cards: document.cards.map((card) => card.id === cardId
      ? {
          ...card,
          hermesHandoffs: [...card.hermesHandoffs, { ...handoff, createdAt: Date.now() }],
          updatedAt: Date.now(),
        }
      : card),
  });
}

export function deleteLocalCard(cardId: string) {
  updateDocument({
    ...document,
    cards: document.cards.filter((card) => card.id !== cardId),
    runs: document.runs.filter((run) => run.cardId !== cardId),
  });
}

export function createLocalRun(cardId: string, prompt: string, profile: ExecutionProfile) {
  const now = Date.now();
  const run: LocalRun = {
    id: newId("run"),
    cardId,
    runtimeId: profile.runtimeId,
    executionProfileId: profile.id,
    sessionId: null,
    model: profile.model,
    sandbox: profile.sandbox,
    instructions: profile.instructions,
    status: "starting",
    messages: [{ id: newId("message"), role: "user", body: prompt, createdAt: now }],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  updateDocument({ ...document, runs: [...document.runs, run].slice(-MAX_RUNS) });
  return run;
}

export function addRunUserMessage(runId: string, body: string) {
  appendRunMessage(runId, { id: newId("message"), role: "user", body, createdAt: Date.now() });
  patchLocalRun(runId, { status: "starting", error: null });
}

export function appendRunAgentDelta(runId: string, delta: string) {
  if (!delta) return;
  const run = document.runs.find((candidate) => candidate.id === runId);
  if (!run) return;
  const messages = [...run.messages];
  const last = messages[messages.length - 1];
  if (last?.role === "agent") messages[messages.length - 1] = { ...last, body: last.body + delta };
  else messages.push({ id: newId("message"), role: "agent", body: delta, createdAt: Date.now() });
  patchLocalRun(runId, { messages: messages.slice(-MAX_MESSAGES_PER_RUN) });
}

export function appendRunActivity(runId: string, body: string) {
  const run = document.runs.find((candidate) => candidate.id === runId);
  const last = run?.messages[run.messages.length - 1];
  if (last?.role === "activity" && last.body === body) return;
  appendRunMessage(runId, { id: newId("message"), role: "activity", body, createdAt: Date.now() });
}

export function patchLocalRun(runId: string, patch: Partial<Pick<LocalRun, "sessionId" | "status" | "messages" | "error">>) {
  updateDocument({
    ...document,
    runs: document.runs.map((run) => run.id === runId ? { ...run, ...patch, updatedAt: Date.now() } : run),
  });
}

export function latestRunForCard(cardId: string) {
  return [...document.runs].reverse().find((run) => run.cardId === cardId) ?? null;
}

export async function flushLocalBoardStore() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  await invoke("save_local_board_store", { content: JSON.stringify(document) });
}

function appendRunMessage(runId: string, message: LocalRunMessage) {
  const run = document.runs.find((candidate) => candidate.id === runId);
  if (!run) return;
  patchLocalRun(runId, { messages: [...run.messages, message].slice(-MAX_MESSAGES_PER_RUN) });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function updateDocument(next: LocalBoardDocument) {
  document = { ...next, updatedAt: Date.now() };
  try {
    localStorage.setItem(LOCAL_BOARD_MIRROR_KEY, JSON.stringify(document));
  } catch {
    // The in-memory board remains usable when browser storage is unavailable.
  }
  emitChange();
  schedulePersist();
}

function emitChange() {
  listeners.forEach((listener) => listener());
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flushLocalBoardStore().catch(() => {}), 300);
}

function readMirror() {
  try {
    return readLocalBoard(readMirrorContent());
  } catch {
    return null;
  }
}

function readMirrorContent() {
  try {
    return localStorage.getItem(LOCAL_BOARD_MIRROR_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeMirror() {
  try {
    localStorage.setItem(LOCAL_BOARD_MIRROR_KEY, JSON.stringify(document));
  } catch {
    // The native store can still persist the migrated document.
  }
}

function isLegacyBoardContent(content: string | null) {
  if (!content) return false;
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) && value.version === 1;
  } catch {
    return false;
  }
}

export function readLocalBoard(content: string): LocalBoardDocument | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return null;
    const cards = Array.isArray(value.cards) ? value.cards.map(sanitizeCard).filter(isPresent).slice(-MAX_CARDS) : [];
    const cardIds = new Set(cards.map((card) => card.id));
    const runs = Array.isArray(value.runs)
      ? value.runs.map(sanitizeRun).filter(isPresent).filter((run) => cardIds.has(run.cardId)).slice(-MAX_RUNS)
      : [];
    return {
      version: 2,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
      cards,
      runs,
    };
  } catch {
    return null;
  }
}

function sanitizeCard(value: unknown): LocalCard | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.repositoryPath !== "string"
    || typeof value.title !== "string"
    || typeof value.body !== "string"
    || !LOCAL_LANES.includes(value.lane as LocalLane)) return null;
  return {
    id: value.id,
    repositoryPath: value.repositoryPath,
    title: value.title,
    body: value.body,
    lane: value.lane as LocalLane,
    executionProfileId: typeof value.executionProfileId === "string"
      ? value.executionProfileId
      : value.provider === "codex" ? "codex-workspace" : null,
    hermesHandoffs: Array.isArray(value.hermesHandoffs)
      ? value.hermesHandoffs.map(sanitizeHandoff).filter(isPresent)
      : [],
    createdAt: numberOrNow(value.createdAt),
    updatedAt: numberOrNow(value.updatedAt),
  };
}

function sanitizeRun(value: unknown): LocalRun | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.cardId !== "string"
    || !isRunStatus(value.status)) return null;
  const runtimeId = sanitizeRuntimeId(value.runtimeId ?? value.provider);
  if (!runtimeId) return null;
  return {
    id: value.id,
    cardId: value.cardId,
    runtimeId,
    executionProfileId: typeof value.executionProfileId === "string"
      ? value.executionProfileId
      : runtimeId === "codex" ? "codex-workspace" : "claude-workspace",
    sessionId: typeof value.sessionId === "string"
      ? value.sessionId
      : typeof value.threadId === "string" ? value.threadId : null,
    model: typeof value.model === "string" ? value.model : "",
    sandbox: sanitizeSandbox(value.sandbox),
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    status: value.status,
    messages: Array.isArray(value.messages) ? value.messages.map(sanitizeMessage).filter(isPresent).slice(-MAX_MESSAGES_PER_RUN) : [],
    error: typeof value.error === "string" ? value.error : null,
    createdAt: numberOrNow(value.createdAt),
    updatedAt: numberOrNow(value.updatedAt),
  };
}

function reconcileInterruptedRuns(board: LocalBoardDocument) {
  const interrupted = board.runs.some((run) => run.status === "starting" || run.status === "running");
  if (!interrupted) return board;
  const updatedAt = Math.max(Date.now(), board.updatedAt + 1);
  return {
    ...board,
    updatedAt,
    runs: board.runs.map((run) => run.status === "starting" || run.status === "running"
      ? {
          ...run,
          status: "failed" as const,
          error: "Run interrupted when Patchdeck restarted. Continue or retry it.",
          updatedAt,
        }
      : run),
  };
}

function sanitizeHandoff(value: unknown): LocalCardHandoff | null {
  if (!isRecord(value) || typeof value.board !== "string" || typeof value.taskId !== "string") return null;
  return { board: value.board, taskId: value.taskId, createdAt: numberOrNow(value.createdAt) };
}

function sanitizeMessage(value: unknown): LocalRunMessage | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || (value.role !== "user" && value.role !== "agent" && value.role !== "activity")
    || typeof value.body !== "string") return null;
  return { id: value.id, role: value.role, body: value.body, createdAt: numberOrNow(value.createdAt) };
}

function sanitizeRuntimeId(value: unknown): AgentRuntimeId | null {
  return value === "codex" || value === "claude" ? value : null;
}

function sanitizeSandbox(value: unknown): AgentSandbox {
  return value === "readOnly" ? "readOnly" : "workspaceWrite";
}

function isRunStatus(value: unknown): value is LocalRunStatus {
  return value === "starting" || value === "running" || value === "idle" || value === "failed" || value === "cancelled";
}

function emptyLocalBoard(): LocalBoardDocument {
  return { version: 2, updatedAt: 0, cards: [], runs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function numberOrNow(value: unknown) {
  return typeof value === "number" ? value : Date.now();
}

function newId(prefix: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}
