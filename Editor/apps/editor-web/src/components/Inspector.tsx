import { Fragment, useEffect, useState  } from "react";
import { getMaterialBindingId, isMaterialCompatible, isMaterialCompatibleWithFace, isPropertyAnimatable, normalizeSlabProperties, sampleChannel, type AnimatableProperty, type MaskMode, type SceneObject, type SlabPropertiesInput } from "@grapix/shared-types";
import { ArrowDown, ArrowUp, Clock3, Copy, Diamond, Eye, EyeOff, Lock, PenTool, Plus, Trash2, Unlock } from "lucide-react";
import { ColorValueEditor } from "./ColorValueEditor";
import { ObjectTypeProperties } from "./ObjectTypeProperties";
import { importedDisclosures, inspectorControl } from "../modules/object-inspector/services/inspectorControls";
import {
  describePropertySource,
  labelWithUnit,
  propertyConstraint,
  resolvePropertySource,
  type PropertySource
} from "@grapix/shared-types";
import { useNumericGesture } from "../lib/numericGesture";
import { TextFontControls } from "./TextFontControls";
import {
  ColorField,
  ConstrainedNumberField,
  NumberField,
  ParityNote,
  ReadOnlyField,
  SelectField,
  TextField,
  ToggleField
} from "./inspectorFields";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import { useObjectInspectorStore } from "../modules/object-inspector/stores/objectInspectorStore";
import { InspectorDisclosureToggle } from "../modules/object-inspector/components/InspectorDisclosureToggle";

export type InspectorScope = "type" | "transform";

// Material eligibility now has one definition, `MATERIAL_SURFACE_TYPES`, shared with the tab
// descriptors. This set had drifted from them and both admitted `paint`, which draws no material.
/**
 * Types whose width and height a renderer actually reads.
 *
 * `line`, `shape` and `paint` are absent because their geometry comes from points, a path and
 * strokes: `drawLine`, `drawShape` and `drawPaint` read `object.width`/`object.height` zero times, so
 * a size control on them resized nothing and reported success. `PROPERTY_RENDERER_SUPPORT` marks those
 * six entries `neither`, and the Editor's audit fails if this set disagrees with it.
 */
const DIMENSION_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "image", "mesh"
]);
const APPEARANCE_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "line", "shape"
]);
const FILL_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "shape"
]);
const MASKABLE_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh"
]);

