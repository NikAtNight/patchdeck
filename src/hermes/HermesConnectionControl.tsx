import { FormEvent, useEffect, useRef, useState } from "react";
import type { HermesSessionController } from "./types";

export function HermesConnectionControl({ session }: { session: HermesSessionController }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"managed" | "attached">("managed");
  const [url, setUrl] = useState("http://127.0.0.1:9119");
  const tokenRef = useRef<HTMLInputElement>(null);
  const connected = session.status.state === "connected" || session.status.state === "degraded";

  useEffect(() => {
    if (connected) setOpen(false);
  }, [connected]);

  async function attach(event: FormEvent) {
    event.preventDefault();
    const token = tokenRef.current?.value ?? "";
    const succeeded = await session.connectExisting(url, token);
    if (succeeded && tokenRef.current) tokenRef.current.value = "";
  }

  return (
    <div className="hermes-connection-control">
      <button
        className={`hermes-status-button state-${session.status.state}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="hermes-status-dot" />
        {session.status.state === "connecting" ? "Connecting Hermes…" : connected ? (
          <><span>Hermes</span><span className="hermes-worker-count">{session.status.activeWorkers} active</span></>
        ) : "Connect Hermes"}
      </button>

      {open && (
        <div className="hermes-connect-popover" role="dialog" aria-label="Hermes connection">
          <div className="hermes-popover-heading">
            <div>
              <strong>{connected ? "Hermes connected" : "Connect Hermes Agent"}</strong>
              <span>{connected ? `${session.status.version ?? "Unknown version"} · ${session.status.mode}` : "Local connections only"}</span>
            </div>
            <button className="plain-close" onClick={() => setOpen(false)} aria-label="Close Hermes connection">×</button>
          </div>

          {connected ? (
            <div className="hermes-connected-detail">
              <dl>
                <div><dt>Server</dt><dd>{session.status.url}</dd></div>
                <div><dt>Workers</dt><dd>{session.status.activeWorkers} active</dd></div>
                <div><dt>Health</dt><dd>{session.status.state}</dd></div>
              </dl>
              {session.status.error && <p className="form-error">{session.status.error}</p>}
              <div className="popover-actions">
                <button className="secondary-button" onClick={() => void session.refresh()}>Check now</button>
                <button className="danger-button" onClick={() => void session.disconnect()}>Disconnect</button>
              </div>
            </div>
          ) : (
            <>
              <div className="connect-mode-tabs" role="tablist" aria-label="Hermes connection mode">
                <button role="tab" aria-selected={mode === "managed"} onClick={() => setMode("managed")}>Start local</button>
                <button role="tab" aria-selected={mode === "attached"} onClick={() => setMode("attached")}>Attach existing</button>
              </div>
              {mode === "managed" ? (
                <div className="connect-mode-body">
                  <p>Use a running local Hermes dashboard when available, or start an isolated <code>hermes serve</code> process for this app.</p>
                  <div className="connect-local-actions">
                    <button className="primary-button" disabled={session.status.state === "connecting"} onClick={() => void session.connectDiscovered()}>
                      {session.status.state === "connecting" ? "Connecting…" : "Use running Hermes"}
                    </button>
                    <button className="secondary-button" disabled={session.status.state === "connecting"} onClick={() => void session.connectManaged()}>
                      Start new Hermes server
                    </button>
                  </div>
                </div>
              ) : (
                <form className="connect-mode-body" onSubmit={attach}>
                  <label>Server URL<input value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} /></label>
                  <label>Session token<input ref={tokenRef} type="password" autoComplete="off" /></label>
                  <button className="primary-button" disabled={session.status.state === "connecting"}>Attach</button>
                </form>
              )}
              {session.status.error && <p className="form-error" role="alert">{session.status.error}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
