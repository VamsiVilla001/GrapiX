import { MESH_PRIMITIVE_KINDS, type BezierPath, type SceneObject, type Vec2 } from "@grapix/shared-types";
import { ArrowDown, ArrowUp, Clock3, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  ColorField,
  NumberField,
  ParityNote,
  ReadOnlyField,
  SelectField,
  TextField,
  ToggleField
} from "./inspectorFields";
import { inspectorControl } from "../modules/object-inspector/services/inspectorControls";

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

/** The history transaction the type panels' numeric fields open, so a scrub is one undo step. */
function useHistory() {
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  return { onBeginEdit: beginHistory, onCancelEdit: cancelHistory, onCommitEdit: commitHistory };
}

function usePatch(objectId: string) {
  const updateObject = useEditorStore((state) => state.updateObject);
  return (patch: Partial<SceneObject>) => updateObject(objectId, patch);
}

function ImageProperties({ object }: { object: OfType<"image"> }) {
  const patch = usePatch(object.id);
  const history = useHistory();

  return (
    <section aria-labelledby="inspector-image-heading" className="field-section inspector-control-section">
      <h3 id="inspector-image-heading">Image</h3>
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
  const history = useHistory();
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
    <section aria-labelledby="inspector-line-points-heading" className="field-section inspector-control-section">
      <div className="inspector-section-heading">
        <h3 id="inspector-line-points-heading">Line points ({points.length})</h3>
        <button className="mini-chip-button" onClick={appendPoint} title="Add a point" type="button">
          <Plus size={12} /> Point
        </button>
      </div>
      {points.map((point, index) => (
        <div className="inspector-point-row" key={index}>
          <span className="inspector-point-index">{index + 1}</span>
          <NumberField {...history} label="X" value={point.x} onChange={(value) => setPoint(index, "x", value)} />
          <NumberField {...history} label="Y" value={point.y} onChange={(value) => setPoint(index, "y", value)} />
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
  const history = useHistory();
  const updateShapeVertex = useEditorStore((state) => state.updateShapeVertex);
  const toggleShapePathKeyframe = useEditorStore((state) => state.toggleShapePathKeyframe);
  const setShapePathAnimationEnabled = useEditorStore((state) => state.setShapePathAnimationEnabled);
  const toggleShapeTrimKeyframe = useEditorStore((state) => state.toggleShapeTrimKeyframe);
  const setShapeTrimAnimationEnabled = useEditorStore((state) => state.setShapeTrimAnimationEnabled);
  const setShapeTrimValue = useEditorStore((state) => state.setShapeTrimValue);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const compoundCount = object.compoundPaths?.length ?? 0;

  const pathAnimated = object.pathAnimation !== undefined;
  const currentPathKey = object.pathAnimation?.find((key) => key.frame === currentFrame);

  return (
    <section aria-labelledby="inspector-shape-path-heading" className="field-section inspector-control-section">
      <div className="inspector-section-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 id="inspector-shape-path-heading">Path</h3>
        <span className="field-animation-controls" style={{ position: "static" }}>
          <button
            aria-label={`${pathAnimated ? "Disable" : "Enable"} path animation`}
            className={`field-stopwatch ${pathAnimated ? "active" : ""}`}
            onClick={() => setShapePathAnimationEnabled(object.id, !pathAnimated, currentFrame)}
            title={pathAnimated ? "Disable path animation (removes keyframes)" : "Enable path animation and add keyframe at playhead"}
            type="button"
          >
            <Clock3 size={12} />
          </button>
          {pathAnimated ? (
            <button
              aria-label={`${currentPathKey ? "Remove" : "Add"} keyframe at current frame`}
              className={`field-key-toggle ${currentPathKey ? "on" : ""}`}
              onClick={() => toggleShapePathKeyframe(object.id, currentFrame)}
              title={currentPathKey ? "Remove keyframe at current frame" : "Add keyframe at current frame"}
              type="button"
            >
              ◆
            </button>
          ) : null}
        </span>
      </div>
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
      {object.path.vertices.map((vertex, index) => {
        const incoming = object.path.inTangents[index] ?? { x: 0, y: 0 };
        const outgoing = object.path.outTangents[index] ?? { x: 0, y: 0 };
        return (
          <div className="inspector-stroke-row" key={index}>
            <div className="inspector-section-heading">
              <h4>Anchor {index + 1}</h4>
              <span>local coordinates</span>
            </div>
            <div className="two-column">
              <NumberField {...history}
                label="X"
                value={vertex.x}
                onChange={(x) => updateShapeVertex(object.id, index, { vertex: { ...vertex, x } })}
              />
              <NumberField {...history}
                label="Y"
                value={vertex.y}
                onChange={(y) => updateShapeVertex(object.id, index, { vertex: { ...vertex, y } })}
              />
              <NumberField {...history}
                label="In X"
                value={incoming.x}
                onChange={(x) => updateShapeVertex(object.id, index, { inTangent: { ...incoming, x } })}
              />
              <NumberField {...history}
                label="In Y"
                value={incoming.y}
                onChange={(y) => updateShapeVertex(object.id, index, { inTangent: { ...incoming, y } })}
              />
              <NumberField {...history}
                label="Out X"
                value={outgoing.x}
                onChange={(x) => updateShapeVertex(object.id, index, { outTangent: { ...outgoing, x } })}
              />
              <NumberField {...history}
                label="Out Y"
                value={outgoing.y}
                onChange={(y) => updateShapeVertex(object.id, index, { outTangent: { ...outgoing, y } })}
              />
            </div>
          </div>
        );
      })}
      <CompoundPathEditor object={object} />
      <ParityNote>
        Anchor and tangent values are the same local coordinates used by Direct Selection on the
        canvas.
        {compoundCount > 0
          ? ` All ${compoundCount + 1} subpaths are drawn as one compound path, so holes and counters composite correctly. The primary compatibility path stays first; the additional paths can be edited and reordered below.`
          : " Add a compound subpath to author a hole, counter or disconnected region."}
      </ParityNote>
      {/* The verdict and its wording come from the shared contract, which is why this no longer
          claims both renderers fill non-zero — Program tessellates even-odd and Preview does not. */}
      <ParityNote>{inspectorControl("shape", "fillRule").note}</ParityNote>

      <TrimPathsSection
        object={object}
        currentFrame={currentFrame}
        onToggleKeyframe={toggleShapeTrimKeyframe}
        onSetAnimationEnabled={setShapeTrimAnimationEnabled}
        onSetValue={setShapeTrimValue}
      />
    </section>
  );
}

/**
 * Additional paths are ordered after `shape.path`, which remains the compatibility path imported by
 * older scenes. Reordering never promotes a hole into that primary slot.
 */
function CompoundPathEditor({ object }: { object: OfType<"shape"> }) {
  const history = useHistory();
  const addShapeSubpath = useEditorStore((state) => state.addShapeSubpath);
  const updateShapeSubpath = useEditorStore((state) => state.updateShapeSubpath);
  const removeShapeSubpath = useEditorStore((state) => state.removeShapeSubpath);
  const moveShapeSubpath = useEditorStore((state) => state.moveShapeSubpath);
  const paths = object.compoundPaths ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, paths.length - 1)));
  }, [object.id, paths.length]);

  const selected = paths[selectedIndex];
  const writePoint = (
    path: BezierPath,
    pointIndex: number,
    patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }
  ) => {
    const replace = (values: Vec2[], value: Vec2 | undefined) =>
      value === undefined ? values : values.map((current, index) => index === pointIndex ? value : current);
    updateShapeSubpath(object.id, selectedIndex, {
      ...path,
      vertices: replace(path.vertices, patch.vertex),
      inTangents: replace(path.inTangents, patch.inTangent),
      outTangents: replace(path.outTangents, patch.outTangent)
    });
  };

  return (
    <section className="shape-subpath-editor" aria-label="Compound subpaths">
      <div className="inspector-section-heading">
        <h4>Compound subpaths</h4>
        <button
          className="mini-chip-button"
          onClick={() => {
            const index = addShapeSubpath(object.id);
            if (index >= 0) setSelectedIndex(index);
          }}
          type="button"
        >
          <Plus size={12} /> Subpath
        </button>
      </div>
      {selected ? (
        <>
          <div className="shape-subpath-toolbar">
            <label className="field">
              <span>Selected</span>
              <select
                aria-label="Selected compound subpath"
                value={selectedIndex}
                onChange={(event) => setSelectedIndex(Number(event.target.value))}
              >
                {paths.map((_, index) => (
                  <option value={index} key={index}>Subpath {index + 2}</option>
                ))}
              </select>
            </label>
            <span className="shape-subpath-actions">
              <button
                aria-label="Move selected subpath earlier"
                className="panel-icon-button"
                disabled={selectedIndex === 0}
                onClick={() => {
                  if (moveShapeSubpath(object.id, selectedIndex, -1)) setSelectedIndex(selectedIndex - 1);
                }}
                title="Move earlier"
                type="button"
              >
                <ArrowUp size={13} />
              </button>
              <button
                aria-label="Move selected subpath later"
                className="panel-icon-button"
                disabled={selectedIndex === paths.length - 1}
                onClick={() => {
                  if (moveShapeSubpath(object.id, selectedIndex, 1)) setSelectedIndex(selectedIndex + 1);
                }}
                title="Move later"
                type="button"
              >
                <ArrowDown size={13} />
              </button>
              <button
                aria-label="Remove selected subpath"
                className="panel-icon-button danger"
                onClick={() => {
                  if (removeShapeSubpath(object.id, selectedIndex)) {
                    setSelectedIndex(Math.max(0, selectedIndex - 1));
                  }
                }}
                title="Remove subpath"
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
          <div className="two-column">
            <ReadOnlyField label="Anchors" value={String(selected.vertices.length)} />
            <ToggleField
              label="Closed"
              value={selected.closed}
              onChange={(closed) => updateShapeSubpath(object.id, selectedIndex, { ...selected, closed })}
            />
          </div>
          {selected.vertices.map((vertex, pointIndex) => {
            const incoming = selected.inTangents[pointIndex] ?? { x: 0, y: 0 };
            const outgoing = selected.outTangents[pointIndex] ?? { x: 0, y: 0 };
            return (
              <div className="inspector-stroke-row" key={pointIndex}>
                <div className="inspector-section-heading">
                  <h4>Subpath anchor {pointIndex + 1}</h4>
                  <span>local coordinates</span>
                </div>
                <div className="two-column">
                  <NumberField {...history} label="X" value={vertex.x} onChange={(x) => writePoint(selected, pointIndex, { vertex: { ...vertex, x } })} />
                  <NumberField {...history} label="Y" value={vertex.y} onChange={(y) => writePoint(selected, pointIndex, { vertex: { ...vertex, y } })} />
                  <NumberField {...history} label="In X" value={incoming.x} onChange={(x) => writePoint(selected, pointIndex, { inTangent: { ...incoming, x } })} />
                  <NumberField {...history} label="In Y" value={incoming.y} onChange={(y) => writePoint(selected, pointIndex, { inTangent: { ...incoming, y } })} />
                  <NumberField {...history} label="Out X" value={outgoing.x} onChange={(x) => writePoint(selected, pointIndex, { outTangent: { ...outgoing, x } })} />
                  <NumberField {...history} label="Out Y" value={outgoing.y} onChange={(y) => writePoint(selected, pointIndex, { outTangent: { ...outgoing, y } })} />
                </div>
              </div>
            );
          })}
        </>
      ) : (
        <p className="inspector-empty-copy">No additional subpaths. The primary path above still renders normally.</p>
      )}
    </section>
  );
}

