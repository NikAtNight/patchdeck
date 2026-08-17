export const AGENT_RUNTIME_IDS = ["codex", "claude"] as const;

export type AgentRuntimeId = typeof AGENT_RUNTIME_IDS[number];
export type AgentSandbox = "readOnly" | "workspaceWrite";

export interface AgentRuntimeStatus {
  id: AgentRuntimeId;
  label: string;
  installed: boolean;
  authenticated: boolean | null;
  ready: boolean;
  version: string | null;
  path: string | null;
  authMode: string | null;
  accountLabel: string | null;
  error: string | null;
}

export interface AgentRuntimeStartRequest {
  runtimeId: AgentRuntimeId;
  runId: string;
  repositoryPath: string;
  prompt: string;
  sessionId?: string | null;
  model?: string | null;
  sandbox: AgentSandbox;
  instructions?: string | null;
}

export interface AgentRuntimeStartResult {
  sessionId: string;
  turnId: string | null;
}

export interface AgentRuntimeEvent {
  runtimeId: AgentRuntimeId;
  runId: string;
  type: "agentDelta" | "activity" | "completed" | "error";
  delta?: string | null;
  message?: string | null;
  status?: "completed" | "failed" | "cancelled" | null;
}

export interface AgentRuntimeConnectionResult {
  status: AgentRuntimeStatus;
  message: string | null;
}
