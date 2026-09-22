import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBoard } from "./LocalBoard";
import { resetExecutionProfiles } from "../providers/profiles";
import { archiveLocalCards, createLocalCard, createLocalRun, patchLocalCard, resetLocalBoardStore } from "./store";
import type { AgentRuntimeEvent } from "../providers/types";
import { applyAgentRuntimeEvent } from "./runtime";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../providers/api", () => ({
  listAgentRuntimes: mocks.list,
  startAgentRuntime: mocks.start,
  stopAgentRuntime: mocks.stop,
}));

describe("local board", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLocalBoardStore();
    resetExecutionProfiles();
    mocks.invoke.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "open_repository") return Promise.resolve({ branches: [{ name: "main", commit: "abc" }], currentBranch: "main", suggestedBaseBranch: "main", path: "/work/product", name: "product" });
      if (command === "create_card_worktree") return Promise.resolve({ repositoryPath: "/work/product", worktreePath: "/worktrees/card", branch: "work/card", baseBranch: "main", ...args });
      if (command === "list_card_worktrees") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    mocks.list.mockReset().mockResolvedValue([
      { id: "codex", label: "Codex", installed: true, authenticated: true, ready: true, version: "codex-cli 0.147.0", path: "/usr/local/bin/codex", authMode: "ChatGPT", accountLabel: null, error: null },
      { id: "claude", label: "Claude Code", installed: true, authenticated: true, ready: true, version: "2.0.0", path: "/usr/local/bin/claude", authMode: "Claude", accountLabel: null, error: null },
    ]);
    mocks.start.mockReset().mockResolvedValue({ sessionId: "session_123", turnId: "turn_1" });
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("creates a card and starts a persistent Codex conversation", async () => {
    render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");

    fireEvent.click(screen.getByRole("button", { name: "New work" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Repair CI" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Run focused tests." } });
    fireEvent.change(screen.getByLabelText("Executor"), { target: { value: "codex-workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & run" }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: "codex",
      repositoryPath: "/worktrees/card",
      prompt: "Repair CI\n\nRun focused tests.",
      sessionId: null,
    })));
    expect(screen.getByRole("complementary", { name: "Repair CI card details" })).toBeInTheDocument();
    expect(screen.getByLabelText("Lane")).toHaveValue("in_progress");

    const runId = mocks.start.mock.calls[0][0].runId;
    act(() => applyAgentRuntimeEvent({ runtimeId: "codex", runId, type: "agentDelta", delta: "I found the failure." } as AgentRuntimeEvent));
    act(() => applyAgentRuntimeEvent({ runtimeId: "codex", runId, type: "completed", status: "completed" } as AgentRuntimeEvent));

    expect(screen.getByText("I found the failure.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message Codex")).toBeEnabled();
  });

  it("routes a new run through the selected Claude execution profile", async () => {
    render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");
    fireEvent.click(screen.getByRole("button", { name: "New work" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Refactor parser" } });
    fireEvent.change(screen.getByLabelText("Executor"), { target: { value: "claude-workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Create & run" }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "claude" })));
    expect(screen.getByText("Claude Code is working…")).toBeInTheDocument();
  });

  it("moves cards between lanes with the lane selector", async () => {
    render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");
    fireEvent.click(screen.getByRole("button", { name: "New work" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Write docs" } });
    fireEvent.change(screen.getByLabelText("Executor"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create work" }));

    fireEvent.change(screen.getByLabelText("Lane"), { target: { value: "done" } });
    expect(screen.getByLabelText("Lane")).toHaveValue("done");
    expect(screen.getByLabelText("Done cards")).toHaveTextContent("Write docs");
  });

  it("closes card details when the visible repository changes", async () => {
    createLocalCard({ repositoryPath: "/work/product", title: "Product-only work" });
    const { rerender } = render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");
    fireEvent.click(screen.getByText("Product-only work"));
    expect(screen.getByRole("complementary", { name: "Product-only work card details" })).toBeInTheDocument();

    rerender(<LocalBoard repositoryPath="/work/other" />);

    expect(screen.queryByRole("complementary", { name: "Product-only work card details" })).not.toBeInTheDocument();
  });

  it("opens review for the bound worktree and base branch", async () => {
    const onReviewTask = vi.fn();
    const card = createLocalCard({ repositoryPath: "/work/product", title: "Review me", lane: "review" });
    patchLocalCard(card.id, { workspace: { repositoryPath: "/work/product", worktreePath: "/worktrees/review", branch: "work/review", baseBranch: "main" } });
    render(<LocalBoard repositoryPath="/work/product" onReviewTask={onReviewTask} />);
    await screen.findByText("2 agents ready");
    fireEvent.click(screen.getByText("Review me"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(onReviewTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "local",
      board: "local",
      taskId: card.id,
      repositoryPath: "/worktrees/review",
      baseBranch: "main",
    }));
  });

  it("requires an explicit workspace binding and runs in the attached worktree", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "open_repository") return Promise.resolve({ branches: [{ name: "main", commit: "abc" }], currentBranch: "main", suggestedBaseBranch: "main", path: "/work/product", name: "product" });
      if (command === "list_card_worktrees") return Promise.resolve([{ path: "/worktrees/existing", branch: "work/existing" }]);
      if (command === "attach_card_worktree") return Promise.resolve({ repositoryPath: "/work/product", worktreePath: "/worktrees/existing", branch: "work/existing", baseBranch: "main" });
      return Promise.resolve(null);
    });
    createLocalCard({ repositoryPath: "/work/product", title: "Attach first" });
    render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");
    fireEvent.click(screen.getByText("Attach first"));
    const runButton = screen.getByRole("button", { name: "Run with Codex" });
    expect(runButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workspace policy"), { target: { value: "attach" } });
    await waitFor(() => expect(screen.getByLabelText("Worktree")).toHaveValue("/worktrees/existing"));
    fireEvent.click(screen.getByRole("button", { name: "Attach workspace" }));
    await waitFor(() => expect(runButton).toBeEnabled());
    fireEvent.click(runButton);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: "/worktrees/existing" })));
  });

  it("selects, archives, and restores repository-scoped cards", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    createLocalCard({ repositoryPath: "/work/product", title: "Archive one", lane: "done" });
    createLocalCard({ repositoryPath: "/work/product", title: "Archive two", lane: "done" });
    createLocalCard({ repositoryPath: "/work/other", title: "Other repository", lane: "done" });
    render(<LocalBoard repositoryPath="/work/product" />);
    await screen.findByText("2 agents ready");

    fireEvent.click(screen.getByRole("button", { name: "Select cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all archivable cards in Done" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Archive one")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive two")).not.toBeInTheDocument();
    expect(screen.queryByText("Other repository")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Archived"));
    expect(screen.getByText("Archive one")).toBeInTheDocument();
    expect(screen.getByText("Archive two")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select to restore" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select local card Archive one" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    expect(screen.queryByText("Archive one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Archived"));
    expect(screen.getByText("Archive one")).toBeInTheDocument();
  });

  it("opens an archived initial card and does not allow active runs to be selected", async () => {
    const archived = createLocalCard({ repositoryPath: "/work/product", title: "Archived history" });
    archiveLocalCards([archived.id]);
    const active = createLocalCard({ repositoryPath: "/work/product", title: "Agent is running", lane: "in_progress" });
    createLocalRun(active.id, "Run", {
      id: "codex-workspace", name: "Codex", runtimeId: "codex", model: "", sandbox: "workspaceWrite", instructions: "", builtIn: true,
    });
    const opened = vi.fn();
    const { rerender } = render(<LocalBoard repositoryPath="/work/product" initialCardId={archived.id} onInitialCardOpened={opened} />);
    await screen.findByText("2 agents ready");

    expect(screen.getByLabelText("Archived")).toBeChecked();
    expect(screen.getByRole("complementary", { name: "Archived history card details" })).toBeInTheDocument();
    expect(opened).toHaveBeenCalledTimes(1);
    rerender(<LocalBoard repositoryPath="/work/product" initialCardId={archived.id} onInitialCardOpened={opened} />);
    expect(opened).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: "Select cards" }));
    expect(screen.getByRole("checkbox", { name: "Select local card Agent is running" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Agent is running/ })).toBeDisabled();
  });

  it("filters and searches local work across repositories", async () => {
    createLocalCard({ repositoryPath: "/work/product", title: "Finished product work", lane: "done" });
    createLocalCard({ repositoryPath: "/work/other", title: "Finished other work", lane: "done" });
    createLocalCard({ repositoryPath: "/work/product", title: "Pending product work", lane: "todo" });
    render(<LocalBoard repositoryPath="/work/product" allRepositories workFilter="completed" query="other" />);
    await screen.findByText("2 agents ready");

    expect(screen.getByText("Finished other work")).toBeInTheDocument();
    expect(screen.queryByText("Finished product work")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending product work")).not.toBeInTheDocument();
  });

  it("includes cards from every checkout in the current repository scope", async () => {
    createLocalCard({ repositoryPath: "/work/product", title: "Main checkout card" });
    createLocalCard({ repositoryPath: "/worktrees/product-card/", title: "Worktree card" });
    createLocalCard({ repositoryPath: "/work/other", title: "Unrelated card" });
    render(
      <LocalBoard
        repositoryPath="/worktrees/product-card"
        scopeRepositoryPaths={["/work/product/", "/worktrees/product-card"]}
      />,
    );
    await screen.findByText("2 agents ready");

    expect(screen.getByText("Main checkout card")).toBeInTheDocument();
    expect(screen.getByText("Worktree card")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated card")).not.toBeInTheDocument();
  });
});