/**
 * AE-style Trim Paths: the stroke's start/end window, rotated by offset.
 *
 * Stroke-only by design — the fill always covers the full region, which is what separates a
 * wipe reveal from a scaling mask. Each channel is an independent stopwatch, matching how the
 * mask channels and the path morph already animate, so the Timeline shows three rows beside
 * the shape's path row.
 */
function TrimPathsSection({
  object,
  currentFrame,
  onToggleKeyframe,
  onSetAnimationEnabled,
  onSetValue
}: {
  object: OfType<"shape">;
  currentFrame: number;
  onToggleKeyframe: (objectId: string, channel: "start" | "end" | "offset", frame: number) => void;
  onSetAnimationEnabled: (objectId: string, channel: "start" | "end" | "offset", enabled: boolean, frame: number) => void;
  onSetValue: (objectId: string, channel: "start" | "end" | "offset", value: number, frame: number) => void;
}) {
  const channels = [
    { key: "start" as const, label: "Start %", staticValue: object.trimStart ?? 0, keys: object.trimAnimation?.start },
    { key: "end" as const, label: "End %", staticValue: object.trimEnd ?? 100, keys: object.trimAnimation?.end },
    { key: "offset" as const, label: "Offset %", staticValue: object.trimOffset ?? 0, keys: object.trimAnimation?.offset }
  ];

  return (
    <section aria-labelledby="inspector-trim-paths-heading" className="field-section inspector-control-section">
      <h3 id="inspector-trim-paths-heading">Trim Paths</h3>
      <div className="two-column">
        {channels.map(({ key, label, staticValue, keys }) => {
          const animated = keys !== undefined && keys.length > 0;
          const currentKey = keys?.find((candidate) => candidate.frame === currentFrame);
          return (
            <div className={`field trim-channel-field ${animated ? "animated" : ""}`} key={key}>
              <span>{label}</span>
              <span className={`field-animation-controls ${animated ? "animated" : ""}`} style={{ position: "static" }}>
                <button
                  aria-label={`${animated ? "Disable" : "Enable"} ${label} animation`}
                  className={`field-stopwatch ${animated ? "active" : ""}`}
                  onClick={() => onSetAnimationEnabled(object.id, key, !animated, currentFrame)}
                  title={animated ? "Disable animation (removes keyframes)" : "Enable animation and add a key at the playhead"}
                  type="button"
                >
                  <Clock3 size={12} />
                </button>
                {animated ? (
                  <button
                    aria-label={`${currentKey ? "Remove" : "Add"} ${label} keyframe at frame ${currentFrame}`}
                    className={`field-key-toggle ${currentKey ? "on" : ""}`}
                    onClick={() => onToggleKeyframe(object.id, key, currentFrame)}
                    title={currentKey ? "Remove keyframe at the playhead" : "Add keyframe at the playhead"}
                    type="button"
                  >
                    ◆
                  </button>
                ) : null}
                <input
                  max={100}
                  min={key === "offset" ? undefined : 0}
                  onChange={(event) => onSetValue(object.id, key, Number(event.target.value), currentFrame)}
                  step={1}
                  type="number"
                  value={staticValue}
                />
              </span>
            </div>
          );
        })}
      </div>
      <ParityNote>
        Start/End are percentages of the path's length; Offset rotates the window around it.
        The trim reveals the stroke only — the fill always covers the full region, as in After
        Effects. Both the viewport and the render engine cut the path at the same arc length.
      </ParityNote>
    </section>
  );
}

