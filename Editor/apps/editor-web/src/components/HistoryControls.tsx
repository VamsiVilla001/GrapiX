import { Redo2, Undo2 } from "lucide-react";
import { useEditorStore } from "../store/editorStore";
import { describeHistoryStep } from "../lib/historyShortcut";

/**
 * Human names for the modules that appear in a history step's tooltip.
 *
 * Keyed by the same ids the dock uses, including the legacy `scene-manager` id whose panel is called
 * Object Manager, so a tooltip never shows an internal id to an author.
 */
export const HISTORY_SCOPE_LABELS: Readonly<Record<string, string>> = {
  "scene-manager": "Object Manager",
  "object-inspector": "Object Inspector",
  "object-library": "Object Library",
  "material-manager": "Material Manager",
  "font-manager": "Font Manager",
  automation: "Scene Automation",
  timeline: "Timeline",
  templates: "Templates",
  canvas: "Canvas",
  project: "Project"
};

/**
 * Undo/redo for the open scene, placed inside a module.
 *
 * There is **one** history for the document and this drives it — the same history the menu, the top
 * bar and Ctrl+Z drive. What makes the control module-*level* is not a private stack (see
 * `SceneHistoryEntry`: separate stacks over one shared document revert each other's work) but that
 * it names the step it will take back, including which module made it. So an author working in the
 * Material Manager who presses its undo sees "Undo Object Manager · Delete 3 objects" if that was
 * the last change, rather than watching something disappear with no explanation.
 */
export function HistoryControls(props: { compact?: boolean }) {
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const undoStep = useEditorStore((state) => state.undoStack.at(-1));
  const redoStep = useEditorStore((state) => state.redoStack.at(-1));
  const inFlight = useEditorStore((state) => Boolean(state.historyTransaction));

  // A gesture in flight is always undoable: Ctrl+Z abandons it. Offering a disabled button while a
  // drag is open would say the opposite.
  const undoTitle = inFlight
    ? "Cancel the change in progress (Ctrl+Z)"
    : `${describeHistoryStep("Undo", undoStep, HISTORY_SCOPE_LABELS)} (Ctrl+Z)`;

  return (
    <div className={`history-controls ${props.compact ? "compact" : ""}`} aria-label="Scene history">
      <button
        aria-label={undoTitle}
        disabled={!undoStep && !inFlight}
        onClick={undo}
        title={undoTitle}
        type="button"
      >
        <Undo2 size={13} />
      </button>
      <button
        aria-label={`${describeHistoryStep("Redo", redoStep, HISTORY_SCOPE_LABELS)} (Ctrl+Shift+Z)`}
        disabled={!redoStep}
        onClick={redo}
        title={`${describeHistoryStep("Redo", redoStep, HISTORY_SCOPE_LABELS)} (Ctrl+Shift+Z)`}
        type="button"
      >
        <Redo2 size={13} />
      </button>
    </div>
  );
}
