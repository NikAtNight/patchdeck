import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { FileTreeNode } from "../fileTree";
import { ChevronIcon, FolderIcon } from "./icons";
import { accessibleFileLabel, FileCounts, StatusBadge } from "./ui";

export function FileTree({
  nodes,
  collapsedFolders,
  selectedPath,
  viewedPaths,
  focusKey,
  onFocus,
  onSelect,
  onToggle,
}: {
  nodes: FileTreeNode[];
  collapsedFolders: Set<string>;
  selectedPath: string | null;
  viewedPaths: ReadonlySet<string>;
  focusKey: string | null;
  onFocus: (key: string) => void;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <div
      className="file-tree"
      role="tree"
      aria-label="Changed files"
      onKeyDown={(event) => handleTreeNavigation(event, onFocus)}
    >
      {nodes.map((node) => (
        <FileTreeItem
          key={treeNodeKey(node)}
          node={node}
          depth={0}
          collapsedFolders={collapsedFolders}
          selectedPath={selectedPath}
          viewedPaths={viewedPaths}
          focusKey={focusKey}
          onFocus={onFocus}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

export function treeNodeKey(node: FileTreeNode) {
  return `${node.kind}:${node.path}`;
}

export function collectVisibleTreeKeys(nodes: FileTreeNode[], collapsedFolders: Set<string>): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    keys.push(treeNodeKey(node));
    if (node.kind === "folder" && !collapsedFolders.has(node.path)) {
      keys.push(...collectVisibleTreeKeys(node.children, collapsedFolders));
    }
  }
  return keys;
}

// File paths in sidebar display order, ignoring collapse state.
export function flattenTreeFiles(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") paths.push(...flattenTreeFiles(node.children));
    else paths.push(node.file.path);
  }
  return paths;
}

export function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) return nodes;

  const filtered: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.file.path.toLocaleLowerCase().includes(normalizedQuery)) filtered.push(node);
      continue;
    }

    const children = filterTree(node.children, normalizedQuery);
    if (children.length === 0) continue;
    filtered.push({
      ...node,
      changedFileCount: flattenTreeFiles(children).length,
      children,
    });
  }
  return filtered;
}

// Vertical indent guides marking each ancestor level, aligned to the chevron
// column so consecutive rows join into continuous lines.
function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="tree-guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, level) => (
        <i key={level} style={{ left: `${16 + level * 15}px` }} />
      ))}
    </span>
  );
}

function FileTreeItem({
  node,
  depth,
  collapsedFolders,
  selectedPath,
  viewedPaths,
  focusKey,
  onFocus,
  onSelect,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  collapsedFolders: Set<string>;
  selectedPath: string | null;
  viewedPaths: ReadonlySet<string>;
  focusKey: string | null;
  onFocus: (key: string) => void;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const nodeKey = treeNodeKey(node);

  if (node.kind === "folder") {
    const collapsed = collapsedFolders.has(node.path);
    return (
      <div
        className="tree-branch"
        role="treeitem"
        data-tree-key={nodeKey}
        tabIndex={focusKey === nodeKey ? 0 : -1}
        aria-expanded={!collapsed}
        aria-label={`${node.path}, ${node.changedFileCount} changed ${node.changedFileCount === 1 ? "file" : "files"}`}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocus(nodeKey);
        }}
        onClick={(event) => handleFolderClick(event, nodeKey, node.path, onFocus, onToggle)}
        onKeyDown={(event) => handleFolderKeyDown(event, collapsed, nodeKey, node.path, onFocus, onToggle)}
        title={node.path}
      >
        <div className="tree-folder" style={{ paddingLeft: `${9 + depth * 15}px` }}>
          <IndentGuides depth={depth} />
          <span className={`tree-chevron${collapsed ? " collapsed" : ""}`}><ChevronIcon /></span>
          <FolderIcon />
          <span>{node.name}</span>
          <span className="tree-count">{node.changedFileCount}</span>
        </div>
        {!collapsed && (
          <div role="group">
            {node.children.map((child) => (
              <FileTreeItem
                key={treeNodeKey(child)}
                node={child}
                depth={depth + 1}
                collapsedFolders={collapsedFolders}
                selectedPath={selectedPath}
                viewedPaths={viewedPaths}
                focusKey={focusKey}
                onFocus={onFocus}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const file = node.file;
  return (
    <button
      className={`file-item tree-file${file.path === selectedPath ? " selected" : ""}${viewedPaths.has(file.path) ? " viewed" : ""}`}
      style={{ paddingLeft: `${14 + depth * 15}px` }}
      onClick={() => {
        onFocus(nodeKey);
        onSelect(file.path);
      }}
      role="treeitem"
      data-tree-key={nodeKey}
      tabIndex={focusKey === nodeKey ? 0 : -1}
      aria-selected={file.path === selectedPath}
      aria-label={accessibleFileLabel(file)}
      onFocus={() => onFocus(nodeKey)}
      title={file.path}
    >
      <IndentGuides depth={depth} />
      <StatusBadge status={file.status} compact />
      <span className="file-name-block">
        <strong>{node.name}</strong>
      </span>
      <span className="file-meta">
        <FileCounts file={file} compact />
        {viewedPaths.has(file.path) && <span className="viewed-mark" aria-hidden="true">✓</span>}
      </span>
    </button>
  );
}

function handleTreeNavigation(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onFocus: (key: string) => void,
) {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!target || !event.currentTarget.contains(target)) return;

  if (event.key === "ArrowLeft" && target.getAttribute("aria-expanded") === null) {
    const parent = target.parentElement?.closest<HTMLElement>('[role="treeitem"]');
    if (parent) {
      event.preventDefault();
      focusTreeItem(parent, onFocus);
    }
    return;
  }

  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = items.indexOf(target);
  if (index < 0 || items.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? Math.min(index + 1, items.length - 1)
        : Math.max(index - 1, 0);
  focusTreeItem(items[nextIndex], onFocus);
}

function handleFolderClick(
  event: ReactMouseEvent<HTMLDivElement>,
  nodeKey: string,
  path: string,
  onFocus: (key: string) => void,
  onToggle: (path: string) => void,
) {
  const clickedItem = (event.target as HTMLElement).closest('[role="treeitem"]');
  if (clickedItem !== event.currentTarget) return;
  event.currentTarget.focus();
  onFocus(nodeKey);
  onToggle(path);
}

function handleFolderKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  collapsed: boolean,
  nodeKey: string,
  path: string,
  onFocus: (key: string) => void,
  onToggle: (path: string) => void,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onToggle(path);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    if (collapsed) {
      onToggle(path);
    } else {
      const firstChild = event.currentTarget.querySelector<HTMLElement>(':scope > [role="group"] > [role="treeitem"]');
      if (firstChild) focusTreeItem(firstChild, onFocus);
    }
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (!collapsed) {
      onToggle(path);
    } else {
      const parent = event.currentTarget.parentElement?.closest<HTMLElement>('[role="treeitem"]');
      if (parent) focusTreeItem(parent, onFocus);
    }
    return;
  }
  onFocus(nodeKey);
}

function focusTreeItem(element: HTMLElement, onFocus: (key: string) => void) {
  const key = element.dataset.treeKey;
  if (key) onFocus(key);
  element.focus();
}
