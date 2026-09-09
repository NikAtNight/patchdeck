import { useEffect, useState } from "react";
import {
  deleteExecutionProfile,
  saveExecutionProfile,
  setRepositoryExecutionProfile,
  useExecutionProfiles,
} from "../providers/profiles";
import type { ExecutionProfile } from "../providers/profiles";
import type { AgentRuntimeId, AgentSandbox } from "../providers/types";
import { PlusIcon } from "../components/icons";

type ProfileDraft = Omit<ExecutionProfile, "builtIn" | "id"> & { id: string | null };

export function ExecutionProfilesSettings({ repositoryPath }: { repositoryPath: string | null }) {
  const profileDocument = useExecutionProfiles();
  const [selectedId, setSelectedId] = useState<string | null>(profileDocument.profiles[0]?.id ?? null);
  const selected = profileDocument.profiles.find((profile) => profile.id === selectedId) ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(selected));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(draftFromProfile(selected));
  }, [selected]);

  function updateDraft(next: ProfileDraft) {
    setDraft(next);
    setSaved(false);
  }

  function startNew(source?: ExecutionProfile) {
    setSelectedId(null);
    setDraft({
      id: null,
      name: source ? `${source.name} copy` : "",
      runtimeId: source?.runtimeId ?? "codex",
      model: source?.model ?? "",
      sandbox: source?.sandbox ?? "workspaceWrite",
      instructions: source?.instructions ?? "",
    });
    setSaved(false);
  }

  function save() {
    if (!draft.name.trim()) return;
    const profile = saveExecutionProfile({
      id: draft.id ?? undefined,
      name: draft.name,
      runtimeId: draft.runtimeId,
      model: draft.model,
      sandbox: draft.sandbox,
      instructions: draft.instructions,
    });
    setSelectedId(profile.id);
    setSaved(true);
  }

  function remove() {
    if (!selected) return;
    deleteExecutionProfile(selected.id);
    setSelectedId(profileDocument.profiles.find((profile) => profile.id !== selected.id)?.id ?? null);
    setSaved(false);
  }

  const readOnly = selected?.builtIn === true;
  const repositoryDefault = repositoryPath ? profileDocument.defaultsByRepository[repositoryPath] ?? "" : "";

  return (
    <div className="settings-page profiles-settings">
      <header className="settings-group-header">
        <div>
          <span>Execution profiles</span>
          <h3>Reusable agent settings</h3>
          <p>Choose a runtime, sandbox, model, and standing instructions once, then route cards through that profile.</p>
        </div>
        <button className="primary-button" onClick={() => startNew()}><PlusIcon /> New profile</button>
      </header>

      <section className="repository-default-card">
        <div>
          <strong>Default for active repository</strong>
          <span title={repositoryPath ?? undefined}>{repositoryPath ?? "Open a repository to choose its default profile."}</span>
        </div>
        <label>
          <span className="sr-only">Default execution profile</span>
          <select
            aria-label="Default execution profile"
            value={repositoryDefault}
            disabled={!repositoryPath}
            onChange={(event) => {
              if (repositoryPath) setRepositoryExecutionProfile(repositoryPath, event.target.value || null);
            }}
          >
            <option value="">Use Patchdeck default</option>
            {profileDocument.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
      </section>

      <div className="profile-workspace">
        <nav className="profile-list" aria-label="Execution profiles">
          {profileDocument.profiles.map((profile) => (
            <button
              key={profile.id}
              className={profile.id === selectedId ? "active" : ""}
              aria-current={profile.id === selectedId ? "true" : undefined}
              onClick={() => {
                setSelectedId(profile.id);
                setSaved(false);
              }}
            >
              <span className={`profile-runtime-dot runtime-${profile.runtimeId}`} />
              <span>
                <strong>{profile.name}</strong>
                <small>{profile.runtimeId === "codex" ? "Codex" : "Claude Code"} · {sandboxLabel(profile.sandbox)}</small>
              </span>
              {profile.builtIn && <em>Built in</em>}
            </button>
          ))}
        </nav>

        <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <header>
            <div>
              <span>{readOnly ? "Built-in profile" : draft.id ? "Custom profile" : "New profile"}</span>
              <strong>{draft.name || "Untitled profile"}</strong>
            </div>
            {readOnly && <button type="button" className="secondary-button" onClick={() => selected && startNew(selected)}>Duplicate</button>}
          </header>

          <label>
            Profile name
            <input
              value={draft.name}
              disabled={readOnly}
              required
              autoFocus={!draft.id}
              onChange={(event) => updateDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <div className="profile-field-grid">
            <label>
              Coding agent
              <select
                value={draft.runtimeId}
                disabled={readOnly}
                onChange={(event) => updateDraft({ ...draft, runtimeId: event.target.value as AgentRuntimeId })}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </label>
            <label>
              Sandbox
              <select
                value={draft.sandbox}
                disabled={readOnly}
                onChange={(event) => updateDraft({ ...draft, sandbox: event.target.value as AgentSandbox })}
              >
                <option value="workspaceWrite">Workspace write</option>
                <option value="readOnly">Read only</option>
              </select>
            </label>
          </div>
          <label>
            Model override <span>Optional</span>
            <input
              value={draft.model}
              disabled={readOnly}
              placeholder="Use provider default"
              spellCheck={false}
              onChange={(event) => updateDraft({ ...draft, model: event.target.value })}
            />
          </label>
          <label>
            Standing instructions <span>Optional</span>
            <textarea
              value={draft.instructions}
              disabled={readOnly}
              rows={7}
              placeholder="Applied to every run that uses this profile."
              onChange={(event) => updateDraft({ ...draft, instructions: event.target.value })}
            />
          </label>

          <footer>
            <span aria-live="polite">{saved ? "Profile saved" : readOnly ? "Duplicate to customize, or delete this built-in profile." : "Stored locally. No credentials are included."}</span>
            {selected && <button type="button" className="settings-danger-action" onClick={remove}>Delete profile</button>}
            {!readOnly && <button className="primary-button" disabled={!draft.name.trim()}>Save profile</button>}
          </footer>
        </form>
      </div>
    </div>
  );
}

function draftFromProfile(profile: ExecutionProfile | null): ProfileDraft {
  return profile
    ? {
        id: profile.id,
        name: profile.name,
        runtimeId: profile.runtimeId,
        model: profile.model,
        sandbox: profile.sandbox,
        instructions: profile.instructions,
      }
    : { id: null, name: "", runtimeId: "codex", model: "", sandbox: "workspaceWrite", instructions: "" };
}

function sandboxLabel(sandbox: AgentSandbox) {
  return sandbox === "workspaceWrite" ? "Workspace write" : "Read only";
}
