import {
  PROJECT_COLOR_SPACES,
  PROJECT_COLOR_SPACE_INFO,
  RESOLUTION_PRESET_INFO,
  findResolutionMismatches,
  type ProjectColorSpace,
  type ResolutionPresetId
} from "@grapix/shared-types";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { conformScene, useProjectStore } from "../store/projectStore";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";

const FRAME_RATE_OPTIONS: { label: string; numerator: number; denominator: number }[] = [
  { label: "23.976", numerator: 24_000, denominator: 1_001 },
  { label: "24", numerator: 24, denominator: 1 },
  { label: "25", numerator: 25, denominator: 1 },
  { label: "29.97", numerator: 30_000, denominator: 1_001 },
  { label: "30", numerator: 30, denominator: 1 },
  { label: "50", numerator: 50, denominator: 1 },
  { label: "59.94", numerator: 60_000, denominator: 1_001 },
  { label: "60", numerator: 60, denominator: 1 }
];

/**
 * Project settings: resolution, colour space, frame rate, safe area.
 *
 * These govern the whole project. Changing the resolution affects every scene, so
 * the dialog names the scenes that would need conforming and makes conforming an
 * explicit action rather than a side effect.
 *
 * Pixel aspect ratio is not editable. Project pixels are square; non-square
 * delivery is configured on the output, and saying so in the UI is clearer than
 * offering a control that must always be 1.
 */
