import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparison, RepositoryInfo } from "../types";
import { createLocalCard, patchLocalCard, resetLocalBoardStore } from "../localBoard/store";
import { WorktreeReviewQueue } from "./WorktreeReviewQueue";

const mocks = vi.hoisted(() => ({
  listCardWorktrees: vi.fn(),
  openRepository: vi.fn(),
  compareWorkingTree: vi.fn(),
  readReviewProgress: vi.fn(),
  readProjectView: vi.fn(),
}));

vi.mock("../providers/workspaces", () => ({ listCardWorktrees: mocks.listCardWorktrees }));
vi.mock("../api", () => ({ openRepository: mocks.openRepository, compareWorkingTree: mocks.compareWorkingTree }));
vi.mock("../review/reviewedFiles", () => ({ readReviewProgress: mocks.readReviewProgress }));
vi.mock("../session", () => ({ readProjectView: mocks.readProjectView }));

const repository = { name: "product", path: "/work/product", suggestedBaseBranch: "main" };

describe("worktree review queue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLocalBoardStore();
    mocks.listCardWorktrees.mockReset();
    mocks.openRepository.mockReset().mockImplementation((path: string) => Promise.resolve(repositoryInfo(path)));
    mocks.compareWorkingTree.mockReset().mockImplementation((path: string, base: string) => Promise.resolve(comparison(path, base)));
    mocks.readReviewProgress.mockReset().mockReturnValue({ viewed: new Set<string>(), changed: new Set<string>() });
    mocks.readProjectView.mockReset().mockReturnValue(null);
  });

  afterEach(cleanup);

  it("shows the current checkout and linked worktrees with review filters and progress", async () => {
    mocks.listCardWorktrees.mockResolvedValue([
      { path: repository.path, branch: "main" },
      { path: "/worktrees/feature-a", branch: "feature/a" },
      { path: "/worktrees/feature-b", branch: "feature/b" },
      { path: "/worktrees/feature-c", branch: "feature/c" },
    ]);
    mocks.readProjectView.mockImplementation((path: string) => path === "/worktrees/feature-a"
      ? { baseBranch: "develop", compareBranch: "feature/a", selectedPath: null, mode: "workingTree" }
      : null);
    mocks.readReviewProgress.mockImplementation((path: string) => {
      if (path === "/worktrees/feature-a") return { viewed: new Set(["one.ts"]), changed: new Set<string>() };
      if (path === "/worktrees/feature-b") return { viewed: new Set(["one.ts"]), changed: new Set(["two.ts"]) };
      if (path === "/worktrees/feature-c") return { viewed: new Set(["one.ts", "two.ts"]), changed: new Set<string>() };
      return { viewed: new Set<string>(), changed: new Set<string>() };
    });
    const card = createLocalCard({ repositoryPath: repository.path, title: "Linked agent task" });
    patchLocalCard(card.id, { workspace: { repositoryPath: repository.path, worktreePath: "/worktrees/feature-a", branch: "feature/a", baseBranch: "main" } });
    const onOpenReview = vi.fn();

    render(<WorktreeReviewQueue repository={repository} onOpenReview={onOpenReview} />);

    const queue = screen.getByRole("region", { name: "Worktree review queue" });
    const linkedCard = await within(queue).findByText(/Linked agent task/);
    expect(linkedCard).toBeInTheDocument();
    expect(within(linkedCard.closest("li")!).getByText("1 of 2 viewed")).toBeInTheDocument();
    expect(within(queue).getByText("feature/b")).toBeInTheDocument();
    expect(within(queue).queryByText("feature/c")).not.toBeInTheDocument();
    expect(mocks.compareWorkingTree).toHaveBeenCalledWith("/worktrees/feature-a", "develop");

    fireEvent.click(within(queue).getByRole("button", { name: /changed since review/i }));
    expect(within(queue).getByText("feature/b")).toBeInTheDocument();
    expect(within(queue).getByText("Changed again")).toBeInTheDocument();
    expect(within(queue).queryByText("feature/a")).not.toBeInTheDocument();

    fireEvent.click(within(queue).getByRole("button", { name: /all worktrees/i }));
    expect(within(queue).getByText("Current checkout")).toBeInTheDocument();
    expect(within(queue).getByText("feature/c")).toBeInTheDocument();
    fireEvent.click(within(queue).getByRole("button", { name: "Review feature/a" }));
    expect(onOpenReview).toHaveBeenCalledWith({ repositoryPath: "/worktrees/feature-a", baseBranch: "develop" });
  });

  it("keeps an unavailable worktree visible and retries only that row", async () => {
    mocks.listCardWorktrees.mockResolvedValue([
      { path: "/worktrees/available", branch: "feature/available" },
      { path: "/worktrees/missing", branch: "feature/missing" },
    ]);
    mocks.openRepository.mockImplementation((path: string) => path === "/worktrees/missing"
      ? Promise.reject(new Error("Worktree directory is unavailable"))
      : Promise.resolve(repositoryInfo(path)));

    render(<WorktreeReviewQueue repository={repository} onOpenReview={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Worktree directory is unavailable");
    expect(screen.getByRole("button", { name: "Review feature/available" })).toBeInTheDocument();
    mocks.openRepository.mockImplementation((path: string) => Promise.resolve(repositoryInfo(path)));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Review feature/missing" })).toBeInTheDocument();
    expect(mocks.listCardWorktrees).toHaveBeenCalledTimes(1);
  });

  it("collapses long linked-card history until requested", async () => {
    mocks.listCardWorktrees.mockResolvedValue([{ path: "/worktrees/shared", branch: "feature/shared" }]);
    for (let index = 1; index <= 4; index += 1) {
      const card = createLocalCard({ repositoryPath: repository.path, title: `Linked card ${index}` });
      patchLocalCard(card.id, { workspace: { repositoryPath: repository.path, worktreePath: "/worktrees/shared", branch: "feature/shared", baseBranch: "main" } });
    }

    render(<WorktreeReviewQueue repository={repository} onOpenReview={vi.fn()} />);

    const summary = await screen.findByText("4 linked local cards");
    expect(screen.getByText(/Linked card 4/)).not.toBeVisible();
    fireEvent.click(summary);
    expect(screen.getByText(/Linked card 4/)).toBeVisible();
  });

  it("requires a valid base choice when no stored or suggested base exists", async () => {
    mocks.listCardWorktrees.mockResolvedValue([{ path: "/worktrees/release", branch: "release/work" }]);
    mocks.openRepository.mockResolvedValue({
      ...repositoryInfo("/worktrees/release"),
      branches: [{ name: "release", commit: "a".repeat(40) }],
      suggestedBaseBranch: null,
    });

    render(<WorktreeReviewQueue repository={{ ...repository, suggestedBaseBranch: null }} onOpenReview={vi.fn()} />);

    const picker = await screen.findByRole("combobox", { name: "Base branch for /worktrees/release" });
    expect(mocks.compareWorkingTree).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { value: "release" } });
    expect(await screen.findByRole("button", { name: "Review release/work" })).toBeInTheDocument();
    expect(mocks.compareWorkingTree).toHaveBeenCalledWith("/worktrees/release", "release");
  });

  it("bounds summary work and ignores results from a previous repository", async () => {
    const oldList = deferred<Array<{ path: string; branch: string }>>();
    mocks.listCardWorktrees
      .mockReturnValueOnce(oldList.promise)
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, index) => ({ path: `/new/worktree-${index}`, branch: `new/${index}` })));
    let active = 0;
    let maximum = 0;
    mocks.compareWorkingTree.mockImplementation(async (path: string, base: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return comparison(path, base);
    });
    const view = render(<WorktreeReviewQueue repository={{ ...repository, path: "/old" }} onOpenReview={vi.fn()} />);

    view.rerender(<WorktreeReviewQueue repository={{ ...repository, path: "/new" }} onOpenReview={vi.fn()} />);
    await act(async () => oldList.resolve([{ path: "/old/stale", branch: "old/stale" }]));

    fireEvent.click(await screen.findByRole("button", { name: /all worktrees/i }));
    expect(await screen.findByRole("button", { name: "Review new/5" })).toBeInTheDocument();
    expect(screen.queryByText("old/stale")).not.toBeInTheDocument();
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("retries a failed worktree listing", async () => {
    mocks.listCardWorktrees
      .mockRejectedValueOnce(new Error("Git worktree list failed"))
      .mockResolvedValueOnce([{ path: repository.path, branch: "main" }]);

    render(<WorktreeReviewQueue repository={repository} onOpenReview={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Git worktree list failed");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Review main" })).toBeInTheDocument();
  });
});

function repositoryInfo(path: string): RepositoryInfo {
  return {
    name: "product",
    path,
    branches: [
      { name: "main", commit: "a".repeat(40) },
      { name: "develop", commit: "b".repeat(40) },
    ],
    currentBranch: path === repository.path ? "main" : "feature/work",
    suggestedBaseBranch: "main",
  };
}

function comparison(path: string, baseBranch: string): Comparison {
  return {
    mode: "workingTree",
    revision: path,
    baseBranch,
    compareBranch: path === repository.path ? "main" : "feature/work",
    baseCommit: "a".repeat(40),
    compareCommit: "b".repeat(40),
    mergeBase: "a".repeat(40),
    totalAdditions: 2,
    totalDeletions: 1,
    files: [
      { path: "one.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false, fingerprint: `${path}:one` },
      { path: "two.ts", oldPath: null, status: "added", additions: 1, deletions: 0, binary: false, fingerprint: `${path}:two` },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
