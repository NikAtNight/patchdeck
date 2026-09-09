import { useSyncExternalStore } from "react";
import type { AgentRuntimeId, AgentSandbox } from "./types";

export const EXECUTION_PROFILES_KEY = "patchdeck.execution-profiles.v1";

export interface ExecutionProfile {
  id: string;
  name: string;
  runtimeId: AgentRuntimeId;
  model: string;
  sandbox: AgentSandbox;
  instructions: string;
  builtIn: boolean;
}

interface ExecutionProfileDocument {
  version: 1;
  profiles: ExecutionProfile[];
  defaultsByRepository: Record<string, string>;
  deletedBuiltInIds: string[];
}

const listeners = new Set<() => void>();
let document = readDocument();

export function useExecutionProfiles() {
  return useSyncExternalStore(subscribe, getExecutionProfileDocument, getExecutionProfileDocument);
}

export function getExecutionProfileDocument() {
  return document;
}

export function saveExecutionProfile(input: Omit<ExecutionProfile, "id" | "builtIn"> & { id?: string }) {
  const current = input.id ? document.profiles.find((profile) => profile.id === input.id) : null;
  if (current?.builtIn) return current;
  const profile: ExecutionProfile = {
    id: current?.id ?? newId(),
    name: input.name.trim(),
    runtimeId: input.runtimeId,
    model: input.model.trim(),
    sandbox: input.sandbox,
    instructions: input.instructions.trim(),
    builtIn: current?.builtIn ?? false,
  };
  update({
    ...document,
    profiles: current
      ? document.profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      : [...document.profiles, profile],
  });
  return profile;
}

export function deleteExecutionProfile(profileId: string) {
  const profile = document.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) return;
  const defaultsByRepository = Object.fromEntries(
    Object.entries(document.defaultsByRepository).filter(([, candidate]) => candidate !== profileId),
  );
  update({
    ...document,
    profiles: document.profiles.filter((profile) => profile.id !== profileId),
    defaultsByRepository,
    deletedBuiltInIds: profile.builtIn
      ? [...new Set([...document.deletedBuiltInIds, profileId])]
      : document.deletedBuiltInIds,
  });
}

export function setRepositoryExecutionProfile(repositoryPath: string, profileId: string | null) {
  const defaultsByRepository = { ...document.defaultsByRepository };
  if (profileId) defaultsByRepository[repositoryPath] = profileId;
  else delete defaultsByRepository[repositoryPath];
  update({ ...document, defaultsByRepository });
}

export function executionProfileForRepository(repositoryPath: string) {
  const selectedId = document.defaultsByRepository[repositoryPath];
  return document.profiles.find((profile) => profile.id === selectedId)
    ?? document.profiles.find((profile) => profile.id === "codex-workspace")
    ?? document.profiles[0]
    ?? null;
}

export function resetExecutionProfiles() {
  document = readDocument();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: ExecutionProfileDocument) {
  document = next;
  try {
    localStorage.setItem(EXECUTION_PROFILES_KEY, JSON.stringify(next));
  } catch {
    // Profiles remain available in memory when browser storage is unavailable.
  }
  emit();
}

function emit() {
  listeners.forEach((listener) => listener());
}

function readDocument(): ExecutionProfileDocument {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(EXECUTION_PROFILES_KEY) ?? "");
    if (isRecord(value) && value.version === 1 && Array.isArray(value.profiles)) {
      const deletedBuiltInIds = Array.isArray(value.deletedBuiltInIds)
        ? value.deletedBuiltInIds.filter((id): id is string => typeof id === "string")
        : [];
      const profiles = mergeBuiltIns(value.profiles.map(sanitizeProfile).filter(isPresent), deletedBuiltInIds);
      const profileIds = new Set(profiles.map((profile) => profile.id));
      const defaultsByRepository = isStringRecord(value.defaultsByRepository)
        ? Object.fromEntries(Object.entries(value.defaultsByRepository).filter(([, profileId]) => profileIds.has(profileId)))
        : {};
      return {
        version: 1,
        profiles,
        defaultsByRepository,
        deletedBuiltInIds,
      };
    }
  } catch {
    // Fall through to built-in profiles.
  }
  return { version: 1, profiles: builtInProfiles(), defaultsByRepository: {}, deletedBuiltInIds: [] };
}

function sanitizeProfile(value: unknown): ExecutionProfile | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || (value.runtimeId !== "codex" && value.runtimeId !== "claude")
    || (value.sandbox !== "readOnly" && value.sandbox !== "workspaceWrite")) return null;
  return {
    id: value.id,
    name: value.name,
    runtimeId: value.runtimeId,
    model: typeof value.model === "string" ? value.model : "",
    sandbox: value.sandbox,
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    builtIn: false,
  };
}

function mergeBuiltIns(profiles: ExecutionProfile[], deletedBuiltInIds: string[]) {
  const deleted = new Set(deletedBuiltInIds);
  const builtIns = builtInProfiles().filter((profile) => !deleted.has(profile.id));
  const builtInIds = new Set(builtIns.map((profile) => profile.id));
  const allBuiltInIds = new Set(builtInProfiles().map((profile) => profile.id));
  return [...builtIns, ...profiles.filter((profile) => !builtInIds.has(profile.id) && !allBuiltInIds.has(profile.id))];
}

function builtInProfiles(): ExecutionProfile[] {
  return [
    { id: "codex-workspace", name: "Codex · Workspace Write", runtimeId: "codex", model: "", sandbox: "workspaceWrite", instructions: "", builtIn: true },
    { id: "codex-review", name: "Codex · Review Only", runtimeId: "codex", model: "", sandbox: "readOnly", instructions: "Review the repository without modifying files.", builtIn: true },
    { id: "claude-workspace", name: "Claude Code · Workspace Write", runtimeId: "claude", model: "", sandbox: "workspaceWrite", instructions: "", builtIn: true },
  ];
}

function newId() {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((candidate) => typeof candidate === "string");
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
