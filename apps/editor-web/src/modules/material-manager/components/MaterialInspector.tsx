import {
  findAssetUsageDetails,
  findMaterialUsage,
  IMPLEMENTED_BLEND_MODES,
  parameterDefaults,
  type Material,
  type MaterialBlendMode,
  type MaterialParameterDefinition,
  type MaterialParameterValue
} from "@grapix/shared-types";
import { AlertTriangle, Link2, RotateCcw } from "lucide-react";
import { useRef } from "react";
import { shaderSource } from "../services/shaderRegistry";
import { useEditorStore } from "../../../store/editorStore";
import { useMaterialManagerStore } from "../stores/materialManagerStore";

// Friendly labels for the blend modes implemented in both renderers. Adobe's
// naming, with the additive alias shown so users coming from other tools
// recognise it. Options are driven from IMPLEMENTED_BLEND_MODES so the menu
// can never advertise a mode the renderers do not support.
const BLEND_MODE_LABELS: Record<MaterialBlendMode, string> = {
  normal: "Normal",
  add: "Additive (Linear Dodge)",
  multiply: "Multiply",
  screen: "Screen",
  darken: "Darken",
  lighten: "Lighten",
  overlay: "Overlay",
  subtract: "Subtract",
  "alpha-mask": "Alpha Mask",
  "inverse-alpha-mask": "Inverse Alpha Mask"
};

