import {
  Camera,
  Image,
  MousePointer2,
  Move,
  Shapes,
  Type,
  ZoomIn
} from "lucide-react";
import { useEditorStore } from "../store/editorStore";

export function TopToolbar() {
  const addTextObject = useEditorStore((state) => state.addTextObject);
  const addRectObject = useEditorStore((state) => state.addRectObject);
  const addImageObject = useEditorStore((state) => state.addImageObject);

  return (
    <div className="top-toolbar" aria-label="Main toolbar">
      <button className="toolbar-icon-button active" title="Select tool"><MousePointer2 size={16} /></button>
      <button className="toolbar-icon-button" title="Move tool"><Move size={16} /></button>
      <button className="toolbar-icon-button" title="Text tool" onClick={addTextObject}><Type size={16} /></button>
      <button className="toolbar-icon-button" title="Image tool" onClick={addImageObject}><Image size={16} /></button>
      <button className="toolbar-icon-button" title="Shape tool" onClick={addRectObject}><Shapes size={16} /></button>
      <button className="toolbar-icon-button" title="Camera tool"><Camera size={16} /></button>
      <span className="toolbar-separator" />
      <button className="toolbar-icon-button" title="Zoom fit"><ZoomIn size={16} /></button>
    </div>
  );
}
