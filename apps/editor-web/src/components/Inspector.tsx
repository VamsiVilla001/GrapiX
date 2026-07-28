import { getMaterialBindingId, isMaterialCompatible, isMaterialCompatibleWithFace, normalizeSlabProperties, type BindingMap, type MaskMode, type SceneObject, type SceneProperty, type SlabPropertiesInput } from "@grapix/shared-types";
import { ArrowDown, ArrowUp, Clock3, Copy, Eye, EyeOff, Lock, PenTool, Plus, Trash2, Unlock } from "lucide-react";
import { ColorValueEditor } from "./ColorValueEditor";
import { TextFontControls } from "./TextFontControls";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

const bindableProperties: SceneProperty[] = [
  "text",
  "src",
  "fill",
  "stroke",
  "visible",
  "x",
  "y",
  "zDepth",
  "width",
  "height",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];

export function Inspector() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObject = useEditorStore((state) => state.updateObject);
  const setActiveCameraId = useEditorStore((state) => state.setActiveCameraId);
  const setContainerChild = useEditorStore((state) => state.setContainerChild);
  const updateObjectBindings = useEditorStore((state) => state.updateObjectBindings);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const object = scene.objects.find((item) => item.id === selectedObjectId);

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

  function setBinding(property: SceneProperty, path: string) {
    const bindings: BindingMap = {
      ...object!.bindings,
      [property]: path
    };

    if (!path.trim()) {
      delete bindings[property];
    }

    updateObjectBindings(object!.id, bindings);
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
        <TextField label="Name" value={object.name} onChange={(value) => patch({ name: value })} />
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
        {object.type === "text" ? (
          <TextField label="Text" value={object.text} onChange={(value) => patch({ text: value } as Partial<SceneObject>)} />
        ) : null}
        {object.type === "image" ? (
          <TextField label="Image URL" value={object.src} onChange={(value) => patch({ src: value } as Partial<SceneObject>)} />
        ) : null}
      </section>

      <section className="field-section two-column">
        <NumberField label="X" value={object.x} onChange={(value) => patch({ x: value })} />
        <NumberField label="Y" value={object.y} onChange={(value) => patch({ y: value })} />
        <NumberField label="Position Z" value={object.zDepth} onChange={(value) => patch({ zDepth: value })} />
        <TextField label="Layer" value={object.layerId} onChange={(value) => patch({ layerId: value || "main" })} />
        <NumberField label="W" value={object.width} onChange={(value) => patch({ width: value })} />
        <NumberField label="H" value={object.height} onChange={(value) => patch({ height: value })} />
        {object.type === "mesh" ? (
          <>
            <NumberField label={object.meshKind === "slab" ? "Extrusion" : "Depth"} value={object.depth} min={0.01} onChange={(value) => patch({ depth: value } as Partial<SceneObject>)} />
            <NumberField label="Rotation X" value={object.rotationX ?? 0} onChange={(value) => patch({ rotationX: value } as Partial<SceneObject>)} />
            <NumberField label="Rotation Y" value={object.rotationY ?? 0} onChange={(value) => patch({ rotationY: value } as Partial<SceneObject>)} />
            <NumberField label="Rotation Z" value={object.rotationZ ?? object.rotation} onChange={(value) => patch({ rotationZ: value } as Partial<SceneObject>)} />
            <NumberField label="Scale X" value={object.scaleX ?? 1} step={0.05} onChange={(value) => patch({ scaleX: value })} />
            <NumberField label="Scale Y" value={object.scaleY ?? 1} step={0.05} onChange={(value) => patch({ scaleY: value })} />
            <NumberField label="Scale Z" value={object.scaleZ ?? 1} step={0.05} onChange={(value) => patch({ scaleZ: value } as Partial<SceneObject>)} />
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
        ) : (
          <>
            <NumberField label="Rotate" value={object.rotation} onChange={(value) => patch({ rotation: value })} />
            <NumberField label="Scale X" value={object.scaleX ?? 1} step={0.05} onChange={(value) => patch({ scaleX: value })} />
            <NumberField label="Scale Y" value={object.scaleY ?? 1} step={0.05} onChange={(value) => patch({ scaleY: value })} />
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
        )}
        <NumberField
          label="Opacity"
          value={object.opacity}
          step={0.05}
          min={0}
          max={1}
          onChange={(value) => patch({ opacity: value })}
        />
      </section>

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

      <section className="field-section">
        <ColorValueEditor
          fallback={object.fill}
          label="Fill"
          value={object.fillStyle ?? object.fill}
          onChange={(fillStyle) => patch({
            fillStyle,
            ...(fillStyle.type === "solid" ? { fill: fillStyle.color } : {})
          })}
        />
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

      {object.type === "shape" ? (
        <section className="field-section two-column">
          <ToggleField label="Fill on" value={object.fillEnabled} onChange={(value) => patch({ fillEnabled: value } as Partial<SceneObject>)} />
          <ToggleField label="Stroke on" value={object.strokeEnabled} onChange={(value) => patch({ strokeEnabled: value } as Partial<SceneObject>)} />
          <ToggleField
            label="Closed"
            value={object.path.closed}
            onChange={(value) => patch({ path: { ...object.path, closed: value } } as Partial<SceneObject>)}
          />
        </section>
      ) : null}

      {object.type === "text" ? (
        <section className="field-section two-column">
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

      <MasksSection object={object} />

      <section className="field-section binding-section">
        <h3>Bindings</h3>
        {bindableProperties
          .filter((property) => isPropertySupported(object, property))
          .map((property) => (
            <label className="binding-row" key={property}>
              <span>{property}</span>
              <input
                value={object.bindings[property] ?? ""}
                onChange={(event) => setBinding(property, event.target.value)}
                placeholder="data.path"
              />
            </label>
          ))}
      </section>
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

function isPropertySupported(object: SceneObject, property: SceneProperty): boolean {
  if (property === "text") {
    return object.type === "text";
  }

  if (property === "src") {
    return object.type === "image";
  }

  if (["rotationX", "rotationY", "rotationZ", "scaleZ"].includes(property)) {
    return ["mesh", "layer", "group"].includes(object.type);
  }

  if (property === "rotation" && object.type === "mesh") {
    return false;
  }

  return true;
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ToggleField(props: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="field toggle-field">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.value} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}

function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const safeColor = props.value.startsWith("#") ? props.value : "#ffffff";

  return (
    <label className="field color-field">
      <span>{props.label}</span>
      <input
        type="color"
        value={safeColor}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: T[];
  renderOption?: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
        {props.options.map((option) => (
          <option value={option} key={option}>
            {props.renderOption ? props.renderOption(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}