export function MaterialInspector() {
  const scene = useEditorStore((state) => state.scene);
  const selection = useMaterialManagerStore((state) => state.selection);
  const error = useEditorStore((state) => state.materialActionError);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const updateAsset = useEditorStore((state) => state.updateAsset);
  const relinkAsset = useEditorStore((state) => state.relinkAsset);
  const updateInstance = useEditorStore((state) => state.updateMaterialInstance);
  const setInstanceParameter = useEditorStore((state) => state.setMaterialInstanceParameter);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const relinkRef = useRef<HTMLInputElement | null>(null);

  if (!selection) return <section className="material-inspector"><header><strong>Inspector</strong></header><div className="material-empty">Select an item to inspect it.</div></section>;
  const material = selection.kind === "material" ? scene.materials.find((item) => item.materialId === selection.id) : undefined;
  const instance = selection.kind === "instance" ? (scene.materialInstances ?? []).find((item) => item.materialInstanceId === selection.id) : undefined;
  const asset = selection.kind === "asset" ? scene.assets.find((item) => item.assetId === selection.id) : undefined;
  const shader = selection.kind === "shader" ? (scene.shaders ?? []).find((item) => item.shaderId === selection.id) : undefined;

  if (material) {
    const shaderDefinition = (scene.shaders ?? []).find((item) => item.shaderId === material.shaderId);
    const definitions = shaderDefinition?.parameters ?? fallbackDefinitions(material);
    const usage = findMaterialUsage(scene, material.materialId);
    const texture = material.textureSlots?.[0];
    const compatibleAssets = scene.assets.filter((item) => ["image", "svg"].includes(item.kind));
    const patchParameter = (name: string, value: MaterialParameterValue) => updateMaterial(material.materialId, {
      parameters: { ...material.parameters, [name]: value },
      ...(name === "baseColor" && typeof value === "string" ? { color: value } : {}),
      ...(name === "opacity" && typeof value === "number" ? { opacity: value } : {})
    });

    // Texture Coordinate values live on material.parameters (the renderer
    // reads them there). Vector2 params are edited a component at a time.
    const uvOffset = (Array.isArray(material.parameters?.uvOffset) ? material.parameters.uvOffset : [0, 0]) as number[];
    const uvScale = (Array.isArray(material.parameters?.uvScale) ? material.parameters.uvScale : [1, 1]) as number[];
    const uvRotation = typeof material.parameters?.uvRotation === "number" ? material.parameters.uvRotation : 0;
    const setUvComponent = (name: "uvOffset" | "uvScale", index: 0 | 1, base: number[], value: number) => {
      const next: [number, number] = [base[0] ?? 0, base[1] ?? 0];
      next[index] = value;
      patchParameter(name, next);
    };

    return (
      <section className="material-inspector">
        <header><strong>Material Inspector</strong><span>{material.type}</span></header>
        {error ? <div className="material-inline-error"><AlertTriangle size={14} />{error}</div> : null}
        <label>Name<input value={material.name} onFocus={() => beginHistory("Rename material")} onBlur={commitHistory} onChange={(event) => updateMaterial(material.materialId, { name: event.target.value })} /></label>
        <label>Shader<select value={material.shaderId} disabled><option>{shaderDefinition?.name ?? material.shaderId ?? "Unassigned"}</option></select></label>
        <label>Blend mode<select value={material.blendMode ?? "normal"} onChange={(event) => updateMaterial(material.materialId, { blendMode: event.target.value as Material["blendMode"] })}>
          {IMPLEMENTED_BLEND_MODES.map((mode) => (
            <option key={mode} value={mode}>{BLEND_MODE_LABELS[mode]}</option>
          ))}
        </select></label>
        <label>Alpha interpretation<select value={material.alphaMode ?? "premultiplied"} onChange={(event) => updateMaterial(material.materialId, { alphaMode: event.target.value as Material["alphaMode"] })}>
          <option value="straight">Straight</option><option value="premultiplied">Premultiplied</option><option value="opaque">Opaque</option><option value="alpha-test" disabled>Alpha test (planned)</option><option value="alpha-mask" disabled>Alpha mask (planned)</option>
        </select></label>
        <label className="checkbox-field"><input type="checkbox" checked={material.enabled !== false} onChange={(event) => updateMaterial(material.materialId, { enabled: event.target.checked })} />Enabled</label>
        {texture ? (
          <fieldset><legend>Texture</legend>
            <label>Source<select value={texture.assetId ?? ""} onChange={(event) => updateMaterial(material.materialId, { assetId: event.target.value || undefined, readiness: event.target.value ? "READY" : "MISSING", textureSlots: [{ ...texture, assetId: event.target.value || undefined }] })}>
              <option value="">Missing / none</option>{compatibleAssets.map((item) => <option key={item.assetId} value={item.assetId}>{item.name}{item.status === "MISSING" ? " (missing)" : ""}</option>)}
            </select></label>
            <label>Fit<select value={texture.fit} onChange={(event) => updateMaterial(material.materialId, { textureSlots: [{ ...texture, fit: event.target.value as typeof texture.fit }] })}>{["stretch", "fit", "fill", "crop", "tile", "original", "pixel-perfect", "nine-slice"].map((value) => <option key={value} value={value} disabled={value === "tile" || value === "nine-slice"}>{value}{value === "tile" || value === "nine-slice" ? " (planned)" : ""}</option>)}</select></label>
            <label>Address mode (wrap)<select value={texture.wrap} onChange={(event) => updateMaterial(material.materialId, { textureSlots: [{ ...texture, wrap: event.target.value as typeof texture.wrap }] })}><option value="clamp">Clamp</option><option value="repeat">Repeat</option><option value="mirror-repeat">Mirror repeat</option></select></label>
            <label>Filtering<select value={texture.filtering} onChange={(event) => updateMaterial(material.materialId, { textureSlots: [{ ...texture, filtering: event.target.value as typeof texture.filtering }] })}><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
          </fieldset>
        ) : null}
        {texture ? (
          <fieldset className="texture-coordinates"><legend>Texture coordinates</legend>
            <div className="uv-row">
              <label>Offset X<input type="number" step="0.01" value={uvOffset[0] ?? 0} onFocus={() => beginHistory("UV offset")} onBlur={commitHistory} onChange={(event) => setUvComponent("uvOffset", 0, uvOffset, Number(event.target.value))} /></label>
              <label>Offset Y<input type="number" step="0.01" value={uvOffset[1] ?? 0} onFocus={() => beginHistory("UV offset")} onBlur={commitHistory} onChange={(event) => setUvComponent("uvOffset", 1, uvOffset, Number(event.target.value))} /></label>
            </div>
            <div className="uv-row">
              <label>Scale X<input type="number" step="0.1" value={uvScale[0] ?? 1} onFocus={() => beginHistory("UV scale")} onBlur={commitHistory} onChange={(event) => setUvComponent("uvScale", 0, uvScale, Number(event.target.value))} /></label>
              <label>Scale Y<input type="number" step="0.1" value={uvScale[1] ?? 1} onFocus={() => beginHistory("UV scale")} onBlur={commitHistory} onChange={(event) => setUvComponent("uvScale", 1, uvScale, Number(event.target.value))} /></label>
            </div>
            <label>Rotation (deg)<input type="number" step="1" value={uvRotation} onFocus={() => beginHistory("UV rotation")} onBlur={commitHistory} onChange={(event) => patchParameter("uvRotation", Number(event.target.value))} /></label>
            <p className="uv-hint">Scale &gt; 1 tiles the texture; set Address mode to Repeat or Mirror to control how tiles wrap.</p>
          </fieldset>
        ) : null}
        <fieldset><legend>Exposed parameters</legend>{definitions.map((definition) => <ParameterControl definition={definition} key={definition.name} value={material.parameters?.[definition.name] ?? definition.default} onBegin={() => beginHistory(`Edit ${definition.label ?? definition.name}`)} onCommit={commitHistory} onChange={(value) => patchParameter(definition.name, value)} />)}</fieldset>
        <label>Tags<input value={(material.tags ?? []).join(", ")} onFocus={() => beginHistory("Edit material tags")} onBlur={commitHistory} onChange={(event) => updateMaterial(material.materialId, { tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="broadcast, team, sponsor" /></label>
        <div className="material-usage"><Link2 size={14} /><strong>Find Usage</strong><span>{usage.objectNames.length ? usage.objectNames.join(", ") : "No primitives"}</span><span>{usage.instanceIds.length} instance(s)</span><span>Shader: {usage.shaderIds.join(", ") || "none"}</span></div>
      </section>
    );
  }

  if (instance) {
    const base = scene.materials.find((item) => item.materialId === instance.baseMaterialId);
    const shaderDefinition = (scene.shaders ?? []).find((item) => item.shaderId === base?.shaderId);
    const definitions = shaderDefinition?.parameters ?? fallbackDefinitions(base);
    const defaults = { ...parameterDefaults(definitions), ...(base?.parameters ?? {}) };
    return (
      <section className="material-inspector">
        <header><strong>Material Instance</strong><span>one inheritance level</span></header>
        <label>Name<input value={instance.name} onFocus={() => beginHistory("Rename material instance")} onBlur={commitHistory} onChange={(event) => updateInstance(instance.materialInstanceId, { name: event.target.value })} /></label>
        <label>Base<input value={base?.name ?? "Missing base material"} disabled /></label>
        <fieldset><legend>Overrides</legend>{definitions.map((definition) => {
          const overridden = Object.hasOwn(instance.parameterOverrides, definition.name);
          const value = instance.parameterOverrides[definition.name] ?? defaults[definition.name] ?? definition.default;
          return <div className="instance-override" key={definition.name}><label className="override-toggle"><input type="checkbox" checked={overridden} onChange={(event) => setInstanceParameter(instance.materialInstanceId, definition.name, event.target.checked ? value : undefined)} />Override</label><ParameterControl definition={definition} disabled={!overridden} value={value} onBegin={() => beginHistory(`Edit instance ${definition.name}`)} onCommit={commitHistory} onChange={(next) => setInstanceParameter(instance.materialInstanceId, definition.name, next)} /></div>;
        })}</fieldset>
        <p className="inspector-note">Unselected properties continue to inherit live changes from {base?.name ?? "the base material"}.</p>
      </section>
    );
  }

  if (asset) {
    const usage = findAssetUsageDetails(scene, asset.assetId);
    return (
      <section className="material-inspector">
        <header><strong>Asset Inspector</strong><span>{asset.kind}</span></header>
        {(asset.status === "MISSING" || asset.status === "ERROR" || asset.status === "UNSUPPORTED") ? <div className="material-inline-error"><AlertTriangle size={14} />{asset.error ?? `Asset is ${asset.status?.toLowerCase()}.`}</div> : null}
        <label>Name<input value={asset.name} onFocus={() => beginHistory("Rename asset")} onBlur={commitHistory} onChange={(event) => updateAsset(asset.assetId, { name: event.target.value })} /></label>
        <Metadata label="Asset ID" value={asset.assetId} /><Metadata label="Source" value={asset.sourcePath ?? asset.source} /><Metadata label="Dimensions" value={asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Unknown"} /><Metadata label="File size" value={asset.sizeBytes ? `${asset.sizeBytes.toLocaleString()} bytes` : "Embedded"} /><Metadata label="Imported" value={asset.importedAt} /><Metadata label="Alpha detected" value={String(asset.hasAlpha ?? "unknown")} />
        <label>Alpha interpretation<select value={asset.alphaMode ?? "unknown"} onChange={(event) => updateAsset(asset.assetId, { alphaMode: event.target.value as typeof asset.alphaMode })}><option value="unknown">Auto / unknown</option><option value="straight">Straight</option><option value="premultiplied">Premultiplied</option><option value="opaque">Opaque</option></select></label>
        <label>Colour space<select value={asset.colorSpace ?? "srgb"} onChange={(event) => updateAsset(asset.assetId, { colorSpace: event.target.value as typeof asset.colorSpace })}><option value="srgb">sRGB</option><option value="linear">Linear</option><option value="display-p3">Display P3</option><option value="unknown">Unknown</option></select></label>
        <input hidden ref={relinkRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/tiff" onChange={async (event) => { const file = event.target.files?.[0]; if (file) await relinkAsset(asset.assetId, file); event.target.value = ""; }} />
        <button className="material-action-button" onClick={() => relinkRef.current?.click()}><RotateCcw size={14} />Relink Asset</button>
        <div className="material-usage"><Link2 size={14} /><strong>Find Usage</strong><span>{usage.materialIds.length ? `${usage.materialIds.length} material(s): ${usage.materialIds.join(", ")}` : "No materials"}</span><span>{usage.shaderIds.length ? `Shaders: ${usage.shaderIds.join(", ")}` : "No shaders"}</span></div>
      </section>
    );
  }

  if (shader) {
    const source = shaderSource(shader.shaderId);
    return (
      <section className="material-inspector shader-inspector">
        <header><strong>Shader Inspector</strong><span>{shader.validationStatus}</span></header>
        <Metadata label="Shader ID" value={shader.shaderId} /><Metadata label="WGSL" value={shader.sourcePath} /><Metadata label="Entry points" value={`${shader.vertexEntry} / ${shader.fragmentEntry}`} /><Metadata label="Primitives" value={shader.supportedPrimitives.join(", ")} />
        {shader.compilationErrors.length ? <div className="shader-errors">{shader.compilationErrors.map((error) => <div key={error}>{error}</div>)}</div> : <div className="shader-valid">Manifest and structural WGSL validation passed.</div>}
        <pre className="shader-source">{source ?? "Custom source is stored outside the scene document. Source retrieval/editor support is planned."}</pre>
      </section>
    );
  }

  return <section className="material-inspector"><div className="material-empty">The selected item no longer exists.</div></section>;
}

function ParameterControl(props: { definition: MaterialParameterDefinition; value: MaterialParameterValue; disabled?: boolean; onChange: (value: MaterialParameterValue) => void; onBegin: () => void; onCommit: () => void }) {
  const { definition, value } = props;
  if (definition.type === "colour") return <label>{definition.label ?? definition.name}<input disabled={props.disabled} type="color" value={typeof value === "string" ? value : "#ffffff"} onFocus={props.onBegin} onBlur={props.onCommit} onChange={(event) => props.onChange(event.target.value)} /></label>;
  if (definition.type === "float" || definition.type === "integer") return <label>{definition.label ?? definition.name}<span className="parameter-range"><input disabled={props.disabled} type="range" min={definition.min ?? 0} max={definition.max ?? 10} step={definition.type === "integer" ? 1 : definition.step ?? 0.01} value={typeof value === "number" ? value : Number(definition.default)} onFocus={props.onBegin} onBlur={props.onCommit} onPointerDown={props.onBegin} onPointerUp={props.onCommit} onPointerCancel={props.onCommit} onChange={(event) => props.onChange(Number(event.target.value))} /><output>{typeof value === "number" ? value.toFixed(definition.type === "integer" ? 0 : 2) : String(value)}</output></span></label>;
  if (definition.type === "boolean") return <label className="checkbox-field"><input disabled={props.disabled} type="checkbox" checked={Boolean(value)} onChange={(event) => props.onChange(event.target.checked)} />{definition.label ?? definition.name}</label>;
  if (["vector2", "vector3", "vector4"].includes(definition.type)) {
    const length = Number(definition.type.at(-1));
    const values = Array.isArray(value) ? value : Array(length).fill(0);
    return <label>{definition.label ?? definition.name}<span className="vector-field">{values.slice(0, length).map((number, index) => <input disabled={props.disabled} key={index} type="number" step={definition.step ?? 0.01} value={number} onFocus={props.onBegin} onBlur={props.onCommit} onChange={(event) => { const next = [...values]; next[index] = Number(event.target.value); props.onChange(next); }} />)}</span></label>;
  }
  if (definition.type === "enum") return <label>{definition.label ?? definition.name}<select disabled={props.disabled} value={String(value)} onChange={(event) => props.onChange(event.target.value)}>{definition.options?.map((option) => <option key={option}>{option}</option>)}</select></label>;
  return <label>{definition.label ?? definition.name}<input disabled value={String(value)} onChange={(event) => props.onChange(event.target.value)} /></label>;
}

function fallbackDefinitions(material?: Material): MaterialParameterDefinition[] {
  return material?.type === "solid-color"
    ? [{ name: "baseColor", label: "Base colour", type: "colour", default: "#ffffff", animatable: true, bindable: true }, { name: "opacity", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01, animatable: true, bindable: true }]
    // uvScale/uvOffset/uvRotation are edited in the dedicated Texture
    // Coordinates panel, not here, to avoid duplicate controls.
    : [{ name: "tint", label: "Tint", type: "colour", default: "#ffffff", animatable: true, bindable: true }, { name: "opacity", label: "Opacity", type: "float", default: 1, min: 0, max: 1, step: 0.01, animatable: true, bindable: true }];
}

function Metadata(props: { label: string; value: string }) {
  return <div className="material-metadata"><span>{props.label}</span><code title={props.value}>{props.value}</code></div>;
}
