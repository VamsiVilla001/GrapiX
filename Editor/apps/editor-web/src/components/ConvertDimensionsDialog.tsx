import {
  RESOLUTION_PRESET_INFO,
  type ResolutionPreset,
  type TemplateScene
} from "@grapix/shared-types";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import {
  CANVAS_CONVERSION_MODES,
  normalizeCanvasDimension,
  planCanvasConversion,
  type CanvasConversionMode
} from "../lib/convertSceneDimensions";
import { useProjectStore } from "../store/projectStore";

const MODE_INFO: Record<CanvasConversionMode, { label: string; detail: string }> = {
  fit: {
    label: "Scale content to fit",
    detail:
      "Everything is scaled by the smaller of the two ratios and centred, so nothing is distorted. When the aspect ratio changes, spare canvas appears on two sides."
  },
  stretch: {
    label: "Stretch content to fill",
    detail:
      "X and Y are scaled independently so the content fills the new canvas exactly. Circles become ellipses if the aspect ratio changes."
  },
  "canvas-only": {
    label: "Resize canvas only",
    detail:
      "Objects keep their pixel positions and sizes. A lower third 40 px from the bottom stays 40 px from the old bottom, which may now be off-canvas."
  }
};

/**
 * Convert one template's canvas to a different size.
 *
 * The Templates context menu has offered "Convert Dimensions…" since the panel was built; it
 * raised an alert saying the tooling was still to come. This is that tooling.
 *
 * Conversion is per template on purpose. `conformScene` already exists for the other direction —
 * dragging a stray scene back onto the project resolution — and it never touches objects because
 * repairing a canvas is not permission to move an operator's graphics. Converting is the opposite
 * situation: the author is asking for the content at another size, so what happens to the content
 * is the first question the dialog asks.
 */
export function ConvertDimensionsDialog(props: {
  template: TemplateScene;
  onClose: () => void;
  onApply: (request: { width: number; height: number; mode: CanvasConversionMode }) => void;
}) {
  const projectResolution = useProjectStore((state) => state.settings.resolution);
  const canvas = props.template.scene.canvas;

  const [width, setWidth] = useState(String(canvas.width));
  const [height, setHeight] = useState(String(canvas.height));
  const [mode, setMode] = useState<CanvasConversionMode>("fit");
  const [lockAspect, setLockAspect] = useState(false);

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [props]);

  const sourceAspect = canvas.width / Math.max(1, canvas.height);

  function applyPreset(preset: ResolutionPreset) {
    setWidth(String(preset.width));
    setHeight(String(preset.height));
  }

  function changeWidth(value: string) {
    setWidth(value);
    if (!lockAspect) return;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      setHeight(String(normalizeCanvasDimension(parsed / sourceAspect, canvas.height)));
    }
  }

  function changeHeight(value: string) {
    setHeight(value);
    if (!lockAspect) return;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      setWidth(String(normalizeCanvasDimension(parsed * sourceAspect, canvas.width)));
    }
  }

  const plan = useMemo(
    () =>
      planCanvasConversion(props.template.scene, {
        width: Number(width),
        height: Number(height),
        mode
      }),
    [height, mode, props.template.scene, width]
  );

  const matchesProject =
    plan.to.width === projectResolution.width && plan.to.height === projectResolution.height;
  const aspectChanges =
    Math.abs(plan.to.width / plan.to.height - plan.from.width / plan.from.height) > 0.001;
  const objectCount = props.template.scene.objects.length;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!plan.changed) {
      props.onClose();
      return;
    }
    props.onApply({ width: plan.to.width, height: plan.to.height, mode });
    props.onClose();
  }

  return createPortal(
    <div className="material-dialog-backdrop" role="presentation" onClick={props.onClose}>
      <form
        className="material-dialog project-settings-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header className="material-dialog-header">
          <h2>Convert Dimensions — {props.template.name}</h2>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="material-dialog-body project-settings-body">
          <fieldset className="project-fieldset">
            <legend>New canvas</legend>

            <div className="project-preset-row">
              {Object.values(RESOLUTION_PRESET_INFO).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={
                    plan.to.width === preset.width && plan.to.height === preset.height
                      ? "small-button preset-active"
                      : "small-button"
                  }
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="project-dimension-row">
              <label className="project-field">
                <span>Width</span>
                <input
                  aria-label="New canvas width"
                  value={width}
                  inputMode="numeric"
                  onChange={(event) => changeWidth(event.target.value)}
                />
              </label>
              <span className="project-times">×</span>
              <label className="project-field">
                <span>Height</span>
                <input
                  aria-label="New canvas height"
                  value={height}
                  inputMode="numeric"
                  onChange={(event) => changeHeight(event.target.value)}
                />
              </label>
              <label className="convert-lock-field">
                <input
                  type="checkbox"
                  checked={lockAspect}
                  onChange={(event) => setLockAspect(event.target.checked)}
                />
                Lock aspect
              </label>
            </div>

            <p className="project-hint">
              {plan.from.width} × {plan.from.height} → <strong>{plan.to.width} × {plan.to.height}</strong>
              {plan.changed ? "" : " — no change"}
              {". Dimensions are rounded up to even numbers because odd sizes break 4:2:0 chroma subsampling."}
            </p>
          </fieldset>

          <fieldset className="project-fieldset">
            <legend>Content ({objectCount} object{objectCount === 1 ? "" : "s"})</legend>
            {CANVAS_CONVERSION_MODES.map((candidate) => (
              <label className="convert-mode-row" key={candidate}>
                <input
                  type="radio"
                  name="conversion-mode"
                  value={candidate}
                  checked={mode === candidate}
                  onChange={() => setMode(candidate)}
                />
                <span>
                  <strong>{MODE_INFO[candidate].label}</strong>
                  <small>{MODE_INFO[candidate].detail}</small>
                </span>
              </label>
            ))}
            {mode !== "canvas-only" && plan.changed ? (
              <p className="project-hint">
                Geometry is scaled by {plan.scaleX.toFixed(4)} × {plan.scaleY.toFixed(4)}. Rotations,
                opacity and the object scale factors are left as authored; keyframe timings do not
                move, only the pixel values on the X, Y and depth channels.
              </p>
            ) : null}
            {mode === "stretch" && aspectChanges ? (
              <p className="project-hint">
                The aspect ratio changes, so stretching distorts every object. Fit is usually the
                honest choice unless the design was made to fill the frame.
              </p>
            ) : null}
          </fieldset>

          {plan.changed && !matchesProject ? (
            <fieldset className="project-fieldset project-mismatch">
              <legend>Leaves the project resolution</legend>
              <p className="project-hint">
                The project is {projectResolution.width} × {projectResolution.height}. Scenes at
                different resolutions cannot be cut between on air, and this template will be listed
                under "Scenes needing conforming" in Project Settings until it matches again.
              </p>
            </fieldset>
          ) : null}
        </div>

        <footer className="material-dialog-footer">
          <button type="button" className="small-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="small-button primary" disabled={!plan.changed}>
            Convert
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
