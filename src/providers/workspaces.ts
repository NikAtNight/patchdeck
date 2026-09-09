import { invoke } from "@tauri-apps/api/core";

export interface CardWorkspace {
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface CardWorktree {
  path: string;
  branch: string | null;
}

export const listCardWorktrees = (repositoryPath: string) =>
  invoke<CardWorktree[]>("list_card_worktrees", { repositoryPath });

export const createCardWorktree = (input: {
  repositoryPath: string;
  cardId: string;
  baseBranch: string;
  existingBranch?: string | null;
}) => invoke<CardWorkspace>("create_card_worktree", input);

export const attachCardWorktree = (input: {
  repositoryPath: string;
  worktreePath: string;
  baseBranch: string;
}) => invoke<CardWorkspace>("attach_card_worktree", input);
