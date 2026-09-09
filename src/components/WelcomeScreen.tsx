import appIcon from "../../app-icon.svg";
import { ChevronIcon, FolderIcon, LockIcon, RepositoryIcon, WorkspaceIcon } from "./icons";
import { ErrorBanner } from "./ui";

export function WelcomeScreen({
  opening,
  recentRepositories,
  openError,
  onOpenRepository,
  onOpenWorkspace,
  onOpenRecent,
}: {
  opening: boolean;
  recentRepositories: string[];
  openError: string | null;
  onOpenRepository: () => void;
  onOpenWorkspace: () => void;
  onOpenRecent: (path: string) => void;
}) {
  return (
    <div className="welcome-scroll">
      <main className="welcome">
        <section className="welcome-intro" aria-labelledby="welcome-heading">
          <div className="welcome-mark" aria-hidden="true"><img src={appIcon} alt="" /></div>
          <h1 id="welcome-heading">Welcome to Patchdeck</h1>
          <p className="welcome-copy">Review branches.<br />Manage your agent tasks.</p>
          <div className="welcome-actions">
            <button className="primary-button welcome-action header-open" onClick={onOpenRepository} disabled={opening}>
              <FolderIcon /> {opening ? "Opening…" : "Open repository"}
            </button>
            <button className="secondary-button welcome-action" onClick={onOpenWorkspace} disabled={opening}>
              <WorkspaceIcon /> Open a workspace
            </button>
          </div>
          <p className="shortcut-hint">A workspace is a folder containing your repositories.</p>
        </section>

        <section className="recent" aria-labelledby="recent-heading">
          <div className="section-heading">
            <h2 id="recent-heading">Recent repositories</h2>
            <span>On this Mac</span>
          </div>
          {recentRepositories.length > 0 ? (
            <div className="recent-list">
              {recentRepositories.map((path) => (
                <button key={path} className="recent-item" title={path} onClick={() => onOpenRecent(path)}>
                  <span className="recent-icon"><RepositoryIcon /></span>
                  <span className="recent-copy">
                    <strong>{basename(path)}</strong>
                    <span>{path}</span>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          ) : (
            <div className="recent-empty">
              <RepositoryIcon />
              <h3>Your projects start here</h3>
              <p>Open a repository to compare branches and review changes. It will appear here next time.</p>
            </div>
          )}
        </section>
        {openError && <ErrorBanner message={openError} />}
      </main>
      <footer className="welcome-footer"><LockIcon /> Nothing is published automatically.</footer>
    </div>
  );
}

function basename(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
