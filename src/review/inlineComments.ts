import {
  readStoredInlineComments,
  readStoredReviewTarget,
  writeStoredInlineComments,
  writeStoredReviewTarget,
} from "./reviewStore";
import type { FileDiff } from "../types";

export interface ReviewTarget {
  board: string;
  taskId: string;
  title: string;
  status: string;
  repositoryPath?: string;
}

export interface InlineReviewComment {
  id: string;
  repositoryPath: string;
  board: string;
  taskId: string;
  baseCommit: string;
  compareCommit: string;
  path: string;
  side: "old" | "new";
  line: number;
  context: string;
  contextFingerprint: string;
  body: string;
  author: string;
  state: "open" | "addressed" | "outdated";
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export function readInlineComments(): InlineReviewComment[] {
  return readStoredInlineComments();
}

export function writeInlineComments(comments: InlineReviewComment[]) {
  writeStoredInlineComments(comments);
}

export function readReviewTarget(repositoryPath: string): ReviewTarget | null {
  return readStoredReviewTarget(repositoryPath);
}

export function writeReviewTarget(repositoryPath: string, target: ReviewTarget | null) {
  writeStoredReviewTarget(repositoryPath, target);
}

export function reviewContextFingerprint(
  path: string,
  side: "old" | "new",
  line: number,
  context: string,
) {
  const value = `${path}\0${side}\0${line}\0${context.trim()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function inlineCommentMatchesDiff(comment: InlineReviewComment, diff: FileDiff) {
  if (comment.contextFingerprint.startsWith("legacy:")) return true;
  const line = diff.hunks
    .flatMap((hunk) => hunk.lines)
    .find((candidate) => (comment.side === "old" ? candidate.oldLine : candidate.newLine) === comment.line);
  return Boolean(line) && reviewContextFingerprint(comment.path, comment.side, comment.line, line!.content)
    === comment.contextFingerprint;
}
