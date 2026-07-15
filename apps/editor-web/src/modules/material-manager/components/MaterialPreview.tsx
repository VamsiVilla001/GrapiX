import type { PrimitiveMaterialBinding, RectSceneObject, SceneDocument } from "@grapix/shared-types";
import { useMemo, useState } from "react";
import { GpuSceneStage } from "../../../components/GpuSceneStage";
import { resolveRenderableObjects } from "../../../rendering/sceneMaterial";
import { useEditorStore } from "../../../store/editorStore";
import { useMaterialManagerStore } from "../stores/materialManagerStore";

type PreviewBackground = "checker" | "light" | "dark";

export function MaterialPreview() {
  const scene = useEditorStore((state) => state.scene);
  const selection = useMaterialManagerStore((state) => state.selection);
  const [background, setBackground] = useState<PreviewBackground>("checker");
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
        {!preview && asset && ["image", "svg"].includes(asset.kind) && asset.status !== "MISSING" ? <img src={asset.source} alt={asset.name} /> : null}
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
  const object: RectSceneObject = {
    id: "material_preview_quad",
    type: "rect",
    name: "Preview Quad",
    x: 32,
    y: 32,
    zDepth: 0,
    zIndex: 0,
    layerId: "preview",
    width: 256,
    height: 166,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: true,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 10,
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
