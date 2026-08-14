export interface Branch {
  name: string;
  commit: string;
}

export interface RepositoryInfo {
  name: string;
  path: string;
  branches: Branch[];
  currentBranch: string | null;
  suggestedBaseBranch: string | null;
}

export interface WorkspaceProject {
  name: string;
  path: string;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "unknown";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface Comparison {
  baseBranch: string;
  compareBranch: string;
  baseCommit: string;
  compareCommit: string;
  mergeBase: string;
  totalAdditions: number;
  totalDeletions: number;
  files: ChangedFile[];
}

export type DiffLineKind = "context" | "addition" | "deletion" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export interface FileDiffRequest {
  repositoryPath: string;
  mergeBase: string;
  compareCommit: string;
  path: string;
  oldPath: string | null;
}
