import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetReviewStore } from "./review/reviewStore";
import type { Comparison, FileDiff, RepositoryInfo } from "./types";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  openRepository: vi.fn(),
  openWorkspace: vi.fn(),
  openWorkspaceProject: vi.fn(),
  compareBranches: vi.fn(),
  loadFileDiff: vi.fn(),
  loadWorkingTreeFileDiff: vi.fn(),
  listCommits: vi.fn(),
}));

const hermesMocks = vi.hoisted(() => ({
  status: {
    state: "disconnected",
    mode: null,
    url: null,
    version: null,
    activeWorkers: 0,
    error: null,
  },
  connectDiscovered: vi.fn(),
  connectManaged: vi.fn(),
  connectExisting: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
  listHermesBoards: vi.fn(),
  listHermesProfiles: vi.fn(),
  getHermesBoard: vi.fn(),
  getHermesTask: vi.fn(),
  getHermesTaskLog: vi.fn(),
  addHermesComment: vi.fn(),
  patchHermesTaskStatus: vi.fn(),
  listHermesHomeChannels: vi.fn(),
  createHermesTask: vi.fn(),
  addHermesTaskLink: vi.fn(),
  removeHermesTaskLink: vi.fn(),
  setHermesHomeSubscription: vi.fn(),
  uploadHermesAttachment: vi.fn(),
  downloadHermesAttachment: vi.fn(),
  deleteHermesAttachment: vi.fn(),
  subscribeHermesEvents: vi.fn(),
  unsubscribeHermesEvents: vi.fn(),
}));

const editorMocks = vi.hoisted(() => ({
  loadEditableFile: vi.fn(),
  saveEditableFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.dialogOpen }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./api", () => ({
  openRepository: mocks.openRepository,
  openWorkspace: mocks.openWorkspace,
  openWorkspaceProject: mocks.openWorkspaceProject,
  compareBranches: mocks.compareBranches,
  loadFileDiff: mocks.loadFileDiff,
  loadWorkingTreeFileDiff: mocks.loadWorkingTreeFileDiff,
  listCommits: mocks.listCommits,
}));
vi.mock("./hermes/useHermesConnection", () => ({
  useHermesConnection: () => ({
    status: hermesMocks.status,
    connectDiscovered: hermesMocks.connectDiscovered,
    connectManaged: hermesMocks.connectManaged,
    connectExisting: hermesMocks.connectExisting,
    disconnect: hermesMocks.disconnect,
    refresh: hermesMocks.refresh,
  }),
}));
vi.mock("./hermes/api", () => ({
  listHermesBoards: hermesMocks.listHermesBoards,
  listHermesProfiles: hermesMocks.listHermesProfiles,
  getHermesBoard: hermesMocks.getHermesBoard,
  getHermesTask: hermesMocks.getHermesTask,
  getHermesTaskLog: hermesMocks.getHermesTaskLog,
  addHermesComment: hermesMocks.addHermesComment,
  patchHermesTaskStatus: hermesMocks.patchHermesTaskStatus,
  listHermesHomeChannels: hermesMocks.listHermesHomeChannels,
  createHermesTask: hermesMocks.createHermesTask,
  addHermesTaskLink: hermesMocks.addHermesTaskLink,
  removeHermesTaskLink: hermesMocks.removeHermesTaskLink,
  setHermesHomeSubscription: hermesMocks.setHermesHomeSubscription,
  uploadHermesAttachment: hermesMocks.uploadHermesAttachment,
  downloadHermesAttachment: hermesMocks.downloadHermesAttachment,
  deleteHermesAttachment: hermesMocks.deleteHermesAttachment,
  subscribeHermesEvents: hermesMocks.subscribeHermesEvents,
  unsubscribeHermesEvents: hermesMocks.unsubscribeHermesEvents,
}));
vi.mock("./editor/api", () => editorMocks);

const repository: RepositoryInfo = {
  name: "example",
  path: "/work/example",
  branches: [
    { name: "feature", commit: "b".repeat(40) },
    { name: "main", commit: "a".repeat(40) },
  ],
  currentBranch: "feature",
  suggestedBaseBranch: "main",
};

