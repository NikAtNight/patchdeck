import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Comparison, FileDiff, RepositoryInfo } from "./types";

const mocks = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  openRepository: vi.fn(),
  openWorkspace: vi.fn(),
  openWorkspaceProject: vi.fn(),
  compareBranches: vi.fn(),
  loadFileDiff: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.dialogOpen }));
vi.mock("./api", () => ({
  openRepository: mocks.openRepository,
  openWorkspace: mocks.openWorkspace,
  openWorkspaceProject: mocks.openWorkspaceProject,
  compareBranches: mocks.compareBranches,
  loadFileDiff: mocks.loadFileDiff,
}));

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

describe("Branch Diff Viewer", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.dialogOpen.mockReset();
    mocks.openRepository.mockReset();
    mocks.openWorkspace.mockReset();
    mocks.openWorkspaceProject.mockReset();
    mocks.compareBranches.mockReset();
    mocks.loadFileDiff.mockReset();
  });

  afterEach(cleanup);

  it("starts with a local-only repository prompt", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /see the whole change/i })).toBeInTheDocument();
    expect(screen.queryByText("Branch Diff")).not.toBeInTheDocument();
    expect(screen.getByText(/nothing leaves your machine/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only by design/i)).toBeInTheDocument();
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
    expect(screen.getAllByRole("tab")).toHaveLength(1);
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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