export function Inspector({ scope = "type" }: { scope?: InspectorScope }) {
  const scene = useEditorStore((state) => state.scene);
  // A binding resolves at the playhead, the same frame the viewport is showing.
  const currentFrame = useUiStore((state) => state.currentFrame);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObject = useEditorStore((state) => state.updateObject);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const renameObject = useEditorStore((state) => state.renameObject);
  const setActiveCameraId = useEditorStore((state) => state.setActiveCameraId);
  const setContainerChild = useEditorStore((state) => state.setContainerChild);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const convertObjectToShape = useEditorStore((state) => state.convertObjectToShape);
  const object = scene.objects.find((item) => item.id === selectedObjectId);
  const supportsDimensions = DIMENSION_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsAppearance = APPEARANCE_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsFill = FILL_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsMasks = MASKABLE_OBJECT_TYPES.has(object?.type ?? "marker");
  if (!object) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <div className="empty-panel">No object selected</div>
      </aside>
    );
  }

  /*
   * The history transaction every numeric field opens.
   *
   * Spread into each `NumberField` rather than made implicit, so a control that should *not* scrub —
   * one whose caller writes through its own transaction — simply does not receive it. With these two
   * the field gains the Object Manager's grammar: scrub, Shift-fine, Enter commits, Escape reverts, and
   * one undo step per gesture instead of one per keystroke.
   */
  const history = { onBeginEdit: beginHistory, onCancelEdit: cancelHistory, onCommitEdit: commitHistory };
  const noteFor = (property: string) =>
    object ? sourceNoteFor(object, property, scene.dataContext, currentFrame) : undefined;

  function patch(patchValue: Partial<SceneObject>) {
    updateObject(object!.id, patchValue);
  }


  // Every parity verdict and its wording come from the shared contract, so a note cannot contradict
  // what the renderers do — which is exactly how the shape fill-rule note came to say the opposite.
  const textControl = (property: string) => inspectorControl("text", property);

  const slab = object.type === "mesh" && object.meshKind === "slab"
    ? normalizeSlabProperties(object.slab)
    : null;

  function patchSlab(patchValue: SlabPropertiesInput) {
    if (!slab) return;
    patch({
      slab: normalizeSlabProperties({
        ...slab,
        ...patchValue,
        frontBevel: {
          ...slab.frontBevel,
          ...patchValue.frontBevel
        },
        backBevel: {
          ...slab.backBevel,
          ...patchValue.backBevel
        }
      })
    } as Partial<SceneObject>);
  }

  return (
    <aside className="inspector">
      {scope === "type" ? (
        <>
      <div className="panel-heading">
        <h2>Inspector</h2>
        <div className="mini-action-row">
          <button
            className="mini-icon-button"
            onClick={() => patch({ visible: !object.visible })}
            title={object.visible ? "Hide object" : "Show object"}
          >
            {object.visible ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
          </button>
          <button
            className="mini-icon-button"
            onClick={() => patch({ locked: !object.locked })}
            title={object.locked ? "Unlock object" : "Lock object"}
          >
            {object.locked ? <Lock size={16} aria-hidden="true" /> : <Unlock size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <section aria-labelledby="inspector-object-heading" className="field-section">
        <h3 id="inspector-object-heading">Object</h3>
        <ObjectNameField
          object={object}
          onRename={(name) => {
            if (renameObject(object.id, name)) return true;
            window.alert(`"${name.trim() || name}" is already used by another object. Object names must be unique.`);
            return false;
          }}
        />
        {/*
          No "Main Material" here.

          It bound the same `main` face the Materials tab binds, so one relationship had two homes and
          an author had to learn which. The Materials tab is the home: it lists every bindable face,
          not just face 0, so the quick field was also the less capable of the two.
        */}
        {object.type === "text" ? (
          <TextField label="Text" sourceNote={noteFor("text")} value={object.text} onChange={(value) => patch({ text: value } as Partial<SceneObject>)} />
        ) : null}
        {object.type === "image" ? (
          <TextField label="Image URL" sourceNote={noteFor("src")} value={object.src} onChange={(value) => patch({ src: value } as Partial<SceneObject>)} />
        ) : null}
      </section>
        </>
      ) : null}

      {scope === "transform" ? (
      <section aria-labelledby="inspector-transform-heading" className="field-section two-column">
        <h3 id="inspector-transform-heading">Transform</h3>
        <AnimatedNumberField label="X" object={object} property="x" value={object.x} />
        <AnimatedNumberField label="Y" object={object} property="y" value={object.y} />
        <AnimatedNumberField label="Position Z" object={object} property="zDepth" value={object.zDepth} />
        <TextField label="Layer" value={object.layerId} onChange={(value) => patch({ layerId: value || "main" })} />
        {supportsDimensions ? (
          <>
        <ConstrainedNumberField {...history} label="W" objectType={object.type} property="width" sourceNote={noteFor("width")} value={object.width} onChange={(value) => patch({ width: value })} />
        <ConstrainedNumberField {...history} label="H" objectType={object.type} property="height" sourceNote={noteFor("height")} value={object.height} onChange={(value) => patch({ height: value })} />
          </>
        ) : null}
        {object.type === "mesh" ? (
          <>
            <ConstrainedNumberField {...history} label={object.meshKind === "slab" ? "Extrusion" : "Depth"} objectType={object.type} property="depth" value={object.depth} onChange={(value) => patch({ depth: value } as Partial<SceneObject>)} />
            <AnimatedNumberField label="Rotation X" object={object} property="rotationX" value={object.rotationX ?? 0} />
            <AnimatedNumberField label="Rotation Y" object={object} property="rotationY" value={object.rotationY ?? 0} />
            <AnimatedNumberField label="Rotation Z" object={object} property="rotationZ" value={object.rotationZ ?? object.rotation} />
            <AnimatedNumberField label="Scale X" object={object} property="scaleX" value={object.scaleX ?? 1} />
            <AnimatedNumberField label="Scale Y" object={object} property="scaleY" value={object.scaleY ?? 1} />
            <AnimatedNumberField label="Scale Z" object={object} property="scaleZ" value={object.scaleZ ?? 1} />
            <ConstrainedNumberField {...history}
              label="Anchor X" objectType={object.type} property="fov"
              value={object.anchor3d?.x ?? object.width / 2}
              onChange={(value) => patch({ anchor3d: { x: value, y: object.anchor3d?.y ?? object.height / 2, z: object.anchor3d?.z ?? object.depth / 2 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Anchor Y"
              value={object.anchor3d?.y ?? object.height / 2}
              onChange={(value) => patch({ anchor3d: { x: object.anchor3d?.x ?? object.width / 2, y: value, z: object.anchor3d?.z ?? object.depth / 2 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Anchor Z"
              value={object.anchor3d?.z ?? object.depth / 2}
              onChange={(value) => patch({ anchor3d: { x: object.anchor3d?.x ?? object.width / 2, y: object.anchor3d?.y ?? object.height / 2, z: value } } as Partial<SceneObject>)}
            />
          </>
        ) : (
          <>
            {/*
              Per property, from the contract, rather than one `supportsDetailedTransform` flag for the
              whole group. The flag meant "not a camera and not a light" and was right about six controls
              and wrong about a seventh: a light's `opacity` scales its intensity in *both* renderers
              (`ThreeSceneLayer.ts:412-413`, `document.rs:1092`), so hiding it hid a working dimmer while
              `rotation` and the scales really are read by neither.
            */}
            {inspectorControl(object.type, "rotation").enabled ? (
              <AnimatedNumberField label="Rotate" object={object} property="rotation" value={object.rotation} />
            ) : null}
            {inspectorControl(object.type, "scaleX").enabled ? (
              <AnimatedNumberField label="Scale X" object={object} property="scaleX" value={object.scaleX ?? 1} />
            ) : null}
            {inspectorControl(object.type, "scaleY").enabled ? (
              <AnimatedNumberField label="Scale Y" object={object} property="scaleY" value={object.scaleY ?? 1} />
            ) : null}
            {DIMENSION_OBJECT_TYPES.has(object.type) ? (
              <>
                <NumberField {...history}
                  label="Anchor X"
                  value={object.anchor?.x ?? 0}
                  onChange={(value) => patch({ anchor: { x: value, y: object.anchor?.y ?? 0 } })}
                />
                <NumberField {...history}
                  label="Anchor Y"
                  value={object.anchor?.y ?? 0}
                  onChange={(value) => patch({ anchor: { x: object.anchor?.x ?? 0, y: value } })}
                />
              </>
            ) : null}
          </>
        )}
        {inspectorControl(object.type, "opacity").enabled ? (
          <AnimatedNumberField label="Opacity" object={object} property="opacity" value={object.opacity} />
        ) : null}
      </section>
      ) : null}

      {scope === "type" ? (
        <>
      {slab ? (
        <>
          <section aria-labelledby="inspector-slab-shape-heading" className="field-section">
            <h3 id="inspector-slab-shape-heading">Slab Shape</h3>
            <div className="two-column">
              <NumberField {...history}
                label="Corner Radius"
                min={0}
                value={slab.cornerRadius}
                onChange={(value) => patchSlab({ cornerRadius: Math.max(0, value) })}
              />
              <NumberField {...history}
                label="Corner Quality"
                max={32}
                min={1}
                value={slab.cornerSegments}
                onChange={(value) => patchSlab({ cornerSegments: Math.max(1, Math.min(32, Math.round(value))) })}
              />
              <NumberField {...history}
                label="Skew"
                value={slab.skew}
                onChange={(value) => patchSlab({ skew: value })}
              />
              <ToggleField
                label="Skew Texture"
                value={slab.skewTexture}
                onChange={(value) => patchSlab({ skewTexture: value })}
              />
              <SelectField
                label="Culling"
                value={slab.culling}
                options={["back", "front", "none"]}
                renderOption={(value) => value === "back"
                  ? "Cull Back"
                  : value === "front"
                    ? "Cull Front"
                    : "Double Sided"}
                onChange={(value) => patchSlab({ culling: value as typeof slab.culling })}
              />
            </div>
          </section>

          <section aria-labelledby="inspector-front-bevel-heading" className="field-section">
            <h3 id="inspector-front-bevel-heading">Front Bevel</h3>
            <ToggleField
              label="Enabled"
              value={slab.frontBevel.enabled}
              onChange={(enabled) => patchSlab({ frontBevel: { enabled } })}
            />
            {slab.frontBevel.enabled ? (
              <div className="two-column">
                <NumberField {...history}
                  label="Size"
                  min={0}
                  value={slab.frontBevel.size}
                  onChange={(size) => patchSlab({ frontBevel: { size: Math.max(0, size) } })}
                />
                <NumberField {...history}
                  label="Depth"
                  min={0}
                  value={slab.frontBevel.depth}
                  onChange={(depth) => patchSlab({ frontBevel: { depth: Math.max(0, depth) } })}
                />
              </div>
            ) : null}
          </section>

          <section aria-labelledby="inspector-back-bevel-heading" className="field-section">
            <h3 id="inspector-back-bevel-heading">Back Bevel</h3>
            <ToggleField
              label="Enabled"
              value={slab.backBevel.enabled}
              onChange={(enabled) => patchSlab({ backBevel: { enabled } })}
            />
            {slab.backBevel.enabled ? (
              <div className="two-column">
                <NumberField {...history}
                  label="Size"
                  min={0}
                  value={slab.backBevel.size}
                  onChange={(size) => patchSlab({ backBevel: { size: Math.max(0, size) } })}
                />
                <NumberField {...history}
                  label="Depth"
                  min={0}
                  value={slab.backBevel.depth}
                  onChange={(depth) => patchSlab({ backBevel: { depth: Math.max(0, depth) } })}
                />
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {supportsAppearance ? (
      <section aria-labelledby="inspector-appearance-heading" className="field-section">
        <h3 id="inspector-appearance-heading">Appearance</h3>
        {supportsFill ? (
        <ColorValueEditor
          fallback={object.fill}
          label="Fill"
          value={object.fillStyle ?? object.fill}
          onChange={(fillStyle) => patch({
            fillStyle,
            ...(fillStyle.type === "solid" ? { fill: fillStyle.color } : {})
          })}
        />
        ) : null}
        {noteFor("fill")}
        <ColorValueEditor
          fallback={object.stroke}
          label="Stroke"
          value={object.strokeStyle ?? object.stroke}
          onChange={(strokeStyle) => patch({
            strokeStyle,
            ...(strokeStyle.type === "solid" ? { stroke: strokeStyle.color } : {})
          })}
        />
        {noteFor("stroke")}
        <div className="two-column">
        <ConstrainedNumberField {...history} label="Stroke W" objectType={object.type} property="strokeWidth" value={object.strokeWidth} onChange={(value) => patch({ strokeWidth: value })} />
        {object.type === "rect" ? (
          <ConstrainedNumberField {...history} label="Radius" objectType={object.type} property="radius" value={object.radius} onChange={(value) => patch({ radius: value } as Partial<SceneObject>)} />
        ) : null}
        </div>
        {object.type === "rect" || object.type === "ellipse" ? (
          <div style={{ marginTop: 8 }}>
            <button
              className="inspector-action-button"
              onClick={() => convertObjectToShape(object.id)}
              style={{
                width: "100%",
                padding: "6px 12px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--r-sm)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 500
              }}
              type="button"
            >
              Convert to Editable Path
            </button>
          </div>
        ) : null}
      </section>
      ) : null}

      <ObjectTypeProperties object={object} />

      {object.type === "text" ? (
        <section aria-labelledby="inspector-typography-heading" className="field-section two-column">
          <h3 id="inspector-typography-heading">Typography</h3>
          <TextFontControls object={object} patch={patch} />
          <ConstrainedNumberField {...history}
            label="Font"
            objectType={object.type}
            property="fontSize"
            value={object.fontSize}
            onChange={(value) => patch({ fontSize: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Align"
            value={object.align}
            options={["left", "center", "right"]}
            onChange={(value) => patch({ align: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Layout"
            value={object.textLayout ?? "paragraph"}
            options={["point", "paragraph"]}
            onChange={(value) => patch({ textLayout: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Auto fit"
            value={object.autoFit ?? "none"}
            options={["none", "shrink", "fit"]}
            onChange={(value) => patch({ autoFit: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Writing"
            value={object.writingMode ?? "horizontal-tb"}
            options={["horizontal-tb", "vertical-rl", "vertical-lr"]}
            onChange={(value) => patch({ writingMode: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Vertical"
            value={object.verticalAlign ?? "top"}
            options={["top", "middle", "bottom"]}
            onChange={(value) => patch({ verticalAlign: value } as Partial<SceneObject>)}
          />
          <ConstrainedNumberField {...history} label="Line height" objectType={object.type} property="lineHeight" value={object.lineHeight ?? object.fontSize * 1.2} onChange={(value) => patch({ lineHeight: value } as Partial<SceneObject>)} />
          <ConstrainedNumberField {...history} label="Letter space" objectType={object.type} property="letterSpacing" value={object.letterSpacing ?? 0} onChange={(value) => patch({ letterSpacing: value } as Partial<SceneObject>)} />
          <ConstrainedNumberField {...history} label="Word space" objectType={object.type} property="wordSpacing" value={object.wordSpacing ?? 0} onChange={(value) => patch({ wordSpacing: value } as Partial<SceneObject>)} />
          <ParityNote>{textControl("wordSpacing").note}</ParityNote>
          <ParityNote>{textControl("paragraphSpacing").note}</ParityNote>
          <ConstrainedNumberField {...history}
            disabled={!textControl("paragraphSpacing").enabled}
            label="Paragraph space" objectType={object.type} property="paragraphSpacing"
            value={object.paragraphSpacing ?? 0}
            onChange={(value) => patch({ paragraphSpacing: value } as Partial<SceneObject>)}
          />
        </section>
      ) : null}

      {object.type === "text" ? (
        <section aria-labelledby="inspector-decoration-flow-heading" className="field-section inspector-control-section">
          <h3 id="inspector-decoration-flow-heading">Decoration and flow</h3>
          <div className="two-column">
            <ToggleField
              label="Underline"
              value={object.textDecoration?.underline ?? false}
              onChange={(underline) => patch({
                textDecoration: { ...object.textDecoration, underline }
              } as Partial<SceneObject>)}
            />
            <ToggleField
              label="Strikethrough"
              value={object.textDecoration?.strikethrough ?? false}
              onChange={(strikethrough) => patch({
                textDecoration: { ...object.textDecoration, strikethrough }
              } as Partial<SceneObject>)}
            />
            <ConstrainedNumberField {...history}
              disabled
              label="First-line indent" objectType={object.type} property="textIndent"
              value={object.textIndent ?? 0}
              onChange={(textIndent) => patch({ textIndent } as Partial<SceneObject>)}
            />
            <SelectField
              disabled
              label="Overflow"
              value={object.overflow ?? "visible"}
              options={["visible", "hidden", "clip"] as const}
              onChange={(overflow) => patch({ overflow } as Partial<SceneObject>)}
            />
          </div>
          <ParityNote>
            Underline and strikethrough are drawn by the Editor viewport; the render engine's text
            renderer does not draw them yet, so a decorated caption will look different on Program.
          </ParityNote>
          {/*
            Reported because Preview is already applying it. Which values get reported, and the wording,
            are decided by `importedDisclosures` so the behaviour can be proven without a browser.
          */}
          {importedDisclosures(object).map((disclosure) => (
            <Fragment key={disclosure.property}>
              <ReadOnlyField label={disclosure.label} value={disclosure.value} />
              <ParityNote>{disclosure.note}</ParityNote>
            </Fragment>
          ))}
          <ParityNote>{textControl("textIndent").note}</ParityNote>
          <ParityNote>{textControl("overflow").note}</ParityNote>
        </section>
      ) : null}

      {object.type === "light" ? (
        <section aria-labelledby="inspector-light-heading" className="field-section inspector-control-section">
          <h3 id="inspector-light-heading">Light</h3>
          <div className="two-column">
            <SelectField
              label="Kind"
              value={object.lightKind}
              options={["directional", "point", "spot"]}
              onChange={(value) => patch({ lightKind: value } as Partial<SceneObject>)}
            />
            <ColorField
              label="Colour"
              value={object.color}
              onChange={(value) => patch({ color: value } as Partial<SceneObject>)}
            />
            <ConstrainedNumberField {...history}
              label="Intensity" objectType={object.type} property="intensity"
              value={object.intensity}
              onChange={(value) => patch({ intensity: value } as Partial<SceneObject>)}
            />
            {object.lightKind !== "directional" ? (
              <>
                <ConstrainedNumberField {...history}
                  label="Range" objectType={object.type} property="range"
                  value={object.range ?? 0}
                  onChange={(value) => patch({ range: value } as Partial<SceneObject>)}
                />
                <ConstrainedNumberField {...history}
                  label="Decay" objectType={object.type} property="decay"
                  value={object.decay ?? 2}
                  onChange={(value) => patch({ decay: value } as Partial<SceneObject>)}
                />
              </>
            ) : null}
            {object.lightKind === "spot" ? (
              <>
                <ConstrainedNumberField {...history}
                  label="Cone" objectType={object.type} property="coneAngleDeg"
                  value={object.coneAngleDeg ?? 42}
                  onChange={(value) => patch({ coneAngleDeg: value } as Partial<SceneObject>)}
                />
                <ConstrainedNumberField {...history}
                  label="Penumbra" objectType={object.type} property="penumbra"
                  value={object.penumbra ?? 0.25}
                  onChange={(value) => patch({ penumbra: value } as Partial<SceneObject>)}
                />
              </>
            ) : null}
            <NumberField {...history}
              label="Target X"
              value={object.target?.x ?? scene.canvas.width / 2}
              onChange={(value) => patch({ target: { x: value, y: object.target?.y ?? scene.canvas.height / 2, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Target Y"
              value={object.target?.y ?? scene.canvas.height / 2}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: value, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Target Z"
              value={object.target?.z ?? 0}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: object.target?.y ?? scene.canvas.height / 2, z: value } } as Partial<SceneObject>)}
            />
            <ToggleField
              label="Cast shadow"
              value={object.castShadow ?? false}
              onChange={(value) => patch({ castShadow: value } as Partial<SceneObject>)}
            />
          </div>
          <ParityNote>{inspectorControl("light", "castShadow").note}</ParityNote>
        </section>
      ) : null}

      {object.type === "camera" ? (
        <section aria-labelledby="inspector-camera-heading" className="field-section inspector-control-section">
          <div className="inspector-section-heading">
            <h3 id="inspector-camera-heading">Camera</h3>
            <button
              className={`mini-chip-button ${scene.activeCameraId === object.id ? "active" : ""}`}
              onClick={() => setActiveCameraId(scene.activeCameraId === object.id ? null : object.id)}
              title={scene.activeCameraId === object.id
                ? "Stop using this camera for the Editor preview"
                : "Use this camera in the Editor preview"}
            >
              {scene.activeCameraId === object.id ? "Active camera" : "Make active"}
            </button>
          </div>
          <div className="two-column">
            <SelectField
              label="Projection"
              value={object.cameraKind}
              options={["perspective", "orthographic"]}
              onChange={(value) => patch({ cameraKind: value } as Partial<SceneObject>)}
            />
            {object.cameraKind === "perspective" ? (
              <ConstrainedNumberField {...history}
                label="Field of view"
                objectType={object.type}
                property="fov"
                value={object.fov}
                onChange={(value) => patch({ fov: value } as Partial<SceneObject>)}
              />
            ) : null}
            <ConstrainedNumberField {...history}
              label="Zoom" objectType={object.type} property="zoom"
              value={object.zoom}
              onChange={(value) => patch({ zoom: value } as Partial<SceneObject>)}
            />
            <ConstrainedNumberField {...history}
              label="Near" objectType={object.type} property="near"
              value={object.near ?? 1}
              onChange={(value) => patch({ near: value } as Partial<SceneObject>)}
            />
            <ConstrainedNumberField {...history}
              label="Far" objectType={object.type} property="far"
              value={object.far ?? 20_000}
              onChange={(value) => patch({ far: value } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Target X"
              value={object.target?.x ?? scene.canvas.width / 2}
              onChange={(value) => patch({ target: { x: value, y: object.target?.y ?? scene.canvas.height / 2, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Target Y"
              value={object.target?.y ?? scene.canvas.height / 2}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: value, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Target Z"
              value={object.target?.z ?? 0}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: object.target?.y ?? scene.canvas.height / 2, z: value } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Up X"
              value={object.up?.x ?? 0}
              step={0.1}
              onChange={(value) => patch({ up: { x: value, y: object.up?.y ?? -1, z: object.up?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Up Y"
              value={object.up?.y ?? -1}
              step={0.1}
              onChange={(value) => patch({ up: { x: object.up?.x ?? 0, y: value, z: object.up?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField {...history}
              label="Up Z"
              value={object.up?.z ?? 0}
              step={0.1}
              onChange={(value) => patch({ up: { x: object.up?.x ?? 0, y: object.up?.y ?? -1, z: value } } as Partial<SceneObject>)}
            />
          </div>
          <ParityNote>{inspectorControl("camera", "fov").note}</ParityNote>
        </section>
      ) : null}

      {object.type === "layer" ? (
        <section aria-labelledby="inspector-layer-contents-heading" className="field-section inspector-control-section">
          <h3 id="inspector-layer-contents-heading">Layer contents</h3>
          <SelectField
            label="Layer kind"
            value={object.layerKind}
            options={["object", "camera"]}
            onChange={(value) => {
              const childIds = object.childIds.filter((childId) => {
                const child = scene.objects.find((candidate) => candidate.id === childId);
                return child && (value === "camera" ? child.type === "camera" : child.type !== "camera");
              });
              patch({ layerKind: value, childIds } as Partial<SceneObject>);
            }}
          />
          <div className="container-child-list">
            {scene.objects
              .filter((candidate) =>
                candidate.id !== object.id
                && (object.layerKind === "camera" ? candidate.type === "camera" : candidate.type !== "camera")
              )
              .map((candidate) => (
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
            {scene.objects.every((candidate) =>
              candidate.id === object.id
              || (object.layerKind === "camera" ? candidate.type !== "camera" : candidate.type === "camera")
            ) ? <div className="empty-panel compact">No compatible objects in this scene.</div> : null}
          </div>
        </section>
      ) : null}

      {object.importedDesign ? <ImportedDesignSection object={object} /> : null}

      {supportsMasks ? <MasksSection object={object} /> : null}

        </>
      ) : null}

    </aside>
  );
}

const MASK_MODES: MaskMode[] = ["add", "subtract", "intersect", "lighten", "darken", "difference", "none"];

function ImportedDesignSection({ object }: { object: SceneObject }) {
  const updateObject = useEditorStore((state) => state.updateObject);
  const metadata = object.importedDesign!;
  const collapsed = useObjectInspectorStore((state) => state.collapsedDisclosures.includes("imported-design"));
  const toggleDisclosure = useObjectInspectorStore((state) => state.toggleDisclosure);
  const headingId = "inspector-imported-design-heading";
  const contentId = "inspector-imported-design-content";
  const effects = metadata.effects ?? [];
  const layout = metadata.responsiveLayout ?? {};
  const patchMetadata = (patch: Partial<NonNullable<SceneObject["importedDesign"]>>) =>
    updateObject(object.id, { importedDesign: { ...metadata, ...patch } });

  return (
    <section aria-labelledby={headingId} className="field-section imported-design-section">
      <div className="inspector-section-heading">
        <InspectorDisclosureToggle
          contentId={contentId}
          expanded={!collapsed}
          headingId={headingId}
          label="Imported Design"
          onToggle={() => toggleDisclosure("imported-design")}
        />
        <span>{metadata.sourceFormat.toUpperCase()}</span>
      </div>
      <div className="inspector-disclosure-content" hidden={collapsed} id={contentId}>
      <div className="two-column">
        <TextField label="Source node" value={metadata.sourceNodeId ?? ""} onChange={(sourceNodeId) => patchMetadata({ sourceNodeId })} />
        <TextField label="Source type" value={metadata.sourceNodeType} onChange={(sourceNodeType) => patchMetadata({ sourceNodeType })} />
        {metadata.componentId ? <TextField label="Component" value={metadata.componentId} onChange={(componentId) => patchMetadata({ componentId })} /> : null}
        {typeof layout.mode === "string" ? (
          <SelectField
            label="Responsive layout"
            value={layout.mode as "none" | "horizontal" | "vertical"}
            options={["none", "horizontal", "vertical"]}
            onChange={(mode) => patchMetadata({ responsiveLayout: { ...layout, mode } })}
          />
        ) : null}
        {typeof layout.gap === "number" ? (
          <NumberField {...history} label="Layout gap" value={layout.gap} onChange={(gap) => patchMetadata({ responsiveLayout: { ...layout, gap } })} />
        ) : null}
      </div>
      {/*
        Reported, not authored.

        These were editable — an Enabled checkbox, opacity, radius, spread and colour — for effects
        that **no GrapiX renderer draws**: `IMPLEMENTED_OBJECT_EFFECTS` is an empty list. So an author
        could tune a drop shadow, see nothing change in Preview, and publish a frame with nothing
        changed either. The values still round-trip; they are simply no longer offered as controls
        until a renderer implements layer styles.
      */}
      {effects.length ? (
        <div className="imported-effect-list">
          {effects.map((effect, index) => (
            <article key={`${String(effect.type)}-${index}`}>
              <div>
                <strong>{String(effect.type ?? "Effect").replaceAll("-", " ")}</strong>
                <span className="imported-effect-state">
                  {effect.enabled === false ? "disabled in source" : "enabled in source"}
                </span>
              </div>
              <div className="two-column">
                {typeof effect.opacity === "number" ? <ReadOnlyField label="Opacity" value={String(effect.opacity)} /> : null}
                {typeof effect.radius === "number" ? <ReadOnlyField label="Radius" value={String(effect.radius)} /> : null}
                {typeof effect.spread === "number" ? <ReadOnlyField label="Spread" value={String(effect.spread)} /> : null}
                {typeof effect.color === "string" ? <ReadOnlyField label="Colour" value={effect.color} /> : null}
              </div>
            </article>
          ))}
          <ParityNote>{inspectorControl(object.type, "effects").note}</ParityNote>
        </div>
      ) : null}
      </div>
    </section>
  );
}

function MasksSection({ object }: { object: SceneObject }) {
  const addRectMask = useEditorStore((state) => state.addRectMask);
  const updateMask = useEditorStore((state) => state.updateMask);
  const duplicateMask = useEditorStore((state) => state.duplicateMask);
  const moveMask = useEditorStore((state) => state.moveMask);
  const toggleMaskKeyframe = useEditorStore((state) => state.toggleMaskKeyframe);
  const deleteMask = useEditorStore((state) => state.deleteMask);
  const setActiveTool = useUiStore((state) => state.setActiveTool);
  const setPenTarget = useUiStore((state) => state.setPenTarget);
  const updateMarquee = useUiStore((state) => state.updateMarqueeOptions);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const masks = object.masks ?? [];
  const collapsed = useObjectInspectorStore((state) => state.collapsedDisclosures.includes("masks"));
  const toggleDisclosure = useObjectInspectorStore((state) => state.toggleDisclosure);
  const headingId = "inspector-masks-heading";
  const contentId = "inspector-masks-content";

  return (
    <section aria-labelledby={headingId} className="field-section masks-section">
      <div className="masks-header">
        <InspectorDisclosureToggle
          contentId={contentId}
          expanded={!collapsed}
          headingId={headingId}
          label="Masks"
          onToggle={() => toggleDisclosure("masks")}
        />
        <div className="masks-actions" hidden={collapsed}>
          <button className="mini-chip-button" title="Add a rectangular mask" onClick={() => addRectMask(object.id)}>
            <Plus size={12} /> Rect
          </button>
          <button className="mini-chip-button" title="Draw an elliptical mask" onClick={() => {
            updateMarquee({ mode: "mask" });
            setActiveTool("elliptical-marquee");
          }}>
            <Plus size={12} /> Ellipse
          </button>
          <button
            className="mini-chip-button"
            title="Draw a mask with the pen tool"
            onClick={() => { setPenTarget("mask"); setActiveTool("pen"); }}
          >
            <PenTool size={12} /> Pen
          </button>
        </div>
      </div>
      <div className="inspector-disclosure-content" hidden={collapsed} id={contentId}>
      {masks.length === 0 ? <div className="empty-panel compact">No masks. Add one to clip this layer.</div> : null}
      {masks.map((mask) => (
        <div className={`mask-row ${selectedMaskId === mask.id ? "selected" : ""}`} key={mask.id} onClick={() => setSelectedMaskId(mask.id)}>
          <div className="mask-row-heading">
            <button className="panel-icon-button" onClick={() => updateMask(object.id, mask.id, { visible: mask.visible === false })} title={mask.visible === false ? "Show mask" : "Hide mask"}>
              {mask.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button className="panel-icon-button" onClick={() => updateMask(object.id, mask.id, { locked: !mask.locked })} title={mask.locked ? "Unlock mask" : "Lock mask"}>
              {mask.locked ? <Lock size={13} /> : <Unlock size={13} />}
            </button>
            <input className="mask-name" value={mask.name} onChange={(event) => updateMask(object.id, mask.id, { name: event.target.value })} />
            <button className="panel-icon-button" title="Duplicate mask" onClick={() => setSelectedMaskId(duplicateMask(object.id, mask.id))}><Copy size={13} /></button>
            <button className="panel-icon-button" title="Move mask up" onClick={() => moveMask(object.id, mask.id, "up")}><ArrowUp size={13} /></button>
            <button className="panel-icon-button" title="Move mask down" onClick={() => moveMask(object.id, mask.id, "down")}><ArrowDown size={13} /></button>
            <button className="panel-icon-button danger" title="Delete mask" onClick={() => {
              deleteMask(object.id, mask.id);
              if (selectedMaskId === mask.id) setSelectedMaskId(null);
            }}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="mask-row-properties">
            <label>Mode <select value={mask.mode} onChange={(event) => updateMask(object.id, mask.id, { mode: event.target.value as MaskMode })}>
              {MASK_MODES.map((mode) => <option value={mode} key={mode}>{mode}</option>)}
            </select></label>
            <label><input type="checkbox" checked={mask.inverted} onChange={(event) => updateMask(object.id, mask.id, { inverted: event.target.checked })} /> Invert</label>
            <label>Opacity <MaskClock active={Boolean(mask.animation?.opacity?.some((key) => key.frame === currentFrame))} onClick={() => toggleMaskKeyframe(object.id, mask.id, "opacity", currentFrame)} /><input min={0} max={100} type="number" value={Math.round(mask.opacity * 100)} onChange={(event) => updateMask(object.id, mask.id, { opacity: event.target.valueAsNumber / 100 })} /></label>
            <label>Feather X <MaskClock active={Boolean(mask.animation?.feather?.some((key) => key.frame === currentFrame))} onClick={() => toggleMaskKeyframe(object.id, mask.id, "feather", currentFrame)} /><input min={0} type="number" value={mask.feather.x} onChange={(event) => updateMask(object.id, mask.id, { feather: { ...mask.feather, x: event.target.valueAsNumber } })} /></label>
            <label>Feather Y <input min={0} type="number" value={mask.feather.y} onChange={(event) => updateMask(object.id, mask.id, { feather: { ...mask.feather, y: event.target.valueAsNumber } })} /></label>
            <label>Expansion <MaskClock active={Boolean(mask.animation?.expansion?.some((key) => key.frame === currentFrame))} onClick={() => toggleMaskKeyframe(object.id, mask.id, "expansion", currentFrame)} /><input type="number" value={mask.expansion} onChange={(event) => updateMask(object.id, mask.id, { expansion: event.target.valueAsNumber })} /></label>
            <label>Path <MaskClock active={Boolean(mask.animation?.path?.some((key) => key.frame === currentFrame))} onClick={() => toggleMaskKeyframe(object.id, mask.id, "path", currentFrame)} /></label>
          </div>
        </div>
      ))}
      </div>
    </section>
  );
}

function MaskClock(props: { active: boolean; onClick: () => void }) {
  return (
    <button
      aria-label={props.active ? "Remove mask keyframe at playhead" : "Add mask keyframe at playhead"}
      className={`mask-clock ${props.active ? "active" : ""}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onClick();
      }}
      title={props.active ? "Remove keyframe at playhead" : "Add keyframe at playhead"}
      type="button"
    >
      <Clock3 size={11} />
    </button>
  );
}

function ObjectNameField(props: {
  object: SceneObject;
  onRename: (name: string) => boolean;
}) {
  const [draft, setDraft] = useState(props.object.name);

  useEffect(() => setDraft(props.object.name), [props.object.id, props.object.name]);

  function commit() {
    const nextName = draft.trim();
    if (nextName === props.object.name) {
      setDraft(props.object.name);
      return;
    }
    if (!props.onRename(nextName)) setDraft(props.object.name);
  }

  return (
    <label className="field">
      <span>Name</span>
      <input
        aria-label="Object name"
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(props.object.name);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** Enough precision for a scrub, without rendering float dust. */
function roundForDisplay(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The source note for a property whose field is not the animated kind.
 *
 * `width`, `height`, `fill`, `stroke`, `text` and `src` are bindable and have no animation channel,
 * so they render through the plain primitives. Without this they were the one place a binding stayed
 * invisible: the Data Binding tab knew, and the field the author was looking at did not.
 */
function sourceNoteFor(object: SceneObject, property: string, dataContext: Record<string, unknown>, frame: number) {
  const source = resolvePropertySource(object, property, dataContext, frame);
  if (source.kind === "static" || source.kind === "keyframed") return undefined;
  return <PropertySourceNote source={source} />;
}

function AnimatedNumberField(props: {
  label: string;
  object: SceneObject;
  property: AnimatableProperty;
  value: number;
}) {
  const currentFrame = useUiStore((state) => state.currentFrame);
  const scene = useEditorStore((state) => state.scene);
  const setAnimationEnabled = useEditorStore((state) => state.setPropertyAnimationEnabled);
  const setAnimatedValue = useEditorStore((state) => state.setAnimatedPropertyValue);
  const addKeyframe = useEditorStore((state) => state.addPropertyKeyframe);
  const deleteKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  // The animation question is per object kind and is answered in one place, which package preflight
  // consults too: Program discards a `zDepth` channel on 2D content because depth is paint order,
  // resolved when the scene is prepared. So the field keeps its number and drops its stopwatch, and
  // an existing channel is ignored here exactly as the evaluator now ignores it.
  const animatable = isPropertyAnimatable(props.object.type, props.property);
  const channel = animatable ? props.object.animation?.[props.property] : undefined;
  const currentKey = channel?.keys.find((key) => key.frame === currentFrame);
  // Named so a diagnostic this sample raises is the same fault the viewport's sampler reports,
  // rather than a second, anonymous copy of it in the console.
  const value = channel
    ? sampleChannel(channel, currentFrame, { objectId: props.object.id, property: props.property })
    : props.value;
  // `sampleChannel` returns undefined for a channel with no keys, in which case the authored value is
  // still the truth — the same fallback the input already relied on.
  const authoredOrSampled = value ?? props.value;
  /*
   * Which value is actually in force, which is not always the one above.
   *
   * Preview prepares a scene as channels, then hierarchy, then bindings, so a binding **overwrites** a
   * sampled keyframe. This field sampled only the channel, so a bound-and-keyframed property showed a
   * number nothing drew — and said nothing about the binding at all. The resolver answers the whole
   * question in one place, including that Program resolves no bindings and so draws something else.
   */
  const source = resolvePropertySource(props.object, props.property, scene.dataContext, currentFrame);
  const displayValue = typeof source.preview === "number" ? source.preview : authoredOrSampled;
  // A bound value is the data's, not the author's: typing over it would write a number the next data
  // update discards, with no sign that it had.
  const boundElsewhere = source.kind === "bound";

  const beginHistory = useEditorStore((state) => state.beginHistory);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const write = (next: number) => {
    if (!Number.isFinite(next)) return;
    setAnimatedValue(props.object.id, props.property, next, currentFrame);
  };
  /*
   * Range, step and unit are the property's, not this widget's — the same table the Object Manager's
   * grid reads, and the same one the store clamps against. Call sites used to pass their own `step`
   * (`0.05` for scale where the grid used `0.01`) and their own `min`/`max`, which is how one property
   * came to have two editing speeds and two ranges depending on which panel was open.
   */
  const constraint = propertyConstraint(props.object.type, props.property);
  const step = constraint?.step ?? 1;
  const gesture = useNumericGesture({
    label: `Edit ${props.label}`,
    max: constraint?.max,
    min: constraint?.min,
    onBeginEdit: beginHistory,
    onCancelEdit: cancelHistory,
    onChange: write,
    onCommitEdit: commitHistory,
    step,
    value: displayValue
  });

  return (
    <label className={`field animated-number-field ${channel ? "animated" : ""}`}>
      <span>{labelWithUnit(props.label, props.object.type, props.property)}</span>
      <span className={`field-animation-controls ${channel ? "animated" : ""}`}>
        {animatable ? (
          <button
            aria-label={`${channel ? "Disable" : "Enable"} ${props.label} animation`}
            className={`field-stopwatch ${channel ? "active" : ""}`}
            onClick={() => setAnimationEnabled(props.object.id, props.property, !channel, currentFrame)}
            title={channel ? "Disable property animation" : "Enable animation and add a key at the playhead"}
            type="button"
          >
            <Clock3 size={12} />
          </button>
        ) : (
          <span
            className="field-stopwatch-absent"
            title={`Program resolves ${props.label} when the scene is prepared, so a ${props.object.type} object cannot animate it. The value is still editable.`}
          />
        )}
        {channel ? (
          <button
            aria-label={`${currentKey ? "Remove" : "Add"} ${props.label} keyframe at frame ${currentFrame}`}
            className={`field-key-toggle ${currentKey ? "on" : ""}`}
            onClick={() => currentKey
              ? deleteKeyframe(props.object.id, props.property, currentKey.id)
              : addKeyframe(props.object.id, props.property, currentFrame)}
            title={currentKey ? "Remove keyframe at the playhead" : "Add keyframe at the playhead"}
            type="button"
          >
            <Diamond size={10} />
          </button>
        ) : null}
        {/*
          The same gesture as the grid's cells and the plain fields: scrub, Shift for fine control,
          Enter commits, Escape reverts, one undo step per gesture. This field had none of it — it wrote
          through `setAnimatedPropertyValue` on every keystroke, so typing a coordinate deposited one
          history entry per character and there was no way to drag a value at all.
        */}
        <input
          disabled={boundElsewhere}
          max={constraint?.max}
          min={constraint?.min}
          onBlur={gesture.handlers.onBlur}
          onChange={(event) => write(Number(event.target.value))}
          onFocus={gesture.handlers.onFocus}
          onKeyDown={gesture.handlers.onKeyDown}
          onPointerCancel={gesture.handlers.onPointerCancel}
          onPointerDown={gesture.handlers.onPointerDown}
          onPointerMove={gesture.handlers.onPointerMove}
          onPointerUp={gesture.handlers.onPointerUp}
          step={step}
          title={boundElsewhere ? "This value comes from the scene's data. Clear the binding in the Data Binding tab to edit it." : undefined}
          type="number"
          value={roundForDisplay(displayValue)}
        />
      </span>
      {/*
        Where the number came from, stated where the number is. An empty string for a plain authored
        value keeps the common case quiet — a note on every field is a note nobody reads.
      */}
      {source.kind === "static" ? null : (
        <PropertySourceNote source={source} />
      )}
    </label>
  );
}

/**
 * One line under a field saying which value is in force and which renderer agrees.
 *
 * Two states are worth distinguishing visually: a binding that changes what Preview draws relative to
 * Program (`agrees === false`) is a parity gap an author must know about before air, while a keyframe or
 * a broken binding is merely information. So the parity case gets the same treatment as every other
 * Preview-only disclosure in this panel, and the rest stay quiet.
 */
function PropertySourceNote(props: { source: PropertySource }) {
  const sentence = describePropertySource(props.source);
  if (!sentence) return null;
  if (!props.source.agrees) return <ParityNote>{sentence}</ParityNote>;
  return <p className="field-source-note" data-state={props.source.kind}>{sentence}</p>;
}

