import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** Mirrors `SupervisorSnapshot` in Editor/apps/desktop-tauri/src-tauri/src/supervisor.rs. */
export type ProcessState =
  | "idle"
  | "starting"
  | "online"
  | "adopted"
  | "lost"
  | "failed";

export interface ProcessStatus {
  label: string;
  address: string;
  state: ProcessState;
  detail?: string | null;
  /** True when the desktop shell owns the process and stops it on close. */
  supervised: boolean;
}

export interface SupervisorStatus {
  /** The Editor's own project/asset service. */
  api: ProcessStatus;
  /** The AI assistant broker (owned, Editor-only). Optional in the payload for older shells. */
  assistant?: ProcessStatus;
  /**
   * The render engine. Ensured, never owned: Program outlives the Editor window, so the
   * shell starts an engine when none is running and then leaves it alone.
   */
  engine: ProcessStatus;
  ready: boolean;
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