const comparison: Comparison = {
  baseBranch: "main",
  compareBranch: "feature",
  baseCommit: "a".repeat(40),
  compareCommit: "b".repeat(40),
  mergeBase: "a".repeat(40),
  totalAdditions: 3,
  totalDeletions: 1,
  files: [
    {
      path: "src/example.ts",
      oldPath: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
    },
    {
      path: "assets/logo.png",
      oldPath: null,
      status: "added",
      additions: null,
      deletions: null,
      binary: true,
    },
  ],
};

const fileDiff: FileDiff = {
  path: "src/example.ts",
  oldPath: null,
  binary: false,
  tooLarge: false,
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      lines: [
        { kind: "deletion", oldLine: 1, newLine: null, content: "const answer = 41;" },
        { kind: "addition", oldLine: null, newLine: 1, content: "const answer = 42;" },
      ],
    },
  ],
};

describe("Patchdeck", () => {
  beforeEach(() => {
    localStorage.clear();
    resetReviewStore();
    mocks.dialogOpen.mockReset();
    mocks.openRepository.mockReset();
    mocks.openWorkspace.mockReset();
    mocks.openWorkspaceProject.mockReset();
    mocks.compareBranches.mockReset();
    mocks.loadFileDiff.mockReset();
    mocks.loadWorkingTreeFileDiff.mockReset();
    mocks.listCommits.mockReset();
    mocks.listCommits.mockResolvedValue([]);
    editorMocks.loadEditableFile.mockReset();
    editorMocks.saveEditableFile.mockReset();
    Object.assign(hermesMocks.status, {
      state: "disconnected",
      mode: null,
      url: null,
      version: null,
      activeWorkers: 0,
      error: null,
    });
    for (const [name, mock] of Object.entries(hermesMocks)) {
      if (name !== "status" && typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    hermesMocks.refresh.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("starts with a local-only repository prompt", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /see the whole change/i })).toBeInTheDocument();
    expect(screen.queryByText("Branch Diff")).not.toBeInTheDocument();
    expect(screen.getByText(/nothing is published automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/local-first/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Hermes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a workspace" })).toBeInTheDocument();
  });

  it("restores the last active project instead of showing the landing screen", async () => {
    localStorage.setItem(
      "branch-diff-viewer.session",
      JSON.stringify({
        version: 1,
        tabs: [
          { name: "other", path: "/work/other", openMode: "repository" },
          { name: repository.name, path: repository.path, openMode: "repository" },
        ],
        activePath: repository.path,
      }),
    );
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);

    expect(screen.queryByRole("heading", { name: /see the whole change/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "other" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "example" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledWith(repository.path));
    expect(mocks.openRepository).toHaveBeenCalledTimes(1);
  });

  it("stays review-only when no Hermes agent is attached", async () => {
    localStorage.setItem(
      "branch-diff-viewer.session",
      JSON.stringify({
        version: 1,
        tabs: [{ name: repository.name, path: repository.path, openMode: "repository" }],
        activePath: repository.path,
      }),
    );
    localStorage.setItem("branch-diff-viewer.active-surface", "agent");
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);

    expect(await screen.findByText("const answer = 42;")).toBeInTheDocument();
    expect(screen.getByText("Review-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Hermes" })).toBeInTheDocument();
  });

  it("opens the task workspace when Review code targets a different repository", async () => {
    const sxcl: RepositoryInfo = {
      ...repository,
      name: "sxcl-services",
      path: "/Users/nikhlkapadia/SXCL/sxcl-services",
    };
    const olive: RepositoryInfo = {
      ...repository,
      name: "api-copilot-mvp",
      path: "/Users/nikhlkapadia/Olive/api-copilot-mvp",
    };
    localStorage.setItem(
      "branch-diff-viewer.session",
      JSON.stringify({
        version: 1,
        tabs: [{ name: sxcl.name, path: sxcl.path, openMode: "repository" }],
        activePath: sxcl.path,
      }),
    );
    localStorage.setItem("branch-diff-viewer.active-surface", "agent");
    Object.assign(hermesMocks.status, {
      state: "connected",
      mode: "attached",
      url: "http://127.0.0.1:9119",
      version: "0.20.1",
      activeWorkers: 1,
      error: null,
    });
    mocks.openRepository.mockImplementation((path: string) => Promise.resolve(path === olive.path ? olive : sxcl));
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);
    hermesMocks.listHermesBoards.mockResolvedValue({
      current: "olive",
      boards: [{ slug: "olive", name: "Olive", total: 1 }],
    });
    hermesMocks.listHermesProfiles.mockResolvedValue({ profiles: [] });
    hermesMocks.getHermesBoard.mockResolvedValue({
      columns: [{
        name: "running",
        tasks: [{ id: "task-olive", title: "Repair Olive service", status: "running", assignee: "olive" }],
      }],
      tenants: [],
      assignees: ["olive"],
      latest_event_id: 1,
      now: 1_700_000_000,
    });
    hermesMocks.getHermesTask.mockResolvedValue({
      task: {
        id: "task-olive",
        title: "Repair Olive service",
        body: "Work only in Olive.",
        status: "running",
        assignee: "olive",
        workspace_path: olive.path,
      },
      comments: [],
      events: [],
      attachments: [],
      runs: [],
      links: { parents: [], children: [] },
      child_results: [],
    });
    hermesMocks.listHermesHomeChannels.mockResolvedValue({ home_channels: [] });

    render(<App />);

    expect(await screen.findByRole("tab", { name: sxcl.name })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(await screen.findByText("Repair Olive service"));
    fireEvent.click(await screen.findByRole("button", { name: "Review code" }));

    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledWith(olive.path));
    expect(await screen.findByRole("tab", { name: olive.name })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: sxcl.name })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: sxcl.name }));
    await waitFor(() => expect(screen.getByRole("tab", { name: sxcl.name })).toHaveAttribute("aria-selected", "true"));
    expect(within(screen.getByRole("tabpanel")).queryByTitle("Reviewing Repair Olive service")).not.toBeInTheDocument();
  });

  it("opens every direct workspace repository as a tab and loads inactive projects lazily", async () => {
    const workspacePath = "/work/product-workspace";
    const otherRepository: RepositoryInfo = {
      ...repository,
      name: "other",
      path: "/work/product-workspace/other",
    };
    mocks.dialogOpen.mockResolvedValue(workspacePath);
    mocks.openWorkspace.mockResolvedValue([
      { name: repository.name, path: repository.path },
      { name: otherRepository.name, path: otherRepository.path },
    ]);
    mocks.openWorkspaceProject.mockImplementation((path: string) =>
      Promise.resolve(path === otherRepository.path ? otherRepository : repository),
    );
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a workspace" }));

    expect(await screen.findByRole("tab", { name: "example" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "other" })).toBeInTheDocument();
    expect(mocks.openWorkspace).toHaveBeenCalledWith(workspacePath);
    await waitFor(() => expect(mocks.openWorkspaceProject).toHaveBeenCalledTimes(1));
    expect(mocks.openWorkspaceProject).toHaveBeenCalledWith(repository.path);
    expect(mocks.openRepository).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.compareBranches).toHaveBeenCalledTimes(1));
    expect(mocks.compareBranches).toHaveBeenCalledWith(repository.path, "main", "feature");
    expect(screen.getByText("2 projects opened from the workspace.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "example" })).toHaveFocus());

    fireEvent.click(screen.getByRole("tab", { name: "other" }));
    await waitFor(() => expect(mocks.openWorkspaceProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.compareBranches).toHaveBeenCalledTimes(2));
    expect(mocks.compareBranches).toHaveBeenLastCalledWith(otherRepository.path, "main", "feature");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("branch-diff-viewer.session") ?? "null")).toEqual({
      version: 1,
      tabs: [
        { name: repository.name, path: repository.path, openMode: "workspace" },
        { name: otherRepository.name, path: otherRepository.path, openMode: "workspace" },
      ],
      activePath: otherRepository.path,
    }));
  });

  it("restores workspace projects through the exact-root workspace boundary", async () => {
    localStorage.setItem(
      "branch-diff-viewer.session",
      JSON.stringify({
        version: 1,
        tabs: [{ name: repository.name, path: repository.path, openMode: "workspace" }],
        activePath: repository.path,
      }),
    );
    mocks.openWorkspaceProject.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);

    await waitFor(() => expect(mocks.openWorkspaceProject).toHaveBeenCalledWith(repository.path));
    expect(mocks.openRepository).not.toHaveBeenCalled();
  });

  it("shows a clear error when a workspace has no direct child repositories", async () => {
    mocks.dialogOpen.mockResolvedValue("/work/documents");
    mocks.openWorkspace.mockRejectedValue(new Error("No Git repositories were found in the workspace's immediate child folders."));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a workspace" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("immediate child folders");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps valid workspace projects available when one detected project cannot open", async () => {
    const brokenPath = "/work/product-workspace/broken";
    const validRepository: RepositoryInfo = {
      name: "valid",
      path: "/work/product-workspace/valid",
      branches: [],
      currentBranch: null,
      suggestedBaseBranch: null,
    };
    mocks.dialogOpen.mockResolvedValue("/work/product-workspace");
    mocks.openWorkspace.mockResolvedValue([
      { name: "broken", path: brokenPath },
      { name: validRepository.name, path: validRepository.path },
    ]);
    mocks.openWorkspaceProject.mockImplementation((path: string) =>
      path === brokenPath
        ? Promise.reject(new Error("invalid gitdir file"))
        : Promise.resolve(validRepository),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a workspace" }));

    expect(await screen.findByRole("heading", { name: "Could not open broken" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "valid" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "valid" }));
    expect(await screen.findByText("No local branches")).toBeInTheDocument();
  });

  it("opens a repository and renders its branch diff", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByText("files changed")).toBeInTheDocument();
    expect(screen.queryByText("Branch Diff")).not.toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("const answer = 42;")).toBeInTheDocument();

    expect(mocks.compareBranches).toHaveBeenCalledWith(repository.path, "main", "feature");
    await waitFor(() => expect(mocks.loadFileDiff).toHaveBeenCalledTimes(1));
  });

  it("shows compare-only commits in a dedicated branch history view", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);
    mocks.listCommits.mockResolvedValue([
      {
        id: "c".repeat(40),
        shortId: "ccccccc",
        author: "Ada Lovelace",
        timestamp: 1_700_000_000,
        subject: "Add guarded editor",
      },
      {
        id: "d".repeat(40),
        shortId: "ddddddd",
        author: "Grace Hopper",
        timestamp: 1_699_900_000,
        subject: "Connect Hermes board",
      },
    ]);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");

    expect(screen.getByRole("tab", { name: "Commits (2)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Commits (2)" }));
    expect(screen.getByRole("heading", { name: "feature compared with main" })).toBeInTheDocument();
    expect(screen.getByText("Add guarded editor")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ccccccc")).toBeInTheDocument();
    expect(mocks.listCommits).toHaveBeenCalledWith(
      repository.path,
      comparison.mergeBase,
      comparison.compareCommit,
    );
  });

  it("reloads the visible patch from the working tree after an editor save", async () => {
    Object.assign(hermesMocks.status, {
      state: "connected",
      mode: "attached",
      url: "http://127.0.0.1:9119",
      version: "0.20.1",
      activeWorkers: 0,
      error: null,
    });
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);
    const workingTreeDiff: FileDiff = {
      ...fileDiff,
      hunks: [{
        header: "@@ -1 +1 @@",
        lines: [{ kind: "addition", oldLine: null, newLine: 1, content: "const answer = 43;" }],
      }],
    };
    mocks.loadWorkingTreeFileDiff.mockResolvedValue(workingTreeDiff);
    editorMocks.loadEditableFile.mockResolvedValue({
      path: "src/example.ts",
      content: "const answer = 42;",
      hash: "before",
    });
    editorMocks.saveEditableFile.mockResolvedValue({
      path: "src/example.ts",
      content: "const answer = 43;",
      hash: "after",
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "File contents" });
    fireEvent.change(editor, { target: { value: "const answer = 43;" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));

    await waitFor(() => expect(mocks.loadWorkingTreeFileDiff).toHaveBeenCalledWith({
      repositoryPath: repository.path,
      mergeBase: comparison.mergeBase,
      path: "src/example.ts",
      oldPath: null,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("const answer = 43;")).toBeInTheDocument();
  });

  it("wraps diff lines by default and lets the user opt into horizontal scrolling", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");

    const diffView = screen.getByLabelText("File diff").querySelector(".diff-view");
    const wrapToggle = screen.getByRole("button", { name: "Disable line wrapping" });
    expect(diffView).toHaveClass("wrap-lines");
    expect(wrapToggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(wrapToggle);
    expect(diffView).toHaveClass("no-wrap-lines");
    expect(screen.getByRole("button", { name: "Enable line wrapping" })).toHaveAttribute("aria-pressed", "false");
  });

  it("uses IDE-style syntax tokens and tracks files reviewed for this comparison", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");

    expect(document.querySelector(".token.keyword")).toHaveTextContent("const");
    const reviewed = screen.getByRole("checkbox", { name: "Mark src/example.ts as viewed" });
    fireEvent.click(reviewed);

    expect(reviewed).toBeChecked();
    expect(screen.getByText("1 of 2 viewed")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toHaveClass("viewed");

    fireEvent.click(screen.getByRole("treeitem", { name: /assets\/logo\.png/ }));
    fireEvent.click(screen.getByRole("treeitem", { name: /src\/example\.ts/ }));
    expect(screen.getByRole("checkbox", { name: "Mark src/example.ts as viewed" })).toBeChecked();
  });

  it("resets the diff viewport when a different file is selected", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");
    const firstViewport = document.querySelector<HTMLElement>(".diff-scroll");
    if (!firstViewport) throw new Error("Expected a diff viewport");
    firstViewport.scrollTop = 240;

    fireEvent.click(screen.getByRole("treeitem", { name: /assets\/logo\.png/ }));
    await screen.findByRole("heading", { name: "Binary file" });
    fireEvent.click(screen.getByRole("treeitem", { name: /src\/example\.ts/ }));

    const nextViewport = document.querySelector<HTMLElement>(".diff-scroll");
    expect(nextViewport).not.toBe(firstViewport);
    expect(nextViewport).toHaveProperty("scrollTop", 0);
  });

  it("shows a binary placeholder without requesting a text patch", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("files changed");
    await screen.findByText("const answer = 42;");
    fireEvent.click(screen.getByRole("treeitem", { name: /assets\/logo\.png/ }));

    expect(await screen.findByRole("heading", { name: "Binary file" })).toBeInTheDocument();
    expect(mocks.loadFileDiff).toHaveBeenCalledTimes(1);
  });

  it("groups files into collapsible folders", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    const srcFolder = await screen.findByRole("treeitem", { name: "src, 1 changed file" });
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toBeVisible();
    fireEvent.click(srcFolder);
    expect(srcFolder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /src\/example\.ts/ })).not.toBeInTheDocument();
  });

  it("keeps a visible tree entry in the tab order after reloading a collapsed selection", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository
      .mockResolvedValueOnce(repository)
      .mockResolvedValueOnce({ ...repository });
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    const srcFolder = await screen.findByRole("treeitem", { name: "src, 1 changed file" });
    fireEvent.click(srcFolder);
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));

    await waitFor(() => expect(mocks.compareBranches).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "assets, 1 changed file" })).toHaveAttribute("tabindex", "0"));
  });

  it("opens another project in a tab and preserves the first project's selection", async () => {
    const otherRepository: RepositoryInfo = {
      ...repository,
      name: "other",
      path: "/work/other",
    };
    const otherComparison: Comparison = {
      ...comparison,
      files: [{
        path: "README.md",
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
      }],
      totalAdditions: 1,
      totalDeletions: 0,
    };
    mocks.dialogOpen
      .mockResolvedValueOnce(repository.path)
      .mockResolvedValueOnce(otherRepository.path);
    mocks.openRepository.mockImplementation((path: string) =>
      Promise.resolve(path === otherRepository.path ? otherRepository : repository),
    );
    mocks.compareBranches.mockImplementation((path: string) =>
      Promise.resolve(path === otherRepository.path ? otherComparison : comparison),
    );
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByRole("treeitem", { name: /assets\/logo\.png/ });
    fireEvent.click(screen.getByRole("treeitem", { name: /assets\/logo\.png/ }));
    expect(await screen.findByRole("heading", { name: "Binary file" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open another project" }));
    expect(await screen.findByRole("tab", { name: "other" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "example" }));
    expect(screen.getByRole("heading", { name: "Binary file" })).toBeInTheDocument();
    expect(mocks.compareBranches).toHaveBeenCalledTimes(2);
  });

  it("activates an existing tab when the selected folder resolves to an open repository", async () => {
    mocks.dialogOpen
      .mockResolvedValueOnce(repository.path)
      .mockResolvedValueOnce("/work/example/src");
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByRole("tab", { name: "example" });
    fireEvent.click(screen.getByRole("button", { name: "Open another project" }));

    await waitFor(() => expect(mocks.openRepository).toHaveBeenCalledTimes(2));
    expect(within(screen.getByRole("tablist", { name: "Open projects" })).getAllByRole("tab")).toHaveLength(1);
    expect(mocks.compareBranches).toHaveBeenCalledTimes(1);
  });

  it("reopens a matching project if its tab closes while the folder is resolving", async () => {
    const pendingRepository = deferred<RepositoryInfo>();
    mocks.dialogOpen
      .mockResolvedValueOnce(repository.path)
      .mockResolvedValueOnce("/work/example/src");
    mocks.openRepository
      .mockResolvedValueOnce(repository)
      .mockReturnValueOnce(pendingRepository.promise);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByRole("tab", { name: "example" });
    fireEvent.click(screen.getByRole("button", { name: "Open another project" }));
    fireEvent.click(screen.getByRole("button", { name: "Close example" }));

    await act(async () => pendingRepository.resolve(repository));
    expect(await screen.findByRole("tab", { name: "example" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toBeVisible();
  });

  it("moves focus to the open action after closing the final project tab", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByRole("tab", { name: "example" });
    fireEvent.click(screen.getByRole("button", { name: "Close example" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Open repository" })).toHaveFocus());
  });

  it("shows an empty-repository state when no branch ref exists", async () => {
    mocks.dialogOpen.mockResolvedValue("/work/empty");
    mocks.openRepository.mockResolvedValue({
      name: "empty",
      path: "/work/empty",
      branches: [],
      currentBranch: null,
      suggestedBaseBranch: null,
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByRole("heading", { name: /nothing to compare yet/i })).toBeInTheDocument();
    expect(screen.getByText("No local branches")).toBeInTheDocument();
    expect(mocks.compareBranches).not.toHaveBeenCalled();
  });

  it("shows a retry action when a file diff fails", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff
      .mockRejectedValueOnce(new Error("Patch could not be read"))
      .mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByRole("heading", { name: "Could not load this diff" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("const answer = 42;")).toBeInTheDocument();
    expect(mocks.loadFileDiff).toHaveBeenCalledTimes(2);
  });

  it("does not label a failed comparison as having no changes", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockRejectedValue(new Error("Branches have no common ancestor"));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no common ancestor");
    expect(screen.queryByText("No changed files")).not.toBeInTheDocument();
    expect(screen.getAllByText("Comparison unavailable").length).toBeGreaterThan(0);
  });

  it("requires a new selection when refresh finds a deleted branch", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository
      .mockResolvedValueOnce(repository)
      .mockResolvedValueOnce({
        ...repository,
        branches: [{ name: "main", commit: "a".repeat(40) }],
        currentBranch: "main",
        suggestedBaseBranch: null,
      });
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("files changed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh comparison" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("'feature' no longer exists");
    expect(screen.getByLabelText("Compare")).toHaveValue("");
    expect(screen.getAllByText("Comparison unavailable").length).toBeGreaterThan(0);
  });

  it("ignores a stale repository response after a newer open completes", async () => {
    localStorage.setItem(
      "branch-diff-viewer.recent-repositories",
      JSON.stringify(["/work/repo-a", "/work/repo-b"]),
    );
    const first = deferred<RepositoryInfo>();
    const emptyRepository: RepositoryInfo = {
      name: "repo-b",
      path: "/work/repo-b",
      branches: [],
      currentBranch: null,
      suggestedBaseBranch: null,
    };
    mocks.openRepository.mockImplementation((path: string) =>
      path === "/work/repo-a" ? first.promise : Promise.resolve(emptyRepository),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /repo-a/i }));
    fireEvent.click(screen.getByRole("button", { name: /repo-b/i }));
    expect(await screen.findByText("No local branches")).toBeInTheDocument();

    await act(async () => first.resolve(repository));
    expect(screen.getByText("No local branches")).toBeInTheDocument();
    expect(mocks.compareBranches).not.toHaveBeenCalled();
  });

  it("keeps a pending comparison isolated while another project is active", async () => {
    const pendingComparison = deferred<Comparison>();
    const emptyRepository: RepositoryInfo = {
      name: "empty",
      path: "/work/empty",
      branches: [],
      currentBranch: null,
      suggestedBaseBranch: null,
    };
    mocks.dialogOpen
      .mockResolvedValueOnce(repository.path)
      .mockResolvedValueOnce(emptyRepository.path);
    mocks.openRepository
      .mockResolvedValueOnce(repository)
      .mockResolvedValueOnce(emptyRepository);
    mocks.compareBranches.mockReturnValue(pendingComparison.promise);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    expect(await screen.findByText("Comparing branches…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open another project" }));

    expect(await screen.findByText("No local branches")).toBeInTheDocument();
    expect(within(screen.getByRole("tabpanel")).queryByText("Comparing branches…")).not.toBeInTheDocument();
    await act(async () => pendingComparison.resolve(comparison));
    expect(within(screen.getByRole("tabpanel")).getByText("No local branches")).toBeInTheDocument();
  });

  it("moves the selected file with j and k", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");
    fireEvent.click(screen.getByRole("treeitem", { name: /assets\/logo\.png/ }));

    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByRole("treeitem", { name: /assets\/logo\.png/ })).toHaveAttribute("aria-selected", "true");
  });

  it("marks the selected file viewed and advances with v", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    const assetFile = await screen.findByRole("treeitem", { name: /assets\/logo\.png/ });
    fireEvent.click(assetFile);

    fireEvent.keyDown(window, { key: "v" });
    expect(assetFile).toHaveClass("viewed");
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toHaveAttribute("aria-selected", "true");
  });

  it("filters changed files and clears the filter with Escape", async () => {
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    const filter = await screen.findByRole("textbox", { name: "Filter files" });

    fireEvent.change(filter, { target: { value: "logo" } });
    expect(screen.getByRole("treeitem", { name: /assets\/logo\.png/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /src\/example\.ts/ })).not.toBeInTheDocument();

    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(screen.getByRole("treeitem", { name: /src\/example\.ts/ })).toBeInTheDocument();
  });

  it("shows a stale comparison notice on focus and refreshes on request", async () => {
    const newerRepository: RepositoryInfo = {
      ...repository,
      branches: [
        { name: "feature", commit: "c".repeat(40) },
        { name: "main", commit: "a".repeat(40) },
      ],
    };
    mocks.dialogOpen.mockResolvedValue(repository.path);
    mocks.openRepository
      .mockResolvedValueOnce(repository)
      .mockResolvedValueOnce(newerRepository)
      .mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("const answer = 42;");

    fireEvent.focus(window);
    expect(await screen.findByText("This comparison is behind the branch.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    await waitFor(() => expect(mocks.compareBranches).toHaveBeenCalledTimes(2));
  });

  it("restores a stored project view after remounting", async () => {
    localStorage.setItem(
      "branch-diff-viewer.session",
      JSON.stringify({
        version: 1,
        tabs: [{ name: repository.name, path: repository.path, openMode: "repository" }],
        activePath: repository.path,
      }),
    );
    localStorage.setItem(
      "branch-diff-viewer.project-views.v1",
      JSON.stringify({
        [repository.path]: {
          baseBranch: "feature",
          compareBranch: "main",
          selectedPath: "assets/logo.png",
        },
      }),
    );
    mocks.openRepository.mockResolvedValue(repository);
    mocks.compareBranches.mockResolvedValue(comparison);
    mocks.loadFileDiff.mockResolvedValue(fileDiff);

    const firstRender = render(<App />);
    await screen.findByRole("treeitem", { name: /assets\/logo\.png/ });
    firstRender.unmount();

    render(<App />);
    const restoredFile = await screen.findByRole("treeitem", { name: /assets\/logo\.png/ });
    expect(screen.getByLabelText("Base")).toHaveValue("feature");
    expect(screen.getByLabelText("Compare")).toHaveValue("main");
    expect(restoredFile).toHaveAttribute("aria-selected", "true");
    expect(mocks.compareBranches).toHaveBeenLastCalledWith(repository.path, "feature", "main");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
