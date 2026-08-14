import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectDiscoveredHermes,
  connectExistingHermes,
  connectManagedHermes,
  disconnectHermes,
  getHermesConnectionStatus,
} from "./api";
import { errorMessage } from "../errors";
import type { HermesConnectionStatus, HermesSessionController } from "./types";

const DISCONNECTED: HermesConnectionStatus = {
  state: "disconnected",
  mode: null,
  url: null,
  version: null,
  activeWorkers: 0,
  error: null,
};

export function useHermesConnection(): HermesSessionController {
  const [status, setStatus] = useState<HermesConnectionStatus>(DISCONNECTED);
  // The most recent board scope for status polls. Callers set it via
  // refresh(board); the interval below reuses it, so there is exactly one
  // status poller regardless of which surfaces are mounted.
  const boardRef = useRef<string | undefined>(undefined);
  const statusRequest = useRef(0);

  const refresh = useCallback(async (board?: string) => {
    if (board !== undefined) boardRef.current = board || undefined;
    const request = ++statusRequest.current;
    try {
      const next = await getHermesConnectionStatus(boardRef.current);
      if (request === statusRequest.current) setStatus(next);
    } catch {
      if (request === statusRequest.current) setStatus((current) => current.state === "disconnected" ? current : {
        ...current,
        state: "degraded",
        error: "Hermes connection status is unavailable",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status.state !== "connected" && status.state !== "degraded") return;
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [refresh, status.state]);

  async function connectManaged() {
    const request = ++statusRequest.current;
    setStatus({ ...DISCONNECTED, state: "connecting" });
    try {
      const next = await connectManagedHermes();
      if (request === statusRequest.current) setStatus(next);
      return request === statusRequest.current;
    } catch (reason) {
      if (request === statusRequest.current) setStatus({ ...DISCONNECTED, state: "error", error: errorMessage(reason) });
      return false;
    }
  }

  async function connectDiscovered() {
    const request = ++statusRequest.current;
    setStatus({ ...DISCONNECTED, state: "connecting" });
    try {
      const next = await connectDiscoveredHermes();
      if (request === statusRequest.current) setStatus(next);
      return request === statusRequest.current;
    } catch (reason) {
      if (request === statusRequest.current) setStatus({ ...DISCONNECTED, state: "error", error: errorMessage(reason) });
      return false;
    }
  }

  async function connectExisting(url: string, token: string) {
    const request = ++statusRequest.current;
    setStatus({ ...DISCONNECTED, state: "connecting" });
    try {
      const next = await connectExistingHermes(url, token);
      if (request === statusRequest.current) setStatus(next);
      return request === statusRequest.current;
    } catch (reason) {
      if (request === statusRequest.current) setStatus({ ...DISCONNECTED, state: "error", error: errorMessage(reason) });
      return false;
    }
  }

  async function disconnect() {
    const request = ++statusRequest.current;
    try {
      const next = await disconnectHermes();
      if (request === statusRequest.current) setStatus(next);
    } catch (reason) {
      if (request === statusRequest.current) setStatus((current) => ({ ...current, state: "error", error: errorMessage(reason) }));
    }
  }

  return { status, connectDiscovered, connectManaged, connectExisting, disconnect, refresh };
}
