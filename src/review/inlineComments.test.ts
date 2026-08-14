import { beforeEach, describe, expect, it } from "vitest";
import {
  inlineCommentMatchesDiff,
  readInlineComments,
  readReviewTarget,
  reviewContextFingerprint,
  writeInlineComments,
  writeReviewTarget,
} from "./inlineComments";

describe("local review persistence", () => {
  beforeEach(() => localStorage.clear());

  it("persists task links and line anchors without a Hermes credential", () => {
    const target = { board: "product", taskId: "task-1", title: "Review me", status: "review" };
    writeReviewTarget("/work/product", { ...target, repositoryPath: "/work/product" });
    writeInlineComments([{
      id: "review-1",
      repositoryPath: "/work/product",
      board: "product",
      taskId: "task-1",
      baseCommit: "aaa",
      compareCommit: "bbb",
      path: "src/example.ts",
      side: "new",
      line: 12,
      context: "return true",
      contextFingerprint: "fnv1a-test",
      body: "Add a test for this branch.",
      author: "human-review",
      state: "open",
      createdAt: 1,
      updatedAt: 1,
      sentAt: null,
    }]);

    expect(readReviewTarget("/work/product")).toEqual({ ...target, repositoryPath: "/work/product" });
    expect(readInlineComments()).toHaveLength(1);
    expect(JSON.stringify(localStorage)).not.toContain("token");
  });

  it("detects when an anchored line no longer has the same context", () => {
    const comment = {
      id: "review-2",
      repositoryPath: "/work/product",
      board: "product",
      taskId: "task-1",
      baseCommit: "aaa",
      compareCommit: "bbb",
      path: "src/example.ts",
      side: "new" as const,
      line: 12,
      context: "return true",
      contextFingerprint: reviewContextFingerprint("src/example.ts", "new", 12, "return true"),
      body: "Keep this behavior.",
      author: "human-review",
      state: "open" as const,
      createdAt: 1,
      updatedAt: 1,
      sentAt: null,
    };
    const diff = {
      path: comment.path,
      oldPath: null,
      binary: false,
      tooLarge: false,
      hunks: [{ header: "@@", lines: [{ kind: "addition" as const, oldLine: null, newLine: 12, content: "return false" }] }],
    };

    expect(inlineCommentMatchesDiff(comment, diff)).toBe(false);
    diff.hunks[0].lines[0].content = "return true";
    expect(inlineCommentMatchesDiff(comment, diff)).toBe(true);
  });
});
