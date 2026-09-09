import { startAgentRuntime, stopAgentRuntime } from "../providers/api";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeEvent } from "../providers/types";
import { errorMessage } from "../errors";
import {
  addRunUserMessage,
  appendRunActivity,
  appendRunAgentDelta,
  createLocalRun,
  getLocalBoardDocument,
  patchLocalCard,
  patchLocalRun,
} from "./store";
import type { LocalCard, LocalRun } from "./types";

export async function launchLocalCard(card: LocalCard, profile: ExecutionProfile) {
  if (!card.workspace) throw new Error("Choose or create a workspace before starting this card.");
  const prompt = card.body ? `${card.title}\n\n${card.body}` : card.title;
  patchLocalCard(card.id, { executionProfileId: profile.id, lane: "in_progress" });
  const run = createLocalRun(card.id, prompt, profile, card.workspace.worktreePath, card.workspace.baseBranch);
  await executeLocalTurn(run, run.repositoryPath!, prompt);
  return run;
}

export async function continueLocalRun(run: LocalRun, repositoryPath: string, prompt: string) {
  if (!run.repositoryPath) {
    patchLocalRun(run.id, {
      status: "failed",
      error: "This older conversation has no recorded workspace. Start a new card in an isolated workspace to continue safely.",
    });
    return;
  }
  const executionPath = run.repositoryPath ?? repositoryPath;
  addRunUserMessage(run.id, prompt);
  const card = getLocalBoardDocument().cards.find((candidate) => candidate.id === run.cardId);
  if (card) patchLocalCard(card.id, { lane: "in_progress" });
  await executeLocalTurn({ ...run, status: "starting" }, executionPath, prompt);
}

export async function stopLocalRun(run: LocalRun) {
  await stopAgentRuntime(run.runtimeId, run.id);
  patchLocalRun(run.id, { status: "cancelled", error: null });
}

export async function executeLocalTurn(run: LocalRun, repositoryPath: string, prompt: string) {
  patchLocalRun(run.id, { status: "starting", error: null });
  try {
    const result = await startAgentRuntime({
      runtimeId: run.runtimeId,
      runId: run.id,
      repositoryPath,
      prompt,
      sessionId: run.sessionId,
      model: run.model || null,
      sandbox: run.sandbox,
      instructions: run.instructions || null,
    });
    const currentStatus = getLocalBoardDocument().runs.find((candidate) => candidate.id === run.id)?.status;
    patchLocalRun(run.id, {
      sessionId: result.sessionId,
      status: currentStatus === "starting" ? "running" : currentStatus,
    });
  } catch (error) {
    const currentStatus = getLocalBoardDocument().runs.find((candidate) => candidate.id === run.id)?.status;
    if (currentStatus === "cancelled") return;
    patchLocalRun(run.id, { status: "failed", error: errorMessage(error) });
  }
}

export function applyAgentRuntimeEvent(event: AgentRuntimeEvent) {
  const run = getLocalBoardDocument().runs.find((candidate) => candidate.id === event.runId);
  if (!run || run.runtimeId !== event.runtimeId) return;
  if (event.type === "agentDelta") {
    appendRunAgentDelta(event.runId, event.delta ?? "");
    return;
  }
  if (event.type === "activity") {
    if (event.message) appendRunActivity(event.runId, event.message);
    return;
  }
  if (event.type === "completed") {
    const status = event.status === "cancelled" ? "cancelled" : event.status === "failed" ? "failed" : "idle";
    patchLocalRun(event.runId, {
      status,
      error: event.status === "failed" ? event.message ?? run.error : null,
    });
    if (status === "idle") patchLocalCard(run.cardId, { lane: "review" });
    return;
  }
  if (event.type === "error") {
    patchLocalRun(event.runId, { status: "failed", error: event.message || `${runtimeLabel(run.runtimeId)} run failed` });
  }
}

export function runtimeLabel(runtimeId: LocalRun["runtimeId"]) {
  return runtimeId === "claude" ? "Claude Code" : "Codex";
}
