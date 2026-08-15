import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errors";
import { CloseIcon } from "./icons";
import { Spinner } from "./ui";

type InstallProgress = {
  downloaded: number;
  total: number | null;
};

export function AppUpdater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const activeUpdate = useRef<Update | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    void check({ timeout: 15_000 })
      .then((availableUpdate) => {
        if (cancelled) {
          void availableUpdate?.close();
          return;
        }
        activeUpdate.current = availableUpdate;
        setUpdate(availableUpdate);
      })
      // A background check should never interrupt repository review. Installation
      // errors are shown because they follow an explicit user action.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      void activeUpdate.current?.close();
    };
  }, []);

  if (!update) return null;
  const availableUpdate = update;

  async function install() {
    setInstalling(true);
    setInstallError(null);
    setProgress({ downloaded: 0, total: null });

    try {
      await availableUpdate.downloadAndInstall(handleDownloadEvent(setProgress));
      await relaunch();
    } catch (reason) {
      setInstallError(errorMessage(reason));
      setInstalling(false);
    }
  }

  function dismiss() {
    activeUpdate.current = null;
    setUpdate(null);
    void availableUpdate.close();
  }

  const percentage = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;

  return (
    <aside className="app-update-card" aria-live="polite" aria-label="Patchdeck update available">
      <div className="app-update-heading">
        <div>
          <strong>Patchdeck {availableUpdate.version} is ready</strong>
          <span>You’re using {availableUpdate.currentVersion}</span>
        </div>
        {!installing && (
          <button className="plain-close" type="button" onClick={dismiss} aria-label="Remind me later">
            <CloseIcon />
          </button>
        )}
      </div>
      {availableUpdate.body && <p>{availableUpdate.body}</p>}
      {installError && <p className="app-update-error" role="alert">Update failed: {installError}</p>}
      {installing && (
        <div className="app-update-progress">
          <span>{percentage === null ? "Downloading update…" : `Downloading update… ${percentage}%`}</span>
          <progress value={progress?.downloaded ?? 0} max={progress?.total ?? undefined} />
        </div>
      )}
      <div className="app-update-actions">
        {!installing && <button className="secondary-button" type="button" onClick={dismiss}>Later</button>}
        <button className="primary-button" type="button" disabled={installing} onClick={() => void install()}>
          {installing && <Spinner />}
          {installing ? "Installing…" : installError ? "Try again" : "Install and restart"}
        </button>
      </div>
    </aside>
  );
}

function handleDownloadEvent(setProgress: (progress: InstallProgress) => void) {
  let downloaded = 0;
  let total: number | null = null;

  return (event: DownloadEvent) => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    } else if (event.event === "Finished" && total !== null) {
      downloaded = total;
    }
    setProgress({ downloaded, total });
  };
}
