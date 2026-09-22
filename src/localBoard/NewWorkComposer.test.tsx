import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetExecutionProfiles } from "../providers/profiles";
import { NewWorkComposer } from "./NewWorkComposer";
import { getLocalBoardDocument, resetLocalBoardStore } from "./store";
import type { LocalCard } from "./types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  createHermesTask: vi.fn(),
  getHermesBoard: vi.fn(),
  listRuntimes: vi.fn(),
  startRuntime: vi.fn(),
  stopRuntime: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../hermes/api", () => ({
  createHermesTask: mocks.createHermesTask,
  getHermesBoard: mocks.getHermesBoard,
}));
vi.mock("../providers/api", () => ({
  listAgentRuntimes: mocks.listRuntimes,
  startAgentRuntime: mocks.startRuntime,
  stopAgentRuntime: mocks.stopRuntime,
}));

const boards = [
  { slug: "sxcl", name: "SXCL", default_workspace_kind: "worktree" as const },
  { slug: "olive", name: "Olive", default_workspace_kind: "dir" as const },
];
const handoffCard: LocalCard = {
  id: "local-1",
  repositoryPath: "/work/product",
  title: "Keep local",
  body: "Send a Hermes copy.",
  lane: "todo",
  executionProfileId: null,
  hermesHandoffs: [],
  createdAt: 1,
  updatedAt: 1,
};

