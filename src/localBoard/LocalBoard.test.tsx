import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBoard } from "./LocalBoard";
import { resetExecutionProfiles } from "../providers/profiles";
import { createLocalCard, resetLocalBoardStore } from "./store";
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
    mocks.invoke.mockReset().mockResolvedValue(null);
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
      repositoryPath: "/work/product",
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
});
