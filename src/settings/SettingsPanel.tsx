import { useEffect, useRef, useState } from "react";
import type { HermesSessionController } from "../hermes/types";
import { CloseIcon, InfoIcon, LockIcon, ProviderIcon, SlidersIcon } from "../components/icons";
import { ExecutionProfilesSettings } from "./ExecutionProfilesSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { getAppearancePreference, setAppearancePreference, type AppearancePreference } from "../appearance";

type SettingsSection = "appearance" | "providers" | "profiles" | "help" | "safety" | "about";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof ProviderIcon;
}> = [
  { id: "appearance", label: "Appearance", description: "Light, dark, or automatic", icon: SlidersIcon },
  { id: "providers", label: "Providers", description: "Agents and orchestrators", icon: ProviderIcon },
  { id: "profiles", label: "Execution Profiles", description: "Reusable run settings", icon: SlidersIcon },
  { id: "help", label: "Help", description: "Agent Board and providers", icon: InfoIcon },
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
        event.stopPropagation();
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
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function containFocus(event: FocusEvent) {
      const dialog = closeButtonRef.current?.closest(".settings-dialog");
      if (event.target instanceof Node && !dialog?.contains(event.target)) {
        closeButtonRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
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
            <span>{import.meta.env.MODE === "development" || import.meta.env.DEV ? "Patchdeck Local" : "Patchdeck"}</span>
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

          <div key={section} className="settings-scroll">
            {section === "appearance" && <AppearanceSettings />}
            {section === "providers" && <ProvidersSettings hermes={hermes} />}
            {section === "profiles" && <ExecutionProfilesSettings repositoryPath={repositoryPath} />}
            {section === "help" && <AgentBoardHelp onNavigate={setSection} />}
            {section === "safety" && <SafetySettings />}
            {section === "about" && <AboutSettings />}
          </div>
        </div>
      </section>
    </div>
  );
}

function AppearanceSettings() {
  const [preference, setPreference] = useState(getAppearancePreference);
  const options: Array<{ value: AppearancePreference; label: string; description: string }> = [
    { value: "system", label: "System", description: "Follow your Mac" },
    { value: "light", label: "Light", description: "Light windows and controls" },
    { value: "dark", label: "Dark", description: "Dark windows and controls" },
  ];

  return (
    <div className="settings-page settings-copy-page">
      <header>
        <h3>App appearance</h3>
        <p>Choose an appearance. System follows your Mac as it switches between light and dark.</p>
      </header>
      <fieldset className="appearance-options">
        <legend>App appearance</legend>
        {options.map((option) => (
          <label className="appearance-option" key={option.value}>
            <input
              type="radio"
              name="appearance"
              value={option.value}
              checked={preference === option.value}
              onChange={() => {
                setAppearancePreference(option.value);
                setPreference(option.value);
              }}
            />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function AgentBoardHelp({ onNavigate }: { onNavigate: (section: "providers" | "profiles") => void }) {
  return (
    <div className="settings-page settings-copy-page">
      <header>
        <h3>Use the Agent Board without Hermes</h3>
        <p>Patchdeck can manage cards and run Codex or Claude Code directly in your repository. Hermes is optional. You can also keep a board of tasks without connecting an agent.</p>
        <div className="settings-help-actions">
          <button className="secondary-button" onClick={() => onNavigate("providers")}><ProviderIcon /> Open Providers</button>
          <button className="secondary-button" onClick={() => onNavigate("profiles")}><SlidersIcon /> Open Execution Profiles</button>
        </div>
      </header>

      <ol className="settings-help-steps">
        <li>
          <h4>Connect a coding agent</h4>
          <p>Install the Codex or Claude Code command-line app on your Mac. In Providers, choose Connect and follow any sign-in instructions in Terminal. Refresh checks the Installed, Authenticated, and Ready indicators. An agent must be Ready before you can run it. Disconnect signs that provider&apos;s CLI out.</p>
        </li>
        <li>
          <h4>Choose an execution profile</h4>
          <p>Execution Profiles chooses the agent, model, sandbox, and standing instructions for a run. Use a built-in profile, duplicate one to customize it, or create your own. With a repository open, you can set its default profile.</p>
        </li>
        <li>
          <h4>Create local work</h4>
          <p>Open a repository, switch to Agent board, select Local Board, and choose New work. Set Destination to Local Board, then add a title and instructions.</p>
          <p>Choose No agent yet under Executor to save a card with Create work. Choose an available execution profile to start the agent when you press Create &amp; run. Check the executor before submitting, since your repository default may already be selected.</p>
        </li>
        <li>
          <h4>Run and follow up</h4>
          <p>Open a local card to see its Agent conversation. For a card without a run, choose a profile and press Run with Codex or Run with Claude Code. Stop run cancels active work. When a conversation can be resumed, use Send to follow up; if no session was created, use Retry.</p>
          <p>Drag cards between lanes or use the card&apos;s Lane menu. Starting a run moves it to In progress; move it to Review or Done yourself when ready.</p>
        </li>
      </ol>

      <section className="settings-help-section" aria-label="Provider troubleshooting">
        <h4>Why is an executor unavailable?</h4>
        <p>Check its provider card. CLI not found means the command-line app needs to be installed or made available to Patchdeck. If Authenticated is missing, complete the provider&apos;s sign-in and reconnect. Refresh after setup, then reopen New work to reload the available executors.</p>
      </section>
      <section className="settings-help-section" aria-label="Local Board and Hermes">
        <h4>Where does the work live?</h4>
        <p>Local cards and conversation history are stored on this Mac. Agents run against the selected repository and use their provider&apos;s service and credentials. Local Board does not mean the agent runs offline.</p>
        <h4>What changes when I connect Hermes?</h4>
        <p>Hermes manages its own boards, profiles, and workers. Connect it in Providers to use those boards. Send to Hermes creates a separate task on the chosen board; the local card and conversation stay in Patchdeck.</p>
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
  const productName = development ? "Patchdeck Local" : "Patchdeck";
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
