import { describe, expect, it } from "vitest";
import { buildFileTree, folderPaths } from "./fileTree";
import type { ChangedFile } from "./types";

describe("buildFileTree", () => {
  it("groups changed files into a naturally sorted folder hierarchy", () => {
    const tree = buildFileTree([
      changedFile("src/views/Page10.tsx"),
      changedFile("README.md"),
      changedFile("src/api/client.ts"),
      changedFile("src/views/Page2.tsx"),
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0]).toMatchObject({ kind: "folder", path: "src", changedFileCount: 3 });
    if (tree[0].kind !== "folder") throw new Error("Expected src folder");
    expect(tree[0].children.map((node) => node.name)).toEqual(["api", "views"]);
    const views = tree[0].children[1];
    if (views.kind !== "folder") throw new Error("Expected views folder");
    expect(views.children.map((node) => node.name)).toEqual(["Page2.tsx", "Page10.tsx"]);
  });

  it("returns every expandable folder path", () => {
    const tree = buildFileTree([
      changedFile("src/features/diff/view.tsx"),
      changedFile("src/features/tabs/state.ts"),
    ]);

    expect(folderPaths(tree)).toEqual(["src", "src/features", "src/features/diff", "src/features/tabs"]);
  });

  it("keeps root files as leaves", () => {
    const [node] = buildFileTree([changedFile("package.json")]);
    expect(node).toMatchObject({ kind: "file", name: "package.json", path: "package.json" });
  });

  it("represents a file-to-folder transition without merging the two paths", () => {
    const tree = buildFileTree([changedFile("config"), changedFile("config/app.json")]);

    expect(tree).toHaveLength(2);
    expect(tree.map((node) => [node.kind, node.path])).toEqual([
      ["folder", "config"],
      ["file", "config"],
    ]);
  });
});

function changedFile(path: string): ChangedFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
  };
}
