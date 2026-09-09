import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionProfile } from "../providers/profiles";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../providers/api", () => ({
  startAgentRuntime: mocks.start,
  stopAgentRuntime: mocks.stop,
}));

const profile: ExecutionProfile = {
  id: "claude-workspace",
  name: "Claude Code · Workspace Write",
  runtimeId: "claude",
  model: "sonnet",
  sandbox: "workspaceWrite",
  instructions: "Keep changes focused.",
  builtIn: true,
};

describe("local agent runtime routing", () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    mocks.invoke.mockReset().mockResolvedValue(null);
    mocks.start.mockReset().mockResolvedValue({ sessionId: "session-1", turnId: "turn-1" });
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });

  it("persists the selected runtime and resumes its normalized session", async () => {
    const store = await import("./store");
    const runtime = await import("./runtime");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Repair CI" });
    store.patchLocalCard(card.id, { workspace: { repositoryPath: "/work/product", worktreePath: "/worktrees/repair", branch: "work/repair", baseBranch: "main" } });
    const boundCard = store.getLocalBoardDocument().cards[0];

    await runtime.launchLocalCard(boundCard, profile);
    const run = store.latestRunForCard(card.id)!;

    expect(run).toMatchObject({
      runtimeId: "claude",
      executionProfileId: "claude-workspace",
      sessionId: "session-1",
      model: "sonnet",
      sandbox: "workspaceWrite",
    });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: "claude",
      sessionId: null,
      instructions: "Keep changes focused.",
      repositoryPath: "/worktrees/repair",
    }));

    await runtime.continueLocalRun(run, "/different/path", "Continue");
    expect(mocks.start).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-1", repositoryPath: "/worktrees/repair" }));
  });

  it("applies only normalized events owned by the run runtime", async () => {
    const store = await import("./store");
    const runtime = await import("./runtime");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Repair CI" });
    const run = store.createLocalRun(card.id, "Repair CI", profile);

    runtime.applyAgentRuntimeEvent({ runtimeId: "codex", runId: run.id, type: "agentDelta", delta: "wrong owner" });
    runtime.applyAgentRuntimeEvent({ runtimeId: "claude", runId: run.id, type: "agentDelta", delta: "Inspecting failures." });
    runtime.applyAgentRuntimeEvent({ runtimeId: "claude", runId: run.id, type: "activity", message: "Ran tests" });
    runtime.applyAgentRuntimeEvent({ runtimeId: "claude", runId: run.id, type: "completed", status: "completed" });

    expect(store.latestRunForCard(card.id)).toMatchObject({
      status: "idle",
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "agent", body: "Inspecting failures." }),
        expect.objectContaining({ role: "activity", body: "Ran tests" }),
      ],
    });
    expect(store.getLocalBoardDocument().cards[0].lane).toBe("review");
  });

  it("keeps failed and cancelled work out of Done", async () => {
    const store = await import("./store");
    const runtime = await import("./runtime");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Fail safely", lane: "in_progress" });
    const failed = store.createLocalRun(card.id, "Fail safely", profile, "/worktrees/fail", "main");
    runtime.applyAgentRuntimeEvent({ runtimeId: "claude", runId: failed.id, type: "completed", status: "failed", message: "Tests failed" });
    expect(store.getLocalBoardDocument().cards[0].lane).toBe("in_progress");
    expect(store.latestRunForCard(card.id)).toMatchObject({ status: "failed", error: "Tests failed" });
  });

  it("keeps a stopped run cancelled when its pending start later rejects", async () => {
    const pendingStart = rejectable<{ sessionId: string; turnId: string | null }>();
    mocks.start.mockReturnValue(pendingStart.promise);
    const store = await import("./store");
    const runtime = await import("./runtime");
    await store.initLocalBoardStore();
    const card = store.createLocalCard({ repositoryPath: "/work/product", title: "Cancel startup" });
    store.patchLocalCard(card.id, { workspace: { repositoryPath: "/work/product", worktreePath: "/worktrees/cancel", branch: "work/cancel", baseBranch: "main" } });
    const boundCard = store.getLocalBoardDocument().cards[0];

    const launch = runtime.launchLocalCard(boundCard, profile);
    const run = store.latestRunForCard(card.id)!;
    await runtime.stopLocalRun(run);

    expect(store.latestRunForCard(card.id)).toMatchObject({ status: "cancelled", error: null });

    pendingStart.reject(new Error("start aborted after stop"));
    await launch;
    expect(store.latestRunForCard(card.id)).toMatchObject({ status: "cancelled", error: null });
  });
});

function rejectable<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_, promiseReject) => {
    reject = promiseReject;
  });
  return { promise, reject };
}
