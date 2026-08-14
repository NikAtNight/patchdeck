import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HermesSessionController } from "../hermes/types";
import { HermesConnectionControl } from "../hermes/HermesConnectionControl";
import type { AppSurface, ProjectTab } from "../session";
import { CloseIcon, FolderIcon, PlusIcon, RepositoryIcon, WorkspaceIcon } from "./icons";
import { Spinner } from "./ui";

export function WorkspaceHeader({
  tabs,
  activeTabId,
  onOpenRepository,
  onOpenWorkspace,
  opening,
  onActivate,
  onClose,
  activeSurface,
  onSurfaceChange,
  agentAttached,
  hermes,
}: {
  tabs: ProjectTab[];
  activeTabId: string | null;
  onOpenRepository: () => void;
  onOpenWorkspace: () => void;
  opening: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  activeSurface: AppSurface;
  onSurfaceChange: (surface: AppSurface) => void;
  agentAttached: boolean;
  hermes: HermesSessionController;
}) {
  return (
    // data-tauri-drag-region lets the header act as the macOS titlebar under
    // the overlay title-bar style; child controls stay clickable.
    <header className="app-header" data-tauri-drag-region>
      {tabs.length > 0 && (
        <div className="project-tabs" role="tablist" aria-label="Open projects" data-tauri-drag-region>
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
      {tabs.length > 0 && agentAttached && (
        <nav className="surface-switch" aria-label="Workspace surface">
          <button className={activeSurface === "review" ? "active" : ""} aria-pressed={activeSurface === "review"} onClick={() => onSurfaceChange("review")}>Review</button>
          <button className={activeSurface === "agent" ? "active" : ""} aria-pressed={activeSurface === "agent"} onClick={() => onSurfaceChange("agent")}>Agent board</button>
        </nav>
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
      <HermesConnectionControl session={hermes} />
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