export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useProjectStore((state) => state.settings);
  const validation = useProjectStore((state) => state.validation);
  const applyPreset = useProjectStore((state) => state.applyPreset);
  const setResolution = useProjectStore((state) => state.setResolution);
  const setColorSpace = useProjectStore((state) => state.setColorSpace);
  const setPeakLuminance = useProjectStore((state) => state.setPeakLuminance);
  const setFrameRate = useProjectStore((state) => state.setFrameRate);
  const setSafeAreaPercent = useProjectStore((state) => state.setSafeAreaPercent);
  const setProjectName = useProjectStore((state) => state.setProjectName);

  const scene = useEditorStore((state) => state.scene);
  const loadScene = useEditorStore((state) => state.loadScene);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const templates = useTemplateStore((state) => state.templates);

  const [name, setName] = useState(settings.name);
  const [width, setWidth] = useState(String(settings.resolution.width));
  const [height, setHeight] = useState(String(settings.resolution.height));
  const [peak, setPeak] = useState(String(settings.peakLuminanceNits ?? 1_000));
  const [safePercent, setSafePercent] = useState(
    String(Math.round(settings.safeAreaPercent * 100))
  );

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  // Reflect store changes back into the fields, so a preset click updates them.
  useEffect(() => {
    setWidth(String(settings.resolution.width));
    setHeight(String(settings.resolution.height));
  }, [settings.resolution.width, settings.resolution.height]);

  const colorInfo = PROJECT_COLOR_SPACE_INFO[settings.colorSpace];

  /** Scenes and templates whose canvas does not match the project. */
  const mismatches = useMemo(() => {
    const candidates = [
      { id: scene.id, name: scene.name, canvas: scene.canvas },
      ...templates.map((template) => ({
        id: template.scene.id,
        name: template.name,
        canvas: template.scene.canvas
      }))
    ];
    // Deduplicate: the open scene is usually also a template.
    const seen = new Set<string>();
    const unique = candidates.filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    });
    return findResolutionMismatches(settings, unique);
  }, [scene, templates, settings]);

  function commitDimensions() {
    const parsedWidth = Number(width);
    const parsedHeight = Number(height);
    if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight)) return;
    setResolution(parsedWidth, parsedHeight);
  }

  function conformOpenScene() {
    beginHistory("conform scene to project resolution");
    loadScene(conformScene(scene, settings));
    commitHistory();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    commitDimensions();
    setProjectName(name);
    onClose();
  }

  const errors = validation.issues.filter((issue) => issue.severity === "error");
  const warnings = validation.issues.filter((issue) => issue.severity === "warning");

  return createPortal(
    <div className="material-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="material-dialog project-settings-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header className="material-dialog-header">
          <h2>Project Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="material-dialog-body project-settings-body">
          <label className="project-field">
            <span>Project name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <fieldset className="project-fieldset">
            <legend>Resolution</legend>
            <p className="project-hint">
              Governs every scene canvas and every viewport in this project. Scenes at
              different resolutions cannot be cut between on air.
            </p>

            <div className="project-preset-row">
              {Object.values(RESOLUTION_PRESET_INFO).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={
                    settings.resolution.preset === preset.id
                      ? "small-button preset-active"
                      : "small-button"
                  }
                  onClick={() => applyPreset(preset.id as ResolutionPresetId)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="project-dimension-row">
              <label className="project-field">
                <span>Width</span>
                <input
                  value={width}
                  inputMode="numeric"
                  onChange={(event) => setWidth(event.target.value)}
                  onBlur={commitDimensions}
                />
              </label>
              <span className="project-times">×</span>
              <label className="project-field">
                <span>Height</span>
                <input
                  value={height}
                  inputMode="numeric"
                  onChange={(event) => setHeight(event.target.value)}
                  onBlur={commitDimensions}
                />
              </label>
              <button type="button" className="small-button" onClick={commitDimensions}>
                Apply
              </button>
            </div>

            <p className="project-hint">
              Pixels are square (pixel aspect ratio 1). Anamorphic and non-square
              delivery is configured on the output, not in authoring. Dimensions are
              rounded up to even numbers because odd sizes break 4:2:0 chroma
              subsampling.
            </p>
          </fieldset>

          <fieldset className="project-fieldset">
            <legend>Colour space</legend>
            <div className="project-colour-row">
              {PROJECT_COLOR_SPACES.map((id) => {
                const info = PROJECT_COLOR_SPACE_INFO[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className={
                      settings.colorSpace === id ? "small-button preset-active" : "small-button"
                    }
                    onClick={() => setColorSpace(id as ProjectColorSpace)}
                  >
                    {info.label}
                  </button>
                );
              })}
            </div>
            <p className="project-hint">
              <strong>{colorInfo.label}</strong> — {colorInfo.primaries} primaries,{" "}
              {colorInfo.transferFunction}. {colorInfo.description}
            </p>

            {colorInfo.highDynamicRange && (
              <label className="project-field">
                <span>Peak luminance (nits)</span>
                <input
                  value={peak}
                  inputMode="numeric"
                  onChange={(event) => setPeak(event.target.value)}
                  onBlur={() => {
                    const parsed = Number(peak);
                    setPeakLuminance(Number.isFinite(parsed) ? parsed : 1_000);
                  }}
                />
              </label>
            )}
          </fieldset>

          <fieldset className="project-fieldset">
            <legend>Timing and guides</legend>
            <div className="project-dimension-row">
              <label className="project-field">
                <span>Frame rate</span>
                <select
                  value={`${settings.frameRate.numerator}/${settings.frameRate.denominator}`}
                  onChange={(event) => {
                    const [numerator, denominator] = event.target.value.split("/").map(Number);
                    setFrameRate({ numerator, denominator });
                  }}
                >
                  {FRAME_RATE_OPTIONS.map((option) => (
                    <option
                      key={option.label}
                      value={`${option.numerator}/${option.denominator}`}
                    >
                      {option.label} fps
                    </option>
                  ))}
                </select>
              </label>
              <label className="project-field">
                <span>Safe area (%)</span>
                <input
                  value={safePercent}
                  inputMode="numeric"
                  onChange={(event) => setSafePercent(event.target.value)}
                  onBlur={() => {
                    const parsed = Number(safePercent);
                    setSafeAreaPercent(Number.isFinite(parsed) ? parsed / 100 : 0.05);
                  }}
                />
              </label>
            </div>
            <p className="project-hint">
              Broadcast rates are stored exactly: 29.97 is 30000/1001, never the
              decimal.
            </p>
          </fieldset>

          {mismatches.length > 0 && (
            <fieldset className="project-fieldset project-mismatch">
              <legend>Scenes needing conforming ({mismatches.length})</legend>
              <ul className="project-mismatch-list">
                {mismatches.slice(0, 8).map((mismatch) => (
                  <li key={mismatch.sceneId}>
                    {mismatch.sceneName} — {mismatch.sceneWidth} × {mismatch.sceneHeight}
                  </li>
                ))}
                {mismatches.length > 8 && <li>…and {mismatches.length - 8} more</li>}
              </ul>
              <p className="project-hint">
                Conforming changes the canvas only. Object positions are left alone, so
                a lower third stays where it was placed rather than being scaled.
              </p>
              <button type="button" className="small-button" onClick={conformOpenScene}>
                Conform the open scene
              </button>
            </fieldset>
          )}

          {errors.length > 0 && (
            <ul className="project-issues project-issues-error">
              {errors.map((issue) => (
                <li key={issue.code}>{issue.message}</li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="project-issues project-issues-warning">
              {warnings.map((issue) => (
                <li key={issue.code}>{issue.message}</li>
              ))}
            </ul>
          )}
        </div>

        <footer className="material-dialog-footer">
          <button type="button" className="small-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="small-button primary" disabled={errors.length > 0}>
            Apply
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
