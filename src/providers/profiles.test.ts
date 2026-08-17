import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteExecutionProfile,
  EXECUTION_PROFILES_KEY,
  executionProfileForRepository,
  getExecutionProfileDocument,
  resetExecutionProfiles,
  saveExecutionProfile,
  setRepositoryExecutionProfile,
} from "./profiles";

beforeEach(() => {
  localStorage.clear();
  resetExecutionProfiles();
});

describe("execution profiles", () => {
  it("provides safe built-in runtime profiles", () => {
    expect(getExecutionProfileDocument().profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-workspace", runtimeId: "codex", sandbox: "workspaceWrite" }),
      expect.objectContaining({ id: "codex-review", runtimeId: "codex", sandbox: "readOnly" }),
      expect.objectContaining({ id: "claude-workspace", runtimeId: "claude", sandbox: "workspaceWrite" }),
    ]));
  });

  it("stores a repository default without deleting built-in profiles", () => {
    const profile = saveExecutionProfile({
      name: "Claude review",
      runtimeId: "claude",
      model: "sonnet",
      sandbox: "readOnly",
      instructions: "Inspect only.",
    });
    setRepositoryExecutionProfile("/work/product", profile.id);

    expect(executionProfileForRepository("/work/product")).toEqual(profile);
    deleteExecutionProfile(profile.id);
    expect(executionProfileForRepository("/work/product")?.id).toBe("codex-workspace");
  });

  it("keeps built-in profiles canonical when persisted data is stale or tampered with", () => {
    localStorage.setItem(EXECUTION_PROFILES_KEY, JSON.stringify({
      version: 1,
      profiles: [
        { id: "codex-workspace", name: "Replaced", runtimeId: "claude", model: "unsafe", sandbox: "readOnly", instructions: "Changed", builtIn: true },
        { id: "custom", name: "Custom", runtimeId: "claude", model: "", sandbox: "workspaceWrite", instructions: "", builtIn: true },
      ],
      defaultsByRepository: { "/work/product": "missing", "/work/valid": "custom" },
    }));

    resetExecutionProfiles();

    expect(getExecutionProfileDocument().profiles.find((profile) => profile.id === "codex-workspace")).toMatchObject({
      name: "Codex · Workspace Write",
      runtimeId: "codex",
      sandbox: "workspaceWrite",
      builtIn: true,
    });
    expect(getExecutionProfileDocument().profiles.find((profile) => profile.id === "custom")?.builtIn).toBe(false);
    expect(getExecutionProfileDocument().defaultsByRepository).toEqual({ "/work/valid": "custom" });
  });

  it("does not edit a built-in profile through the storage API", () => {
    const profile = saveExecutionProfile({
      id: "codex-workspace",
      name: "Changed",
      runtimeId: "claude",
      model: "sonnet",
      sandbox: "readOnly",
      instructions: "Changed",
    });

    expect(profile).toMatchObject({ name: "Codex · Workspace Write", runtimeId: "codex", builtIn: true });
  });

  it("allows a built-in profile to be deleted and keeps it deleted after reload", () => {
    setRepositoryExecutionProfile("/work/product", "codex-workspace");

    deleteExecutionProfile("codex-workspace");
    resetExecutionProfiles();

    expect(getExecutionProfileDocument().profiles.some((profile) => profile.id === "codex-workspace")).toBe(false);
    expect(getExecutionProfileDocument().defaultsByRepository["/work/product"]).toBeUndefined();
  });
});
