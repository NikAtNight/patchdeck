import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const commentsKey = "branch-diff-viewer.inline-review-comments.v1";
const targetKey = "branch-diff-viewer.review-target.v1";
const reviewedFilesKey = "branch-diff-viewer.reviewed-files.v1";
const mirrorKey = "branch-diff-viewer.review-store.v1";

const target = {
  board: "product",
  taskId: "task-1",
  title: "Review me",
  status: "review",
  repositoryPath: "/work/product",
};
const comment = {
  id: "review-1",
  repositoryPath: "/work/product",
  board: "product",
  taskId: "task-1",
  baseCommit: "aaa",
  compareCommit: "bbb",
  path: "src/example.ts",
  side: "new" as const,
  line: 12,
  context: "return true",
  contextFingerprint: "fingerprint",
  body: "Add a test for this branch.",
  author: "human-review",
  state: "open" as const,
  createdAt: 1,
  updatedAt: 1,
  sentAt: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function loadReviewModules() {
  const [store, comments, reviewedFiles] = await Promise.all([
    import("./reviewStore"),
    import("./inlineComments"),
    import("./reviewedFiles"),
  ]);
  return { ...store, ...comments, ...reviewedFiles };
}

describe("review store", () => {
  it("serializes native saves and persists the latest snapshot", async () => {
    const pendingSaves: Array<{
      content: string;
      resolve: () => void;
    }> = [];
    invoke.mockImplementation((command: string, args?: { content: string }) => {
      if (command === "load_review_store") return Promise.resolve(null);
      return new Promise<void>((resolve) => {
        pendingSaves.push({ content: args?.content ?? "", resolve });
      });
    });

    const store = await loadReviewModules();
    await store.initReviewStore();

    store.writeStoredReviewTarget(target.repositoryPath, { ...target, title: "First title" });
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingSaves).toHaveLength(1);

    store.writeStoredReviewTarget(target.repositoryPath, { ...target, title: "Final title" });
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingSaves).toHaveLength(1);

    pendingSaves[0].resolve();
    await vi.waitFor(() => expect(pendingSaves).toHaveLength(2));
    expect(JSON.parse(pendingSaves[1].content).reviewTargets[target.repositoryPath]).toEqual({
      ...target,
      title: "Final title",
    });
  });

  it("falls back to legacy local storage when invoke fails", async () => {
    localStorage.setItem(commentsKey, JSON.stringify([comment]));
    localStorage.setItem(targetKey, JSON.stringify(target));
    localStorage.setItem(reviewedFilesKey, JSON.stringify({ '["/work/product","aaa","bbb"]': ["src/example.ts"] }));
    invoke.mockRejectedValue(new Error("Tauri is unavailable"));

    const store = await loadReviewModules();
    await store.initReviewStore();

    expect(store.readInlineComments()).toEqual([comment]);
    expect(store.readStoredReviewTarget(target.repositoryPath)).toEqual(target);
    expect(store.readReviewedPaths("/work/product", "aaa", "bbb")).toEqual(new Set(["src/example.ts"]));
  });

  it("migrates legacy values when the backend store is empty", async () => {
    localStorage.setItem(commentsKey, JSON.stringify([comment]));
    localStorage.setItem(targetKey, JSON.stringify(target));
    invoke.mockResolvedValue(null);

    const store = await loadReviewModules();
    await store.initReviewStore();
    await vi.advanceTimersByTimeAsync(300);

    expect(store.readInlineComments()).toEqual([comment]);
    expect(invoke).toHaveBeenLastCalledWith("save_review_store", expect.anything());
    expect(JSON.parse(lastSavedContent())).toMatchObject({
      version: 2,
      inlineComments: [comment],
      reviewTargets: { [target.repositoryPath]: target },
      reviewedFiles: {},
    });
  });

  it("keeps synchronous reads consistent with writes", async () => {
    invoke.mockResolvedValue(JSON.stringify({ version: 2, updatedAt: 0, inlineComments: [], reviewTargets: {}, reviewedFiles: {} }));
    const store = await loadReviewModules();
    await store.initReviewStore();

    store.writeInlineComments([comment]);
    store.writeStoredReviewTarget(target.repositoryPath, target);
    store.writeReviewedPaths("/work/product", "aaa", "bbb", new Set(["src/b.ts", "src/a.ts"]));

    expect(store.readInlineComments()).toEqual([comment]);
    expect(store.readStoredReviewTarget(target.repositoryPath)).toEqual(target);
    expect(store.readReviewedPaths("/work/product", "aaa", "bbb")).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    expect(JSON.parse(localStorage.getItem(commentsKey) ?? "")).toEqual([comment]);
    expect(localStorage.getItem(targetKey)).toBeNull();
    expect(JSON.parse(localStorage.getItem(mirrorKey) ?? "").reviewTargets).toEqual({
      [target.repositoryPath]: target,
    });
  });

  it("debounces durable persistence", async () => {
    invoke.mockResolvedValue(null);
    const store = await loadReviewModules();
    await store.initReviewStore();

    store.writeStoredReviewTarget(target.repositoryPath, { ...target, title: "First title" });
    store.writeStoredReviewTarget(target.repositoryPath, { ...target, title: "Final title" });
    await vi.advanceTimersByTimeAsync(299);
    expect(invoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(JSON.parse(lastSavedContent())).toMatchObject({
      version: 2,
      inlineComments: [],
      reviewTargets: { [target.repositoryPath]: { ...target, title: "Final title" } },
      reviewedFiles: {},
    });
  });

  it("keeps review targets independent by repository", async () => {
    invoke.mockResolvedValue(null);
    const store = await loadReviewModules();
    await store.initReviewStore();
    const otherTarget = {
      ...target,
      taskId: "task-2",
      title: "Other repository",
      repositoryPath: "/work/other",
    };

    store.writeStoredReviewTarget(target.repositoryPath, target);
    store.writeStoredReviewTarget(otherTarget.repositoryPath, otherTarget);

    expect(store.readStoredReviewTarget(target.repositoryPath)).toEqual(target);
    expect(store.readStoredReviewTarget(otherTarget.repositoryPath)).toEqual(otherTarget);
  });

  it("migrates a version 1 target using its repository path", async () => {
    invoke.mockResolvedValue(JSON.stringify({
      version: 1,
      updatedAt: 10,
      inlineComments: [],
      reviewTarget: target,
      reviewedFiles: {},
    }));
    const store = await loadReviewModules();

    await store.initReviewStore();

    expect(store.readStoredReviewTarget(target.repositoryPath)).toEqual(target);
  });

  it("normalizes legacy inline comments instead of dropping their new metadata", async () => {
    const {
      contextFingerprint: _contextFingerprint,
      author: _author,
      state: _state,
      updatedAt: _updatedAt,
      ...legacyComment
    } = comment;
    invoke.mockResolvedValue(JSON.stringify({
      version: 1,
      updatedAt: 10,
      inlineComments: [legacyComment],
      reviewTarget: target,
      reviewedFiles: {},
    }));
    const store = await loadReviewModules();

    await store.initReviewStore();

    expect(store.readStoredInlineComments()).toEqual([{
      ...legacyComment,
      contextFingerprint: `legacy:${legacyComment.context}`,
      author: "human-review",
      state: "open",
      updatedAt: legacyComment.createdAt,
    }]);
  });

  it("reports oversized UTF-8 unsent content without dropping it", async () => {
    invoke.mockResolvedValue(null);
    const store = await loadReviewModules();
    await store.initReviewStore();
    const oversized = { ...comment, body: "😀".repeat(1_200_000) };

    store.writeStoredInlineComments([oversized]);

    await expect(store.flushReviewStore()).rejects.toThrow("unsent comments remain");
    expect(store.readStoredInlineComments()).toEqual([oversized]);
    expect(store.readReviewStorePersistenceError()?.message).toContain("native persistence limit");
    expect(invoke.mock.calls.filter(([command]) => command === "save_review_store")).toHaveLength(0);
  });
});

function lastSavedContent(): string {
  const saves = invoke.mock.calls.filter(([command]) => command === "save_review_store");
  const call = saves[saves.length - 1];
  if (!call) throw new Error("save_review_store was never invoked");
  return (call[1] as { content: string }).content;
}
