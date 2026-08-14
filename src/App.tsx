import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  compareBranches,
  loadFileDiff,
  openRepository,
  openWorkspace,
  openWorkspaceProject,
} from "./api";
import { buildFileTree } from "./fileTree";
import type { FileTreeNode } from "./fileTree";
import type {
  ChangedFile,
  Comparison,
  DiffLineKind,
  FileDiff,
  FileStatus,
  RepositoryInfo,
  WorkspaceProject,
} from "./types";
import "./App.css";

const RECENT_REPOSITORIES_KEY = "branch-diff-viewer.recent-repositories";
const PROJECT_SESSION_KEY = "branch-diff-viewer.session";
const FILE_STATUS_LABELS: Record<FileStatus, [string, string]> = {
  added: ["A", "Added"],
  modified: ["M", "Modified"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  type_changed: ["T", "Type changed"],
  unmerged: ["U", "Unmerged"],
  unknown: ["?", "Changed"],
};

function App() {
  const initialSession = useMemo(readProjectSession, []);
  const [tabs, setTabs] = useState<ProjectTab[]>(initialSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialSession.activeTabId);
  const [recentRepositories, setRecentRepositories] = useState<string[]>(readRecentRepositories);
  const [openingProject, setOpeningProject] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [workspaceAnnouncement, setWorkspaceAnnouncement] = useState("");
  const openRequest = useRef(0);
  const nextTabId = useRef(initialSession.nextTabId);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    if (!tab || tab.repository || tab.loading || tab.error) return;

    const tabId = tab.id;
    setTabs((current) => current.map((candidate) =>
      candidate.id === tabId ? { ...candidate, loading: true } : candidate
    ));
    const open = tab.openMode === "workspace" ? openWorkspaceProject : openRepository;
    open(tab.path)
      .then((repository) => {
        setTabs((current) => current.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, name: repository.name, path: repository.path, repository, loading: false, error: null }
            : candidate
        ));
      })
      .catch((reason: unknown) => {
        setTabs((current) => current.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, loading: false, error: errorMessage(reason) }
            : candidate
        ));
      });
  }, [activeTabId, tabs]);

  useEffect(() => {
    persistProjectSession(tabs, activeTabId);
  }, [activeTabId, tabs]);

  async function chooseRepository() {
    const path = await openDialog({ directory: true, multiple: false, title: "Open Git repository" });
    if (typeof path === "string") await openProject(path);
  }

  async function chooseWorkspace() {
    const path = await openDialog({ directory: true, multiple: false, title: "Open workspace folder" });
    if (typeof path === "string") await openWorkspaceProjects(path);
  }

  async function openProject(path: string) {
    const request = ++openRequest.current;
    setOpeningProject(true);
    setOpenError(null);
    try {
      const repository = await openRepository(path);
      if (request !== openRequest.current) return;
      openRepositoryTabs([repository]);
      rememberRepository(repository.path);
    } catch (reason) {
      if (request === openRequest.current) setOpenError(errorMessage(reason));
    } finally {
      if (request === openRequest.current) setOpeningProject(false);
    }
  }

  async function openWorkspaceProjects(path: string) {
    const request = ++openRequest.current;
    setOpeningProject(true);
    setOpenError(null);
    try {
      const projects = await openWorkspace(path);
      if (request !== openRequest.current) return;
      if (projects.length === 0) {
        throw new Error("No Git repositories were found in the workspace's immediate child folders.");
      }
      const firstTabId = openWorkspaceTabs(projects);
      setWorkspaceAnnouncement(`${projects.length} ${projects.length === 1 ? "project" : "projects"} opened from the workspace.`);
      focusTabAfterRender(firstTabId);
    } catch (reason) {
      if (request === openRequest.current) setOpenError(errorMessage(reason));
    } finally {
      if (request === openRequest.current) setOpeningProject(false);
    }
  }

  function openRepositoryTabs(repositories: RepositoryInfo[]) {
    const nextTabs = [...tabsRef.current];
    let firstTabId: string | null = null;

    for (const repository of repositories) {
      const existingIndex = nextTabs.findIndex((candidate) => candidate.path === repository.path);
      let tab = existingIndex >= 0 ? nextTabs[existingIndex] : undefined;
      if (!tab) {
        tab = {
          id: `project-${nextTabId.current++}`,
          name: repository.name,
          path: repository.path,
          repository,
          openMode: "repository",
          loading: false,
          error: null,
        };
        nextTabs.push(tab);
      } else if (!tab.repository) {
        tab = {
          ...tab,
          name: repository.name,
          path: repository.path,
          repository,
          openMode: "repository",
          loading: false,
          error: null,
        };
        nextTabs[existingIndex] = tab;
      }
      firstTabId ??= tab.id;
    }

    if (firstTabId) {
      setTabs(nextTabs);
      setActiveTabId(firstTabId);
      focusTabAfterRender(firstTabId);
    }
  }

  function openWorkspaceTabs(projects: WorkspaceProject[]) {
    const nextTabs = [...tabsRef.current];
    let firstTabId: string | null = null;

    for (const project of projects) {
      let tab = nextTabs.find((candidate) => candidate.path === project.path);
      if (!tab) {
        tab = {
          id: `project-${nextTabId.current++}`,
          name: project.name,
          path: project.path,
          repository: null,
          openMode: "workspace",
          loading: false,
          error: null,
        };
        nextTabs.push(tab);
      }
      firstTabId ??= tab.id;
    }

    if (firstTabId) {
      setTabs(nextTabs);
      setActiveTabId(firstTabId);
    }
    return firstTabId;
  }

  function focusTabAfterRender(id: string | null) {
    if (!id) return;
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="${id}-panel"]`)?.focus();
    }, 0);
  }

  function rememberRepository(path: string) {
    setRecentRepositories((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 5);
      localStorage.setItem(RECENT_REPOSITORIES_KEY, JSON.stringify(next));
      return next;
    });
  }

  function closeTab(id: string) {
    const closingIndex = tabs.findIndex((tab) => tab.id === id);
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs);
    if (activeTabId === id) {
      setActiveTabId(nextTabs[Math.min(closingIndex, nextTabs.length - 1)]?.id ?? null);
    }
  }

  function updateTabRepository(id: string, repository: RepositoryInfo) {
    setTabs((current) => current.map((tab) => tab.id === id
      ? { ...tab, name: repository.name, path: repository.path, repository }
      : tab
    ));
  }

  function retryTab(id: string) {
    setTabs((current) => current.map((tab) => tab.id === id
      ? { ...tab, loading: false, error: null }
      : tab
    ));
  }

  return (
    <div className={tabs.length === 0 ? "welcome-shell" : "app-shell"}>
      <WorkspaceHeader
        tabs={tabs}
        activeTabId={activeTabId}
        opening={openingProject}
        onActivate={setActiveTabId}
        onClose={closeTab}
        onOpenRepository={chooseRepository}
        onOpenWorkspace={chooseWorkspace}
      />
      <div className="sr-only" aria-live="polite">{workspaceAnnouncement}</div>

      {tabs.length === 0 ? (
        <>
          <main className="welcome">
            <div className="welcome-mark" aria-hidden="true"><BranchIcon /></div>
            <p className="eyebrow">LOCAL BRANCH REVIEW</p>
            <h1>See the whole change<br />before the pull request.</h1>
            <p className="welcome-copy">
              Compare any two local branches, scan every changed path, and review the exact diff.
              Nothing gets edited. Nothing leaves your machine.
            </p>
            <div className="welcome-actions">
              <button className="primary-button welcome-action" onClick={chooseRepository} disabled={openingProject}>
                <FolderIcon /> {openingProject ? "Opening…" : "Open a repository"}
              </button>
              <button className="secondary-button welcome-action" onClick={chooseWorkspace} disabled={openingProject}>
                <WorkspaceIcon /> Open a workspace
              </button>
            </div>
            <p className="shortcut-hint">Open one Git repository or a parent folder containing repositories</p>

            {recentRepositories.length > 0 && (
              <section className="recent" aria-labelledby="recent-heading">
                <div className="section-heading">
                  <h2 id="recent-heading">Recent repositories</h2>
                  <span>Stored on this Mac</span>
                </div>
                <div className="recent-list">
                  {recentRepositories.map((path) => (
                    <button key={path} className="recent-item" onClick={() => openProject(path)}>
                      <span className="recent-icon"><RepositoryIcon /></span>
                      <span className="recent-copy">
                        <strong>{basename(path)}</strong>
                        <span>{path}</span>
                      </span>
                      <ChevronIcon />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {openError && <ErrorBanner message={openError} />}
          </main>
          <footer className="welcome-footer"><LockIcon /> Read-only by design · No network access</footer>
        </>
      ) : (
        <div className="project-stack">
          {tabs.map((tab) => (
            tab.repository ? (
              <ProjectPane
                key={tab.id}
                id={tab.id}
                active={tab.id === activeTabId}
                initialRepository={tab.repository}
                onRepositoryUpdated={(repository) => updateTabRepository(tab.id, repository)}
              />
            ) : (
              <ProjectLoadingPane
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onRetry={() => retryTab(tab.id)}
              />
            )
          ))}
          {openError && <div className="workspace-error global"><ErrorBanner message={openError} /></div>}
        </div>
      )}
    </div>
  );
}

interface ProjectTab {
  id: string;
  name: string;
  path: string;
  repository: RepositoryInfo | null;
  openMode: "repository" | "workspace";
  loading: boolean;
  error: string | null;
}

function ProjectLoadingPane({
  tab,
  active,
  onRetry,
}: {
  tab: ProjectTab;
  active: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      id={`${tab.id}-panel`}
      className="project-pane project-loading-pane"
      role="tabpanel"
      hidden={!active}
      aria-hidden={!active}
    >
      {tab.error ? (
        <div className="project-loading-card">
          <AlertIcon />
          <h2>Could not open {tab.name}</h2>
          <p>{tab.error}</p>
          <button className="secondary-button" onClick={onRetry}>Try again</button>
        </div>
      ) : (
        <div className="project-loading-card" aria-live="polite">
          <Spinner />
          <h2>Opening {tab.name}…</h2>
          <p>Reading local branches from {tab.path}</p>
        </div>
      )}
    </section>
  );
}

function ProjectPane({
  id,
  active,
  initialRepository,
  onRepositoryUpdated,
}: {
  id: string;
  active: boolean;
  initialRepository: RepositoryInfo;
  onRepositoryUpdated: (repository: RepositoryInfo) => void;
}) {
  const initialBranches = defaultBranches(initialRepository);
  const [repository, setRepository] = useState(initialRepository);
  const [baseBranch, setBaseBranch] = useState(initialBranches.base);
  const [compareBranch, setCompareBranch] = useState(initialBranches.compare);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, string>>({});
  const [loadingRepository, setLoadingRepository] = useState(false);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [treeFocusKey, setTreeFocusKey] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const [hasActivated, setHasActivated] = useState(active);
  const comparisonRequest = useRef(0);
  const diffRequest = useRef(0);
  const repositoryRequest = useRef(0);
  const controlId = useId();

  const selectedFile = useMemo(
    () => comparison?.files.find((file) => file.path === selectedPath) ?? null,
    [comparison, selectedPath],
  );
  const selectedDiff = selectedFile && comparison
    ? diffs[diffCacheKey(comparison, selectedFile.path)]
    : undefined;
  const fileTree = useMemo(() => buildFileTree(comparison?.files ?? []), [comparison]);
  const visibleTreeKeys = useMemo(
    () => collectVisibleTreeKeys(fileTree, collapsedFolders),
    [fileTree, collapsedFolders],
  );
  const effectiveTreeFocusKey = treeFocusKey && visibleTreeKeys.includes(treeFocusKey)
    ? treeFocusKey
    : selectedPath && visibleTreeKeys.includes(`file:${selectedPath}`)
      ? `file:${selectedPath}`
      : visibleTreeKeys[0] ?? null;

  useEffect(() => {
    if (active) setHasActivated(true);
  }, [active]);

  useEffect(() => {
    if (!hasActivated || !baseBranch || !compareBranch) {
      return;
    }

    const request = ++comparisonRequest.current;
    setLoadingComparison(true);
    setError(null);
    compareBranches(repository.path, baseBranch, compareBranch)
      .then((nextComparison) => {
        if (request !== comparisonRequest.current) return;
        setComparison(nextComparison);
        setTreeFocusKey(null);
        setSelectedPath((current) =>
          current && nextComparison.files.some((file) => file.path === current)
            ? current
            : nextComparison.files[0]?.path ?? null,
        );
      })
      .catch((reason: unknown) => {
        if (request !== comparisonRequest.current) return;
        setComparison(null);
        setSelectedPath(null);
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (request === comparisonRequest.current) setLoadingComparison(false);
      });
  }, [hasActivated, repository, baseBranch, compareBranch]);

  useEffect(() => {
    if (!comparison || !selectedFile || selectedFile.binary) {
      setLoadingDiff(false);
      return;
    }
    const key = diffCacheKey(comparison, selectedFile.path);
    if (diffs[key]) {
      setLoadingDiff(false);
      return;
    }
    if (diffErrors[key]) {
      setLoadingDiff(false);
      return;
    }

    const request = ++diffRequest.current;
    setLoadingDiff(true);
    loadFileDiff({
      repositoryPath: repository.path,
      mergeBase: comparison.mergeBase,
      compareCommit: comparison.compareCommit,
      path: selectedFile.path,
      oldPath: selectedFile.oldPath,
    })
      .then((diff) => {
        if (request !== diffRequest.current) return;
        setDiffs((current) => ({ ...current, [key]: diff }));
      })
      .catch((reason: unknown) => {
        if (request !== diffRequest.current) return;
        setDiffErrors((current) => ({ ...current, [key]: errorMessage(reason) }));
      })
      .finally(() => {
        if (request === diffRequest.current) setLoadingDiff(false);
      });
  }, [repository, comparison, selectedFile, diffs, diffErrors]);

  async function refresh() {
    const request = ++repositoryRequest.current;
    comparisonRequest.current += 1;
    diffRequest.current += 1;
    setLoadingComparison(false);
    setLoadingDiff(false);
    setLoadingRepository(true);
    setError(null);
    try {
      const info = await openRepository(repository.path);
      if (request !== repositoryRequest.current) return;
      const branchNames = info.branches.map((branch) => branch.name);
      const missingBranches = [baseBranch, compareBranch]
        .filter((branch) => branch && !branchNames.includes(branch));
      const nextCompare = branchNames.includes(compareBranch) ? compareBranch : "";
      const nextBase = branchNames.includes(baseBranch) ? baseBranch : "";

      setRepository(info);
      onRepositoryUpdated(info);
      setCompareBranch(nextCompare);
      setBaseBranch(nextBase);
      setComparison(null);
      setDiffs({});
      setDiffErrors({});
      setSelectedPath(null);
      if (missingBranches.length > 0) {
        setError(`Local branch ${missingBranches.map((branch) => `'${branch}'`).join(" and ")} no longer exists. Choose another branch to continue.`);
      }
    } catch (reason) {
      if (request !== repositoryRequest.current) return;
      setError(errorMessage(reason));
    } finally {
      if (request === repositoryRequest.current) setLoadingRepository(false);
    }
  }

  function swapBranches() {
    setBaseBranch(compareBranch);
    setCompareBranch(baseBranch);
  }

  function retrySelectedDiff() {
    if (!comparison || !selectedFile) return;
    const key = diffCacheKey(comparison, selectedFile.path);
    setDiffErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function toggleFolder(path: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <section id={`${id}-panel`} className="project-pane" role="tabpanel" hidden={!active} aria-hidden={!active}>
      <section className="compare-bar" aria-label="Branch comparison controls">
        <div className="branch-field">
          <label htmlFor={`${controlId}-base`}>Base</label>
          <select id={`${controlId}-base`} value={baseBranch} disabled={repository.branches.length === 0} onChange={(event) => setBaseBranch(event.target.value)}>
            {repository.branches.length === 0 && <option value="">No branches</option>}
            {repository.branches.length > 0 && !baseBranch && <option value="">Select a branch</option>}
            {repository.branches.map((branch) => <option key={branch.name}>{branch.name}</option>)}
          </select>
        </div>
        <button className="swap-button" onClick={swapBranches} aria-label="Swap base and compare branches">
          <SwapIcon />
        </button>
        <div className="branch-field">
          <label htmlFor={`${controlId}-compare`}>Compare</label>
          <select id={`${controlId}-compare`} value={compareBranch} disabled={repository.branches.length === 0} onChange={(event) => setCompareBranch(event.target.value)}>
            {repository.branches.length === 0 && <option value="">No branches</option>}
            {repository.branches.length > 0 && !compareBranch && <option value="">Select a branch</option>}
            {repository.branches.map((branch) => <option key={branch.name}>{branch.name}</option>)}
          </select>
        </div>
        <div className="comparison-summary" aria-live="polite">
          {repository.branches.length === 0 ? (
            <span>No local branches</span>
          ) : loadingComparison ? (
            <span className="loading-label"><Spinner /> Comparing branches…</span>
          ) : comparison ? (
            <>
              <strong>{comparison.files.length}</strong>
              <span>{comparison.files.length === 1 ? "file changed" : "files changed"}</span>
              <span className="summary-divider" />
              <span className="additions">+{comparison.totalAdditions}</span>
              <span className="deletions">−{comparison.totalDeletions}</span>
            </>
          ) : (
            <span>Comparison unavailable</span>
          )}
        </div>
        <button className="icon-button" onClick={refresh} disabled={loadingRepository || loadingComparison} aria-label="Refresh comparison" title="Refresh comparison">
          <RefreshIcon />
        </button>
        <span className="readonly-badge"><LockIcon /> Read-only</span>
      </section>

      {error && <div className="workspace-error"><ErrorBanner message={error} /></div>}

      <main className="workspace">
        <aside className="files-panel" aria-label="Changed files">
          <div className="files-heading">
            <span>Changed files</span>
            <span className="count-badge">{comparison?.files.length ?? 0}</span>
          </div>
          {loadingComparison ? (
            <FileListSkeleton />
          ) : comparison?.files.length ? (
            <div
              className="file-tree"
              role="tree"
              aria-label="Changed files"
              onKeyDown={(event) => handleTreeNavigation(event, setTreeFocusKey)}
            >
              {fileTree.map((node) => (
                <FileTreeItem
                  key={treeNodeKey(node)}
                  node={node}
                  depth={0}
                  collapsedFolders={collapsedFolders}
                  selectedPath={selectedPath}
                  focusKey={effectiveTreeFocusKey}
                  onFocus={setTreeFocusKey}
                  onSelect={setSelectedPath}
                  onToggle={toggleFolder}
                />
              ))}
            </div>
          ) : comparison ? (
            <div className="sidebar-empty"><CheckIcon /> No changed files</div>
          ) : (
            <div className="sidebar-empty"><AlertIcon /> Comparison unavailable</div>
          )}
        </aside>

        <section className="diff-panel" aria-label="File diff">
          {loadingComparison ? (
            <DiffSkeleton />
          ) : repository.branches.length === 0 ? (
            <NoBranches />
          ) : !comparison ? (
            <ComparisonUnavailable />
          ) : comparison && comparison.files.length === 0 ? (
            <EmptyComparison base={baseBranch} compare={compareBranch} />
          ) : selectedFile ? (
            <DiffView
              key={`${comparison.mergeBase}:${comparison.compareCommit}:${selectedFile.path}`}
              file={selectedFile}
              diff={selectedDiff}
              error={diffErrors[diffCacheKey(comparison, selectedFile.path)]}
              loading={loadingDiff}
              wrapLines={wrapLines}
              onToggleWrap={() => setWrapLines((current) => !current)}
              onRetry={retrySelectedDiff}
            />
          ) : (
            <div className="blank-diff">Select a file to review its changes.</div>
          )}
        </section>
      </main>
    </section>
  );
}

function WorkspaceHeader({
  tabs,
  activeTabId,
  onOpenRepository,
  onOpenWorkspace,
  opening,
  onActivate,
  onClose,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  onOpenRepository: () => void;
  onOpenWorkspace: () => void;
  opening: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <header className="app-header">
      {tabs.length > 0 && (
        <div className="project-tabs" role="tablist" aria-label="Open projects">
          {tabs.map((tab, index) => (
            <div className={`project-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id} title={tab.path}>
              <button
                className="project-tab-select"
                role="tab"
                aria-selected={tab.id === activeTabId}
                aria-controls={`${tab.id}-panel`}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => handleTabNavigation(event, index)}
              >
                <RepositoryIcon />
                <span>{tab.name}</span>
              </button>
              <button
                className="project-tab-close"
                onClick={() => closeTabAndRestoreFocus(index, onClose, tab.id)}
                aria-label={`Close ${tab.name}`}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
          <button className="add-tab-button" onClick={onOpenRepository} disabled={opening} aria-label="Open another project" title="Open another project">
            {opening ? <Spinner /> : <PlusIcon />}
          </button>
          <button className="add-tab-button" onClick={onOpenWorkspace} disabled={opening} aria-label="Open workspace" title="Open workspace">
            <WorkspaceIcon />
          </button>
        </div>
      )}
      {tabs.length === 0 && (
        <div className="header-actions">
          <button className="secondary-button header-open" onClick={onOpenRepository} disabled={opening}>
            <FolderIcon /> Open repository
          </button>
          <button className="secondary-button" onClick={onOpenWorkspace} disabled={opening}>
            <WorkspaceIcon /> Open workspace
          </button>
        </div>
      )}
    </header>
  );
}

