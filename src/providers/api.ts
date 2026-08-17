import { invoke } from "@tauri-apps/api/core";
import type {
  AgentRuntimeConnectionResult,
  AgentRuntimeId,
  AgentRuntimeStartRequest,
  AgentRuntimeStartResult,
  AgentRuntimeStatus,
} from "./types";

export const listAgentRuntimes = () =>
  invoke<AgentRuntimeStatus[]>("agent_runtime_list");

export const connectAgentRuntime = (runtimeId: AgentRuntimeId) =>
  invoke<AgentRuntimeConnectionResult>("agent_runtime_connect", { runtimeId });

export const disconnectAgentRuntime = (runtimeId: AgentRuntimeId) =>
  invoke<AgentRuntimeStatus>("agent_runtime_disconnect", { runtimeId });

export const startAgentRuntime = (request: AgentRuntimeStartRequest) =>
  invoke<AgentRuntimeStartResult>("agent_runtime_start", { request });

export const stopAgentRuntime = (runtimeId: AgentRuntimeId, runId: string) =>
  invoke<void>("agent_runtime_stop", { runtimeId, runId });
