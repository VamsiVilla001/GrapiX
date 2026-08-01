import { ChevronDown, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { saveSceneToApi } from "../lib/apiClient";
import { useDockStore } from "../store/dockStore";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";
import { PublishToPlayoutDialog } from "./PublishToPlayoutDialog";

export function ReferenceTopBar() {
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const setSaveStatus = useEditorStore((state) => state.setSaveStatus);
  const hasTemplates = useTemplateStore((state) => state.templates.length > 0);
  const zoom = useUiStore((state) => state.zoom);
  const setZoom = useUiStore((state) => state.setZoom);
  const resetDockLayout = useDockStore((state) => state.resetDockLayout);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.redoStack.length > 0);

  async function saveScene() {
    if (!hasActiveScene) return;
    try {
      setSaveStatus("saving");
      await saveSceneToApi(scene);
      setSaveStatus("saved");
    } catch (error) {
      setSaveStatus("error", error instanceof Error ? error.message : "Save failed");
    }
  }


  return (
    <>
    <header className="reference-topbar">
      <div className="topbar-left">
        <div className="product-stack-mark" aria-hidden="true" />
        <strong>Live Graphics Editor</strong>
      </div>

      <div className="topbar-center">
        <button className="topbar-icon" disabled={!canUndo} onClick={undo} title="Undo"><Undo2 size={15} /></button>
        <button className="topbar-icon" disabled={!canRedo} onClick={redo} title="Redo"><Redo2 size={15} /></button>
        <span className="topbar-divider" />
        <select className="zoom-control" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} title="Viewport zoom">
          <option value={50}>50%</option>
          <option value={75}>75%</option>
          <option value={100}>100%</option>
          <option value={125}>125%</option>
          <option value={150}>150%</option>
        </select>
        <button className="topbar-icon" onClick={resetDockLayout} title="Reset docks">
          <RotateCcw size={15} />
        </button>
      </div>

      <div className="topbar-right">
        <button className="save-button" disabled={!hasActiveScene} onClick={() => void saveScene()}>Save</button>
        <button className="publish-button" disabled={!hasTemplates} onClick={() => setPublishDialogOpen(true)}>Publish <ChevronDown size={13} /></button>
      </div>
    </header>
      {publishDialogOpen ? <PublishToPlayoutDialog onClose={() => setPublishDialogOpen(false)} /> : null}
    </>
  );
}
