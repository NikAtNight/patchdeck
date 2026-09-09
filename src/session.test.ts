import { beforeEach, describe, expect, it, vi } from "vitest";
import { initSessionStore, readAppSurface, readProjectSession, readProjectView, readRecentRepositories } from "./session";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const prePatchdeckPrefix = ["branch", "diff", "viewer"].join("-");

describe("Patchdeck session storage", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset().mockResolvedValue({});
  });

  it("moves pre-Patchdeck session values into the Patchdeck namespace", () => {
    localStorage.setItem(`${prePatchdeckPrefix}.recent-repositories`, JSON.stringify(["/work/product"]));
    localStorage.setItem(`${prePatchdeckPrefix}.active-surface`, "agent");
    localStorage.setItem(`${prePatchdeckPrefix}.project-views.v1`, JSON.stringify({
      "/work/product": { baseBranch: "main", compareBranch: "feature", selectedPath: "src/App.tsx" },
    }));
    localStorage.setItem(`${prePatchdeckPrefix}.session`, JSON.stringify({
      version: 1,
      tabs: [{ name: "product", path: "/work/product", openMode: "repository" }],
      activePath: "/work/product",
    }));

    expect(readRecentRepositories()).toEqual(["/work/product"]);
    expect(readAppSurface()).toBe("agent");
    expect(readProjectView("/work/product")).toEqual({ baseBranch: "main", compareBranch: "feature", selectedPath: "src/App.tsx" });
    expect(readProjectSession().tabs).toHaveLength(1);
    expect(localStorage.getItem("patchdeck.session")).not.toBeNull();
    expect(localStorage.getItem(`${prePatchdeckPrefix}.session`)).toBeNull();
  });

  it("imports known values supplied by the previous native WebKit container", async () => {
    invoke.mockResolvedValue({
      "patchdeck.recent-repositories": JSON.stringify(["/work/native"]),
      "patchdeck.active-surface": "agent",
      "unrelated.secret": "ignored",
    });

    await initSessionStore();

    expect(readRecentRepositories()).toEqual(["/work/native"]);
    expect(readAppSurface()).toBe("agent");
    expect(localStorage.getItem("unrelated.secret")).toBeNull();
  });
});
