import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export interface SupervisorStatus {
  apiHealthy: boolean;
  rendererHealthy: boolean;
  outputHealthy: boolean;
  fallbackActive: boolean;
  fallbackReason?: string | null;
  restartCount: number;
  consecutiveFailures: number;
  lastHeartbeatAtMs?: number | null;
  lastFrameCount?: number | null;
  programSceneId?: string | null;
  outputState?: string | null;
  rendererLastError?: string | null;
  gpuAdapter?: string | null;
  gpuBackend?: string | null;
  maxTextureDimension?: number | null;
  certificationWarning: string;
}

export function useSupervisorStatus(): SupervisorStatus | null {
  const [status, setStatus] = useState<SupervisorStatus | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return undefined;
    }

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void invoke<SupervisorStatus>("supervisor_status").then((initial) => {
      if (!cancelled) setStatus(initial);
    });
    void listen<SupervisorStatus>("grapix-supervisor-status", (event) => {
      if (!cancelled) setStatus(event.payload);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return status;
}
