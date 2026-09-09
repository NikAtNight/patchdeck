// Vitest runs in Node, while the production tsconfig intentionally omits Node globals.
// @ts-expect-error Node's built-in module is available to the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync("src/App.css", "utf8");
const workspaceHeader: string = readFileSync("src/components/WorkspaceHeader.tsx", "utf8");
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const tauriDevConfig = JSON.parse(readFileSync("src-tauri/tauri.dev.conf.json", "utf8"));
const tauriCapability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));

function declarations(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return Object.fromEntries((match?.[1] ?? "").split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    }));
}

describe("review layout contract", () => {
  it("uses one sidebar type scale with truncating tree labels", () => {
    const folder = declarations(".tree-folder");
    const file = declarations(".file-name-block strong");
    const label = declarations(".tree-node-label");

    expect(folder["font-size"]).toBeDefined();
    expect(folder["font-size"]).toBe(file["font-size"]);
    expect(label["min-width"]).toBe("0");
    expect(label.overflow).toBe("hidden");
    expect(label["text-overflow"]).toBe("ellipsis");
    expect(label["white-space"]).toBe("nowrap");
  });

  it("aligns the sidebar and diff header rows", () => {
    expect(declarations(".sidebar-view-tabs").height).toBe(declarations(".file-header").height);
    expect(declarations(".files-heading").height).toBe(declarations(".hunk-header").height);
    expect(declarations(".branch-history > header").height).toBe(declarations(".hunk-header").height);
  });

  it("gives top-bar icon buttons balanced padding", () => {
    const button = declarations(".add-tab-button");
    expect(button.padding).toBe("var(--space-control-y) var(--space-control-x)");
    expect(button.width).toBe("32px");
    expect(button.height).toBe("32px");
    expect(button["align-self"]).toBe("center");
    expect(button["margin-bottom"]).toBe("0");
    expect(button.background).toBe("transparent");
    expect(declarations(".add-tab-button svg").width).toBe("16px");
    expect(declarations(".icon-button.header-settings-button").width).toBe("32px");
    expect(declarations(".icon-button.header-settings-button").height).toBe("32px");
    expect(workspaceHeader).toContain("<SettingsIcon />");
  });

  it("starts a native drag from non-interactive header surfaces", () => {
    const header = declarations(".app-header");
    const handle = declarations(".window-drag-handle");

    expect(header.position).toBe("relative");
    expect(handle.position).toBe("absolute");
    expect(handle.top).toBe("0");
    expect(handle.right).toBe("0");
    expect(handle.left).toBe("var(--traffic-light-inset)");
    expect(handle.height).toBe("16px");
    expect(handle["z-index"]).toBe("0");
    expect(declarations(".app-header > :not(.window-drag-handle)")["z-index"]).toBe("1");
    expect(workspaceHeader).toContain('<div className="window-drag-handle" />');
    expect(workspaceHeader).not.toContain("data-tauri-drag-region");
    expect(workspaceHeader).toContain("getCurrentWindow().startDragging()");
    expect(workspaceHeader).toContain("onMouseDown={startHeaderDrag}");
    expect(workspaceHeader).toContain('target.closest(".header-tools, button, input, select, textarea, a, [role=\'tab\']")');
    expect(tauriCapability.permissions).toContain("core:window:allow-start-dragging");
  });

  it("aligns the native macOS window controls with the custom header", () => {
    const mainWindow = tauriConfig.app.windows[0];

    expect(mainWindow.titleBarStyle).toBe("Overlay");
    expect(mainWindow.trafficLightPosition).toEqual({ x: 18, y: 25 });
  });

  it("uses Patchdeck bundle identities for release and development", () => {
    expect(tauriConfig.identifier).toBe("com.local.patchdeck");
    expect(tauriDevConfig.identifier).toBe("com.local.patchdeck.dev");
  });

  it("gives both welcome actions the same dimensions", () => {
    const action = declarations(".welcome-action");

    expect(action.width).toBe("240px");
    expect(action.height).toBe("38px");
    expect(action.padding).toBe("0 16px");
  });

  it("keeps the welcome titlebar outside the scrollable content", () => {
    expect(declarations(".welcome-shell").overflow).toBe("hidden");
    expect(declarations(".welcome-scroll")["overflow-y"]).toBe("auto");
    expect(declarations(".welcome-scroll")["min-height"]).toBe("0");
    expect(declarations(".app-header").flex).toBe("0 0 var(--toolbar-height)");
  });
});
