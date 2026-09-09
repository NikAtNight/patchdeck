import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionProfile } from "../providers/profiles";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const codexProfile: ExecutionProfile = {
  id: "codex-workspace",
  name: "Codex · Workspace Write",
  runtimeId: "codex",
  model: "",
  sandbox: "workspaceWrite",
  instructions: "",
  builtIn: true,
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("local board store", () => {
  it("creates repository-scoped cards and persists them", async () => {
    invoke.mockResolvedValue(null);
    const store = await import("./store");
    await store.initLocalBoardStore();

    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "  Build the board  " });
    expect(card).toMatchObject({ repositoryPath: "/work/product", title: "Build the board", lane: "todo" });
    expect(store.getLocalBoardDocument().cards).toEqual([card]);

    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).toHaveBeenLastCalledWith("save_local_board_store", expect.objectContaining({ content: expect.any(String) }));
  });

  it("keeps runtime conversations separate from cards", async () => {
    invoke.mockResolvedValue(null);
    const store = await import("./store");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Repair CI", executionProfileId: codexProfile.id });

    const run = store.createLocalRun(card.id, "Repair CI\n\nRun the focused tests.", codexProfile);
    store.patchLocalRun(run.id, { sessionId: "thr_123", status: "running" });
    store.appendRunAgentDelta(run.id, "I’ll inspect");
    store.appendRunAgentDelta(run.id, " the failures.");

    expect(store.getLocalBoardDocument().cards[0].executionProfileId).toBe("codex-workspace");
    expect(store.latestRunForCard(card.id)).toMatchObject({
      runtimeId: "codex",
      sessionId: "thr_123",
      status: "running",
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "agent", body: "I’ll inspect the failures." }),
      ],
    });
  });

  it("makes persisted active runs recoverable after an app restart", async () => {
    const persistedBoard = JSON.stringify({
      version: 2,
      updatedAt: 20,
      cards: [
        { id: "card-1", repositoryPath: "/work/product", title: "Running", body: "", lane: "in_progress", executionProfileId: "codex-workspace", hermesHandoffs: [], createdAt: 1, updatedAt: 1 },
        { id: "card-2", repositoryPath: "/work/product", title: "Starting", body: "", lane: "in_progress", executionProfileId: "codex-workspace", hermesHandoffs: [], createdAt: 2, updatedAt: 2 },
      ],
      runs: [
        { id: "run-1", cardId: "card-1", runtimeId: "codex", executionProfileId: "codex-workspace", sessionId: "session-1", model: "", sandbox: "workspaceWrite", instructions: "", status: "running", messages: [], error: null, createdAt: 3, updatedAt: 3 },
        { id: "run-2", cardId: "card-2", runtimeId: "codex", executionProfileId: "codex-workspace", sessionId: null, model: "", sandbox: "workspaceWrite", instructions: "", status: "starting", messages: [], error: null, createdAt: 4, updatedAt: 4 },
      ],
    });
    invoke.mockImplementation((command: string) => Promise.resolve(command === "load_local_board_store" ? persistedBoard : null));
    const store = await import("./store");

    await store.initLocalBoardStore();

    expect(store.getLocalBoardDocument().runs).toEqual([
      expect.objectContaining({
        id: "run-1",
        sessionId: "session-1",
        status: "failed",
        error: "Run interrupted when Patchdeck restarted. Continue or retry it.",
      }),
      expect.objectContaining({
        id: "run-2",
        sessionId: null,
        status: "failed",
        error: "Run interrupted when Patchdeck restarted. Continue or retry it.",
      }),
    ]);
    expect(JSON.parse(localStorage.getItem(store.LOCAL_BOARD_MIRROR_KEY) ?? "{}").runs).toEqual([
      expect.objectContaining({ id: "run-1", status: "failed" }),
      expect.objectContaining({ id: "run-2", status: "failed" }),
    ]);

    await vi.advanceTimersByTimeAsync(300);
    const repairedNativeSnapshot = invoke.mock.calls.find(([command]) => command === "save_local_board_store")?.[1]?.content;
    expect(JSON.parse(repairedNativeSnapshot).runs).toEqual([
      expect.objectContaining({ id: "run-1", status: "failed" }),
      expect.objectContaining({ id: "run-2", status: "failed" }),
    ]);
  });

  it("migrates legacy Codex provider and thread identity without data loss", async () => {
    const store = await import("./store");
    const parsed = store.readLocalBoard(JSON.stringify({
      version: 1,
      updatedAt: 2,
      cards: [
        { id: "card-1", repositoryPath: "/work/product", title: "Good", body: "Keep this", lane: "todo", provider: "codex", createdAt: 1, updatedAt: 1 },
        { id: "bad", title: "Missing fields" },
      ],
      runs: [
        { id: "run-1", cardId: "card-1", provider: "codex", threadId: "thr_legacy", status: "idle", messages: [{ id: "message-1", role: "agent", body: "Preserved", createdAt: 1 }], error: null, createdAt: 1, updatedAt: 1 },
        { id: "run-orphan", cardId: "missing", provider: "codex", threadId: null, status: "idle", messages: [], error: null, createdAt: 1, updatedAt: 1 },
      ],
    }));

    expect(parsed).toMatchObject({
      version: 2,
      cards: [{ id: "card-1", executionProfileId: "codex-workspace", body: "Keep this", hermesHandoffs: [] }],
      runs: [{ id: "run-1", runtimeId: "codex", executionProfileId: "codex-workspace", sessionId: "thr_legacy", messages: [expect.objectContaining({ body: "Preserved" })] }],
    });
    expect(parsed?.cards[0].workspace).toBeUndefined();
    expect(parsed?.runs[0]).toMatchObject({ repositoryPath: null, baseBranch: null });
  });

  it("writes a migrated version back to native and mirror storage", async () => {
    const legacy = JSON.stringify({
      version: 1,
      updatedAt: 2,
      cards: [{ id: "card-1", repositoryPath: "/work/product", title: "Legacy", body: "", lane: "todo", provider: "codex", createdAt: 1, updatedAt: 1 }],
      runs: [],
    });
    invoke.mockImplementation((command: string) => Promise.resolve(command === "load_local_board_store" ? legacy : null));
    const store = await import("./store");

    await store.initLocalBoardStore();
    expect(JSON.parse(localStorage.getItem(store.LOCAL_BOARD_MIRROR_KEY) ?? "{}")).toMatchObject({ version: 2 });
    await vi.advanceTimersByTimeAsync(300);

    const persisted = invoke.mock.calls.find(([command]) => command === "save_local_board_store")?.[1]?.content;
    expect(JSON.parse(persisted)).toMatchObject({ version: 2, cards: [expect.objectContaining({ executionProfileId: "codex-workspace" })] });
  });

  it("repairs native storage when the local mirror is newer", async () => {
    const nativeBoard = JSON.stringify({
      version: 2,
      updatedAt: 10,
      cards: [{ id: "card-1", repositoryPath: "/work/product", title: "Older native copy", body: "", lane: "todo", executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1 }],
      runs: [],
    });
    const mirrorBoard = JSON.stringify({
      version: 2,
      updatedAt: 20,
      cards: [{ id: "card-1", repositoryPath: "/work/product", title: "Newer mirror copy", body: "", lane: "todo", executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 20 }],
      runs: [],
    });
    localStorage.setItem("patchdeck.local-board.v1", mirrorBoard);
    invoke.mockImplementation((command: string) => Promise.resolve(command === "load_local_board_store" ? nativeBoard : null));
    const store = await import("./store");

    await store.initLocalBoardStore();
    expect(store.getLocalBoardDocument().cards[0].title).toBe("Newer mirror copy");

    await vi.advanceTimersByTimeAsync(300);
    const repairedNativeSnapshot = invoke.mock.calls.find(([command]) => command === "save_local_board_store")?.[1]?.content;
    expect(JSON.parse(repairedNativeSnapshot)).toMatchObject({
      version: 2,
      updatedAt: 20,
      cards: [expect.objectContaining({ title: "Newer mirror copy" })],
    });
  });

  it("repairs a stale or missing local mirror when native storage wins", async () => {
    const nativeBoard = JSON.stringify({
      version: 2,
      updatedAt: 20,
      cards: [{ id: "card-1", repositoryPath: "/work/product", title: "Newer native copy", body: "", lane: "todo", executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 20 }],
      runs: [],
    });
    const staleMirror = JSON.stringify({
      version: 2,
      updatedAt: 10,
      cards: [{ id: "card-1", repositoryPath: "/work/product", title: "Older mirror copy", body: "", lane: "todo", executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1 }],
      runs: [],
    });
    localStorage.setItem("patchdeck.local-board.v1", staleMirror);
    invoke.mockImplementation((command: string) => Promise.resolve(command === "load_local_board_store" ? nativeBoard : null));
    const store = await import("./store");

    await store.initLocalBoardStore();

    expect(store.getLocalBoardDocument().cards[0].title).toBe("Newer native copy");
    expect(JSON.parse(localStorage.getItem(store.LOCAL_BOARD_MIRROR_KEY) ?? "{}")).toMatchObject({
      updatedAt: 20,
      cards: [expect.objectContaining({ title: "Newer native copy" })],
    });

    localStorage.removeItem(store.LOCAL_BOARD_MIRROR_KEY);
    await store.initLocalBoardStore();
    expect(JSON.parse(localStorage.getItem(store.LOCAL_BOARD_MIRROR_KEY) ?? "{}")).toMatchObject({
      updatedAt: 20,
      cards: [expect.objectContaining({ title: "Newer native copy" })],
    });
  });

  it("records Hermes handoffs without removing the local card", async () => {
    invoke.mockResolvedValue(null);
    const store = await import("./store");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Keep me local" });

    store.addLocalCardHandoff(card.id, { board: "sxcl", taskId: "task-42" });

    expect(store.getLocalBoardDocument().cards).toHaveLength(1);
    expect(store.getLocalBoardDocument().cards[0].hermesHandoffs).toEqual([
      expect.objectContaining({ board: "sxcl", taskId: "task-42" }),
    ]);
  });
});
