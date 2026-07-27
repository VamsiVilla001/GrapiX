import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import { useSupervisorStatus } from "../hooks/useSupervisorStatus";
import { useApiHealth } from "../hooks/useApiHealth";

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
        <span
          className={`program-health ${
            supervisor.fallbackActive
              ? "fallback"
              : supervisor.rendererHealthy && supervisor.outputHealthy
                ? "healthy"
                : "degraded"
          }`}
          title={supervisor.fallbackReason ?? supervisor.rendererLastError ?? "Native Program renderer health"}
        >
          {supervisor.fallbackActive
            ? `Program fallback: ${supervisor.fallbackReason ?? "active"}`
            : supervisor.rendererHealthy
              ? `Program ${supervisor.outputState ?? "ready"} · frame ${supervisor.lastFrameCount ?? 0}`
              : "Program renderer starting"}
        </span>
      ) : null}
      {apiHealth?.showMode === "read-only" ? (
        <span className="show-mode-lock" title="Project and asset editing is locked; playout controls and live-data patches remain available.">
          Show mode: read-only
        </span>
      ) : null}
      {supervisor ? (
        <span
          className="certification-warning"
          title={`${supervisor.certificationWarning} ${supervisor.gpuAdapter ?? "GPU unknown"} · ${supervisor.gpuBackend ?? "backend unknown"}`}
        >
          Hardware: uncertified
        </span>
      ) : null}
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
