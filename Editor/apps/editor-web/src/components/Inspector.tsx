import { useEffect, useState } from "react";
import { getMaterialBindingId, isMaterialCompatible, isMaterialCompatibleWithFace, normalizeSlabProperties, sampleChannel, type AnimatableProperty, type MaskMode, type SceneObject, type SlabPropertiesInput } from "@grapix/shared-types";
import { ArrowDown, ArrowUp, Clock3, Copy, Diamond, Eye, EyeOff, Lock, PenTool, Plus, Trash2, Unlock } from "lucide-react";
import { ColorValueEditor } from "./ColorValueEditor";
import { ObjectTypeProperties } from "./ObjectTypeProperties";
import { TextFontControls } from "./TextFontControls";
import {
  ColorField,
  NumberField,
  ParityNote,
  SelectField,
  TextField,
  ToggleField
} from "./inspectorFields";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

export type InspectorScope = "type" | "transform";

const MATERIAL_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "image", "shape", "paint", "mesh"
]);
const DIMENSION_OBJECT_TYPES: ReadonlySet<SceneObject["type"]> = new Set([
  "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh"
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
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObject = useEditorStore((state) => state.updateObject);
  const renameObject = useEditorStore((state) => state.renameObject);
  const setActiveCameraId = useEditorStore((state) => state.setActiveCameraId);
  const setContainerChild = useEditorStore((state) => state.setContainerChild);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const object = scene.objects.find((item) => item.id === selectedObjectId);
  const supportsMaterial = MATERIAL_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsDimensions = DIMENSION_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsAppearance = APPEARANCE_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsFill = FILL_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsMasks = MASKABLE_OBJECT_TYPES.has(object?.type ?? "marker");
  const supportsDetailedTransform = object?.type !== "camera" && object?.type !== "light";

  if (!object) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <div className="empty-panel">No object selected</div>
      </aside>
    );
  }

  function patch(patchValue: Partial<SceneObject>) {
    updateObject(object!.id, patchValue);
  }


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

      <section className="field-section">
        <h3>Object</h3>
        <ObjectNameField
          object={object}
          onRename={(name) => {
            if (renameObject(object.id, name)) return true;
            window.alert(`"${name.trim() || name}" is already used by another object. Object names must be unique.`);
            return false;
          }}
        />
        {supportsMaterial ? (
        <SelectField
          label="Main Material"
          value={getMaterialBindingId(object.materialSlots.main) ?? ""}
          options={["", ...scene.materials
            .filter((material) => object.type === "mesh"
              ? isMaterialCompatibleWithFace(material, object, 0)
              : isMaterialCompatible(material, object.type))
            .map((material) => material.materialId)]}
          renderOption={(value) =>
            value ? scene.materials.find((material) => material.materialId === value)?.name ?? value : "None"
          }
          onChange={(value) => assignMaterialSlot(object.id, "main", value)}
        />
        ) : null}
        {object.type === "text" ? (
          <TextField label="Text" value={object.text} onChange={(value) => patch({ text: value } as Partial<SceneObject>)} />
        ) : null}
        {object.type === "image" ? (
          <TextField label="Image URL" value={object.src} onChange={(value) => patch({ src: value } as Partial<SceneObject>)} />
        ) : null}
      </section>
        </>
      ) : null}

      {scope === "transform" ? (
      <section className="field-section two-column">
        <h3>Transform</h3>
        <AnimatedNumberField label="X" object={object} property="x" value={object.x} />
        <AnimatedNumberField label="Y" object={object} property="y" value={object.y} />
        <AnimatedNumberField label="Position Z" object={object} property="zDepth" value={object.zDepth} />
        <TextField label="Layer" value={object.layerId} onChange={(value) => patch({ layerId: value || "main" })} />
        {supportsDimensions ? (
          <>
        <NumberField label="W" value={object.width} onChange={(value) => patch({ width: value })} />
        <NumberField label="H" value={object.height} onChange={(value) => patch({ height: value })} />
          </>
        ) : null}
        {object.type === "mesh" ? (
          <>
            <NumberField label={object.meshKind === "slab" ? "Extrusion" : "Depth"} value={object.depth} min={0.01} onChange={(value) => patch({ depth: value } as Partial<SceneObject>)} />
            <AnimatedNumberField label="Rotation X" object={object} property="rotationX" value={object.rotationX ?? 0} />
            <AnimatedNumberField label="Rotation Y" object={object} property="rotationY" value={object.rotationY ?? 0} />
            <AnimatedNumberField label="Rotation Z" object={object} property="rotationZ" value={object.rotationZ ?? object.rotation} />
            <AnimatedNumberField label="Scale X" object={object} property="scaleX" step={0.05} value={object.scaleX ?? 1} />
            <AnimatedNumberField label="Scale Y" object={object} property="scaleY" step={0.05} value={object.scaleY ?? 1} />
            <AnimatedNumberField label="Scale Z" object={object} property="scaleZ" step={0.05} value={object.scaleZ ?? 1} />
            <NumberField
              label="Anchor X"
              value={object.anchor3d?.x ?? object.width / 2}
              onChange={(value) => patch({ anchor3d: { x: value, y: object.anchor3d?.y ?? object.height / 2, z: object.anchor3d?.z ?? object.depth / 2 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Anchor Y"
              value={object.anchor3d?.y ?? object.height / 2}
              onChange={(value) => patch({ anchor3d: { x: object.anchor3d?.x ?? object.width / 2, y: value, z: object.anchor3d?.z ?? object.depth / 2 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Anchor Z"
              value={object.anchor3d?.z ?? object.depth / 2}
              onChange={(value) => patch({ anchor3d: { x: object.anchor3d?.x ?? object.width / 2, y: object.anchor3d?.y ?? object.height / 2, z: value } } as Partial<SceneObject>)}
            />
          </>
        ) : supportsDetailedTransform ? (
          <>
            <AnimatedNumberField label="Rotate" object={object} property="rotation" value={object.rotation} />
            <AnimatedNumberField label="Scale X" object={object} property="scaleX" step={0.05} value={object.scaleX ?? 1} />
            <AnimatedNumberField label="Scale Y" object={object} property="scaleY" step={0.05} value={object.scaleY ?? 1} />
            <NumberField
              label="Anchor X"
              value={object.anchor?.x ?? 0}
              onChange={(value) => patch({ anchor: { x: value, y: object.anchor?.y ?? 0 } })}
            />
            <NumberField
              label="Anchor Y"
              value={object.anchor?.y ?? 0}
              onChange={(value) => patch({ anchor: { x: object.anchor?.x ?? 0, y: value } })}
            />
          </>
        ) : null}
        {supportsDetailedTransform ? (
        <AnimatedNumberField
          label="Opacity"
          max={1}
          min={0}
          object={object}
          property="opacity"
          step={0.05}
          value={object.opacity}
        />
        ) : null}
      </section>
      ) : null}

      {scope === "type" ? (
        <>
      {slab ? (
        <>
          <section className="field-section">
            <h3>Slab Shape</h3>
            <div className="two-column">
              <NumberField
                label="Corner Radius"
                value={slab.cornerRadius}
                min={0}
                onChange={(value) => patchSlab({ cornerRadius: Math.max(0, value) })}
              />
              <NumberField
                label="Corner Quality"
                value={slab.cornerSegments}
                min={1}
                max={32}
                onChange={(value) => patchSlab({ cornerSegments: Math.max(1, Math.min(32, Math.round(value))) })}
              />
              <NumberField
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

          <section className="field-section">
            <h3>Front Bevel</h3>
            <ToggleField
              label="Enabled"
              value={slab.frontBevel.enabled}
              onChange={(enabled) => patchSlab({ frontBevel: { enabled } })}
            />
            {slab.frontBevel.enabled ? (
              <div className="two-column">
                <NumberField
                  label="Size"
                  value={slab.frontBevel.size}
                  min={0}
                  onChange={(size) => patchSlab({ frontBevel: { size: Math.max(0, size) } })}
                />
                <NumberField
                  label="Depth"
                  value={slab.frontBevel.depth}
                  min={0}
                  onChange={(depth) => patchSlab({ frontBevel: { depth: Math.max(0, depth) } })}
                />
              </div>
            ) : null}
          </section>

          <section className="field-section">
            <h3>Back Bevel</h3>
            <ToggleField
              label="Enabled"
              value={slab.backBevel.enabled}
              onChange={(enabled) => patchSlab({ backBevel: { enabled } })}
            />
            {slab.backBevel.enabled ? (
              <div className="two-column">
                <NumberField
                  label="Size"
                  value={slab.backBevel.size}
                  min={0}
                  onChange={(size) => patchSlab({ backBevel: { size: Math.max(0, size) } })}
                />
                <NumberField
                  label="Depth"
                  value={slab.backBevel.depth}
                  min={0}
                  onChange={(depth) => patchSlab({ backBevel: { depth: Math.max(0, depth) } })}
                />
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {supportsAppearance ? (
      <section className="field-section">
        <h3>Appearance</h3>
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
        <ColorValueEditor
          fallback={object.stroke}
          label="Stroke"
          value={object.strokeStyle ?? object.stroke}
          onChange={(strokeStyle) => patch({
            strokeStyle,
            ...(strokeStyle.type === "solid" ? { stroke: strokeStyle.color } : {})
          })}
        />
        <div className="two-column">
        <NumberField label="Stroke W" value={object.strokeWidth} min={0} onChange={(value) => patch({ strokeWidth: value })} />
        {object.type === "rect" ? (
          <NumberField label="Radius" value={object.radius} min={0} onChange={(value) => patch({ radius: value } as Partial<SceneObject>)} />
        ) : null}
        </div>
      </section>
      ) : null}

      <ObjectTypeProperties object={object} />

      {object.type === "text" ? (
        <section className="field-section two-column">
          <h3>Typography</h3>
          <TextFontControls object={object} patch={patch} />
          <NumberField
            label="Font"
            value={object.fontSize}
            min={8}
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
          <NumberField label="Line height" value={object.lineHeight ?? object.fontSize * 1.2} min={1} onChange={(value) => patch({ lineHeight: value } as Partial<SceneObject>)} />
          <NumberField label="Letter space" value={object.letterSpacing ?? 0} onChange={(value) => patch({ letterSpacing: value } as Partial<SceneObject>)} />
          <NumberField label="Word space" value={object.wordSpacing ?? 0} onChange={(value) => patch({ wordSpacing: value } as Partial<SceneObject>)} />
          <NumberField label="Paragraph space" value={object.paragraphSpacing ?? 0} min={0} onChange={(value) => patch({ paragraphSpacing: value } as Partial<SceneObject>)} />
        </section>
      ) : null}

      {object.type === "text" ? (
        <section className="field-section inspector-control-section">
          <h3>Decoration and flow</h3>
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
            <NumberField
              disabled
              label="First-line indent"
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
            Indent and overflow are disabled because neither renderer honours them.
          </ParityNote>
        </section>
      ) : null}

      {object.type === "light" ? (
        <section className="field-section inspector-control-section">
          <h3>Light</h3>
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
            <NumberField
              label="Intensity"
              value={object.intensity}
              min={0}
              step={0.1}
              onChange={(value) => patch({ intensity: value } as Partial<SceneObject>)}
            />
            {object.lightKind !== "directional" ? (
              <>
                <NumberField
                  label="Range"
                  value={object.range ?? 0}
                  min={0}
                  onChange={(value) => patch({ range: value } as Partial<SceneObject>)}
                />
                <NumberField
                  label="Decay"
                  value={object.decay ?? 2}
                  min={0}
                  step={0.1}
                  onChange={(value) => patch({ decay: value } as Partial<SceneObject>)}
                />
              </>
            ) : null}
            {object.lightKind === "spot" ? (
              <>
                <NumberField
                  label="Cone °"
                  value={object.coneAngleDeg ?? 42}
                  min={1}
                  max={179}
                  step={1}
                  onChange={(value) => patch({ coneAngleDeg: value } as Partial<SceneObject>)}
                />
                <NumberField
                  label="Penumbra"
                  value={object.penumbra ?? 0.25}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) => patch({ penumbra: value } as Partial<SceneObject>)}
                />
              </>
            ) : null}
            <NumberField
              label="Target X"
              value={object.target?.x ?? scene.canvas.width / 2}
              onChange={(value) => patch({ target: { x: value, y: object.target?.y ?? scene.canvas.height / 2, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Target Y"
              value={object.target?.y ?? scene.canvas.height / 2}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: value, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
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
        </section>
      ) : null}

      {object.type === "camera" ? (
        <section className="field-section inspector-control-section">
          <div className="inspector-section-heading">
            <h3>Camera</h3>
            <button
              className={`mini-chip-button ${scene.activeCameraId === object.id ? "active" : ""}`}
              onClick={() => setActiveCameraId(scene.activeCameraId === object.id ? null : object.id)}
              title={scene.activeCameraId === object.id ? "Stop using this as the program camera" : "Use this camera in the canvas"}
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
              <NumberField
                label="Field of view"
                value={object.fov}
                min={1}
                max={179}
                step={1}
                onChange={(value) => patch({ fov: value } as Partial<SceneObject>)}
              />
            ) : null}
            <NumberField
              label="Zoom"
              value={object.zoom}
              min={0.01}
              step={0.05}
              onChange={(value) => patch({ zoom: value } as Partial<SceneObject>)}
            />
            <NumberField
              label="Near"
              value={object.near ?? 1}
              min={0.01}
              step={0.1}
              onChange={(value) => patch({ near: value } as Partial<SceneObject>)}
            />
            <NumberField
              label="Far"
              value={object.far ?? 20_000}
              min={0.02}
              onChange={(value) => patch({ far: value } as Partial<SceneObject>)}
            />
            <NumberField
              label="Target X"
              value={object.target?.x ?? scene.canvas.width / 2}
              onChange={(value) => patch({ target: { x: value, y: object.target?.y ?? scene.canvas.height / 2, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Target Y"
              value={object.target?.y ?? scene.canvas.height / 2}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: value, z: object.target?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Target Z"
              value={object.target?.z ?? 0}
              onChange={(value) => patch({ target: { x: object.target?.x ?? scene.canvas.width / 2, y: object.target?.y ?? scene.canvas.height / 2, z: value } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Up X"
              value={object.up?.x ?? 0}
              step={0.1}
              onChange={(value) => patch({ up: { x: value, y: object.up?.y ?? -1, z: object.up?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Up Y"
              value={object.up?.y ?? -1}
              step={0.1}
              onChange={(value) => patch({ up: { x: object.up?.x ?? 0, y: value, z: object.up?.z ?? 0 } } as Partial<SceneObject>)}
            />
            <NumberField
              label="Up Z"
              value={object.up?.z ?? 0}
              step={0.1}
              onChange={(value) => patch({ up: { x: object.up?.x ?? 0, y: object.up?.y ?? -1, z: value } } as Partial<SceneObject>)}
            />
          </div>
        </section>
      ) : null}

      {object.type === "layer" ? (
        <section className="field-section inspector-control-section">
          <h3>Layer contents</h3>
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
  const effects = metadata.effects ?? [];
  const layout = metadata.responsiveLayout ?? {};
  const patchMetadata = (patch: Partial<NonNullable<SceneObject["importedDesign"]>>) =>
    updateObject(object.id, { importedDesign: { ...metadata, ...patch } });
  const patchEffect = (index: number, patch: Record<string, unknown>) =>
    patchMetadata({ effects: effects.map((effect, effectIndex) => effectIndex === index ? { ...effect, ...patch } : effect) });

  return (
    <section className="field-section imported-design-section">
      <div className="inspector-section-heading">
        <h3>Imported Design</h3>
        <span>{metadata.sourceFormat.toUpperCase()}</span>
      </div>
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
          <NumberField label="Layout gap" value={layout.gap} onChange={(gap) => patchMetadata({ responsiveLayout: { ...layout, gap } })} />
        ) : null}
      </div>
      {effects.length ? (
        <div className="imported-effect-list">
          {effects.map((effect, index) => (
            <article key={`${String(effect.type)}-${index}`}>
              <div>
                <strong>{String(effect.type ?? "Effect").replaceAll("-", " ")}</strong>
                <label><input checked={effect.enabled !== false} onChange={(event) => patchEffect(index, { enabled: event.target.checked })} type="checkbox" /> Enabled</label>
              </div>
              <div className="two-column">
                {typeof effect.opacity === "number" ? <NumberField label="Opacity" min={0} max={1} step={0.05} value={effect.opacity} onChange={(opacity) => patchEffect(index, { opacity })} /> : null}
                {typeof effect.radius === "number" ? <NumberField label="Radius" min={0} value={effect.radius} onChange={(radius) => patchEffect(index, { radius })} /> : null}
                {typeof effect.spread === "number" ? <NumberField label="Spread" min={0} value={effect.spread} onChange={(spread) => patchEffect(index, { spread })} /> : null}
                {typeof effect.color === "string" ? <ColorField label="Colour" value={effect.color} onChange={(color) => patchEffect(index, { color })} /> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
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

  return (
    <section className="field-section masks-section">
      <div className="masks-header">
        <h3>Masks</h3>
        <div className="masks-actions">
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

function AnimatedNumberField(props: {
  label: string;
  object: SceneObject;
  property: AnimatableProperty;
  value: number;
  min?: number;
  max?: number;
  step?: number;
}) {
  const currentFrame = useUiStore((state) => state.currentFrame);
  const setAnimationEnabled = useEditorStore((state) => state.setPropertyAnimationEnabled);
  const setAnimatedValue = useEditorStore((state) => state.setAnimatedPropertyValue);
  const addKeyframe = useEditorStore((state) => state.addPropertyKeyframe);
  const deleteKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  const channel = props.object.animation?.[props.property];
  const currentKey = channel?.keys.find((key) => key.frame === currentFrame);
  const value = channel ? sampleChannel(channel, currentFrame) : props.value;

  return (
    <label className={`field animated-number-field ${channel ? "animated" : ""}`}>
      <span>{props.label}</span>
      <span className={`field-animation-controls ${channel ? "animated" : ""}`}>
        <button
          aria-label={`${channel ? "Disable" : "Enable"} ${props.label} animation`}
          className={`field-stopwatch ${channel ? "active" : ""}`}
          onClick={() => setAnimationEnabled(props.object.id, props.property, !channel, currentFrame)}
          title={channel ? "Disable property animation" : "Enable animation and add a key at the playhead"}
          type="button"
        >
          <Clock3 size={12} />
        </button>
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
        <input
          max={props.max}
          min={props.min}
          onChange={(event) => setAnimatedValue(
            props.object.id,
            props.property,
            Number(event.target.value),
            currentFrame
          )}
          step={props.step ?? 1}
          type="number"
          value={value}
        />
      </span>
    </label>
  );
}