describe("new work composer interaction contract", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLocalBoardStore();
    resetExecutionProfiles();
    mocks.invoke.mockReset().mockResolvedValue(null);
    mocks.createHermesTask.mockReset().mockResolvedValue({ task: { id: "task-new", title: "Keep local", status: "todo" } });
    mocks.getHermesBoard.mockReset().mockResolvedValue({
      columns: [{ name: "todo", tasks: [{ id: "parent-1", title: "Prepare the repository", status: "todo" }] }],
      tenants: [],
      assignees: [],
      latest_event_id: 1,
      now: 1,
    });
    mocks.listRuntimes.mockReset().mockResolvedValue([]);
    mocks.startRuntime.mockReset();
    mocks.stopRuntime.mockReset();
  });

  afterEach(cleanup);

  it("lets an explicit handoff choose any named Hermes board but never Local", async () => {
    const created = vi.fn();
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[{ name: "coder", is_default: true, description: "Writes code" }]}
        initialDestination="hermes:sxcl"
        handoffCard={handoffCard}
        onClose={vi.fn()}
        onCreated={created}
      />,
    );

    const destination = screen.getByLabelText("Destination");
    expect(destination).toBeEnabled();
    expect(within(destination).queryByRole("option", { name: "Local Board" })).not.toBeInTheDocument();
    expect(within(destination).getByRole("option", { name: "Hermes · SXCL" })).toBeInTheDocument();
    expect(within(destination).getByRole("option", { name: "Hermes · Olive" })).toBeInTheDocument();

    fireEvent.change(destination, { target: { value: "hermes:olive" } });
    await waitFor(() => expect(screen.getByLabelText("Executor")).toHaveValue("coder"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm send" }));

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith(
      "olive",
      expect.objectContaining({ title: "Keep local", assignee: "coder" }),
      "todo",
    ));
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ source: "hermes", board: "olive" }));
  });

  it("keeps the Hermes task routing and execution fields in the unified composer", async () => {
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[{ name: "coder", is_default: true, description: "Writes code" }]}
        initialDestination="hermes:sxcl"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const advanced = screen.getByText("Advanced").closest("details");
    expect(advanced).not.toHaveAttribute("open");
    await waitFor(() => expect(advanced).toHaveTextContent("Priority 0 · default skills · worktree · /work/product · no parent · goal mode off"));
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Implement routing" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Skills"), { target: { value: "testing, code-review" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "dir" } });
    fireEvent.change(screen.getByLabelText("Workspace path"), { target: { value: "/work/custom" } });
    await waitFor(() => expect(screen.getByRole("option", { name: "parent-1 — Prepare the repository" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Parent task"), { target: { value: "parent-1" } });
    fireEvent.click(screen.getByLabelText("Goal mode"));
    fireEvent.change(screen.getByLabelText("Goal max turns"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Create work" }));

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith(
      "sxcl",
      expect.objectContaining({
        title: "Implement routing",
        assignee: "coder",
        priority: 3,
        skills: ["testing", "code-review"],
        parents: ["parent-1"],
        goal_mode: true,
        goal_max_turns: 12,
        workspace_kind: "dir",
        workspace_path: "/work/custom",
      }),
      "todo",
    ));
  });

  it("captures a Hermes idea in Triage without implicitly assigning or starting an agent", async () => {
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[{ name: "coder", is_default: true, description: "Writes code" }]}
        initialDestination="hermes:sxcl"
        targetStatus="triage"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Capture Hermes idea" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture idea" })).toBeInTheDocument();
    expect(screen.getByLabelText("Executor")).toHaveValue("");
    expect(screen.getByText(/Triage for refinement before execution/i)).toBeInTheDocument();
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Explore a smaller review loop" } });
    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => expect(mocks.createHermesTask).toHaveBeenCalledWith(
      "sxcl",
      expect.objectContaining({ title: "Explore a smaller review loop", assignee: null, triage: true }),
      "triage",
    ));
    expect(mocks.startRuntime).not.toHaveBeenCalled();
  });

  it("creates a local card without running the selected profile when the form uses its safe default", async () => {
    mocks.listRuntimes.mockResolvedValue([{ id: "codex", ready: true }]);
    const created = vi.fn();
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[]}
        onClose={vi.fn()}
        onCreated={created}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Executor")).toHaveValue("codex-workspace"));
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Keep this queued" } });

    expect(screen.getByRole("button", { name: "Create card" })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create & run" })).toBeEnabled());
    fireEvent.keyDown(title, { key: "Enter" });

    await waitFor(() => expect(created).toHaveBeenCalledWith(expect.objectContaining({
      source: "local",
      card: expect.objectContaining({ title: "Keep this queued", executionProfileId: "codex-workspace" }),
    })));
    expect(created.mock.calls[0][0].card.workspace).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalledWith("create_card_worktree", expect.anything());
    expect(mocks.startRuntime).not.toHaveBeenCalled();
  });

  it("preserves the draft and prevents duplicate Create & run attempts when workspace preparation fails", async () => {
    const workspace = deferred<never>();
    mocks.listRuntimes.mockResolvedValue([{ id: "codex", ready: true }]);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "open_repository") return Promise.resolve({ suggestedBaseBranch: "main" });
      if (command === "create_card_worktree") return workspace.promise;
      return Promise.resolve(null);
    });
    const created = vi.fn();
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[]}
        onClose={vi.fn()}
        onCreated={created}
      />,
    );
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Retry this draft" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Keep these details." } });
    const run = await screen.findByRole("button", { name: "Create & run" });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "create_card_worktree")).toHaveLength(1));

    workspace.reject(new Error("workspace unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("workspace unavailable");
    expect(screen.getByLabelText("Title")).toHaveValue("Retry this draft");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Keep these details.");
    expect(screen.getByRole("button", { name: "Create & run" })).toBeEnabled();
    expect(created).not.toHaveBeenCalled();
    expect(getLocalBoardDocument().cards).toHaveLength(0);
  });

  it("dismisses with Escape and restores focus to the opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open composer</button>
          {open && (
            <NewWorkComposer
              repositoryPath="/work/product"
              boards={boards}
              hermesProfiles={[]}
              onClose={() => setOpen(false)}
              onCreated={vi.fn()}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open composer" });
    opener.focus();
    fireEvent.click(opener);
    const title = screen.getByLabelText("Title");
    expect(title).toHaveFocus();

    fireEvent.keyDown(title, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create new work" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("contains keyboard focus by wrapping Tab at both dialog edges", () => {
    render(
      <NewWorkComposer
        repositoryPath="/work/product"
        boards={boards}
        hermesProfiles={[]}
        handoffCard={handoffCard}
        initialDestination="hermes:sxcl"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const first = screen.getByRole("button", { name: "Close work form" });
    const last = screen.getByRole("button", { name: "Confirm send" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });
});

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, promiseReject) => {
    reject = promiseReject;
  });
  return { promise, reject };
}
