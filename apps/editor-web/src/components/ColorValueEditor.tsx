import {
  createSceneId,
  normalizeColorValue,
  type ColorValue,
  type GradientStop
} from "@grapix/shared-types";
import { useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { BUILT_IN_GRADIENT_PRESETS } from "../tools/designToolMath";

type GradientValue = Extract<ColorValue, { type: "linear-gradient" | "radial-gradient" }>;

export function ColorValueEditor(props: {
  label: string;
  value: ColorValue | string | undefined;
  fallback: string;
  onChange: (value: ColorValue) => void;
}) {
  const scenePresets = useEditorStore((state) => state.scene.gradientPresets ?? []);
  const saveGradientPreset = useEditorStore((state) => state.saveGradientPreset);
  const updateGradientPreset = useEditorStore((state) => state.updateGradientPreset);
  const duplicateGradientPreset = useEditorStore((state) => state.duplicateGradientPreset);
  const deleteGradientPreset = useEditorStore((state) => state.deleteGradientPreset);
  const [presetName, setPresetName] = useState("");
  const value = normalizeColorValue(props.value, props.fallback);
  const presets = [...BUILT_IN_GRADIENT_PRESETS, ...scenePresets];

  function setType(type: ColorValue["type"]) {
    if (type === "none") props.onChange({ type: "none" });
    else if (type === "solid") props.onChange({ type: "solid", color: firstColor(value, props.fallback) });
    else props.onChange(makeGradient(type, firstColor(value, props.fallback)));
  }

  function patchGradient(patch: Partial<GradientValue>) {
    if (!isGradient(value)) return;
    props.onChange({ ...value, ...patch } as GradientValue);
  }

  function patchStop(id: string, patch: Partial<GradientStop>) {
    if (!isGradient(value)) return;
    patchGradient({
      stops: value.stops
        .map((stop) => stop.id === id ? { ...stop, ...patch } : stop)
        .sort((left, right) => left.position - right.position)
    });
  }

  function addStop() {
    if (!isGradient(value)) return;
    const position = largestGapMidpoint(value.stops);
    const color = nearestStop(value.stops, position)?.color ?? props.fallback;
    patchGradient({
      stops: [...value.stops, { id: createSceneId("stop"), position, color, opacity: 1 }]
        .sort((left, right) => left.position - right.position)
    });
  }

  function duplicateStop(stop: GradientStop) {
    if (!isGradient(value)) return;
    const ordered = [...value.stops].sort((left, right) => left.position - right.position);
    const index = ordered.findIndex((item) => item.id === stop.id);
    const nextPosition = ordered[index + 1]?.position ?? 1;
    const position = nextPosition > stop.position
      ? stop.position + (nextPosition - stop.position) / 2
      : Math.max(0, stop.position - 0.01);
    patchGradient({
      stops: [
        ...value.stops,
        { ...stop, id: createSceneId("stop"), position }
      ].sort((left, right) => left.position - right.position)
    });
  }

  return (
    <div className="color-value-editor">
      <div className="color-value-heading">
        <strong>{props.label}</strong>
        <div className="color-kind-tabs">
          {(["none", "solid", "linear-gradient", "radial-gradient"] as const).map((type) => (
            <button className={value.type === type ? "active" : ""} key={type} onClick={() => setType(type)} type="button">
              {type === "linear-gradient" ? "Linear" : type === "radial-gradient" ? "Radial" : capitalize(type)}
            </button>
          ))}
        </div>
      </div>

      {value.type === "solid" ? (
        <label className="gradient-compact-field">
          <input type="color" value={sixDigitHex(value.color)} onChange={(event) => props.onChange({ type: "solid", color: event.target.value })} />
          <input value={value.color} onChange={(event) => props.onChange({ type: "solid", color: event.target.value })} />
        </label>
      ) : null}

      {isGradient(value) ? (
        <>
          <div
            className="gradient-preview"
            style={{
              backgroundImage: `${cssGradient(value)}, repeating-conic-gradient(#d9d9d9 0 25%, #ffffff 0 50%)`,
              backgroundSize: "auto, 12px 12px"
            }}
          />
          <div className="gradient-preset-row">
            <select onChange={(event) => {
              const preset = presets.find((item) => item.presetId === event.target.value);
              if (preset) props.onChange(structuredClone(preset.value));
            }} value="">
              <option value="">Apply preset</option>
              {presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.name}</option>)}
            </select>
            <input placeholder="Preset name" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
            <button onClick={() => {
              saveGradientPreset(presetName, structuredClone(value));
              setPresetName("");
            }} type="button">Save</button>
          </div>
          <div className="gradient-actions">
            <button onClick={addStop} type="button">Add stop</button>
            <button onClick={() => patchGradient({
              stops: value.stops.map((stop) => ({ ...stop, position: 1 - stop.position })).reverse()
            })} type="button">Reverse</button>
            <button onClick={() => patchGradient({
              stops: value.stops.map((stop, index, all) => ({ ...stop, position: all.length === 1 ? 0 : index / (all.length - 1) }))
            })} type="button">Distribute</button>
            <button onClick={() => props.onChange(makeGradient(value.type, firstColor(value, props.fallback)))} type="button">Reset</button>
          </div>
          <div className="gradient-stop-list">
            {value.stops.map((stop) => (
              <div className="gradient-stop-row" key={stop.id}>
                <input type="color" value={sixDigitHex(stop.color)} onChange={(event) => patchStop(stop.id, { color: event.target.value })} />
                <input aria-label="Stop colour" value={stop.color} onChange={(event) => patchStop(stop.id, { color: event.target.value })} />
                <label>Pos <input min={0} max={100} type="number" value={Math.round(stop.position * 100)} onChange={(event) => patchStop(stop.id, { position: event.target.valueAsNumber / 100 })} /></label>
                <label>Alpha <input min={0} max={100} type="number" value={Math.round(stop.opacity * 100)} onChange={(event) => patchStop(stop.id, { opacity: event.target.valueAsNumber / 100 })} /></label>
                <div className="gradient-stop-actions">
                  <button onClick={() => duplicateStop(stop)} type="button">Duplicate</button>
                  <button disabled={value.stops.length <= 2} onClick={() => patchGradient({ stops: value.stops.filter((item) => item.id !== stop.id) })} type="button">Delete</button>
                </div>
              </div>
            ))}
          </div>
          <div className="gradient-coordinate-grid">
            <label>Spread <select value={value.spread} onChange={(event) => patchGradient({ spread: event.target.value as GradientValue["spread"] })}>
              <option value="pad">Pad</option><option value="repeat">Repeat</option><option value="reflect">Reflect</option>
            </select></label>
            <label>Coordinates <select value={value.coordinateMode} onChange={(event) => patchGradient({ coordinateMode: event.target.value as GradientValue["coordinateMode"] })}>
              <option value="object">Object</option><option value="scene">Scene</option>
            </select></label>
            {value.type === "linear-gradient" ? (
              <>
                <GradientNumber label="Start X" value={value.startX} onChange={(startX) => patchGradient({ startX })} />
                <GradientNumber label="Start Y" value={value.startY} onChange={(startY) => patchGradient({ startY })} />
                <GradientNumber label="End X" value={value.endX} onChange={(endX) => patchGradient({ endX })} />
                <GradientNumber label="End Y" value={value.endY} onChange={(endY) => patchGradient({ endY })} />
                <GradientNumber label="Angle" value={value.angle} onChange={(angle) => patchGradient({ angle })} />
              </>
            ) : (
              <>
                <GradientNumber label="Centre X" value={value.centerX} onChange={(centerX) => patchGradient({ centerX })} />
                <GradientNumber label="Centre Y" value={value.centerY} onChange={(centerY) => patchGradient({ centerY })} />
                <GradientNumber label="Radius X" value={value.radiusX} min={0.001} onChange={(radiusX) => patchGradient({ radiusX })} />
                <GradientNumber label="Radius Y" value={value.radiusY} min={0.001} onChange={(radiusY) => patchGradient({ radiusY })} />
                <GradientNumber label="Focal X" value={value.focalX ?? value.centerX} onChange={(focalX) => patchGradient({ focalX })} />
                <GradientNumber label="Focal Y" value={value.focalY ?? value.centerY} onChange={(focalY) => patchGradient({ focalY })} />
              </>
            )}
          </div>
          {scenePresets.length ? (
            <div className="custom-gradient-presets">
              {scenePresets.map((preset) => (
                <div className="custom-gradient-preset" key={preset.presetId}>
                  <input
                    aria-label="Custom gradient preset name"
                    defaultValue={preset.name}
                    onBlur={(event) => updateGradientPreset(preset.presetId, { name: event.target.value })}
                  />
                  <button onClick={() => props.onChange(structuredClone(preset.value))} type="button">Apply</button>
                  <button onClick={() => duplicateGradientPreset(preset.presetId)} type="button">Duplicate</button>
                  <button onClick={() => deleteGradientPreset(preset.presetId)} type="button">Delete</button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GradientNumber(props: { label: string; value: number; min?: number; onChange: (value: number) => void }) {
  return <label>{props.label}<input min={props.min} step={0.01} type="number" value={props.value} onChange={(event) => props.onChange(event.target.valueAsNumber)} /></label>;
}

function isGradient(value: ColorValue): value is GradientValue {
  return value.type === "linear-gradient" || value.type === "radial-gradient";
}

function makeGradient(type: GradientValue["type"], color: string): GradientValue {
  const stops = [
    { id: createSceneId("stop"), position: 0, color, opacity: 1 },
    { id: createSceneId("stop"), position: 1, color: "#ffffff", opacity: 1 }
  ];
  return type === "linear-gradient"
    ? { type, angle: 0, startX: 0, startY: 0.5, endX: 1, endY: 0.5, stops, spread: "pad", coordinateMode: "object" }
    : { type, centerX: 0.5, centerY: 0.5, radiusX: 0.5, radiusY: 0.5, stops, spread: "pad", coordinateMode: "object" };
}

function firstColor(value: ColorValue, fallback: string): string {
  if (value.type === "solid") return value.color;
  if (isGradient(value)) return value.stops[0]?.color ?? fallback;
  return fallback;
}

function sixDigitHex(value: string): string {
  return /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : "#ffffff";
}

function cssGradient(value: GradientValue): string {
  const stops = value.stops.map((stop) => `${rgba(stop.color, stop.opacity)} ${Math.round(stop.position * 100)}%`).join(", ");
  return value.type === "linear-gradient"
    ? `linear-gradient(${value.angle}deg, ${stops})`
    : `radial-gradient(ellipse at ${value.centerX * 100}% ${value.centerY * 100}%, ${stops})`;
}

function rgba(color: string, opacity: number): string {
  const raw = sixDigitHex(color);
  const red = parseInt(raw.slice(1, 3), 16);
  const green = parseInt(raw.slice(3, 5), 16);
  const blue = parseInt(raw.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function largestGapMidpoint(stops: GradientStop[]): number {
  const sorted = [...stops].sort((left, right) => left.position - right.position);
  let best = { size: 0, midpoint: 0.5 };
  for (let index = 1; index < sorted.length; index += 1) {
    const size = sorted[index].position - sorted[index - 1].position;
    if (size > best.size) best = { size, midpoint: sorted[index - 1].position + size / 2 };
  }
  return best.midpoint;
}

function nearestStop(stops: GradientStop[], position: number): GradientStop | undefined {
  return [...stops].sort((left, right) => Math.abs(left.position - position) - Math.abs(right.position - position))[0];
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
