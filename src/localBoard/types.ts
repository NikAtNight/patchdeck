import type { AgentRuntimeId, AgentSandbox } from "../providers/types";

export const LOCAL_LANES = ["todo", "in_progress", "review", "done"] as const;

export type LocalLane = typeof LOCAL_LANES[number];
export type LocalRunStatus = "starting" | "running" | "idle" | "failed" | "cancelled";

export interface LocalCardHandoff {
  board: string;
  taskId: string;
  createdAt: number;
}

export interface LocalCard {
  id: string;
  repositoryPath: string;
  title: string;
  body: string;
  lane: LocalLane;
  executionProfileId: string | null;
  hermesHandoffs: LocalCardHandoff[];
  createdAt: number;
  updatedAt: number;
}

export interface LocalRunMessage {
  id: string;
  role: "user" | "agent" | "activity";
  body: string;
  createdAt: number;
}

export interface LocalRun {
  id: string;
  cardId: string;
  runtimeId: AgentRuntimeId;
  executionProfileId: string;
  sessionId: string | null;
  model: string;
  sandbox: AgentSandbox;
  instructions: string;
  status: LocalRunStatus;
  messages: LocalRunMessage[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalBoardDocument {
  version: 2;
  updatedAt: number;
  cards: LocalCard[];
  runs: LocalRun[];
}
