import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPane } from "./ProjectPane";
import type { Comparison, FileDiff, RepositoryInfo } from "../types";
import type { ReviewTarget } from "../review/inlineComments";
import { readInlineComments } from "../review/inlineComments";
import { resetReviewStore } from "../review/reviewStore";
import { createLocalCard, createLocalRun, patchLocalCard, patchLocalRun, resetLocalBoardStore } from "../localBoard/store";
import { getExecutionProfileDocument } from "../providers/profiles";

const api = vi.hoisted(() => ({ compareBranches: vi.fn(), compareWorkingTree: vi.fn(), listCommits: vi.fn(), loadFileDiff: vi.fn(), loadWorkingTreeFileDiff: vi.fn(), openRepository: vi.fn() }));
const provider = vi.hoisted(() => ({ startAgentRuntime: vi.fn(), stopAgentRuntime: vi.fn() }));
const hermes = vi.hoisted(() => ({ addHermesComment: vi.fn(), getHermesTask: vi.fn(), patchHermesTaskStatus: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("../providers/api", () => provider);
vi.mock("../hermes/api", () => hermes);

const repository: RepositoryInfo = { path: "/repo/worktree", name: "worktree", branches: [{ name: "main", commit: "aaa" }, { name: "task", commit: "bbb" }], currentBranch: "task", suggestedBaseBranch: "main" };
const initial: Comparison = { mode: "workingTree", revision: "one", baseBranch: "main", compareBranch: "task", baseCommit: "aaa", mergeBase: "aaa", compareCommit: "bbb", totalAdditions: 1, totalDeletions: 0, files: [{ path: "one.ts", oldPath: null, status: "modified", additions: 1, deletions: 0, binary: false, fingerprint: "first" }] };
function patch(content = "const value = 1;"): FileDiff {
  return { path: "one.ts", oldPath: null, binary: false, tooLarge: false, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "addition", oldLine: null, newLine: 1, content }] }] };
}
const props = { id: "work", active: true, initialRepository: repository, onRepositoryUpdated: vi.fn(), reviewTarget: null as ReviewTarget | null, onReviewTargetUpdated: vi.fn(), agentAttached: false };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); resetReviewStore(); resetLocalBoardStore();
  api.compareBranches.mockResolvedValue({ ...initial, mode: "branch" });
  api.compareWorkingTree.mockResolvedValue(initial);
  api.loadFileDiff.mockResolvedValue(patch());
  api.loadWorkingTreeFileDiff.mockResolvedValue(patch());
  api.listCommits.mockResolvedValue([]);
  provider.startAgentRuntime.mockResolvedValue({ sessionId: "session" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function openLive(target: ReviewTarget | null = null) {
  const view = render(<ProjectPane {...props} reviewTarget={target} />);
  if (!target) fireEvent.change(screen.getByRole("combobox", { name: "Comparison mode" }), { target: { value: "workingTree" } });
  await screen.findByRole("checkbox", { name: "Mark one.ts as viewed" });
  await waitFor(() => expect(view.container.querySelector(".diff-scroll")).toBeTruthy());
  return view;
}

function localTarget() {
  const card = createLocalCard({ repositoryPath: "/repo", title: "Fix value", body: "", lane: "review" });
  patchLocalCard(card.id, { workspace: { repositoryPath: "/repo", worktreePath: repository.path, branch: "task", baseBranch: "main" } });
  const profile = getExecutionProfileDocument().profiles[0];
  const run = createLocalRun(card.id, "Fix value", profile, repository.path, "main");
  patchLocalRun(run.id, { sessionId: "session", status: "idle" });
  return { target: { source: "local" as const, board: "local", taskId: card.id, title: card.title, status: "review", repositoryPath: repository.path, baseBranch: "main" }, run };
}
async function addComment() {
  fireEvent.click(await screen.findByRole("button", { name: "Comment on new line 1" }));
  fireEvent.change(screen.getByPlaceholderText("Comment on one.ts:1"), { target: { value: "Please cover the empty value." } });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  await screen.findByRole("button", { name: /Request changes/ });
}

describe("live review", () => {
  it("updates a viewed file without replacing the scroll container, and honors pause", async () => {
    const view = await openLive();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark one.ts as viewed" }));
    const scroll = view.container.querySelector(".diff-scroll")!;
    scroll.scrollTop = 75;
    api.compareWorkingTree.mockResolvedValue({ ...initial, revision: "two", files: [{ ...initial.files[0], fingerprint: "second" }] });
    api.loadWorkingTreeFileDiff.mockResolvedValue(patch("const value = 2;"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Mark one.ts as viewed" })).not.toBeChecked());
    expect(view.container.querySelector(".diff-scroll")).toBe(scroll);
    expect(scroll.scrollTop).toBe(75);
    expect(screen.getByTitle("Changed since your last review")).toBeInTheDocument();
    const calls = api.compareWorkingTree.mock.calls.length;
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(api.compareWorkingTree).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole("button", { name: "Paused" }));
    await act(async () => { await Promise.resolve(); });
    expect(api.compareWorkingTree.mock.calls.length).toBeGreaterThan(calls);
  });

  it("refreshes commit metadata when file content is unchanged", async () => {
    await openLive();
    const diffCalls = api.loadWorkingTreeFileDiff.mock.calls.length;
    api.compareWorkingTree.mockResolvedValue({ ...initial, compareCommit: "new-head", compareBranch: "other-task" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    await waitFor(() => expect(api.listCommits).toHaveBeenLastCalledWith(repository.path, initial.mergeBase, "new-head"));
    expect(screen.getByTitle("other-task")).toBeInTheDocument();
    expect(api.loadWorkingTreeFileDiff).toHaveBeenCalledTimes(diffCalls);
  });

  it("does not poll an inactive pane or while a comment draft is open", async () => {
    const target = localTarget().target;
    const view = await openLive(target);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Comment on new line 1" }));
    const calls = api.compareWorkingTree.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(api.compareWorkingTree).toHaveBeenCalledTimes(calls);
    view.rerender(<ProjectPane {...props} active={false} reviewTarget={target} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(api.compareWorkingTree).toHaveBeenCalledTimes(calls);
  });

  it("ignores an old live response after switching to committed review", async () => {
    await openLive();
    let resolve!: (comparison: Comparison) => void;
    api.compareWorkingTree.mockReturnValue(new Promise<Comparison>((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Comparison mode" }), { target: { value: "branch" } });
    await screen.findByRole("button", { name: "Swap base and compare branches" });
    await act(async () => resolve({ ...initial, revision: "late", files: [] }));
    expect(screen.getByRole("combobox", { name: "Comparison mode" })).toHaveValue("branch");
    await screen.findByRole("checkbox", { name: "Mark one.ts as viewed" });
  });

  it("sends local feedback once to the recorded workspace and keeps failure retryable", async () => {
    const { target, run } = localTarget();
    await openLive(target);
    await addComment();
    provider.startAgentRuntime.mockRejectedValueOnce(new Error("Provider offline"));
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await screen.findByText("Provider offline");
    expect(readInlineComments()[0].sentAt).toBeNull();
    let resolve!: (value: { sessionId: string }) => void;
    provider.startAgentRuntime.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await waitFor(() => expect(provider.startAgentRuntime).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Request changes/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    expect(provider.startAgentRuntime).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ sessionId: "session" }));
    await screen.findByText("Feedback sent to the card's agent conversation.");
    expect(provider.startAgentRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ runId: run.id, repositoryPath: repository.path, sessionId: "session", prompt: expect.stringContaining("Please cover the empty value.") }));
    expect(readInlineComments()[0].sentAt).not.toBeNull();
    expect(hermes.addHermesComment).not.toHaveBeenCalled();
  });

  it("does not send feedback if the file changed after the comment was written", async () => {
    await openLive(localTarget().target);
    await addComment();
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    api.compareWorkingTree.mockResolvedValue({ ...initial, revision: "new", files: [{ ...initial.files[0], fingerprint: "new" }] });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await screen.findByText(/Files changed since these comments/);
    expect(provider.startAgentRuntime).not.toHaveBeenCalled();
    expect(readInlineComments()[0].sentAt).toBeNull();
  });
});
