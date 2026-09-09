import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesSessionController } from "../hermes/types";
import { getExecutionProfileDocument, resetExecutionProfiles } from "../providers/profiles";
import type { AgentRuntimeStatus } from "../providers/types";
import { SettingsPanel } from "./SettingsPanel";
import { setAppearancePreference } from "../appearance";

const providerMocks = vi.hoisted(() => ({
  listAgentRuntimes: vi.fn(),
  connectAgentRuntime: vi.fn(),
  disconnectAgentRuntime: vi.fn(),
}));

vi.mock("../providers/api", () => providerMocks);

const codex: AgentRuntimeStatus = {
  id: "codex",
  label: "Codex",
  installed: true,
  authenticated: true,
  ready: true,
  version: "codex-cli 0.147.0",
  path: "/usr/local/bin/codex",
  authMode: "ChatGPT",
  accountLabel: "Developer account",
  error: null,
};

const claude: AgentRuntimeStatus = {
  id: "claude",
  label: "Claude Code",
  installed: true,
  authenticated: false,
  ready: false,
  version: "2.1.233",
  path: "/usr/local/bin/claude",
  authMode: null,
  accountLabel: null,
  error: null,
};

describe("SettingsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    setAppearancePreference("system");
    resetExecutionProfiles();
    providerMocks.listAgentRuntimes.mockReset();
    providerMocks.connectAgentRuntime.mockReset();
    providerMocks.disconnectAgentRuntime.mockReset();
    providerMocks.listAgentRuntimes.mockResolvedValue([codex, claude]);
  });

  afterEach(cleanup);

  it("shows coding agents separately from Hermes and updates provider connections", async () => {
    const hermes = disconnectedHermes();
    providerMocks.connectAgentRuntime.mockResolvedValue({
      status: { ...claude, authenticated: true, ready: true, authMode: "claude.ai", accountLabel: "Claude account" },
      message: "Claude Code connected.",
    });

    render(<SettingsPanel open onClose={vi.fn()} repositoryPath="/work/example" hermes={hermes} />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Coding agents")).toBeInTheDocument();
    expect(screen.getByText("Orchestrators")).toBeInTheDocument();
    const codexCard = screen.getByRole("article", { name: "Codex" });
    expect(await within(codexCard).findByText("codex-cli 0.147.0")).toBeInTheDocument();
    expect(within(codexCard).getByText("Developer account")).toBeInTheDocument();

    const claudeCard = screen.getByRole("article", { name: "Claude Code" });
    fireEvent.click(within(claudeCard).getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Claude Code connected.")).toBeInTheDocument();
    expect(within(claudeCard).getByText("Claude account")).toBeInTheDocument();
    expect(providerMocks.connectAgentRuntime).toHaveBeenCalledWith("claude");

    fireEvent.click(screen.getByRole("button", { name: "Use running Hermes" }));
    expect(hermes.connectDiscovered).toHaveBeenCalledTimes(1);
  });

  it("opens Agent Board help without Hermes and links to provider and profile settings", async () => {
    const hermes = disconnectedHermes();
    render(<SettingsPanel open onClose={vi.fn()} repositoryPath={null} hermes={hermes} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("heading", { name: "Use the Agent Board without Hermes" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Providers" }));
    expect(screen.getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("article", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Claude Code" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Execution Profiles" }));
    expect(screen.getByRole("button", { name: "Execution Profiles" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Default execution profile")).toBeDisabled();
    expect(providerMocks.connectAgentRuntime).not.toHaveBeenCalled();
    expect(hermes.connectDiscovered).not.toHaveBeenCalled();
    expect(hermes.connectManaged).not.toHaveBeenCalled();
    expect(hermes.connectExisting).not.toHaveBeenCalled();
  });

  it("creates, selects, edits, and deletes a repository execution profile", async () => {
    render(<SettingsPanel open onClose={vi.fn()} repositoryPath="/work/example" hermes={disconnectedHermes()} />);
    fireEvent.click(screen.getByRole("button", { name: "Execution Profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Claude careful" } });
    fireEvent.change(screen.getByLabelText("Coding agent"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Sandbox"), { target: { value: "readOnly" } });
    fireEvent.change(screen.getByLabelText(/Model override/), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByLabelText(/Standing instructions/), { target: { value: "Inspect first." } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Profile saved")).toBeInTheDocument();
    const profile = getExecutionProfileDocument().profiles.find((candidate) => candidate.name === "Claude careful");
    expect(profile).toMatchObject({ runtimeId: "claude", sandbox: "readOnly", model: "sonnet", instructions: "Inspect first.", builtIn: false });

    fireEvent.change(screen.getByLabelText("Default execution profile"), { target: { value: profile?.id } });
    expect(getExecutionProfileDocument().defaultsByRepository["/work/example"]).toBe(profile?.id);

    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Claude audit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(getExecutionProfileDocument().profiles.find((candidate) => candidate.id === profile?.id)?.name).toBe("Claude audit");

    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(getExecutionProfileDocument().profiles.some((candidate) => candidate.id === profile?.id)).toBe(false));
    expect(getExecutionProfileDocument().defaultsByRepository["/work/example"]).toBeUndefined();
  });

  it("keeps built-in profiles read-only but deletable and closes with Escape", () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} repositoryPath={null} hermes={disconnectedHermes()} />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
    focusable[0].focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(focusable[focusable.length - 1]).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(focusable[0]).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Execution Profiles" }));

    expect(screen.getByLabelText("Profile name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(screen.getByLabelText("Default execution profile")).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies an appearance choice and remembers it when Settings is reopened", () => {
    const props = { open: true, onClose: vi.fn(), repositoryPath: null, hermes: disconnectedHermes() };
    const { rerender } = render(<SettingsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("radio", { name: /System/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(localStorage.getItem("patchdeck.appearance")).toBe("dark");

    rerender(<SettingsPanel {...props} open={false} />);
    rerender(<SettingsPanel {...props} />);
    expect(screen.getByRole("radio", { name: /Dark/ })).toBeChecked();
  });

  it("contains programmatic focus and restores the trigger after closing", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const props = { open: true, onClose: vi.fn(), repositoryPath: null, hermes: disconnectedHermes() };
    const { rerender } = render(<SettingsPanel {...props} />);
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();
    trigger.focus();
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();

    rerender(<SettingsPanel {...props} open={false} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

function disconnectedHermes(): HermesSessionController {
  return {
    status: {
      state: "disconnected",
      mode: null,
      url: null,
      version: null,
      activeWorkers: 0,
      error: null,
    },
    connectDiscovered: vi.fn().mockResolvedValue(true),
    connectManaged: vi.fn().mockResolvedValue(true),
    connectExisting: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}
