import type { SceneObject } from "@grapix/shared-types";
import { Plus, Trash2 } from "lucide-react";
import { useEditorStore } from "../store/editorStore";
import {
  ColorField,
  NumberField,
  ParityNote,
  ReadOnlyField,
  SelectField,
  TextField,
  ToggleField
} from "./inspectorFields";

/**
 * The properties that belong to one kind of object and to no other.
 *
 * The Inspector covers the transform, colour and mask properties every object shares. Everything
 * a *type* adds on top used to be covered for four types only — text, mesh, light and camera —
 * so an image had no fit control, a line had no points, a shape had no fill rule, a paint layer
 * had no strokes, a marker had no event name and a group had no children. Each of those is a
 * property the object genuinely carries, saved with the scene and published to Playout, that the
 * operator had no way to see or change.
 *
 * Where a property is authored but not drawn, the control is disabled and says which renderer is
 * missing rather than accepting a value that will never appear. Silently accepting one is how
 * six of eight texture fit modes came to render as `stretch`.
 */
export function ObjectTypeProperties({ object }: { object: SceneObject }) {
  switch (object.type) {
    case "image":
      return <ImageProperties object={object} />;
    case "line":
      return <LineProperties object={object} />;
    case "shape":
      return <ShapeProperties object={object} />;
    case "paint":
      return <PaintProperties object={object} />;
    case "marker":
      return <MarkerProperties object={object} />;
    case "group":
      return <GroupProperties object={object} />;
    case "mesh":
      return <MeshProperties object={object} />;
    default:
      return null;
  }
}

type OfType<T extends SceneObject["type"]> = Extract<SceneObject, { type: T }>;

function usePatch(objectId: string) {
  const updateObject = useEditorStore((state) => state.updateObject);
  return (patch: Partial<SceneObject>) => updateObject(objectId, patch);
}

function ImageProperties({ object }: { object: OfType<"image"> }) {
  const patch = usePatch(object.id);

  return (
    <section className="field-section inspector-control-section">
      <h3>Image</h3>
      <div className="two-column">
        <SelectField
          label="Fit"
          value={object.objectFit}
          options={["cover", "contain", "stretch"] as const}
          renderOption={(value) => value === "cover"
            ? "Cover (crop to fill)"
            : value === "contain"
              ? "Contain (fit inside)"
              : "Stretch (ignore aspect)"}
          onChange={(objectFit) => patch({ objectFit } as Partial<SceneObject>)}
        />
      </div>
      <ParityNote>
        Image objects are drawn by the Editor viewport only; the render engine reports them as an
        unsupported object type. Use a quad with a textured material for anything going to air.
      </ParityNote>
    </section>
  );
}

