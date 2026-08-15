import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdater } from "./AppUpdater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  isTauri: vi.fn(() => true),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));

function availableUpdate(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.6.0",
    currentVersion: "0.5.0",
    body: "A safer, faster release.",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("AppUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri.mockReturnValue(true);
  });

  it("stays hidden when there is no update", async () => {
    mocks.check.mockResolvedValue(null);
    render(<AppUpdater />);
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith({ timeout: 15_000 }));
    expect(screen.queryByLabelText("Patchdeck update available")).not.toBeInTheDocument();
  });

  it("installs an available update and restarts the app", async () => {
    const update = availableUpdate();
    mocks.check.mockResolvedValue(update);
    render(<AppUpdater />);

    expect(await screen.findByText("Patchdeck 0.6.0 is ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("keeps the prompt open when installation fails", async () => {
    const update = availableUpdate({ downloadAndInstall: vi.fn().mockRejectedValue(new Error("signature rejected")) });
    mocks.check.mockResolvedValue(update);
    render(<AppUpdater />);

    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Update failed: signature rejected");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
