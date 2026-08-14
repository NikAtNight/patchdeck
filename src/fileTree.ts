import type { ChangedFile } from "./types";

export type FileTreeNode = FileTreeFolder | FileTreeLeaf;

export interface FileTreeFolder {
  kind: "folder";
  name: string;
  path: string;
  changedFileCount: number;
  children: FileTreeNode[];
}

export interface FileTreeLeaf {
  kind: "file";
  name: string;
  path: string;
  file: ChangedFile;
}

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: FileTreeLeaf[];
}

export function buildFileTree(files: ChangedFile[]): FileTreeNode[] {
  const root: MutableFolder = { name: "", path: "", folders: new Map(), files: [] };

  for (const file of files) {
    const segments = file.path.split("/");
    const filename = segments.pop() || file.path;
    let folder = root;

    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let child = folder.folders.get(segment);
      if (!child) {
        child = { name: segment, path, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }

    folder.files.push({ kind: "file", name: filename, path: file.path, file });
  }

  return finalizeChildren(root);
}

export function folderPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      paths.push(node.path, ...folderPaths(node.children));
    }
  }
  return paths;
}

function finalizeChildren(folder: MutableFolder): FileTreeNode[] {
  const folders: FileTreeFolder[] = [...folder.folders.values()]
    .sort((left, right) => naturalCompare(left.name, right.name))
    .map((child) => {
      const children = finalizeChildren(child);
      return {
        kind: "folder",
        name: child.name,
        path: child.path,
        changedFileCount: countFiles(children),
        children,
      };
    });
  const files = [...folder.files].sort((left, right) => naturalCompare(left.name, right.name));
  return [...folders, ...files];
}

function countFiles(nodes: FileTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === "file" ? 1 : node.changedFileCount),
    0,
  );
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
