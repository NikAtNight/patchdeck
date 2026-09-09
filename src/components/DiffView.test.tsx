import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { DiffView } from "./DiffView";
import type { InlineReviewComment, ReviewTarget } from "../review/inlineComments";

afterEach(cleanup);

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

it("keeps addition and deletion markers separate from comment actions and preserves line anchors", () => {
  const onAddComment = vi.fn();
  const props: ComponentProps<typeof DiffView> = {
    file: { path: "src/example.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false },
    diff: {
      path: "src/example.ts", oldPath: null, binary: false, tooLarge: false,
      hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [
        { kind: "context", oldLine: 1, newLine: 1, content: "const stable = true;" },
        { kind: "deletion", oldLine: 2, newLine: null, content: "const answer = 41;" },
        { kind: "addition", oldLine: null, newLine: 2, content: "const answer = 42;" },
      ] }],
    },
    loading: false,
    wrapLines: true,
    onToggleWrap: vi.fn(),
    onRetry: vi.fn(),
    showEdit: false,
    canEdit: false,
    onEdit: vi.fn(),
    reviewTarget,
    comments: [],
    onAddComment,
    onUpdateComment: vi.fn(),
    onSendFeedback: vi.fn(),
    feedbackStatus: null,
    onClearReviewTarget: vi.fn(),
    viewed: false,
    onToggleViewed: vi.fn(),
  };
  const { container, rerender } = render(<DiffView {...props} />);

  for (const [kind, marker] of [["addition", "+"], ["deletion", "−"]]) {
    const lineMarker = container.querySelector(`.diff-line.${kind} .line-marker`)!;
    expect(lineMarker).toHaveTextContent(marker);
    expect(lineMarker).toBeVisible();
    expect(lineMarker.querySelector("button")).toBeNull();
  }

  for (const [side, line, context] of [
    ["old", 2, "const answer = 41;"],
    ["new", 2, "const answer = 42;"],
    ["new", 1, "const stable = true;"],
  ] as const) {
    fireEvent.click(screen.getByRole("button", { name: `Comment on ${side} line ${line}` }));
    const composer = screen.getByPlaceholderText(`Comment on src/example.ts:${line}`);
    fireEvent.change(composer, { target: { value: `Review ${context}` } });
    fireEvent.click(within(composer.closest("form")!).getByRole("button", { name: "Add comment" }));
    expect(onAddComment).toHaveBeenLastCalledWith({ side, line, context }, `Review ${context}`);
  }

  rerender(<DiffView {...props} reviewTarget={null} />);
  expect(screen.queryByRole("button", { name: /Comment on/ })).not.toBeInTheDocument();
  expect(container.querySelector(".diff-line.addition .line-marker")).toHaveTextContent("+");
  expect(container.querySelector(".diff-line.deletion .line-marker")).toHaveTextContent("−");
});
