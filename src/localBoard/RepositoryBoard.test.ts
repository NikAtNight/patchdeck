import { describe, expect, it } from "vitest";
import { normalizeFederatedWork, normalizeRepositoryWork } from "./RepositoryBoard";

describe("repository board projection", () => {
  it("normalizes display lanes without changing source ownership", () => {
    const local = {
      id: "local-1", repositoryPath: "/work/product", title: "Local", body: "", lane: "review" as const,
      executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1,
    };
    const items = normalizeRepositoryWork(
      "/work/product/",
      [local],
      [{ slug: "sxcl", name: "SXCL" }],
      {
        sxcl: {
          columns: [{ name: "blocked", tasks: [{ id: "h-1", title: "Hermes", status: "blocked", workspace_path: "/work/product" }] }],
          tenants: [], assignees: [], latest_event_id: 1, now: 1,
        },
      },
    );

    expect(items).toEqual([
      expect.objectContaining({ source: "local", lane: "review", sourceStatus: "review", card: local }),
      expect.objectContaining({ source: "hermes", lane: "in_progress", sourceStatus: "blocked", board: expect.objectContaining({ slug: "sxcl" }), task: expect.objectContaining({ id: "h-1" }) }),
    ]);
  });

  it("includes every source record in All Work without copying ownership", () => {
    const local = {
      id: "local-other", repositoryPath: "/work/other", title: "Other local", body: "", lane: "todo" as const,
      executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1,
    };
    const task = { id: "h-other", title: "Other Hermes", status: "ready", workspace_path: "/hermes/other" };
    const items = normalizeFederatedWork(
      null,
      [local],
      [{ slug: "olive", name: "Olive" }],
      { olive: { columns: [{ name: "ready", tasks: [task] }], tenants: [], assignees: [], latest_event_id: 1, now: 1 } },
    );

    expect(items).toEqual([
      expect.objectContaining({ source: "local", card: local }),
      expect.objectContaining({ source: "hermes", task, board: expect.objectContaining({ slug: "olive" }) }),
    ]);
  });
});
