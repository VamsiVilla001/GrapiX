import {
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatibleWithFace,
  normalizePrimitiveMaterialBinding,
  resolvePrimitiveMaterial,
  type MaterialFace,
  type ResolvedMaterial,
  type SceneDocument
} from "@grapix/shared-types";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { useEditorStore } from "../store/editorStore";
import { useDockStore } from "../store/dockStore";
import { useMaterialManagerStore } from "../modules/material-manager";
import { resolveProjectAssetUrl } from "../lib/projectAssets";

/**
 * Object Inspector "Materials" tab. Shows the object's bindable faces/elements
 * (from getBindableFaces — the object decides its own faces, nothing is
 * hard-coded here) and the material bound to each. Selecting faces here drives
 * which faces a Material Manager double-click binds to. Right-click a bound face
 * to Unbind (which clears the object-material relationship only — it never
 * deletes the shared project material).
 */
export function MaterialsTab() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectedFaceIndices = useEditorStore((state) => state.selectedFaceIndices);
  const selectFace = useEditorStore((state) => state.selectFace);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const assignAssetToFaces = useEditorStore((state) => state.assignAssetToFaces);
  const unbindMaterialFromFaces = useEditorStore((state) => state.unbindMaterialFromFaces);
  const materialActionError = useEditorStore((state) => state.materialActionError);
  const activatePanel = useDockStore((state) => state.activatePanel);
  const selectMaterialManagerItem = useMaterialManagerStore((state) => state.select);

  const object = scene.objects.find((item) => item.id === selectedObjectId);
  const [menu, setMenu] = useState<{ x: number; y: number; faceIndex: number } | null>(null);

  useEffect(() => setMenu(null), [selectedObjectId]);

  if (!object) {
    return (
      <div className="property-tab-panel">
        <div className="empty-panel">Select an object to bind materials</div>
      </div>
    );
  }

  const faces = getBindableFaces(object);
  const multiFace = faces.length > 1;
  const usableImageAssets = scene.assets.filter((asset) =>
    ["image", "svg"].includes(asset.kind) &&
    !["MISSING", "ERROR", "UNSUPPORTED"].includes(asset.status ?? "")
  );

  function chooseFace(event: MouseEvent, face: MaterialFace) {
    if (event.shiftKey) return selectFace(face.index, "range");
    if (event.ctrlKey || event.metaKey) return selectFace(face.index, "toggle");
    selectFace(face.index, "single");
  }

  return (
    <section aria-labelledby="inspector-materials-heading" className="property-tab-panel" onClick={() => menu && setMenu(null)}>
      <div className="property-tab-header">
        <h2 id="inspector-materials-heading">Materials</h2>
        <span>{object.name}</span>
      </div>

      <div className="materials-face-list" role="listbox" aria-label="Bindable material faces">
        {faces.map((face) => {
          const binding = normalizePrimitiveMaterialBinding(object.materialSlots[face.slotKey]);
          const material = scene.materials.find((item) => item.materialId === binding?.materialId);
          const instance = binding?.instanceId
            ? (scene.materialInstances ?? []).find((item) => item.materialInstanceId === binding.instanceId)
            : undefined;
          const resolved = resolvePrimitiveMaterial(scene, object, face.slotKey);
          const compatibleInstances = (scene.materialInstances ?? []).flatMap((candidate) => {
            const base = scene.materials.find((item) => item.materialId === candidate.baseMaterialId);
            return base && isMaterialCompatibleWithFace(base, object, face.index)
              ? [{ instance: candidate, base }]
              : [];
          });
          const selected = selectedFaceIndices.includes(face.index);
          const assignmentValue = binding?.instanceId
            ? `instance:${binding.instanceId}`
            : material
              ? `material:${material.materialId}`
              : "";
          const assignmentName = instance
            ? `${instance.name} · instance of ${material?.name ?? instance.baseMaterialId}`
            : binding?.instanceId
              ? `Missing instance · ${binding.instanceId}`
              : material?.name ?? "Unbound";
          return (
            <div
              key={face.slotKey}
              role="option"
              aria-selected={selected}
              className={`materials-face-row ${selected ? "selected" : ""} ${material ? "bound" : "unbound"}`}
              tabIndex={0}
              onClick={(event) => chooseFace(event, face)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selected) selectFace(face.index, "single");
                setMenu({ x: event.clientX, y: event.clientY, faceIndex: face.index });
              }}
            >
              <FaceThumb resolved={resolved} scene={scene} />
              <div className="materials-face-label">
                <strong>
                  {face.label}
                  <span className="materials-face-kind">{face.kind}</span>
                </strong>
                <span>{assignmentName}</span>
              </div>
              <select
                aria-label={`Assignment for ${face.label}`}
                className="materials-face-assignment"
                value={assignmentValue}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  const value = event.target.value;
                  if (!value) {
                    unbindMaterialFromFaces(object.id, [face.index]);
                  } else if (value.startsWith("asset:")) {
                    assignAssetToFaces(object.id, [face.index], value.slice("asset:".length));
                  } else if (value.startsWith("instance:")) {
                    const nextInstanceId = value.slice("instance:".length);
                    const nextInstance = (scene.materialInstances ?? []).find(
                      (candidate) => candidate.materialInstanceId === nextInstanceId
                    );
                    if (nextInstance) {
                      assignMaterialToFaces(object.id, [face.index], {
                        materialId: nextInstance.baseMaterialId,
                        instanceId: nextInstance.materialInstanceId
                      });
                    }
                  } else if (value.startsWith("material:")) {
                    assignMaterialToFaces(object.id, [face.index], value.slice("material:".length));
                  }
                }}
              >
                <option value="">Unbound</option>
                {binding?.instanceId && !instance ? (
                  <option value={`instance:${binding.instanceId}`}>Missing instance: {binding.instanceId}</option>
                ) : null}
                <optgroup label="Reusable materials">
                  {scene.materials
                    .filter((candidate) => isMaterialCompatibleWithFace(candidate, object, face.index))
                    .map((candidate) => (
                      <option value={`material:${candidate.materialId}`} key={candidate.materialId}>
                        {candidate.name}
                      </option>
                    ))}
                </optgroup>
                {compatibleInstances.length ? (
                  <optgroup label="Material instances">
                    {compatibleInstances.map(({ instance: candidate, base }) => (
                      <option value={`instance:${candidate.materialInstanceId}`} key={candidate.materialInstanceId}>
                        {candidate.name} — {base.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {usableImageAssets.length ? (
                  <optgroup label="Images and textures">
                    {usableImageAssets.map((asset) => (
                      <option value={`asset:${asset.assetId}`} key={asset.assetId}>
                        {asset.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <span className={`materials-face-state ${material ? "on" : "off"}`}>
                {instance ? (
                  <button
                    aria-label={`Inspect material instance ${instance.name}`}
                    className="materials-face-instance-route"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectMaterialManagerItem({ kind: "instance", id: instance.materialInstanceId });
                      activatePanel("material-manager");
                    }}
                    title="Open instance in Material Manager"
                    type="button"
                  >
                    <ExternalLink size={13} />
                  </button>
                ) : material ? <Link2 size={13} /> : null}
              </span>
            </div>
          );
        })}
      </div>

      {materialActionError ? <div className="materials-face-message">{materialActionError}</div> : null}

      <p className="materials-face-hint">
        {multiFace
          ? "Assign a material, imported image, or texture independently on each real mesh face. Select multiple faces (Shift = range, Ctrl/Cmd = toggle) to apply one Material Manager item to all of them."
          : "Assign a material, imported image, or texture to this continuous mesh surface."}
      </p>

      {menu ? (
        <div className="materials-face-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button
            disabled={!getMaterialBindingId(object.materialSlots[faces[menu.faceIndex]?.slotKey ?? ""])}
            onClick={() => {
              // Unbind every selected face if the right-clicked face is part of
              // the selection, otherwise just the right-clicked one.
              const targets = selectedFaceIndices.includes(menu.faceIndex) ? selectedFaceIndices : [menu.faceIndex];
              unbindMaterialFromFaces(object.id, targets);
              setMenu(null);
            }}
          >
            <Unlink size={13} /> Unbind
          </button>
        </div>
      ) : null}
    </section>
  );
}

function FaceThumb({ resolved, scene }: { resolved: ResolvedMaterial | null; scene: SceneDocument }) {
  if (!resolved) {
    return <div className="materials-face-thumb checkerboard empty" />;
  }
  const assetId = resolved.textureSlots[0]?.assetId ?? resolved.material.assetId;
  const asset = assetId ? scene.assets.find((item) => item.assetId === assetId) : undefined;
  if (asset && ["image", "svg"].includes(asset.kind) && asset.status !== "MISSING") {
    return (
      <div className="materials-face-thumb checkerboard">
        <img src={resolveProjectAssetUrl(asset.thumbnailSource ?? asset.source)} alt="" />
      </div>
    );
  }
  const color = resolved.parameters.baseColor ?? resolved.material.color;
  const swatch = typeof color === "string" ? color : "#46586d";
  return <div className="materials-face-thumb" style={{ background: swatch }} />;
}
