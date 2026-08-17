import { useEffect, useRef, useState } from "react";
import type { HermesSessionController } from "../hermes/types";
import { CloseIcon, InfoIcon, LockIcon, ProviderIcon, SlidersIcon } from "../components/icons";
import { ExecutionProfilesSettings } from "./ExecutionProfilesSettings";
import { ProvidersSettings } from "./ProvidersSettings";

type SettingsSection = "providers" | "profiles" | "safety" | "about";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof ProviderIcon;
}> = [
  { id: "providers", label: "Providers", description: "Agents and orchestrators", icon: ProviderIcon },
  { id: "profiles", label: "Execution Profiles", description: "Reusable run settings", icon: SlidersIcon },
  { id: "safety", label: "Safety", description: "Execution boundaries", icon: LockIcon },
  { id: "about", label: "About", description: "App and build details", icon: InfoIcon },
];

export function SettingsPanel({
  open,
  onClose,
  repositoryPath,
  hermes,
}: {
  open: boolean;
  onClose: () => void;
  repositoryPath: string | null;
  hermes: HermesSessionController;
}) {
  const [section, setSection] = useState<SettingsSection>("providers");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = closeButtonRef.current?.closest<HTMLElement>(".settings-dialog");
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const active = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0];

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <aside className="settings-sidebar">
          <div className="settings-sidebar-heading">
            <span>Patchdeck</span>
            <h1 id="settings-title">Settings</h1>
          </div>
          <nav aria-label="Settings sections">
            {SECTIONS.map((candidate) => {
              const Icon = candidate.icon;
              return (
                <button
                  key={candidate.id}
                  className={section === candidate.id ? "active" : ""}
                  aria-label={candidate.label}
                  aria-current={section === candidate.id ? "page" : undefined}
                  onClick={() => setSection(candidate.id)}
                >
                  <Icon />
                  <span>
                    <strong>{candidate.label}</strong>
                    <small>{candidate.description}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="settings-repository-context">
            <span>Active repository</span>
            <strong title={repositoryPath ?? undefined}>{repositoryName(repositoryPath)}</strong>
          </div>
        </aside>

        <div className="settings-main">
          <header className="settings-main-header">
            <div>
              <span>Settings</span>
              <h2>{active.label}</h2>
            </div>
            <button ref={closeButtonRef} className="plain-close" onClick={onClose} aria-label="Close settings">
              <CloseIcon />
            </button>
          </header>

          <div className="settings-scroll">
            {section === "providers" && <ProvidersSettings hermes={hermes} />}
            {section === "profiles" && <ExecutionProfilesSettings repositoryPath={repositoryPath} />}
            {section === "safety" && <SafetySettings />}
            {section === "about" && <AboutSettings />}
          </div>
        </div>
      </section>
    </div>
  );
}

function SafetySettings() {
  return (
    <div className="settings-page settings-copy-page">
      <header>
        <h3>Work stays inside explicit boundaries</h3>
        <p>Patchdeck starts coding agents with a repository and an execution profile you select.</p>
      </header>
      <div className="safety-grid">
        <article>
          <LockIcon />
          <div>
            <strong>Sandboxed execution</strong>
            <p>Read-only profiles request a non-writing sandbox. Workspace-write profiles pass the selected repository as the working directory and use the provider&apos;s workspace boundary.</p>
          </div>
        </article>
        <article>
          <ProviderIcon />
          <div>
            <strong>No silent publication</strong>
            <p>Patchdeck does not automatically commit, push, publish, or open a pull request. Those actions require an explicit workflow you initiate.</p>
          </div>
        </article>
        <article>
          <SlidersIcon />
          <div>
            <strong>Provider-owned credentials</strong>
            <p>Provider sign-in stays with the provider CLI or secure operating-system storage. Tokens are never saved in cards or execution profiles.</p>
          </div>
        </article>
      </div>
    </div>
  );
}

function AboutSettings() {
  const development = import.meta.env.MODE === "development" || import.meta.env.DEV;
  const productName = development ? "Patchdeck (Dev)" : "Patchdeck";
  const bundleIdentity = development ? "com.local.patchdeck.dev" : "com.local.patchdeck";

  return (
    <div className="settings-page settings-copy-page">
      <header className="about-heading">
        <div className="about-mark"><ProviderIcon /></div>
        <div>
          <span>{development ? "Development build" : "Release build"}</span>
          <h3>{productName}</h3>
          <p>A local-first workbench for directing and reviewing repository work across coding agents.</p>
        </div>
      </header>
      <dl className="about-details">
        <div><dt>Build channel</dt><dd>{development ? "Development" : "Production"}</dd></div>
        <div><dt>Bundle identity</dt><dd><code>{bundleIdentity}</code></dd></div>
        <div><dt>Data ownership</dt><dd>Local application storage</dd></div>
        <div><dt>Publication</dt><dd>Manual only</dd></div>
      </dl>
    </div>
  );
}

function repositoryName(repositoryPath: string | null) {
  if (!repositoryPath) return "No repository open";
  return repositoryPath.split(/[\\/]/).filter(Boolean).pop() ?? repositoryPath;
}
