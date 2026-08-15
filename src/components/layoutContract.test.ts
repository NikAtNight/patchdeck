// Vitest runs in Node, while the production tsconfig intentionally omits Node globals.
// @ts-expect-error Node's built-in module is available to the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync("src/App.css", "utf8");

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
    expect(button.width).toBe("30px");
    expect(button.height).toBe("30px");
    expect(button["align-self"]).toBe("flex-end");
    expect(button["margin-bottom"]).toBe("6px");
    expect(button.background).toBe("transparent");
    expect(declarations(".add-tab-button svg").width).toBe("16px");
  });
});
