import type { MeshSceneObject, PrimitiveMaterialBinding, SceneDocument } from "@grapix/shared-types";
import { useMemo } from "react";
import { GpuSceneStage } from "../../../components/GpuSceneStage";
import { resolveRenderableObjects } from "../../../rendering/sceneMaterial";
import { useEditorStore } from "../../../store/editorStore";
import { useMaterialManagerStore } from "../stores/materialManagerStore";
import { resolveProjectAssetUrl } from "../../../lib/projectAssets";

export function MaterialPreview() {
  const scene = useEditorStore((state) => state.scene);
  const selection = useMaterialManagerStore((state) => state.selection);
  const background = useMaterialManagerStore((state) => state.previewBackground);
  const setBackground = useMaterialManagerStore((state) => state.setPreviewBackground);
  const preview = useMemo(() => createPreviewScene(scene, selection), [scene, selection]);
  const asset = selection?.kind === "asset" ? scene.assets.find((item) => item.assetId === selection.id) : undefined;

  return (
    <section className="material-preview-section">
      <header>
        <strong>Preview</strong>
        <span className="preview-background-controls">
          {(["checker", "light", "dark"] as const).map((value) => (
            <button className={background === value ? "active" : ""} key={value} onClick={() => setBackground(value)} title={`${value} background`}>{value[0].toUpperCase()}</button>
          ))}
        </span>
      </header>
      <div className={`material-preview material-preview-${background}`}>
        {preview ? <GpuSceneStage scene={preview} objects={resolveRenderableObjects(preview)} /> : null}
        {!preview && asset && ["image", "svg"].includes(asset.kind) && asset.status !== "MISSING" ? <img src={resolveProjectAssetUrl(asset.source)} alt={asset.name} /> : null}
        {!preview && !asset ? <span>Select a material to render its live preview.</span> : null}
        {asset?.status === "MISSING" ? <span className="preview-warning">Source is missing. Relink the asset to restore the preview.</span> : null}
      </div>
    </section>
  );
}

function createPreviewScene(
  scene: SceneDocument,
  selection: ReturnType<typeof useMaterialManagerStore.getState>["selection"]
): SceneDocument | null {
  if (!selection || !["material", "instance"].includes(selection.kind)) return null;
  let binding: string | PrimitiveMaterialBinding;
  if (selection.kind === "material") {
    if (!scene.materials.some((item) => item.materialId === selection.id)) return null;
    binding = selection.id;
  } else {
    const instance = (scene.materialInstances ?? []).find((item) => item.materialInstanceId === selection.id);
    if (!instance) return null;
    binding = { materialId: instance.baseMaterialId, instanceId: instance.materialInstanceId };
  }
  const object: MeshSceneObject = {
    id: "material_preview_surface",
    type: "mesh",
    meshKind: "sphere",
    name: "Material Preview Surface",
    x: 160,
    y: 115,
    zDepth: 0,
    zIndex: 0,
    layerId: "preview",
    width: 150,
    height: 150,
    depth: 150,
    rotation: 0,
    rotationX: -16,
    rotationY: 28,
    rotationZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 75, y: 75 },
    anchor3d: { x: 75, y: 75, z: 75 },
    opacity: 1,
    visible: true,
    locked: true,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: { main: binding }
  };
  return {
    ...scene,
    id: "material_preview",
    name: "Material Preview",
    canvas: { width: 320, height: 230, background: "rgba(0,0,0,0)" },
    objects: [object],
    timeline: { fps: 60, durationFrames: 1, keyframes: [] }
  };
}
