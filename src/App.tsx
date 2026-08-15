import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openRepository, openWorkspace, openWorkspaceProject } from "./api";
import { errorMessage } from "./errors";
import type { RepositoryInfo, WorkspaceProject } from "./types";
import { ProjectLoadingPane, ProjectPane } from "./components/ProjectPane";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { AppUpdater } from "./components/AppUpdater";
import { ErrorBanner } from "./components/ui";
import { useHermesConnection } from "./hermes/useHermesConnection";
import { readReviewTarget, writeReviewTarget } from "./review/inlineComments";
import type { ReviewTarget } from "./review/inlineComments";
import {
  persistProjectSession,
  readAppSurface,
  readProjectSession,
  readRecentRepositories,
  writeAppSurface,
  writeRecentRepositories,
} from "./session";
import type { AppSurface, ProjectTab } from "./session";
import "./App.css";

// The agent board carries the Markdown renderer; load it only when opened.
const HermesBoard = lazy(() =>
  import("./hermes/HermesBoard").then((module) => ({ default: module.HermesBoard })),
);

function App() {
  const initialSession = useMemo(readProjectSession, []);
  const [tabs, setTabs] = useState<ProjectTab[]>(initialSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialSession.activeTabId);
  const [recentRepositories, setRecentRepositories] = useState<string[]>(readRecentRepositories);
  const [openingProject, setOpeningProject] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [workspaceAnnouncement, setWorkspaceAnnouncement] = useState("");
  const [activeSurface, setActiveSurface] = useState<AppSurface>(readAppSurface);
  const initialActivePath = initialSession.tabs.find((tab) => tab.id === initialSession.activeTabId)?.path;
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(() =>
    initialActivePath ? readReviewTarget(initialActivePath) : null
  );
  const hermes = useHermesConnection();
  const agentAttached = hermes.status.state === "connected" || hermes.status.state === "degraded";
  const visibleSurface: AppSurface = agentAttached ? activeSurface : "review";
  const openRequest = useRef(0);
  const reviewTargetRequest = useRef(0);
  const nextTabId = useRef(initialSession.nextTabId);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    function handleTabShortcut(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable]") || target.isContentEditable)) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const tab = tabsRef.current[Number(event.key) - 1];
      if (!tab) return;
      event.preventDefault();
      setActiveTabId(tab.id);
    }

    window.addEventListener("keydown", handleTabShortcut);
    return () => window.removeEventListener("keydown", handleTabShortcut);
  }, []);

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

  useEffect(() => {
    writeAppSurface(activeSurface);
  }, [activeSurface]);

  useEffect(() => {
    const activePath = tabs.find((tab) => tab.id === activeTabId)?.path;
    setReviewTarget(activePath ? readReviewTarget(activePath) : null);
  }, [activeTabId, tabs]);

  function selectReviewTarget(target: ReviewTarget) {
    const repositoryPath = target.repositoryPath;
    if (!repositoryPath) return;
    const request = ++reviewTargetRequest.current;
    setReviewTarget(target);
    writeReviewTarget(repositoryPath, target);
    setActiveSurface("review");
    const existing = tabsRef.current.find((tab) => tab.path === repositoryPath);
    if (existing) {
      setActiveTabId(existing.id);
      focusTabAfterRender(existing.id);
      return;
    }
    void openProject(repositoryPath).then((repository) => {
      if (!repository || request !== reviewTargetRequest.current || repository.path === repositoryPath) return;
      const resolved = { ...target, repositoryPath: repository.path };
      writeReviewTarget(repositoryPath, null);
      writeReviewTarget(repository.path, resolved);
      setReviewTarget(resolved);
    });
  }

  function updateReviewTarget(target: ReviewTarget | null) {
    reviewTargetRequest.current += 1;
    const activePath = tabsRef.current.find((tab) => tab.id === activeTabId)?.path;
    const repositoryPath = target?.repositoryPath ?? activePath;
    if (!repositoryPath) return;
    setReviewTarget(target);
    writeReviewTarget(repositoryPath, target);
  }

  async function chooseRepository() {
    const path = await openDialog({ directory: true, multiple: false, title: "Open Git repository" });
    if (typeof path === "string") await openProject(path);
  }

  async function chooseWorkspace() {
    const path = await openDialog({ directory: true, multiple: false, title: "Open workspace folder" });
    if (typeof path === "string") await openWorkspaceProjects(path);
  }

  async function openProject(path: string): Promise<RepositoryInfo | null> {
    const request = ++openRequest.current;
    setOpeningProject(true);
    setOpenError(null);
    try {
      const repository = await openRepository(path);
      if (request !== openRequest.current) return null;
      openRepositoryTabs([repository]);
      rememberRepository(repository.path);
      return repository;
    } catch (reason) {
      if (request === openRequest.current) setOpenError(errorMessage(reason));
      return null;
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
      writeRecentRepositories(next);
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
        activeSurface={visibleSurface}
        onSurfaceChange={setActiveSurface}
        agentAttached={agentAttached}
        hermes={hermes}
      />
      <div className="sr-only" aria-live="polite">{workspaceAnnouncement}</div>
      <AppUpdater />

      {tabs.length === 0 ? (
        <WelcomeScreen
          opening={openingProject}
          recentRepositories={recentRepositories}
          openError={openError}
          onOpenRepository={chooseRepository}
          onOpenWorkspace={chooseWorkspace}
          onOpenRecent={(path) => void openProject(path)}
        />
      ) : visibleSurface === "agent" ? (
        <Suspense fallback={<div className="board-loading">Loading agent board…</div>}>
          <HermesBoard
            session={hermes}
            repositoryPath={tabs.find((tab) => tab.id === activeTabId)?.path}
            onReviewTask={selectReviewTarget}
          />
        </Suspense>
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
                reviewTarget={reviewTarget}
                onReviewTargetUpdated={updateReviewTarget}
                agentAttached={agentAttached}
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

export default App;
