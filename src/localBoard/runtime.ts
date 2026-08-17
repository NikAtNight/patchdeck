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
  const prompt = card.body ? `${card.title}\n\n${card.body}` : card.title;
  patchLocalCard(card.id, { executionProfileId: profile.id, lane: "in_progress" });
  const run = createLocalRun(card.id, prompt, profile);
  await executeLocalTurn(run, card.repositoryPath, prompt);
  return run;
}

export async function continueLocalRun(run: LocalRun, repositoryPath: string, prompt: string) {
  addRunUserMessage(run.id, prompt);
  await executeLocalTurn({ ...run, status: "starting" }, repositoryPath, prompt);
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
    patchLocalRun(event.runId, {
      status: event.status === "cancelled" ? "cancelled" : event.status === "failed" ? "failed" : "idle",
      error: event.status === "failed" ? event.message ?? run.error : null,
    });
    return;
  }
  if (event.type === "error") {
    patchLocalRun(event.runId, { status: "failed", error: event.message || `${runtimeLabel(run.runtimeId)} run failed` });
  }
}

export function runtimeLabel(runtimeId: LocalRun["runtimeId"]) {
  return runtimeId === "claude" ? "Claude Code" : "Codex";
}