function handleTabNavigation(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabList = event.currentTarget.closest('[role="tablist"]');
  const tabs = [...(tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
  if (tabs.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

function closeTabAndRestoreFocus(
  index: number,
  onClose: (id: string) => void,
  id: string,
) {
  onClose(id);
  window.setTimeout(() => {
    const remainingTabs = [...document.querySelectorAll<HTMLButtonElement>('.project-tabs [role="tab"]')];
    if (remainingTabs.length > 0) {
      remainingTabs[Math.min(index, remainingTabs.length - 1)].focus();
    } else {
      document.querySelector<HTMLButtonElement>(".header-open")?.focus();
    }
  }, 0);
}

function FileTreeItem({
  node,
  depth,
  collapsedFolders,
  selectedPath,
  focusKey,
  onFocus,
  onSelect,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  collapsedFolders: Set<string>;
  selectedPath: string | null;
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
      className={`file-item tree-file${file.path === selectedPath ? " selected" : ""}`}
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
      <StatusBadge status={file.status} compact />
      <span className="file-name-block">
        <strong>{node.name}</strong>
      </span>
      <FileCounts file={file} compact />
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

function treeNodeKey(node: FileTreeNode) {
  return `${node.kind}:${node.path}`;
}

function collectVisibleTreeKeys(nodes: FileTreeNode[], collapsedFolders: Set<string>): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    keys.push(treeNodeKey(node));
    if (node.kind === "folder" && !collapsedFolders.has(node.path)) {
      keys.push(...collectVisibleTreeKeys(node.children, collapsedFolders));
    }
  }
  return keys;
}

function accessibleFileLabel(file: ChangedFile) {
  const status = FILE_STATUS_LABELS[file.status][1];
  if (file.binary || file.additions === null || file.deletions === null) {
    return `${file.path}, ${status}, binary file`;
  }
  return `${file.path}, ${status}, ${file.additions} additions, ${file.deletions} deletions`;
}

function DiffView({
  file,
  diff,
  error,
  loading,
  wrapLines,
  onToggleWrap,
  onRetry,
}: {
  file: ChangedFile;
  diff?: FileDiff;
  error?: string;
  loading: boolean;
  wrapLines: boolean;
  onToggleWrap: () => void;
  onRetry: () => void;
}) {
  return (
    <div className={`diff-view${wrapLines ? " wrap-lines" : " no-wrap-lines"}`}>
      <header className="file-header">
        <div className="file-title-row">
          <StatusBadge status={file.status} />
          <div className="file-title">
            <div>{file.path}</div>
            {file.oldPath && <span>renamed from {file.oldPath}</span>}
          </div>
        </div>
        <div className="file-header-actions">
          <FileCounts file={file} />
          <button
            className={`wrap-toggle${wrapLines ? " active" : ""}`}
            type="button"
            aria-pressed={wrapLines}
            aria-label={wrapLines ? "Disable line wrapping" : "Enable line wrapping"}
            title={wrapLines ? "Show long lines with horizontal scrolling" : "Wrap long lines to the available width"}
            onClick={onToggleWrap}
          >
            <WrapIcon />
            <span>Wrap</span>
          </button>
        </div>
      </header>

      {file.binary || diff?.binary ? (
        <div className="diff-message"><BinaryIcon /><h2>Binary file</h2><p>This file changed, but it cannot be displayed as text.</p></div>
      ) : error ? (
        <div className="diff-message error-state"><AlertIcon /><h2>Could not load this diff</h2><p>{error}</p><button className="secondary-button" onClick={onRetry}>Try again</button></div>
      ) : loading || !diff ? (
        <DiffSkeleton embedded />
      ) : diff.tooLarge ? (
        <div className="diff-message"><LargeFileIcon /><h2>Diff too large to display</h2><p>The file is listed in the comparison, but its patch exceeds the 5 MB rendering limit.</p></div>
      ) : diff.hunks.length === 0 ? (
        <div className="diff-message"><CheckIcon /><h2>No textual changes</h2><p>Git did not return any text hunks for this file.</p></div>
      ) : (
        <div className="diff-scroll">
          {diff.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="hunk-header"><span>•••</span>{hunk.header}</div>
              <div className="diff-lines">
                {hunk.lines.map((line, lineIndex) => (
                  <div className={`diff-line ${line.kind}`} key={`${hunkIndex}-${lineIndex}`}>
                    <span className="line-number" aria-label={line.oldLine ? `Old line ${line.oldLine}` : undefined}>{line.oldLine ?? ""}</span>
                    <span className="line-number" aria-label={line.newLine ? `New line ${line.newLine}` : undefined}>{line.newLine ?? ""}</span>
                    <span className="line-marker" aria-hidden="true">{lineMarker(line.kind)}</span>
                    <code>{line.content || " "}</code>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileCounts({ file, compact = false }: { file: ChangedFile; compact?: boolean }) {
  if (file.binary || file.additions === null || file.deletions === null) {
    return <span className={`binary-label${compact ? " compact" : ""}`}>BIN</span>;
  }
  return (
    <span className={`file-counts${compact ? " compact" : ""}`} aria-label={`${file.additions} additions and ${file.deletions} deletions`}>
      <span className="additions">+{file.additions}</span>
      <span className="deletions">−{file.deletions}</span>
    </span>
  );
}

function StatusBadge({ status, compact = false }: { status: FileStatus; compact?: boolean }) {
  const [short, label] = FILE_STATUS_LABELS[status];
  return <span className={`status-badge ${status}${compact ? " compact" : ""}`} title={label}>{short}{!compact && <span>{label}</span>}</span>;
}

function EmptyComparison({ base, compare }: { base: string; compare: string }) {
  return (
    <div className="empty-comparison">
      <div className="empty-orbit"><CheckIcon /></div>
      <p className="eyebrow">ALL CLEAR</p>
      <h2>No changes between these branches</h2>
      <p><code>{compare}</code> has no committed changes relative to the merge base with <code>{base}</code>.</p>
    </div>
  );
}

function NoBranches() {
  return (
    <div className="empty-comparison">
      <div className="empty-orbit muted"><BranchIcon /></div>
      <p className="eyebrow">NO COMMITTED BRANCHES</p>
      <h2>There is nothing to compare yet</h2>
      <p>Create the repository's first commit outside this viewer, then refresh to load its branches.</p>
    </div>
  );
}

function ComparisonUnavailable() {
  return (
    <div className="empty-comparison unavailable">
      <div className="empty-orbit muted"><AlertIcon /></div>
      <p className="eyebrow">COMPARISON UNAVAILABLE</p>
      <h2>Choose two available branches</h2>
      <p>Review the message above, select valid local branches, or refresh the repository.</p>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner" role="alert"><AlertIcon /><span>{message}</span></div>;
}

function FileListSkeleton() {
  return <div className="file-list skeleton-list">{Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><i /><span /></div>)}</div>;
}

function DiffSkeleton({ embedded = false }: { embedded?: boolean }) {
  return <div className={`diff-skeleton${embedded ? " embedded" : ""}`}><div className="skeleton-title" />{Array.from({ length: 12 }, (_, index) => <div className="skeleton-code" style={{ width: `${48 + (index * 17) % 44}%` }} key={index} />)}</div>;
}

function Spinner() { return <span className="spinner" aria-hidden="true" />; }

function basename(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}

function defaultBranches(repository: RepositoryInfo) {
  const branchNames = repository.branches.map((branch) => branch.name);
  const compare = repository.currentBranch ?? branchNames[0] ?? "";
  const base = repository.suggestedBaseBranch
    ?? branchNames.find((branch) => branch !== compare)
    ?? compare;
  return { base, compare };
}

function diffCacheKey(comparison: Comparison, path: string) {
  return `${comparison.mergeBase}:${comparison.compareCommit}:${path}`;
}

function readRecentRepositories(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_REPOSITORIES_KEY) ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function readProjectSession(): {
  tabs: ProjectTab[];
  activeTabId: string | null;
  nextTabId: number;
} {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROJECT_SESSION_KEY) ?? "null");
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tabs)) {
      return { tabs: [], activeTabId: null, nextTabId: 1 };
    }

    const seenPaths = new Set<string>();
    const tabs: ProjectTab[] = [];
    for (const candidate of value.tabs.slice(0, 50)) {
      if (
        !isRecord(candidate)
        || typeof candidate.name !== "string"
        || typeof candidate.path !== "string"
        || (candidate.openMode !== "repository" && candidate.openMode !== "workspace")
        || seenPaths.has(candidate.path)
      ) {
        continue;
      }
      seenPaths.add(candidate.path);
      tabs.push({
        id: `project-${tabs.length + 1}`,
        name: candidate.name,
        path: candidate.path,
        repository: null,
        openMode: candidate.openMode,
        loading: false,
        error: null,
      });
    }

    const activePath = typeof value.activePath === "string" ? value.activePath : null;
    const activeTabId = tabs.find((tab) => tab.path === activePath)?.id ?? tabs[0]?.id ?? null;
    return { tabs, activeTabId, nextTabId: tabs.length + 1 };
  } catch {
    return { tabs: [], activeTabId: null, nextTabId: 1 };
  }
}

function persistProjectSession(tabs: ProjectTab[], activeTabId: string | null) {
  try {
    if (tabs.length === 0) {
      localStorage.removeItem(PROJECT_SESSION_KEY);
      return;
    }
    localStorage.setItem(PROJECT_SESSION_KEY, JSON.stringify({
      version: 1,
      tabs: tabs.map(({ name, path, openMode }) => ({ name, path, openMode })),
      activePath: tabs.find((tab) => tab.id === activeTabId)?.path ?? tabs[0].path,
    }));
  } catch {
    // Storage can be unavailable; the current in-memory session still works normally.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function lineMarker(kind: DiffLineKind) {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "−";
  return " ";
}

function BranchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2.25" /><circle cx="18" cy="6" r="2.25" /><circle cx="6" cy="19" r="2.25" /><path d="M6 7.25v9.5M8.25 10.5h3.5A6.25 6.25 0 0 0 18 8.25" /></svg>; }
function RepositoryIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h11.5v16H7a2.5 2.5 0 0 0-2.5 2V5.5Z" /><path d="M7 17.5h11.5M8.5 7h6" /></svg>; }
function FolderIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7.5A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5V8A1.5 1.5 0 0 1 4 6.5Z" /></svg>; }
function LockIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" /></svg>; }
function ChevronIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>; }
function SwapIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7-3 3 3 3M4 10h13M17 17l3-3-3-3M20 14H7" /></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.5 10A7 7 0 0 0 6.2 7.3L4 10M5.5 14A7 7 0 0 0 17.8 16.7L20 14" /></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>; }
function AlertIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 9v5M12 17.5v.1" /></svg>; }
function BinaryIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3Z" /><path d="M14 3v5h5M10 12h5M10 16h5" /></svg>; }
function LargeFileIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3Z" /><path d="M14 3v5h5M12 11v5M12 18.5v.1" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>; }
function WrapIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12.5a3.5 3.5 0 0 1 0 7H9" /><path d="m12 11-3 3 3 3M4 17h2M4 12h3" /></svg>; }
function WorkspaceIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7.5A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5V8A1.5 1.5 0 0 1 4 6.5Z" /><path d="M8 12h3v3H8zM14 12h3v3h-3z" /></svg>; }

export default App;
