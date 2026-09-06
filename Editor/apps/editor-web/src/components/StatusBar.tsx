import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  useSupervisorStatus,
  type ProcessState,
  type ProcessStatus
} from "../hooks/useSupervisorStatus";
import { useApiHealth } from "../hooks/useApiHealth";
import { AssistantChip } from "./AssistantChip";
import { useEffect, useState } from "react";
import { onUiDiagnostic, uiDiagnostics } from "../lib/diagnostics";

export function StatusBar() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const zoom = useUiStore((state) => state.zoom);
  const supervisor = useSupervisorStatus();
  const apiHealth = useApiHealth();
  const selectedObject = useEditorStore((state) =>
    state.scene.objects.find((object) => object.id === state.selectedObjectId)
  );

  return (
    <footer className="status-bar">
      <span>{hasActiveScene ? `Scene: ${scene.name}` : "No scene open"}</span>
      <span>Selected: {selectedObject?.name ?? "None"}</span>
      <span>{hasActiveScene ? `${scene.canvas.width}x${scene.canvas.height}` : "—"}</span>
      <span>{hasActiveScene ? `${scene.timeline.fps}fps` : "—"}</span>
      <span>Zoom: {zoom}%</span>
      {supervisor ? (
        <>
          <ServiceChip process={supervisor.api} />
          <ServiceChip process={supervisor.engine} />
        </>
      ) : null}
      {apiHealth?.showMode === "read-only" ? (
        <span className="show-mode-lock" title="Project and asset editing is locked; playout controls and live-data patches remain available.">
          Show mode: read-only
        </span>
      ) : null}
      {supervisor ? (
        <span className="certification-warning" title={supervisor.certificationWarning}>
          Hardware: uncertified
        </span>
      ) : null}
      <AssistantChip />
      <ConsoleChip />
      <span className={`save-status ${saveStatus}`}>{saveStatusLabel(saveStatus, saveError)}</span>
    </footer>
  );
}

function saveStatusLabel(status: "local" | "saving" | "saved" | "error", error: string | null): string {
  if (status === "saving") {
    return "Autosave: Saving";
  }

  if (status === "saved") {
    return "Autosave: Saved";
  }

  if (status === "error") {
    return `Autosave: ${error ?? "Error"}`;
  }

  return "Autosave: Local draft";
}

/**
 * One process chip. It reports what the desktop shell can actually observe — reachability and
 * ownership — and nothing about Program: Program state belongs to Playout and the engine, and
 * a shell that guessed at it would give an operator a second, wrong truth.
 */
function ServiceChip({ process }: { process: ProcessStatus }) {
  const ownership = process.supervised ? "started by this Editor" : "not started by this Editor";
  return (
    <span
      className={`service-health ${serviceTone(process.state)}`}
      title={`${process.label} on ${process.address} — ${process.state}, ${ownership}${
        process.detail ? `: ${process.detail}` : ""
      }`}
    >
      {process.label}: {process.state}
    </span>
  );
}

function serviceTone(state: ProcessState): "healthy" | "degraded" | "fallback" {
  if (state === "online" || state === "adopted") return "healthy";
  if (state === "lost" || state === "failed") return "fallback";
  return "degraded";
}

/**
 * The console's door in the status bar. Quiet when nothing has failed; a red or amber count
 * when it has. Clicking toggles the drawer — the store lives outside React, so the chip
 * subscribes rather than polling.
 */
function ConsoleChip() {
  const [counts, setCounts] = useState(() => countLevels(uiDiagnostics()));

  useEffect(
    () => onUiDiagnostic(() => setCounts(countLevels(uiDiagnostics()))),
    []
  );

  const tone = counts.errors > 0 ? "has-errors" : counts.warnings > 0 ? "has-warnings" : "";
  const label =
    counts.errors > 0
      ? `Console: ${counts.errors} error${counts.errors === 1 ? "" : "s"}`
      : counts.warnings > 0
        ? `Console: ${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`
        : "Console";

  return (
    <button
      className={`console-chip-button ${tone}`}
      title="Open the diagnostics console (Ctrl+Alt+C)"
      onClick={() => window.dispatchEvent(new CustomEvent("grapix:toggle-console"))}
    >
      {label}
    </button>
  );
}

function countLevels(records: readonly { level: string }[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const record of records) {
    if (record.level === "error") errors += 1;
    else if (record.level === "warning") warnings += 1;
  }
  return { errors, warnings };
}
