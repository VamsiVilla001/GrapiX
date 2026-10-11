import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

export function StatusBar() {
  const scene = useEditorStore((state) => state.scene);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const zoom = useUiStore((state) => state.zoom);
  const selectedObject = useEditorStore((state) =>
    state.scene.objects.find((object) => object.id === state.selectedObjectId)
  );

  return (
    <footer className="status-bar">
      <span>Scene: {scene.name}</span>
      <span>Selected: {selectedObject?.name ?? "None"}</span>
      <span>{scene.canvas.width}x{scene.canvas.height}</span>
      <span>60fps</span>
      <span>Zoom: {zoom}%</span>
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