function PaintProperties({ object }: { object: OfType<"paint"> }) {
  const patch = usePatch(object.id);
  const history = useHistory();
  const updatePaintStroke = useEditorStore((state) => state.updatePaintStroke);

  return (
    <section aria-labelledby="inspector-paint-heading" className="field-section inspector-control-section">
      <h3 id="inspector-paint-heading">Paint ({object.strokes.length} stroke{object.strokes.length === 1 ? "" : "s"})</h3>
      <div className="two-column">
        {/* Read-only rather than a dead select: the imported value stays legible, and nothing
            suggests it can be changed into something that draws. */}
        <ReadOnlyField label="Layer blend" value={object.paintBlendMode} />
      </div>
      <ParityNote>{inspectorControl("paint", "paintBlendMode").note}</ParityNote>
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
            <NumberField {...history}
              label="Size"
              min={1}
              value={stroke.size}
              onChange={(size) => updatePaintStroke(object.id, stroke.id, { size })}
            />
            <NumberField {...history}
              label="Opacity"
              min={0}
              max={1}
              step={0.05}
              value={stroke.opacity}
              onChange={(opacity) => updatePaintStroke(object.id, stroke.id, { opacity })}
            />
            <NumberField {...history}
              label="Flow"
              min={0}
              max={1}
              step={0.05}
              value={stroke.flow}
              onChange={(flow) => updatePaintStroke(object.id, stroke.id, { flow })}
            />
            <NumberField {...history}
              disabled
              label="Hardness %"
              min={0}
              max={100}
              value={stroke.hardness * 100}
              onChange={(hardness) => updatePaintStroke(object.id, stroke.id, { hardness: hardness / 100 })}
            />
            <NumberField {...history}
              disabled
              label="Spacing %"
              min={1}
              max={500}
              value={stroke.spacing * 100}
              onChange={(spacing) => updatePaintStroke(object.id, stroke.id, { spacing: spacing / 100 })}
            />
            <NumberField {...history}
              disabled
              label="Smoothing %"
              min={0}
              max={100}
              value={stroke.smoothing * 100}
              onChange={(smoothing) => updatePaintStroke(object.id, stroke.id, { smoothing: smoothing / 100 })}
            />
            <NumberField {...history}
              disabled
              label="Roundness %"
              min={1}
              max={100}
              value={stroke.roundness * 100}
              onChange={(roundness) => updatePaintStroke(object.id, stroke.id, { roundness: roundness / 100 })}
            />
            <NumberField {...history}
              disabled
              label="Angle °"
              min={-180}
              max={180}
              value={stroke.angle}
              onChange={(angle) => updatePaintStroke(object.id, stroke.id, { angle })}
            />
            <SelectField
              disabled
              label="Blend"
              value={stroke.blendMode}
              options={["normal", "multiply", "screen", "add", "erase"] as const}
              onChange={(blendMode) => updatePaintStroke(object.id, stroke.id, { blendMode })}
            />
            <SelectField
              disabled
              label="Mask mode"
              value={stroke.maskMode ?? "paint"}
              options={["paint", "erase", "reveal"] as const}
              onChange={(maskMode) => updatePaintStroke(object.id, stroke.id, { maskMode })}
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
        Size, opacity, flow and colour are rendered and editable. Hardness, spacing, smoothing,
        roundness, angle, blend and mask mode remain visible but disabled because the viewport does
        not honour them yet. Paint layers are Editor-only; Program reports paint as unsupported.
      </ParityNote>
    </section>
  );
}

