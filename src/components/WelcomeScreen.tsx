import { BranchIcon, ChevronIcon, FolderIcon, LockIcon, RepositoryIcon, WorkspaceIcon } from "./icons";
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
    <>
      <main className="welcome">
        <div className="welcome-mark" aria-hidden="true"><BranchIcon /></div>
        <p className="eyebrow">LOCAL BRANCH REVIEW</p>
        <h1>See the whole change<br />before the pull request.</h1>
        <p className="welcome-copy">
          Compare any two local branches, scan every changed path, and review the exact diff.
          Connect Hermes when you want the agent board beside the code. Nothing is published automatically.
        </p>
        <div className="welcome-actions">
          <button className="primary-button welcome-action" onClick={onOpenRepository} disabled={opening}>
            <FolderIcon /> {opening ? "Opening…" : "Open a repository"}
          </button>
          <button className="secondary-button welcome-action" onClick={onOpenWorkspace} disabled={opening}>
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
                <button key={path} className="recent-item" onClick={() => onOpenRecent(path)}>
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
      <footer className="welcome-footer"><LockIcon /> Local-first · Nothing published automatically</footer>
    </>
  );
}

function basename(path: string) {
  return path.replace(/[\\/]$/, "").split(/[\\/]/).pop() || path;
}
