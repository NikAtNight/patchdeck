import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesBoard } from "./HermesBoard";
import { HermesConnectionControl } from "./HermesConnectionControl";
import type { HermesSessionController } from "./types";

const mocks = vi.hoisted(() => ({
  listHermesBoards: vi.fn(),
  listHermesProfiles: vi.fn(),
  getHermesBoard: vi.fn(),
  getHermesTask: vi.fn(),
  getHermesTaskLog: vi.fn(),
  addHermesComment: vi.fn(),
  createHermesTask: vi.fn(),
  patchHermesTaskStatus: vi.fn(),
  addHermesTaskLink: vi.fn(),
  removeHermesTaskLink: vi.fn(),
  listHermesHomeChannels: vi.fn(),
  setHermesHomeSubscription: vi.fn(),
  uploadHermesAttachment: vi.fn(),
  downloadHermesAttachment: vi.fn(),
  deleteHermesAttachment: vi.fn(),
  subscribeHermesEvents: vi.fn(),
  unsubscribeHermesEvents: vi.fn(),
}));

vi.mock("./api", () => mocks);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
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
  refresh: vi.fn().mockResolvedValue(undefined),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("Hermes workspace", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listHermesBoards.mockResolvedValue({
      current: "product",
      boards: [{ slug: "product", name: "Product", total: 1, default_workspace_kind: "worktree", default_workdir: "/work/product" }],
    });
    mocks.listHermesProfiles.mockResolvedValue({ profiles: [{ name: "coder", is_default: true, description: "Writes code" }] });
    mocks.getHermesBoard.mockResolvedValue({
      columns: [
        { name: "triage", tasks: [] },
        { name: "todo", tasks: [] },
        { name: "scheduled", tasks: [] },
        { name: "ready", tasks: [] },
        { name: "running", tasks: [{ id: "task-1", title: "Build review loop", status: "running", assignee: "coder", comment_count: 1 }] },
        { name: "blocked", tasks: [] },
        { name: "review", tasks: [] },
        { name: "done", tasks: [] },
      ],
      tenants: [],
      assignees: ["coder"],
      latest_event_id: 3,
      now: 1_700_000_000,
    });
    mocks.getHermesTask.mockResolvedValue({
      task: { id: "task-1", title: "Build review loop", body: "Keep it local", status: "running", assignee: "coder", workspace_path: "/work/product", last_heartbeat_at: 1_700_000_000 },
      comments: [{ id: 1, author: "human", body: "Please wrap long lines", created_at: 1_700_000_000 }],
      events: [{ id: 1, kind: "claimed", payload: { profile: "coder" }, created_at: 1_700_000_000 }],
      runs: [{ id: 9, profile: "coder", status: "running", started_at: 1_700_000_000 }],
      links: { parents: [], children: [] },
    });
    mocks.getHermesTaskLog.mockResolvedValue({ exists: true, size_bytes: 18, content: "working on the task", truncated: false });
    mocks.addHermesComment.mockResolvedValue({ ok: true });
    mocks.listHermesHomeChannels.mockResolvedValue({ home_channels: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the canonical Hermes lanes and live task evidence", async () => {
    const review = vi.fn();
    render(<HermesBoard session={session} repositoryPath="/work/product" onReviewTask={review} />);

    expect(await screen.findByText("Build review loop")).toBeInTheDocument();
    for (const label of ["Triage tasks", "To do tasks", "Scheduled tasks", "Ready tasks", "Running tasks", "Blocked tasks", "Review tasks", "Done tasks"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText("Build review loop"));
    expect(await screen.findByText("Please wrap long lines")).toBeInTheDocument();
    expect(screen.getByText("Last heartbeat").nextElementSibling).not.toHaveTextContent("Unknown time");
    fireEvent.click(screen.getByRole("button", { name: "Review code" }));
    expect(review).toHaveBeenCalledWith({ board: "product", taskId: "task-1", title: "Build review loop", status: "running", repositoryPath: "/work/product" });

    fireEvent.click(screen.getByText("Build review loop"));
    await screen.findByText("Please wrap long lines");
    fireEvent.click(screen.getByRole("button", { name: "activity" }));
    expect(screen.getByText("claimed")).toBeInTheDocument();
    expect(screen.getAllByText("coder").length).toBeGreaterThan(0);
    expect(mocks.getHermesTaskLog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "log" }));
    expect(await screen.findByText("working on the task")).toBeInTheDocument();
    expect(mocks.getHermesTaskLog).toHaveBeenCalledWith("product", "task-1");
  });

  it("sends human feedback into the selected Hermes task", async () => {
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("Build review loop"));
    const composer = await screen.findByPlaceholderText(/give the agent context/i);
    fireEvent.change(composer, { target: { value: "Address the line-level review comments." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Hermes" }));

    await waitFor(() => expect(mocks.addHermesComment).toHaveBeenCalledWith(
      "product",
      "task-1",
      "Address the line-level review comments.",
    ));
  });

  it("does not review an unrelated open repository when the task has no workspace path", async () => {
    mocks.getHermesTask.mockResolvedValue({
      task: { id: "task-1", title: "Build review loop", status: "running" },
      comments: [], events: [], attachments: [], runs: [], links: { parents: [], children: [] }, child_results: [],
    });
    const review = vi.fn();
    render(<HermesBoard session={session} repositoryPath="/work/unrelated" onReviewTask={review} />);
    fireEvent.click(await screen.findByText("Build review loop"));

    const button = await screen.findByRole("button", { name: "Review code" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Task workspace unavailable")).toBeInTheDocument();
    fireEvent.click(button);
    expect(review).not.toHaveBeenCalled();
  });

  it("subscribes to the Hermes event socket and unsubscribes on teardown", async () => {
    const { unmount } = render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    await screen.findByText("Build review loop");
    expect(mocks.subscribeHermesEvents).toHaveBeenCalledWith("product", 0);

    unmount();
    await waitFor(() => expect(mocks.unsubscribeHermesEvents).toHaveBeenCalled());
  });

  it("uses a stable vector refresh glyph during board polling", async () => {
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    await screen.findByText("Build review loop");

    const refresh = screen.getByRole("button", { name: "Refresh agent board" });
    expect(refresh.querySelector("svg")).not.toBeNull();
    expect(refresh).not.toHaveTextContent("↻");
  });

  it("does not visibly reload the board when only connection status identity changes", async () => {
    const review = vi.fn();
    const { rerender } = render(<HermesBoard session={session} onReviewTask={review} />);
    await screen.findByText("Build review loop");
    expect(mocks.getHermesBoard).toHaveBeenCalledTimes(1);

    rerender(
      <HermesBoard
        session={{ ...session, status: { ...session.status } }}
        onReviewTask={review}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(mocks.getHermesBoard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refresh agent board" })).toBeEnabled();
  });

  it("does not let an older board response replace the newly selected board", async () => {
    mocks.listHermesBoards.mockResolvedValue({
      current: "product",
      boards: [
        { slug: "product", name: "Product", total: 1 },
        { slug: "operations", name: "Operations", total: 1 },
      ],
    });
    const product = deferred<Awaited<ReturnType<typeof mocks.getHermesBoard>>>();
    const operations = deferred<Awaited<ReturnType<typeof mocks.getHermesBoard>>>();
    mocks.getHermesBoard.mockImplementation((board: string) => (
      board === "product" ? product.promise : operations.promise
    ));

    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    const boardPicker = await screen.findByRole("combobox", { name: "Board" });
    await waitFor(() => expect(mocks.getHermesBoard).toHaveBeenCalledWith("product", false));
    fireEvent.change(boardPicker, { target: { value: "operations" } });
    await waitFor(() => expect(mocks.getHermesBoard).toHaveBeenCalledWith("operations", false));

    operations.resolve({
      columns: [{ name: "ready", tasks: [{ id: "ops-1", title: "Operations task", status: "ready" }] }],
      tenants: [], assignees: [], latest_event_id: 1, now: 1_700_000_000,
    });
    expect(await screen.findByText("Operations task")).toBeInTheDocument();

    product.resolve({
      columns: [{ name: "ready", tasks: [{ id: "product-1", title: "Product task", status: "ready" }] }],
      tenants: [], assignees: [], latest_event_id: 1, now: 1_700_000_000,
    });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("Operations task")).toBeInTheDocument();
    expect(screen.queryByText("Product task")).not.toBeInTheDocument();
  });

  it("remembers board selection separately for each repository", async () => {
    mocks.listHermesBoards.mockResolvedValue({
      current: "product",
      boards: [
        { slug: "product", name: "Product", total: 0 },
        { slug: "operations", name: "Operations", total: 0 },
      ],
    });
    mocks.getHermesBoard.mockResolvedValue({ columns: [], tenants: [], assignees: [], latest_event_id: 0, now: 1_700_000_000 });

    const first = render(<HermesBoard session={session} repositoryPath="/work/first" onReviewTask={vi.fn()} />);
    const firstPicker = await screen.findByRole("combobox", { name: "Board" });
    fireEvent.change(firstPicker, { target: { value: "operations" } });
    await waitFor(() => expect(firstPicker).toHaveValue("operations"));
    first.unmount();

    const second = render(<HermesBoard session={session} repositoryPath="/work/second" onReviewTask={vi.fn()} />);
    const secondPicker = await screen.findByRole("combobox", { name: "Board" });
    await waitFor(() => expect(secondPicker).toHaveValue("product"));
    second.unmount();

    render(<HermesBoard session={session} repositoryPath="/work/first" onReviewTask={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Board" })).toHaveValue("operations"));
  });

  it("does not let an older task-detail response replace the newly selected task", async () => {
    mocks.getHermesBoard.mockResolvedValue({
      columns: [{ name: "ready", tasks: [
        { id: "task-1", title: "First card", status: "ready" },
        { id: "task-2", title: "Second card", status: "ready" },
      ] }],
      tenants: [], assignees: [], latest_event_id: 1, now: 1_700_000_000,
    });
    const first = deferred<Awaited<ReturnType<typeof mocks.getHermesTask>>>();
    const second = deferred<Awaited<ReturnType<typeof mocks.getHermesTask>>>();
    mocks.getHermesTask.mockImplementation((_board: string, taskId: string) => (
      taskId === "task-1" ? first.promise : second.promise
    ));

    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("First card"));
    await waitFor(() => expect(mocks.getHermesTask).toHaveBeenCalledWith("product", "task-1"));
    fireEvent.click(screen.getByText("Second card"));
    await waitFor(() => expect(mocks.getHermesTask).toHaveBeenCalledWith("product", "task-2"));

    second.resolve({
      task: { id: "task-2", title: "Second detail", status: "ready" },
      comments: [{ id: 2, author: "human", body: "Second comment", created_at: 1_700_000_000 }],
      events: [], attachments: [], runs: [], links: { parents: [], children: [] }, child_results: [],
    });
    expect(await screen.findByText("Second comment")).toBeInTheDocument();

    first.resolve({
      task: { id: "task-1", title: "First detail", status: "ready" },
      comments: [{ id: 1, author: "human", body: "Stale first comment", created_at: 1_700_000_000 }],
      events: [], attachments: [], runs: [], links: { parents: [], children: [] }, child_results: [],
    });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("Second detail")).toBeInTheDocument();
    expect(screen.queryByText("Stale first comment")).not.toBeInTheDocument();
  });

  it("clears task-specific drafts when opening another task", async () => {
    mocks.getHermesBoard.mockResolvedValue({
      columns: [{ name: "ready", tasks: [
        { id: "task-1", title: "First card", status: "ready" },
        { id: "task-2", title: "Second card", status: "ready" },
      ] }],
      tenants: [], assignees: [], latest_event_id: 1, now: 1_700_000_000,
    });
    mocks.getHermesTask.mockImplementation((_board: string, taskId: string) => Promise.resolve({
      task: { id: taskId, title: taskId === "task-1" ? "First detail" : "Second detail", status: "ready" },
      comments: [], events: [], attachments: [], runs: [], links: { parents: [], children: [] }, child_results: [],
    }));

    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("First card"));
    const composer = await screen.findByPlaceholderText(/give the agent context/i);
    fireEvent.change(composer, { target: { value: "Draft only for the first task" } });

    fireEvent.click(screen.getByText("Second card"));
    await screen.findByText("Second detail");

    expect(screen.getByPlaceholderText(/give the agent context/i)).toHaveValue("");
  });

  it("only offers workflow-safe task moves", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.patchHermesTaskStatus.mockResolvedValue({ ok: true });
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("Build review loop"));

    const blockTask = await screen.findByRole("button", { name: "Block task" });
    expect(screen.getByLabelText("Task transitions").querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Move task to scheduled" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move task to running" })).not.toBeInTheDocument();
    fireEvent.click(blockTask);

    await waitFor(() => expect(mocks.patchHermesTaskStatus).toHaveBeenCalledWith("product", "task-1", "blocked"));
    expect(window.confirm).toHaveBeenCalled();
  });

  it("only offers review completion or the supported review-to-ready loop", async () => {
    mocks.getHermesTask.mockResolvedValue({
      task: { id: "task-1", title: "Build review loop", status: "review", workspace_path: "/work/product" },
      comments: [], events: [], attachments: [], runs: [], links: { parents: [], children: [] }, child_results: [],
    });
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("Build review loop"));

    expect(await screen.findByRole("button", { name: "Move task to ready" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete task" })).toBeInTheDocument();
    expect(screen.getByLabelText("Task transitions").querySelectorAll("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Move task to running" })).not.toBeInTheDocument();
  });

  it("creates tasks from eligible columns with the native Hermes fields", async () => {
    mocks.createHermesTask.mockResolvedValue({ task: { id: "task-new", status: "ready" } });
    mocks.patchHermesTaskStatus.mockResolvedValue({ ok: true });
    render(<HermesBoard session={session} repositoryPath="/work/product" onReviewTask={vi.fn()} />);
    await screen.findByText("Build review loop");

    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task in Running" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task in Done" })).not.toBeInTheDocument();
    const todoLane = screen.getByLabelText("To do tasks");
    expect(todoLane.querySelector("header .lane-create-button")).toBe(screen.getByRole("button", { name: "New task in To do" }));
    expect(todoLane.querySelector(".kanban-card-list .lane-create-button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task in To do" }));

    expect(screen.getByRole("dialog", { name: "Create Hermes task" })).toHaveTextContent("New task — To do");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship reviewed changes" } });
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "coder" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/skills/i), { target: { value: "testing, code-review" } });
    fireEvent.click(screen.getByLabelText("Goal mode"));
    fireEvent.change(screen.getByLabelText("Goal max turns"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith("product", expect.objectContaining({
      title: "Ship reviewed changes",
      assignee: "coder",
      priority: 4,
      skills: ["testing", "code-review"],
      goal_mode: true,
      goal_max_turns: 12,
      workspace_kind: "worktree",
      workspace_path: "/work/product",
    }), "todo"));
    expect(mocks.patchHermesTaskStatus).not.toHaveBeenCalled();
  });

  it("closes and refreshes after partial task creation while keeping its warning visible", async () => {
    mocks.createHermesTask.mockResolvedValue({
      task: { id: "task-new", title: "Partially routed task", status: "todo" },
      warning: "Task was created, but moving it to blocked failed.",
    });
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    await screen.findByText("Build review loop");
    fireEvent.click(screen.getByRole("button", { name: "New task in Blocked" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Partially routed task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Task was created, but moving it to blocked failed.");
    expect(screen.queryByRole("dialog", { name: "Create Hermes task" })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.getHermesBoard).toHaveBeenCalledTimes(2));
  });

  it("formats task markdown and exposes dependencies, attachments, transitions, and notifications", async () => {
    mocks.getHermesTask.mockResolvedValue({
      task: { id: "task-1", title: "Build review loop", body: "# Plan\\n\\n- Keep it local\\n- Verify it", status: "running", assignee: "coder" },
      comments: [],
      events: [],
      attachments: [{ id: 9, filename: "review.md", size: 2048, content_type: "text/markdown" }],
      links: { parents: ["task-parent"], children: ["task-child"] },
      child_results: [{ id: "task-child", title: "Verify it", status: "todo", result: null }],
      runs: [],
    });
    mocks.listHermesHomeChannels.mockResolvedValue({
      home_channels: [{ platform: "telegram", chat_id: "home", thread_id: "", name: "Home", subscribed: true }],
    });
    render(<HermesBoard session={session} onReviewTask={vi.fn()} />);
    fireEvent.click(await screen.findByText("Build review loop"));

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByText("Keep it local")).toBeInTheDocument();
    expect(screen.getByText("task-parent")).toBeInTheDocument();
    expect(screen.getByText("review.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop telegram notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block task" })).toBeInTheDocument();
  });

  it("offers managed and attached loopback connection modes", async () => {
    const disconnected: HermesSessionController = {
      ...session,
      status: { state: "disconnected", mode: null, url: null, version: null, activeWorkers: 0, error: null },
      connectDiscovered: vi.fn().mockResolvedValue(true),
      connectManaged: vi.fn().mockResolvedValue(true),
      connectExisting: vi.fn().mockResolvedValue(true),
    };
    render(<HermesConnectionControl session={disconnected} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Hermes" }));
    fireEvent.click(screen.getByRole("button", { name: "Use running Hermes" }));
    await waitFor(() => expect(disconnected.connectDiscovered).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Start new Hermes server" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Attach existing" }));
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://127.0.0.1:43117" } });
    fireEvent.change(screen.getByLabelText("Session token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(disconnected.connectExisting).toHaveBeenCalledWith("http://127.0.0.1:43117", "secret"));
  });
});
