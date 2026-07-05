import { Circle, Copy, Image, Square, Trash2, Type } from "lucide-react";
import { useEditorStore } from "../store/editorStore";

export function LeftRail() {
  const addTextObject = useEditorStore((state) => state.addTextObject);
  const addRectObject = useEditorStore((state) => state.addRectObject);
  const addEllipseObject = useEditorStore((state) => state.addEllipseObject);
  const addImageObject = useEditorStore((state) => state.addImageObject);
  const duplicateSelectedObject = useEditorStore((state) => state.duplicateSelectedObject);
  const deleteSelectedObject = useEditorStore((state) => state.deleteSelectedObject);
  const hasSelection = useEditorStore((state) => Boolean(state.selectedObjectId));

  return (
    <aside className="left-rail" aria-label="Editor tools">
      <button className="tool-button" onClick={addTextObject} title="Add text">
        <Type size={20} aria-hidden="true" />
      </button>
      <button className="tool-button" onClick={addRectObject} title="Add rectangle">
        <Square size={20} aria-hidden="true" />
      </button>
      <button className="tool-button" onClick={addEllipseObject} title="Add ellipse">
        <Circle size={20} aria-hidden="true" />
      </button>
      <button className="tool-button" onClick={addImageObject} title="Add image">
        <Image size={20} aria-hidden="true" />
      </button>
      <div className="rail-divider" />
      <button
        className="tool-button"
        onClick={duplicateSelectedObject}
        disabled={!hasSelection}
        title="Duplicate selected object"
      >
        <Copy size={20} aria-hidden="true" />
      </button>
      <button
        className="tool-button danger"
        onClick={deleteSelectedObject}
        disabled={!hasSelection}
        title="Delete selected object"
      >
        <Trash2 size={20} aria-hidden="true" />
      </button>
    </aside>
  );
}
