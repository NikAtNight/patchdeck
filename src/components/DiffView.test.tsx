import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
import { DiffView } from "./DiffView";
import type { InlineReviewComment, ReviewTarget } from "../review/inlineComments";

const reviewTarget: ReviewTarget = {
  board: "product",
  taskId: "task-1",
  title: "Review me",
  status: "review",
  repositoryPath: "/work/product",
};

const comment: InlineReviewComment = {
  id: "review-1",
  repositoryPath: "/work/product",
  board: "product",
  taskId: "task-1",
  baseCommit: "aaa",
  compareCommit: "bbb",
  path: "src/example.ts",
  side: "new",
  line: 1,
  context: "const answer = 42;",
  contextFingerprint: "fingerprint",
  body: "Please cover this branch.",
  author: "human-review",
  state: "open",
  createdAt: 1,
  updatedAt: 1,
  sentAt: null,
};

it("lets a reviewer address and reopen a durable inline comment", async () => {
  const onUpdateComment = vi.fn();
  const { rerender } = render(
    <DiffView
      file={{ path: "src/example.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false }}
      diff={{
        path: "src/example.ts",
        oldPath: null,
        binary: false,
        tooLarge: false,
        hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "addition", oldLine: null, newLine: 1, content: "const answer = 42;" }] }],
      }}
      loading={false}
      wrapLines
      onToggleWrap={vi.fn()}
      onRetry={vi.fn()}
      showEdit={false}
      canEdit={false}
      onEdit={vi.fn()}
      reviewTarget={reviewTarget}
      comments={[comment]}
      onAddComment={vi.fn()}
      onUpdateComment={onUpdateComment}
      onSendFeedback={vi.fn()}
      feedbackStatus={null}
      onClearReviewTarget={vi.fn()}
      viewed={false}
      onToggleViewed={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Mark comment addressed" }));
  expect(onUpdateComment).toHaveBeenCalledWith("review-1", "addressed");

  rerender(
    <DiffView
      file={{ path: "src/example.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false }}
      diff={{ path: "src/example.ts", oldPath: null, binary: false, tooLarge: false, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "addition", oldLine: null, newLine: 1, content: "const answer = 42;" }] }] }}
      loading={false}
      wrapLines
      onToggleWrap={vi.fn()}
      onRetry={vi.fn()}
      showEdit={false}
      canEdit={false}
      onEdit={vi.fn()}
      reviewTarget={reviewTarget}
      comments={[{ ...comment, state: "addressed" }]}
      onAddComment={vi.fn()}
      onUpdateComment={onUpdateComment}
      onSendFeedback={vi.fn()}
      feedbackStatus={null}
      onClearReviewTarget={vi.fn()}
      viewed={false}
      onToggleViewed={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reopen comment" }));
  expect(onUpdateComment).toHaveBeenLastCalledWith("review-1", "open");
});
