import type { CanvasMargins } from "@grapix/shared-types";
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../store/editorStore";

export function ProjectViewportDialog({ onClose }: { onClose: () => void }) {
  const canvas = useEditorStore((state) => state.scene.canvas);
  const updateCanvasViewport = useEditorStore((state) => state.updateCanvasViewport);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const current = canvas.editorViewport;
  const [showRulers, setShowRulers] = useState(current?.showRulers ?? true);
  const [margins, setMargins] = useState<CanvasMargins>(current?.margins ?? {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  });
  const [clearGuides, setClearGuides] = useState(false);

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  function setMargin(side: keyof CanvasMargins, value: number) {
    const maximum = side === "top" || side === "bottom" ? canvas.height : canvas.width;
    setMargins((previous) => ({
      ...previous,
      [side]: Math.min(maximum, Math.max(0, Number.isFinite(value) ? Math.round(value) : 0))
    }));
  }

  function applyPreset(percent: number) {
    setMargins({
      top: Math.round(canvas.height * percent),
      right: Math.round(canvas.width * percent),
      bottom: Math.round(canvas.height * percent),
      left: Math.round(canvas.width * percent)
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    beginHistory("viewport settings");
    updateCanvasViewport({
      showRulers,
      margins,
      ...(clearGuides ? { guides: [] } : {})
    });
    commitHistory();
    onClose();
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form
        className="material-create-dialog project-viewport-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-viewport-title"
      >
        <header>
          <strong id="project-viewport-title">Project Viewport</strong>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>
        <label className="viewport-ruler-option">
          <input
            type="checkbox"
            checked={showRulers}
            onChange={(event) => setShowRulers(event.target.checked)}
          />
          Show canvas rulers and guides
        </label>
        <fieldset>
          <legend>Viewport safe margins (scene pixels)</legend>
          <div className="viewport-margin-grid">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <label key={side}>
                <span>{side[0].toUpperCase() + side.slice(1)}</span>
                <input
                  aria-label={`${side} viewport margin`}
                  min={0}
                  max={side === "top" || side === "bottom" ? canvas.height : canvas.width}
                  type="number"
                  value={margins[side]}
                  onChange={(event) => setMargin(side, event.target.valueAsNumber)}
                />
              </label>
            ))}
          </div>
          <div className="viewport-margin-presets">
            <button type="button" onClick={() => applyPreset(0)}>None</button>
            <button type="button" onClick={() => applyPreset(0.05)}>Action safe 5%</button>
            <button type="button" onClick={() => applyPreset(0.1)}>Title safe 10%</button>
          </div>
        </fieldset>
        <p className="material-dialog-note">
          Drag from either ruler to add a guide. Drag a guide outside the canvas
          to remove it. Margins and guides are saved with this project.
        </p>
        <label className="viewport-ruler-option">
          <input
            type="checkbox"
            checked={clearGuides}
            disabled={!current?.guides.length}
            onChange={(event) => setClearGuides(event.target.checked)}
          />
          Remove all {current?.guides.length ?? 0} project guides
        </label>
        <footer>
          <button onClick={onClose} type="button">Cancel</button>
          <button className="primary" type="submit">Apply</button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