function LineProperties({ object }: { object: OfType<"line"> }) {
  const patch = usePatch(object.id);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const points = object.points;

  function setPoint(index: number, axis: "x" | "y", value: number) {
    patch({
      points: points.map((point, pointIndex) =>
        pointIndex === index ? { ...point, [axis]: value } : point
      )
    } as Partial<SceneObject>);
  }

  function appendPoint() {
    const last = points.at(-1) ?? { x: 0, y: 0 };
    beginHistory("add line point");
    patch({ points: [...points, { x: last.x + 40, y: last.y }] } as Partial<SceneObject>);
    commitHistory();
  }

  function removePoint(index: number) {
    // Two points are the least that still draws a line; below that the object would be invisible
    // and look deleted rather than edited.
    if (points.length <= 2) return;
    beginHistory("remove line point");
    patch({ points: points.filter((_, pointIndex) => pointIndex !== index) } as Partial<SceneObject>);
    commitHistory();
  }

  return (
    <section className="field-section inspector-control-section">
      <div className="inspector-section-heading">
        <h3>Line points ({points.length})</h3>
        <button className="mini-chip-button" onClick={appendPoint} title="Add a point" type="button">
          <Plus size={12} /> Point
        </button>
      </div>
      {points.map((point, index) => (
        <div className="inspector-point-row" key={index}>
          <span className="inspector-point-index">{index + 1}</span>
          <NumberField label="X" value={point.x} onChange={(value) => setPoint(index, "x", value)} />
          <NumberField label="Y" value={point.y} onChange={(value) => setPoint(index, "y", value)} />
          <button
            aria-label={`Remove point ${index + 1}`}
            className="panel-icon-button danger"
            disabled={points.length <= 2}
            onClick={() => removePoint(index)}
            title={points.length <= 2 ? "A line needs at least two points" : "Remove this point"}
            type="button"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <ParityNote>
        Points are object-local, so they move with X/Y above. Lines are drawn by the Editor
        viewport only; the render engine reports them as an unsupported object type.
      </ParityNote>
    </section>
  );
}

function ShapeProperties({ object }: { object: OfType<"shape"> }) {
  const patch = usePatch(object.id);
  const compoundCount = object.compoundPaths?.length ?? 0;

  return (
    <section className="field-section inspector-control-section">
      <h3>Path</h3>
      <div className="two-column">
        <ReadOnlyField label="Anchors" value={String(object.path.vertices.length)} />
        <ReadOnlyField label="Subpaths" value={String(compoundCount + 1)} />
        <ToggleField
          label="Closed"
          value={object.path.closed}
          onChange={(closed) => patch({ path: { ...object.path, closed } } as Partial<SceneObject>)}
        />
        <ToggleField
          label="Fill on"
          value={object.fillEnabled}
          onChange={(fillEnabled) => patch({ fillEnabled } as Partial<SceneObject>)}
        />
        <ToggleField
          label="Stroke on"
          value={object.strokeEnabled}
          onChange={(strokeEnabled) => patch({ strokeEnabled } as Partial<SceneObject>)}
        />
        <SelectField
          disabled
          label="Fill rule"
          value={object.fillRule}
          options={["nonzero", "evenodd"] as const}
          renderOption={(value) => value === "nonzero" ? "Non-zero" : "Even-odd"}
          onChange={(fillRule) => patch({ fillRule } as Partial<SceneObject>)}
        />
      </div>
      <ParityNote>
        Fill rule is disabled: both renderers fill non-zero, so offering even-odd would change the
        saved scene and nothing on screen. Anchors and handles are edited on the canvas with the
        Direct Selection tool.
        {compoundCount > 0
          ? ` The ${compoundCount} extra subpath${compoundCount === 1 ? "" : "s"} on this shape ${compoundCount === 1 ? "is" : "are"} preserved but not yet drawn.`
          : ""}
      </ParityNote>
    </section>
  );
}

function PaintProperties({ object }: { object: OfType<"paint"> }) {
  const patch = usePatch(object.id);
  const updatePaintStroke = useEditorStore((state) => state.updatePaintStroke);

  return (
    <section className="field-section inspector-control-section">
      <h3>Paint ({object.strokes.length} stroke{object.strokes.length === 1 ? "" : "s"})</h3>
      <div className="two-column">
        <SelectField
          disabled
          label="Layer blend"
          value={object.paintBlendMode}
          options={["normal", "multiply", "screen", "add", "erase"] as const}
          onChange={(paintBlendMode) => patch({ paintBlendMode } as Partial<SceneObject>)}
        />
      </div>
      {object.strokes.length === 0 ? (
        <div className="empty-panel compact">No strokes. Paint on the canvas with the Brush tool.</div>
      ) : null}
      {object.strokes.map((stroke, index) => (
        <div className="inspector-stroke-row" key={stroke.id}>
          <div className="inspector-section-heading">
            <h4>Stroke {index + 1}</h4>
            <span>{stroke.points.length} pts</span>
          </div>
          <div className="two-column">
            <NumberField
              label="Size"
              min={1}
              value={stroke.size}
              onChange={(size) => updatePaintStroke(object.id, stroke.id, { size })}
            />
            <NumberField
              label="Opacity"
              min={0}
              max={1}
              step={0.05}
              value={stroke.opacity}
              onChange={(opacity) => updatePaintStroke(object.id, stroke.id, { opacity })}
            />
            <NumberField
              label="Flow"
              min={0}
              max={1}
              step={0.05}
              value={stroke.flow}
              onChange={(flow) => updatePaintStroke(object.id, stroke.id, { flow })}
            />
            {stroke.color.type === "solid" ? (
              <ColorField
                label="Colour"
                value={stroke.color.color}
                onChange={(color) => updatePaintStroke(object.id, stroke.id, { color: { type: "solid", color } })}
              />
            ) : (
              <ReadOnlyField label="Colour" value={stroke.color.type} />
            )}
          </div>
        </div>
      ))}
      <ParityNote>
        Size, opacity, flow and colour are the stroke properties the viewport draws. Hardness,
        spacing, smoothing, roundness, angle and the per-layer blend are recorded by the Brush tool
        but not yet honoured, so they are not offered here. Paint layers are Editor-only; the
        render engine reports them as an unsupported object type.
      </ParityNote>
    </section>
  );
}

function MarkerProperties({ object }: { object: OfType<"marker"> }) {
  const patch = usePatch(object.id);

  return (
    <section className="field-section inspector-control-section">
      <h3>Marker</h3>
      <div className="two-column">
        <SelectField
          label="Kind"
          value={object.markerKind}
          options={["event"] as const}
          onChange={(markerKind) => patch({ markerKind } as Partial<SceneObject>)}
        />
        <TextField
          label="Event name"
          placeholder="score.changed"
          value={object.eventName}
          onChange={(eventName) => patch({ eventName } as Partial<SceneObject>)}
        />
      </div>
      <ParityNote>
        The event name is saved with the scene and published, but nothing subscribes to it yet:
        automation rules in the Automation panel carry their own event names. Treat this as scene
        metadata until markers are wired to triggers.
      </ParityNote>
    </section>
  );
}

function GroupProperties({ object }: { object: OfType<"group"> }) {
  const scene = useEditorStore((state) => state.scene);
  const setContainerChild = useEditorStore((state) => state.setContainerChild);
  const candidates = scene.objects.filter((candidate) => candidate.id !== object.id);

  return (
    <section className="field-section inspector-control-section">
      <h3>Group contents ({object.childIds.length})</h3>
      <div className="container-child-list">
        {candidates.map((candidate) => (
          <label className="container-child-row" key={candidate.id}>
            <input
              type="checkbox"
              checked={object.childIds.includes(candidate.id)}
              onChange={(event) => setContainerChild(object.id, candidate.id, event.target.checked)}
            />
            <span>{candidate.name}</span>
            <small>{candidate.type}</small>
          </label>
        ))}
        {candidates.length === 0 ? (
          <div className="empty-panel compact">No other objects in this scene.</div>
        ) : null}
      </div>
      <ParityNote>
        A group passes its position, Z rotation, scale, depth, visibility and opacity down to its
        children. A child that already belongs to another container is refused rather than being
        moved, so an object has exactly one parent.
      </ParityNote>
    </section>
  );
}

function MeshProperties({ object }: { object: OfType<"mesh"> }) {
  const patch = usePatch(object.id);
  const scene = useEditorStore((state) => state.scene);
  const modelAsset = object.modelAssetId
    ? scene.assets.find((asset) => asset.assetId === object.modelAssetId)
    : undefined;
  const isModel = object.meshKind === "model";

  return (
    <section className="field-section inspector-control-section">
      <h3>Mesh</h3>
      <div className="two-column">
        <ReadOnlyField label="Primitive" value={object.meshKind} />
        {isModel ? <ReadOnlyField label="Model asset" value={modelAsset?.name ?? object.modelAssetId ?? "none"} /> : null}
        {isModel ? <ReadOnlyField label="Elements" value={String(object.materialElements?.length ?? 0)} /> : null}
      </div>
      {isModel ? (
        <>
          <h4>Imported clip</h4>
          <div className="two-column">
            <TextField
              label="Clip"
              value={object.clipName ?? ""}
              onChange={(clipName) => patch({ clipName } as Partial<SceneObject>)}
            />
            <NumberField
              disabled
              label="Clip index"
              min={0}
              value={object.clipIndex ?? 0}
              onChange={(clipIndex) => patch({ clipIndex } as Partial<SceneObject>)}
            />
            <NumberField
              disabled
              label="Time scale"
              min={0}
              step={0.1}
              value={object.timeScale ?? 1}
              onChange={(timeScale) => patch({ timeScale } as Partial<SceneObject>)}
            />
            <NumberField
              disabled
              label="Frame offset"
              value={object.frameOffset ?? 0}
              onChange={(frameOffset) => patch({ frameOffset } as Partial<SceneObject>)}
            />
            <ToggleField
              disabled
              label="Loop"
              value={object.animationLoop ?? false}
              onChange={(animationLoop) => patch({ animationLoop } as Partial<SceneObject>)}
            />
          </div>
          <ParityNote>
            Clip playback is disabled: neither renderer samples an imported glTF animation track
            yet, so a clip index, time scale, offset or loop would be saved and ignored. The clip
            name stays editable because it is the label the model was imported with.
          </ParityNote>
        </>
      ) : null}
    </section>
  );
}
