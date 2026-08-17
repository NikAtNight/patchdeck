import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { errorMessage } from "../errors";
import type { HermesSessionController } from "../hermes/types";
import { connectAgentRuntime, disconnectAgentRuntime, listAgentRuntimes } from "../providers/api";
import { AGENT_RUNTIME_IDS } from "../providers/types";
import type { AgentRuntimeId, AgentRuntimeStatus } from "../providers/types";
import { RefreshIcon } from "../components/icons";

const RUNTIME_LABELS: Record<AgentRuntimeId, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

export function ProvidersSettings({ hermes }: { hermes: HermesSessionController }) {
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyRuntime, setBusyRuntime] = useState<AgentRuntimeId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuntimes(await listAgentRuntimes());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function replaceRuntime(next: AgentRuntimeStatus) {
    setRuntimes((current) => [...current.filter((runtime) => runtime.id !== next.id), next]);
  }

  async function connect(runtimeId: AgentRuntimeId) {
    setBusyRuntime(runtimeId);
    setError(null);
    setNotice(null);
    try {
      const result = await connectAgentRuntime(runtimeId);
      replaceRuntime(result.status);
      setNotice(result.message ?? `${result.status.label} connection updated.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyRuntime(null);
    }
  }

  async function disconnect(runtimeId: AgentRuntimeId) {
    setBusyRuntime(runtimeId);
    setError(null);
    setNotice(null);
    try {
      const next = await disconnectAgentRuntime(runtimeId);
      replaceRuntime(next);
      setNotice(`${next.label} disconnected.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyRuntime(null);
    }
  }

  return (
    <div className="settings-page providers-settings">
      <SettingsGroupHeader
        eyebrow="Coding agents"
        title="Local coding runtimes"
        copy="Connect the command-line agents Patchdeck can launch directly for repository cards."
        action={(
          <button className="settings-inline-action" onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon /> {loading ? "Checking…" : "Refresh"}
          </button>
        )}
      />

      {error && <p className="settings-message error" role="alert">{error}</p>}
      {notice && <p className="settings-message success" role="status">{notice}</p>}

      <div className="provider-list" aria-busy={loading}>
        {AGENT_RUNTIME_IDS.map((runtimeId) => (
          <RuntimeCard
            key={runtimeId}
            runtime={runtimes.find((candidate) => candidate.id === runtimeId) ?? unavailableRuntime(runtimeId)}
            busy={busyRuntime === runtimeId}
            onConnect={() => void connect(runtimeId)}
            onDisconnect={() => void disconnect(runtimeId)}
          />
        ))}
      </div>

      <section className="settings-group orchestrator-group">
        <SettingsGroupHeader
          eyebrow="Orchestrators"
          title="Board and worker services"
          copy="Hermes owns its boards, profiles, and workers. Patchdeck connects to it without turning it into a coding-agent runtime."
        />
        <HermesProviderCard session={hermes} />
      </section>
    </div>
  );
}

function RuntimeCard({
  runtime,
  busy,
  onConnect,
  onDisconnect,
}: {
  runtime: AgentRuntimeStatus;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <article className="provider-card" aria-labelledby={`runtime-${runtime.id}-name`}>
      <header>
        <div className={`provider-monogram provider-${runtime.id}`}>{runtime.id === "codex" ? "CX" : "CL"}</div>
        <div className="provider-title">
          <strong id={`runtime-${runtime.id}-name`}>{runtime.label}</strong>
          <span>{runtime.version ?? (runtime.installed ? "Version unavailable" : "CLI not found")}</span>
        </div>
        <ProviderState status={runtime} />
      </header>

      <div className="provider-state-row" aria-label={`${runtime.label} status`}>
        <StateChip label="Installed" state={runtime.installed} />
        <StateChip label="Authenticated" state={runtime.authenticated} />
        <StateChip label="Ready" state={runtime.ready} />
      </div>

      <dl className="provider-details">
        <Detail label="Executable" value={runtime.path} mono />
        <Detail label="Authentication" value={runtime.authMode} />
        <Detail label="Account" value={runtime.accountLabel} />
      </dl>
      {runtime.error && <p className="provider-card-error">{runtime.error}</p>}

      <footer>
        <button className="secondary-button" onClick={onConnect} disabled={busy}>
          {busy ? "Working…" : runtime.ready ? "Reconnect" : "Connect"}
        </button>
        <button className="settings-danger-action" onClick={onDisconnect} disabled={busy || !runtime.installed}>
          Disconnect
        </button>
      </footer>
    </article>
  );
}

