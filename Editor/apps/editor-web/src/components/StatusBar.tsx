import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  useSupervisorStatus,
  type ProcessState,
  type ProcessStatus
} from "../hooks/useSupervisorStatus";
import { useApiHealth } from "../hooks/useApiHealth";
import { AssistantChip } from "./AssistantChip";

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
