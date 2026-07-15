import {
  ChevronDown,
  HelpCircle,
  Menu,
  MessageSquare,
  Redo2,
  RotateCcw,
  Search,
  Settings,
  Undo2
} from "lucide-react";
import { useEffect } from "react";
import { publishSavedSceneOnApi, saveSceneToApi } from "../lib/apiClient";
import { useDockStore } from "../store/dockStore";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

export function ReferenceTopBar() {
  const scene = useEditorStore((state) => state.scene);
  const setSaveStatus = useEditorStore((state) => state.setSaveStatus);
  const zoom = useUiStore((state) => state.zoom);
  const setZoom = useUiStore((state) => state.setZoom);
  const resetDockLayout = useDockStore((state) => state.resetDockLayout);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.redoStack.length > 0);

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [redo, undo]);

  async function saveScene() {
    try {
      setSaveStatus("saving");
      await saveSceneToApi(scene);
      setSaveStatus("saved");
    } catch (error) {
      setSaveStatus("error", error instanceof Error ? error.message : "Save failed");
    }
  }

  async function publishScene() {
    try {
      await saveSceneToApi(scene);
      const result = await publishSavedSceneOnApi(scene.id);
      window.alert(result.package ? `Published ${result.package.fileName}` : "Publish blocked by preflight.");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Publish failed");
    }
  }

  return (
    <header className="reference-topbar">
      <div className="topbar-left">
        <button className="topbar-icon" disabled title="Main menu coming later"><Menu size={20} /></button>
        <div className="product-stack-mark" aria-hidden="true" />
        <strong>Live Graphics Editor</strong>
        <span className="topbar-divider" />
        <button className="project-selector" disabled title="Project switcher coming later">
          Sports Package v3
          <ChevronDown size={15} />
        </button>
        <span className="scene-dot" />
        <button className="project-selector" disabled title="Scene switcher coming later">
          {scene.name}
          <ChevronDown size={15} />
        </button>
      </div>

      <div className="topbar-center">
        <button className="topbar-icon" disabled={!canUndo} onClick={undo} title="Undo material action (Ctrl+Z)"><Undo2 size={17} /></button>
        <button className="topbar-icon muted" disabled={!canRedo} onClick={redo} title="Redo material action (Ctrl+Shift+Z)"><Redo2 size={17} /></button>
        <span className="topbar-divider" />
        <select className="zoom-control" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
          <option value={50}>50%</option>
          <option value={75}>75%</option>
          <option value={100}>100%</option>
          <option value={125}>125%</option>
          <option value={150}>150%</option>
        </select>
        <button className="topbar-icon" onClick={resetDockLayout} title="Reset docks">
          <RotateCcw size={17} />
        </button>
        <button className="topbar-icon" disabled title="Search coming later"><Search size={17} /></button>
      </div>

      <div className="topbar-right">
        <button className="topbar-icon" disabled title="Comments coming later"><MessageSquare size={17} /></button>
        <button className="topbar-icon" disabled title="Help coming later"><HelpCircle size={17} /></button>
        <button className="topbar-icon" disabled title="Settings coming later"><Settings size={17} /></button>
        <button className="save-button" onClick={() => void saveScene()}>Save</button>
        <button className="publish-button" onClick={() => void publishScene()}>Publish <ChevronDown size={14} /></button>
      </div>
    </header>
  );
}