function HermesProviderCard({ session }: { session: HermesSessionController }) {
  const [url, setUrl] = useState("http://127.0.0.1:9119");
  const tokenRef = useRef<HTMLInputElement>(null);
  const connected = session.status.state === "connected" || session.status.state === "degraded";
  const connecting = session.status.state === "connecting";

  async function attach(event: FormEvent) {
    event.preventDefault();
    const succeeded = await session.connectExisting(url, tokenRef.current?.value ?? "");
    if (succeeded && tokenRef.current) tokenRef.current.value = "";
  }

  return (
    <article className="provider-card hermes-provider-card" aria-labelledby="hermes-provider-name">
      <header>
        <div className="provider-monogram provider-hermes">H</div>
        <div className="provider-title">
          <strong id="hermes-provider-name">Hermes</strong>
          <span>{session.status.version ?? "Local board orchestrator"}</span>
        </div>
        <span className={`provider-ready-badge state-${session.status.state}`}>
          <i /> {connected ? session.status.state : connecting ? "Connecting" : "Disconnected"}
        </span>
      </header>

      {connected ? (
        <>
          <dl className="provider-details hermes-provider-details">
            <Detail label="Endpoint" value={session.status.url} mono />
            <Detail label="Connection" value={session.status.mode} />
            <Detail label="Workers" value={`${session.status.activeWorkers} active`} />
          </dl>
          {session.status.error && <p className="provider-card-error">{session.status.error}</p>}
          <footer>
            <button className="secondary-button" onClick={() => void session.refresh()}><RefreshIcon /> Check now</button>
            <button className="settings-danger-action" onClick={() => void session.disconnect()}>Disconnect</button>
          </footer>
        </>
      ) : (
        <div className="hermes-connect-options">
          <div className="hermes-local-connect">
            <p>Connect to a running local service or let Patchdeck start an isolated Hermes server.</p>
            <div>
              <button className="primary-button" disabled={connecting} onClick={() => void session.connectDiscovered()}>Use running Hermes</button>
              <button className="secondary-button" disabled={connecting} onClick={() => void session.connectManaged()}>Start local server</button>
            </div>
          </div>
          <form onSubmit={attach}>
            <strong>Attach an existing server</strong>
            <label>
              Server URL
              <input value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} />
            </label>
            <label>
              Session token
              <input ref={tokenRef} type="password" autoComplete="off" />
            </label>
            <button className="secondary-button" disabled={connecting}>Attach</button>
          </form>
          {session.status.error && <p className="provider-card-error" role="alert">{session.status.error}</p>}
        </div>
      )}
    </article>
  );
}

function SettingsGroupHeader({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <header className="settings-group-header">
      <div>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
        <p>{copy}</p>
      </div>
      {action}
    </header>
  );
}

function ProviderState({ status }: { status: AgentRuntimeStatus }) {
  const label = status.ready ? "Ready" : !status.installed ? "Not installed" : status.authenticated === false ? "Sign-in required" : "Unavailable";
  return <span className={`provider-ready-badge ${status.ready ? "ready" : "unavailable"}`}><i /> {label}</span>;
}

function StateChip({ label, state }: { label: string; state: boolean | null }) {
  return <span className={`provider-state-chip state-${state === null ? "unknown" : state ? "yes" : "no"}`}><i />{label}</span>;
}

function Detail({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined} title={value ?? undefined}>{value || "Not available"}</dd></div>;
}

function unavailableRuntime(id: AgentRuntimeId): AgentRuntimeStatus {
  return {
    id,
    label: RUNTIME_LABELS[id],
    installed: false,
    authenticated: null,
    ready: false,
    version: null,
    path: null,
    authMode: null,
    accountLabel: null,
    error: null,
  };
}
