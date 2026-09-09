import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesBoardsResponse, HermesProfilesResponse, HermesSessionController } from "../hermes/types";
import { resetExecutionProfiles } from "../providers/profiles";
import { AgentWorkspace } from "./AgentWorkspace";
import { createLocalCard, getLocalBoardDocument, resetLocalBoardStore } from "./store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listHermesBoards: vi.fn(),
  listHermesProfiles: vi.fn(),
  getHermesBoard: vi.fn(),
  createHermesTask: vi.fn(),
  listRuntimes: vi.fn(),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../providers/api", () => ({
  listAgentRuntimes: mocks.listRuntimes,
  startAgentRuntime: mocks.startRuntime,
  stopAgentRuntime: mocks.stopRuntime,
}));
vi.mock("../hermes/api", () => ({
  listHermesBoards: mocks.listHermesBoards,
  listHermesProfiles: mocks.listHermesProfiles,
  getHermesBoard: mocks.getHermesBoard,
  createHermesTask: mocks.createHermesTask,
}));
vi.mock("../hermes/HermesBoard", () => ({
  HermesBoard: ({ boardSlug, initialTaskId }: { boardSlug: string; initialTaskId?: string | null }) => (
    <div data-testid="hermes-board">Hermes source {boardSlug}{initialTaskId ? ` · ${initialTaskId}` : ""}</div>
  ),
}));

const session: HermesSessionController = {
  status: {
    state: "connected",
    mode: "managed",
    url: "http://127.0.0.1:43117",
    version: "0.20.1",
    activeWorkers: 1,
    error: null,
  },
  connectDiscovered: vi.fn(),
  connectManaged: vi.fn(),
  connectExisting: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
};

const disconnectedSession: HermesSessionController = {
  ...session,
  status: {
    state: "disconnected",
    mode: null,
    url: null,
    version: null,
    activeWorkers: 0,
    error: null,
  },
};

