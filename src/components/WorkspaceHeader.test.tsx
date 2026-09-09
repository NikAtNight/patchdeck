import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "./WorkspaceHeader";

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHeader() {
  return render(<WorkspaceHeader tabs={[]} activeTabId={null} opening={false}
    onOpenRepository={vi.fn()} onOpenWorkspace={vi.fn()} onActivate={vi.fn()}
    onClose={vi.fn()} activeSurface="review" onSurfaceChange={vi.fn()} onOpenSettings={vi.fn()} />);
}

describe("welcome window dragging", () => {
  it("drags from the empty titlebar and its app title", () => {
    renderHeader();
    fireEvent.mouseDown(screen.getByRole("banner"), { button: 0 });
    fireEvent.mouseDown(screen.getByText("Patchdeck"), { button: 0 });
    expect(startDragging).toHaveBeenCalledTimes(2);
  });

  it("does not drag when pressing Settings or the secondary mouse button", () => {
    renderHeader();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Settings" }).querySelector("svg")!, { button: 0 });
    fireEvent.mouseDown(screen.getByRole("banner"), { button: 2 });
    expect(startDragging).not.toHaveBeenCalled();
  });
});
