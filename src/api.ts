import { invoke } from "@tauri-apps/api/core";
import type { CommitInfo, Comparison, FileDiff, FileDiffRequest, RepositoryInfo, WorkspaceProject } from "./types";

export function openRepository(path: string) {
  return invoke<RepositoryInfo>("open_repository", { path });
}

export function openWorkspace(path: string) {
  return invoke<WorkspaceProject[]>("open_workspace", { path });
}

export function openWorkspaceProject(path: string) {
  return invoke<RepositoryInfo>("open_workspace_project", { path });
}

export function compareBranches(repositoryPath: string, baseBranch: string, compareBranch: string) {
  return invoke<Comparison>("compare_branches", { repositoryPath, baseBranch, compareBranch });
}

export function loadFileDiff(request: FileDiffRequest) {
  return invoke<FileDiff>("load_file_diff", { ...request });
}

export function loadWorkingTreeFileDiff(request: Omit<FileDiffRequest, "compareCommit">) {
  return invoke<FileDiff>("load_working_tree_file_diff", { ...request });
}

export function listCommits(repositoryPath: string, mergeBase: string, compareCommit: string) {
  return invoke<CommitInfo[]>("list_commits", { repositoryPath, mergeBase, compareCommit });
}
