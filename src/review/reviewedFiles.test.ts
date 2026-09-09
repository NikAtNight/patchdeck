import { beforeEach, describe, expect, it } from "vitest";
import type { Comparison } from "../types";
import { resetReviewStore } from "./reviewStore";
import { readReviewProgress, writeReviewProgress } from "./reviewedFiles";

const comparison: Comparison = {
  mode: "branch", revision: "one", baseBranch: "main", compareBranch: "feature",
  baseCommit: "aaa", mergeBase: "aaa", compareCommit: "bbb", totalAdditions: 2, totalDeletions: 0,
  files: ["one.ts", "two.ts"].map((path) => ({ path, oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false, fingerprint: path })),
};

beforeEach(() => { localStorage.clear(); resetReviewStore(); });

describe("review progress by file content", () => {
  it("keeps unchanged files viewed across commits and flags revised files", () => {
    writeReviewProgress("/repo", comparison, new Set(["one.ts", "two.ts"]));
    const next = { ...comparison, compareCommit: "ccc", revision: "two", files: comparison.files.map((file) => file.path === "two.ts" ? { ...file, fingerprint: "revised" } : file) };
    expect(readReviewProgress("/repo", next)).toEqual({ viewed: new Set(["one.ts"]), changed: new Set(["two.ts"]) });
    resetReviewStore();
    expect(readReviewProgress("/repo", next).viewed).toEqual(new Set(["one.ts"]));
    writeReviewProgress("/repo", next, new Set(["one.ts", "two.ts"]));
    expect(readReviewProgress("/repo", next).changed.size).toBe(0);
  });

  it("detects working-tree edits without a commit and keeps modes and branches separate", () => {
    const live = { ...comparison, mode: "workingTree" as const };
    writeReviewProgress("/repo", live, new Set(["one.ts"]));
    const edited = { ...live, files: live.files.map((file) => ({ ...file, fingerprint: "edited" })) };
    expect(readReviewProgress("/repo", edited).changed).toEqual(new Set(["one.ts"]));
    expect(readReviewProgress("/repo", comparison).viewed.size).toBe(0);
    expect(readReviewProgress("/repo", { ...live, compareBranch: "other" }).viewed.size).toBe(0);
    expect(readReviewProgress("/different", live).viewed.size).toBe(0);
  });

  it("allows explicitly unmarking a file without resurrecting its old review", () => {
    writeReviewProgress("/repo", comparison, new Set(["one.ts"]));
    writeReviewProgress("/repo", comparison, new Set());
    expect(readReviewProgress("/repo", comparison).viewed.size).toBe(0);
  });
});
