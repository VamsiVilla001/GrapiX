import { ChevronDown, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { usePreferencesStore } from "../store/preferencesStore";
import { useDockStore } from "../store/dockStore";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";
import { AlignmentToolbar } from "./AlignmentToolbar";
import { PublishToPlayoutDialog } from "./PublishToPlayoutDialog";
import { HISTORY_SCOPE_LABELS } from "./HistoryControls";
import { describeHistoryStep } from "../lib/historyShortcut";

/** The zoom steps the dropdown offers. Ctrl+scroll is continuous between them. */
const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 200, 400];

export function ReferenceTopBar() {
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const saveScene = useEditorStore((state) => state.saveScene);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const hasTemplates = useTemplateStore((state) => state.templates.length > 0);
  const zoom = useUiStore((state) => state.zoom);
  const setZoom = useUiStore((state) => state.setZoom);
  const resetDockLayout = useDockStore((state) => state.resetDockLayout);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.redoStack.length > 0);
  const undoStep = useEditorStore((state) => state.undoStack.at(-1));
  const redoStep = useEditorStore((state) => state.redoStack.at(-1));
  const historyInFlight = useEditorStore((state) => Boolean(state.historyTransaction));
  const autosaveEnabled = usePreferencesStore((state) => state.preferences.autosave.enabled);


  return (
    <>
    <header className="reference-topbar">
      <div className="topbar-left">
        <div className="product-stack-mark" aria-hidden="true" />
        <strong>Live Graphics Editor</strong>
      </div>

      {/*
        Existing controls sit to the left in their original grouping and order, with the alignment
        tools added after them and a divider between: the two are different jobs, and an operator
        who has learnt where Undo is should not have to find it again.
      */}
      <div className="topbar-tools">
        {/* The tooltip names the step and the module that made it, because one history serves every
            panel and a keystroke may take back a change made somewhere else. */}
        <button
          className="topbar-icon"
          disabled={!canUndo && !historyInFlight}
          onClick={undo}
          title={historyInFlight
            ? "Cancel the change in progress (Ctrl+Z)"
            : `${describeHistoryStep("Undo", undoStep, HISTORY_SCOPE_LABELS)} (Ctrl+Z)`}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="topbar-icon"
          disabled={!canRedo}
          onClick={redo}
          title={`${describeHistoryStep("Redo", redoStep, HISTORY_SCOPE_LABELS)} (Ctrl+Shift+Z)`}
        >
          <Redo2 size={15} />
        </button>
        <span className="topbar-divider" />
        <select className="zoom-control" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} title="Viewport zoom — Ctrl+scroll over the canvas to zoom">
          {/*
            Ctrl+scroll produces any value in the range, not just a preset, so the current zoom
            is listed whenever it is not one of them. Without it the select matches no option and
            renders blank — the control would look broken exactly while it is being used.
          */}
          {!ZOOM_PRESETS.includes(zoom) ? <option value={zoom}>{zoom}%</option> : null}
          {ZOOM_PRESETS.map((preset) => (
            <option key={preset} value={preset}>{preset}%</option>
          ))}
        </select>
        <button className="topbar-icon" onClick={resetDockLayout} title="Reset docks">
          <RotateCcw size={15} />
        </button>
        <span className="topbar-divider" />
        <AlignmentToolbar />
      </div>

      {/*
        A Save button with no state cannot tell an operator whether their work is safe, which
        is the only question it exists to answer. The pill reports the real `saveStatus`, and
        names autosave when it is on so nobody assumes cover they have not enabled.
      */}
      <div className="topbar-right">
        <span
          className={`save-state save-state-${saveStatus}`}
          title={saveError ?? (autosaveEnabled ? "Autosave is on — Edit ▸ Preferences…" : "Autosave is off — Edit ▸ Preferences…")}
        >
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
              ? "Saved"
              : saveStatus === "error"
                ? "Not saved"
                : autosaveEnabled
                  ? "Unsaved · autosave on"
                  : "Unsaved"}
        </span>
        <button className="save-button" disabled={!hasActiveScene} onClick={() => void saveScene()}>Save</button>
        <button className="publish-button" disabled={!hasTemplates} onClick={() => setPublishDialogOpen(true)}>Publish <ChevronDown size={13} /></button>
      </div>
    </header>
      {publishDialogOpen ? <PublishToPlayoutDialog onClose={() => setPublishDialogOpen(false)} /> : null}
    </>
  );
}