function MarkerProperties({ object }: { object: OfType<"marker"> }) {
  const patch = usePatch(object.id);
  const history = useHistory();

  return (
    <section aria-labelledby="inspector-marker-heading" className="field-section inspector-control-section">
      <h3 id="inspector-marker-heading">Marker</h3>
      <div className="two-column">
        {/*
          The Kind select offers exactly one option, so it is a label wearing a control's clothes.
        */}
        <ReadOnlyField label="Kind" value={object.markerKind} />
        {/*
          Not editable. The event name was writable, saved and published, and **nothing subscribes to
          it** — the Automation panel carries its own trigger names. Editing it looked like wiring a
          trigger and wired nothing. The value is kept and shown so an imported marker stays legible.
        */}
        <ReadOnlyField label="Event name" value={object.eventName || "—"} />
      </div>
      <ParityNote>{inspectorControl("marker", "eventName").note}</ParityNote>
    </section>
  );
}

function GroupProperties({ object }: { object: OfType<"group"> }) {
  const scene = useEditorStore((state) => state.scene);
  const setContainerChild = useEditorStore((state) => state.setContainerChild);
  const candidates = scene.objects.filter((candidate) => candidate.id !== object.id);

  return (
    <section aria-labelledby="inspector-group-contents-heading" className="field-section inspector-control-section">
      <h3 id="inspector-group-contents-heading">Group contents ({object.childIds.length})</h3>
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
  const history = useHistory();
  const convertMeshKind = useEditorStore((state) => state.convertMeshKind);
  const scene = useEditorStore((state) => state.scene);
  const modelAsset = object.modelAssetId
    ? scene.assets.find((asset) => asset.assetId === object.modelAssetId)
    : undefined;
  const isModel = object.meshKind === "model";

  return (
    <section aria-labelledby="inspector-mesh-heading" className="field-section inspector-control-section">
      <h3 id="inspector-mesh-heading">Mesh</h3>
      <div className="two-column">
        <SelectField
          label="Primitive"
          value={object.meshKind}
          options={MESH_PRIMITIVE_KINDS}
          renderOption={(kind) => kind[0].toUpperCase() + kind.slice(1)}
          onChange={(kind) => convertMeshKind(object.id, kind)}
        />
        {isModel ? <ReadOnlyField label="Model asset" value={modelAsset?.name ?? object.modelAssetId ?? "none"} /> : null}
        {isModel ? <ReadOnlyField label="Source" value={object.src ?? "none"} /> : null}
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
            <NumberField {...history}
              disabled
              label="Clip index"
              min={0}
              value={object.clipIndex ?? 0}
              onChange={(clipIndex) => patch({ clipIndex } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              disabled
              label="Time scale"
              min={0}
              step={0.1}
              value={object.timeScale ?? 1}
              onChange={(timeScale) => patch({ timeScale } as Partial<SceneObject>)}
            />
            <NumberField {...history}
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