describe("unified agent workspace", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLocalBoardStore();
    resetExecutionProfiles();
    mocks.invoke.mockReset().mockImplementation((command: string) => {
      if (command === "open_repository") return Promise.resolve({ branches: [{ name: "main", commit: "abc" }], currentBranch: "main", suggestedBaseBranch: "main", path: "/work/product", name: "product" });
      if (command === "create_card_worktree") return Promise.resolve({ repositoryPath: "/work/product", worktreePath: "/worktrees/card", branch: "work/card", baseBranch: "main" });
      if (command === "list_card_worktrees") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    mocks.listHermesBoards.mockReset().mockResolvedValue({
      current: "sxcl",
      boards: [
        { slug: "sxcl", name: "SXCL", total: 2, default_workspace_kind: "worktree", default_workdir: "/work/sxcl" },
        { slug: "olive", name: "Olive", total: 1, default_workspace_kind: "scratch", default_workdir: null },
      ],
    });
    mocks.listHermesProfiles.mockReset().mockResolvedValue({ profiles: [{ name: "coder", is_default: true, description: "Writes code" }] });
    mocks.getHermesBoard.mockReset().mockImplementation((board: string) => Promise.resolve({
      columns: board === "sxcl" ? [
        { name: "running", tasks: [{ id: "sx-1", title: "Hermes repository task", status: "running", assignee: "coder", workspace_path: "/work/product" }] },
        { name: "blocked", tasks: [{ id: "sx-2", title: "Blocked repository task", status: "blocked", assignee: "coder", workspace_path: "/work/product/" }] },
        { name: "todo", tasks: [{ id: "sx-other", title: "Other repository task", status: "todo", workspace_path: "/work/elsewhere" }] },
      ] : [],
      tenants: [], assignees: [], latest_event_id: 1, now: 1,
    }));
    mocks.createHermesTask.mockReset().mockResolvedValue({ task: { id: "task-new", title: "Created", status: "todo" } });
    mocks.listRuntimes.mockReset().mockResolvedValue([
      { id: "codex", label: "Codex", installed: true, authenticated: true, ready: true, version: "0.147.0", path: "/codex", authMode: "ChatGPT", accountLabel: null, error: null },
      { id: "claude", label: "Claude Code", installed: true, authenticated: true, ready: true, version: "2.0.0", path: "/claude", authMode: "Claude", accountLabel: null, error: null },
    ]);
    mocks.startRuntime.mockReset().mockResolvedValue({ sessionId: "session-new", turnId: "turn-new" });
    mocks.stopRuntime.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("navigates local, repository, and every named Hermes board", async () => {
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    const navigator = screen.getByRole("navigation", { name: "Board navigator" });

    expect(within(navigator).getByRole("button", { name: "Local Board" })).toBeInTheDocument();
    expect(await within(navigator).findByRole("button", { name: "This Repository" })).toBeInTheDocument();
    expect(within(navigator).getByRole("button", { name: "All Work" })).toBeInTheDocument();
    expect(within(navigator).getByRole("button", { name: "Hermes · SXCL" })).toBeInTheDocument();
    expect(within(navigator).getByRole("button", { name: "Hermes · Olive" })).toBeInTheDocument();

    fireEvent.click(within(navigator).getByRole("button", { name: "Hermes · Olive" }));
    expect(await screen.findByText("Hermes source olive")).toBeInTheDocument();
  });

  it("projects matching local and Hermes work while preserving source and blocked state", async () => {
    createLocalCard({ repositoryPath: "/work/product", title: "Local repository card" });
    createLocalCard({ repositoryPath: "/work/elsewhere", title: "Other local card" });
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "This Repository" }));
    expect(await screen.findByText("Local repository card")).toBeInTheDocument();
    expect(await screen.findByText("Hermes repository task")).toBeInTheDocument();
    expect(screen.getByText("Blocked repository task")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toHaveClass("status-blocked");
    expect(screen.queryByText("Other repository task")).not.toBeInTheDocument();
    expect(screen.queryByText("Other local card")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Hermes repository task"));
    expect(await screen.findByText("Hermes source sxcl · sx-1")).toBeInTheDocument();
  });

  it("keeps local repository projections available without Hermes", async () => {
    createLocalCard({ repositoryPath: "/work/product", title: "Offline product card" });
    createLocalCard({ repositoryPath: "/work/elsewhere", title: "Offline other card" });
    render(<AgentWorkspace hermes={disconnectedSession} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    const navigator = screen.getByRole("navigation", { name: "Board navigator" });

    fireEvent.click(within(navigator).getByRole("button", { name: "This Repository" }));
    expect(screen.getByText("Offline product card")).toBeInTheDocument();
    expect(screen.queryByText("Offline other card")).not.toBeInTheDocument();

    fireEvent.click(within(navigator).getByRole("button", { name: "All Work" }));
    expect(screen.getByText("Offline product card")).toBeInTheDocument();
    expect(screen.getByText("Offline other card")).toBeInTheDocument();
    expect(mocks.getHermesBoard).not.toHaveBeenCalled();
  });

  it("removes Hermes projection failures after Hermes disconnects", async () => {
    mocks.getHermesBoard.mockRejectedValue(new Error("Hermes is unavailable"));
    const { rerender } = render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "This Repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hermes is unavailable");

    rerender(<AgentWorkspace hermes={disconnectedSession} repositoryPath="/work/product" onReviewTask={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("removes Hermes metadata failures after Hermes disconnects", async () => {
    mocks.listHermesBoards.mockRejectedValue(new Error("Hermes metadata is unavailable"));
    const { rerender } = render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Hermes metadata is unavailable");

    rerender(<AgentWorkspace hermes={disconnectedSession} repositoryPath="/work/product" onReviewTask={vi.fn()} />);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows metadata only from the current Hermes connection", async () => {
    const staleBoards = deferred<HermesBoardsResponse>();
    const staleProfiles = deferred<HermesProfilesResponse>();
    const freshBoards = deferred<HermesBoardsResponse>();
    const freshProfiles = deferred<HermesProfilesResponse>();
    const staleError = deferred<HermesBoardsResponse>();
    mocks.listHermesBoards
      .mockReset()
      .mockReturnValueOnce(staleBoards.promise)
      .mockReturnValueOnce(freshBoards.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockResolvedValueOnce({ current: "final", boards: [{ slug: "final", name: "Final" }] });
    mocks.listHermesProfiles
      .mockReset()
      .mockReturnValueOnce(staleProfiles.promise)
      .mockReturnValueOnce(freshProfiles.promise)
      .mockResolvedValueOnce({ profiles: [] })
      .mockResolvedValueOnce({ profiles: [] });
    const secondConnection = connectedSession("http://127.0.0.1:43118");
    const thirdConnection = connectedSession("http://127.0.0.1:43119");
    const finalConnection = connectedSession("http://127.0.0.1:43120");
    const view = render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await waitFor(() => expect(mocks.listHermesBoards).toHaveBeenCalledTimes(1));

    view.rerender(<AgentWorkspace hermes={disconnectedSession} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await act(async () => {
      staleBoards.resolve({ current: "stale", boards: [{ slug: "stale", name: "Stale" }] });
      staleProfiles.resolve({ profiles: [] });
      await staleBoards.promise;
    });

    view.rerender(<AgentWorkspace hermes={secondConnection} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await waitFor(() => expect(mocks.listHermesBoards).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Hermes · Stale" })).not.toBeInTheDocument();
    await act(async () => {
      freshBoards.resolve({ current: "fresh", boards: [{ slug: "fresh", name: "Fresh" }] });
      freshProfiles.resolve({ profiles: [] });
      await freshBoards.promise;
    });
    expect(await screen.findByRole("button", { name: "Hermes · Fresh" })).toBeInTheDocument();

    view.rerender(<AgentWorkspace hermes={thirdConnection} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await waitFor(() => expect(mocks.listHermesBoards).toHaveBeenCalledTimes(3));
    view.rerender(<AgentWorkspace hermes={finalConnection} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Hermes · Final" })).toBeInTheDocument();
    await act(async () => {
      staleError.reject(new Error("stale connection failed"));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Hermes · Final" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("routes destination and Hermes executor without copying the task locally", async () => {
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await screen.findByRole("button", { name: "Hermes · SXCL" });
    fireEvent.click(screen.getByRole("button", { name: "+ New work" }));
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "hermes:sxcl" } });
    await waitFor(() => expect(screen.getByLabelText("Executor")).toHaveValue("coder"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship from Hermes" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Use the repository tests." } });
    fireEvent.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith("sxcl", expect.objectContaining({
      title: "Ship from Hermes",
      body: "Use the repository tests.",
      assignee: "coder",
      workspace_kind: "worktree",
      workspace_path: "/work/product",
    }), "todo"));
    expect(getLocalBoardDocument().cards).toEqual([]);
    expect(await screen.findByText("Hermes source sxcl · task-new")).toBeInTheDocument();
  });

  it("routes a local card through the chosen Claude execution profile", async () => {
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New work" }));
    fireEvent.change(screen.getByLabelText("Executor"), { target: { value: "claude-workspace" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Run with Claude" } });
    const createAndRun = screen.getByRole("button", { name: "Create & run" });
    await waitFor(() => expect(createAndRun).toBeEnabled());
    fireEvent.click(createAndRun);

    await waitFor(() => expect(mocks.startRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "claude", repositoryPath: "/worktrees/card" })));
    expect(getLocalBoardDocument().cards[0]).toMatchObject({ title: "Run with Claude", executionProfileId: "claude-workspace" });
  });

  it("reports workspace preparation failure without leaving a partial card or starting an agent", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "open_repository") return Promise.resolve({ branches: [{ name: "main", commit: "abc" }], currentBranch: "main", suggestedBaseBranch: "main", path: "/work/product", name: "product" });
      if (command === "create_card_worktree") return Promise.reject(new Error("worktree creation failed"));
      if (command === "list_card_worktrees") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New work" }));
    fireEvent.change(screen.getByLabelText("Executor"), { target: { value: "codex-workspace" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Cannot prepare" } });
    const createAndRun = screen.getByRole("button", { name: "Create & run" });
    await waitFor(() => expect(createAndRun).toBeEnabled());
    fireEvent.click(createAndRun);

    expect(await screen.findByRole("alert")).toHaveTextContent("worktree creation failed");
    expect(getLocalBoardDocument().cards).toHaveLength(0);
    expect(mocks.startRuntime).not.toHaveBeenCalled();
  });

  it("sends an explicit Hermes handoff and visibly preserves its local source", async () => {
    const card = createLocalCard({ repositoryPath: "/work/product", title: "Keep local", body: "Then send." });
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await screen.findByRole("button", { name: "Hermes · SXCL" });
    fireEvent.click(screen.getByText("Keep local"));
    fireEvent.click(screen.getByRole("button", { name: "Send to Hermes…" }));

    const dialog = screen.getByRole("dialog", { name: "Send local card to Hermes" });
    expect(within(dialog).getByLabelText("Destination")).toHaveValue("hermes:sxcl");
    expect(within(dialog).getByText(/local card, its lane, and its agent conversation stay unchanged/i)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Executor")).toHaveValue("coder"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm send" }));

    await waitFor(() => expect(getLocalBoardDocument().cards[0].hermesHandoffs).toEqual([
      expect.objectContaining({ board: "sxcl", taskId: "task-new" }),
    ]));
    expect(getLocalBoardDocument().cards[0]).toMatchObject({ id: card.id, title: "Keep local" });
    expect(screen.getByRole("status")).toHaveTextContent("The local card was preserved");

    fireEvent.click(screen.getByRole("button", { name: "Local Board" }));
    fireEvent.click(screen.getByText("Keep local"));
    fireEvent.click(screen.getByRole("button", { name: /Hermes · sxcl.*task-new.*Open source/ }));
    expect(await screen.findByText("Hermes source sxcl · task-new")).toBeInTheDocument();
  });

  it("allows Hermes dispatcher assignment when no profiles are available", async () => {
    mocks.listHermesProfiles.mockResolvedValue({ profiles: [] });
    render(<AgentWorkspace hermes={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await screen.findByRole("button", { name: "Hermes · SXCL" });
    fireEvent.click(screen.getByRole("button", { name: "+ New work" }));
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "hermes:sxcl" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Dispatcher task" } });
    expect(screen.getByLabelText("Executor")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith("sxcl", expect.objectContaining({ assignee: null }), "todo"));
  });
});

function connectedSession(url: string): HermesSessionController {
  return { ...session, status: { ...session.status, url } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
