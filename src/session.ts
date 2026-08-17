import { invoke } from "@tauri-apps/api/core";
import type { RepositoryInfo } from "./types";

export type AppSurface = "review" | "agent";

export interface ProjectTab {
  id: string;
  name: string;
  path: string;
  repository: RepositoryInfo | null;
  openMode: "repository" | "workspace";
  loading: boolean;
  error: string | null;
}

const RECENT_REPOSITORIES_KEY = "patchdeck.recent-repositories";
const PROJECT_SESSION_KEY = "patchdeck.session";
const APP_SURFACE_KEY = "patchdeck.active-surface";
const PROJECT_VIEWS_KEY = "patchdeck.project-views.v1";
const PRE_PATCHDECK_STORAGE_PREFIX = ["branch", "diff", "viewer"].join("-");
const STORAGE_MIGRATION_KEY = "patchdeck.storage-migration.v1";
const MIGRATED_STORAGE_KEYS = [
  RECENT_REPOSITORIES_KEY,
  PROJECT_SESSION_KEY,
  APP_SURFACE_KEY,
  PROJECT_VIEWS_KEY,
  "patchdeck.hermes.selected-board",
  "patchdeck.hermes.selected-boards",
  "patchdeck.inline-review-comments.v1",
  "patchdeck.review-store.v1",
  "patchdeck.review-target.v1",
  "patchdeck.reviewed-files.v1",
] as const;

export async function initSessionStore() {
  for (const key of MIGRATED_STORAGE_KEYS) readStorageValue(key);
  if (localStorage.getItem(STORAGE_MIGRATION_KEY) === "complete") return;
  try {
    const values = await invoke<Record<string, string>>("load_pre_patchdeck_webkit_storage");
    for (const key of MIGRATED_STORAGE_KEYS) {
      if (localStorage.getItem(key) === null && typeof values[key] === "string") {
        localStorage.setItem(key, values[key]);
      }
    }
    localStorage.setItem(STORAGE_MIGRATION_KEY, "complete");
  } catch {
    // Browser previews and platforms without an old WebKit container need no migration.
  }
}

export interface ProjectView {
  baseBranch: string;
  compareBranch: string;
  selectedPath: string | null;
}

export function readRecentRepositories(): string[] {
  try {
    const value = JSON.parse(readStorageValue(RECENT_REPOSITORIES_KEY) ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function writeRecentRepositories(paths: string[]) {
  localStorage.setItem(RECENT_REPOSITORIES_KEY, JSON.stringify(paths));
}

export function readAppSurface(): AppSurface {
  return readStorageValue(APP_SURFACE_KEY) === "agent" ? "agent" : "review";
}

export function writeAppSurface(surface: AppSurface) {
  localStorage.setItem(APP_SURFACE_KEY, surface);
}

export function readProjectView(path: string): ProjectView | null {
  try {
    const value: unknown = JSON.parse(readStorageValue(PROJECT_VIEWS_KEY) ?? "null");
    if (!isRecord(value)) return null;
    const candidate = value[path];
    return isProjectView(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function writeProjectView(path: string, view: ProjectView) {
  try {
    const value: unknown = JSON.parse(readStorageValue(PROJECT_VIEWS_KEY) ?? "{}");
    const current = isRecord(value) ? value : {};
    const entries = Object.entries(current)
      .filter(([storedPath, storedView]) => storedPath !== path && isProjectView(storedView))
      .slice(-49);
    localStorage.setItem(PROJECT_VIEWS_KEY, JSON.stringify({
      ...Object.fromEntries(entries),
      [path]: view,
    }));
  } catch {
    // Storage can be unavailable; the current in-memory view still works normally.
  }
}

export function readProjectSession(): {
  tabs: ProjectTab[];
  activeTabId: string | null;
  nextTabId: number;
} {
  try {
    const value: unknown = JSON.parse(readStorageValue(PROJECT_SESSION_KEY) ?? "null");
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tabs)) {
      return { tabs: [], activeTabId: null, nextTabId: 1 };
    }

    const seenPaths = new Set<string>();
    const tabs: ProjectTab[] = [];
    for (const candidate of value.tabs.slice(0, 50)) {
      if (
        !isRecord(candidate)
        || typeof candidate.name !== "string"
        || typeof candidate.path !== "string"
        || (candidate.openMode !== "repository" && candidate.openMode !== "workspace")
        || seenPaths.has(candidate.path)
      ) {
        continue;
      }
      seenPaths.add(candidate.path);
      tabs.push({
        id: `project-${tabs.length + 1}`,
        name: candidate.name,
        path: candidate.path,
        repository: null,
        openMode: candidate.openMode,
        loading: false,
        error: null,
      });
    }

    const activePath = typeof value.activePath === "string" ? value.activePath : null;
    const activeTabId = tabs.find((tab) => tab.path === activePath)?.id ?? tabs[0]?.id ?? null;
    return { tabs, activeTabId, nextTabId: tabs.length + 1 };
  } catch {
    return { tabs: [], activeTabId: null, nextTabId: 1 };
  }
}

export function persistProjectSession(tabs: ProjectTab[], activeTabId: string | null) {
  try {
    if (tabs.length === 0) {
      localStorage.removeItem(PROJECT_SESSION_KEY);
      return;
    }
    localStorage.setItem(PROJECT_SESSION_KEY, JSON.stringify({
      version: 1,
      tabs: tabs.map(({ name, path, openMode }) => ({ name, path, openMode })),
      activePath: tabs.find((tab) => tab.id === activeTabId)?.path ?? tabs[0].path,
    }));
  } catch {
    // Storage can be unavailable; the current in-memory session still works normally.
  }
}

function readStorageValue(key: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacyKey = `${PRE_PATCHDECK_STORAGE_PREFIX}${key.slice("patchdeck".length)}`;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;
  localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProjectView(value: unknown): value is ProjectView {
  return isRecord(value)
    && typeof value.baseBranch === "string"
    && typeof value.compareBranch === "string"
    && (typeof value.selectedPath === "string" || value.selectedPath === null);
}
