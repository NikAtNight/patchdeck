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

  it("excludes archived local cards from repository and All Work projections", () => {
    const active = {
      id: "active", repositoryPath: "/work/product", title: "Active", body: "", lane: "todo" as const,
      executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1,
    };
    const archived = { ...active, id: "archived", title: "Archived", archivedAt: 2 };

    expect(normalizeRepositoryWork("/work/product", [active, archived], [], {}).map((item) => item.id)).toEqual(["active"]);
    expect(normalizeFederatedWork(null, [active, archived], [], {}).map((item) => item.id)).toEqual(["active"]);
    expect(normalizeFederatedWork(null, [active, archived], [], {}, { filter: "archived" }).map((item) => item.id)).toEqual(["archived"]);
  });

  it("filters attention, active, and completed work without treating archive as complete", () => {
    const local = [
      localCard("todo", "todo"),
      localCard("review", "review"),
      localCard("done", "done"),
      { ...localCard("archived", "done"), archivedAt: 2 },
    ];
    const board = {
      sxcl: {
        columns: [
          { name: "blocked", tasks: [{ id: "blocked", title: "Blocked", status: "blocked" }] },
          { name: "running", tasks: [{ id: "running", title: "Running", status: "running" }] },
          { name: "done", tasks: [{ id: "hermes-done", title: "Done", status: "done" }] },
          { name: "archived", tasks: [{ id: "hermes-archived", title: "Archived", status: "archived" }] },
        ],
        tenants: [], assignees: [], latest_event_id: 1, now: 1,
      },
    };
    const metadata = [{ slug: "sxcl", name: "SXCL" }];

    expect(normalizeFederatedWork(null, local, metadata, board, { filter: "attention" }).map((item) => item.id)).toEqual(["review", "blocked"]);
    expect(normalizeFederatedWork(null, local, metadata, board, { filter: "active" }).map((item) => item.id)).toEqual(["running"]);
    expect(normalizeFederatedWork(null, local, metadata, board, { filter: "completed" }).map((item) => item.id)).toEqual(["done", "hermes-done"]);
    expect(normalizeFederatedWork(null, local, metadata, board, { filter: "archived" }).map((item) => item.id)).toEqual(["archived", "hermes-archived"]);
  });

  it("includes Hermes tasks bound to a known worktree in repository scope", () => {
    const task = { id: "worktree-task", title: "Worktree", status: "running", workspace_path: "/worktrees/product-card" };
    const items = normalizeFederatedWork(
      "/work/product",
      [],
      [{ slug: "sxcl", name: "SXCL" }],
      { sxcl: { columns: [{ name: "running", tasks: [task] }], tenants: [], assignees: [], latest_event_id: 1, now: 1 } },
      { repositoryPaths: ["/work/product", "/worktrees/product-card"] },
    );

    expect(items).toEqual([expect.objectContaining({ id: "worktree-task", task })]);
  });
});

function localCard(id: string, lane: "todo" | "in_progress" | "review" | "done") {
  return {
    id, repositoryPath: "/work/product", title: id, body: "", lane,
    executionProfileId: null, hermesHandoffs: [], createdAt: 1, updatedAt: 1,
  };
}
