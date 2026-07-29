import {
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatibleWithFace,
  type Material,
  type MaterialFace,
  type SceneDocument
} from "@grapix/shared-types";
import { Link2, Unlink } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { useEditorStore } from "../store/editorStore";

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

  const object = scene.objects.find((item) => item.id === selectedObjectId);
  const [menu, setMenu] = useState<{ x: number; y: number; faceIndex: number } | null>(null);

  useEffect(() => setMenu(null), [selectedObjectId]);

  if (!object) {
    return (
      <section className="property-tab-panel">
        <div className="empty-panel">Select an object to bind materials</div>
      </section>
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
    <section className="property-tab-panel" onClick={() => menu && setMenu(null)}>
      <div className="property-tab-header">
        <h2>Materials</h2>
        <span>{object.name}</span>
      </div>

      <div className="materials-face-list" role="listbox" aria-label="Bindable material faces">
        {faces.map((face) => {
          const materialId = getMaterialBindingId(object.materialSlots[face.slotKey]);
          const material = scene.materials.find((item) => item.materialId === materialId);
          const selected = selectedFaceIndices.includes(face.index);
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
              <FaceThumb material={material} scene={scene} />
              <div className="materials-face-label">
                <strong>
                  {face.label}
                  <span className="materials-face-kind">{face.kind}</span>
                </strong>
                <span>{material ? material.name : "Unbound"}</span>
              </div>
              <select
                aria-label={`Assignment for ${face.label}`}
                className="materials-face-assignment"
                value={materialId ?? ""}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  const value = event.target.value;
                  if (!value) {
                    unbindMaterialFromFaces(object.id, [face.index]);
                  } else if (value.startsWith("asset:")) {
                    assignAssetToFaces(object.id, [face.index], value.slice("asset:".length));
                  } else {
                    assignMaterialToFaces(object.id, [face.index], value);
                  }
                }}
              >
                <option value="">Unbound</option>
                <optgroup label="Reusable materials">
                  {scene.materials
                    .filter((candidate) => isMaterialCompatibleWithFace(candidate, object, face.index))
                    .map((candidate) => (
                      <option value={candidate.materialId} key={candidate.materialId}>
                        {candidate.name}
                      </option>
                    ))}
                </optgroup>
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
                {material ? <Link2 size={13} /> : null}
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

function FaceThumb({ material, scene }: { material: Material | undefined; scene: SceneDocument }) {
  if (!material) {
    return <div className="materials-face-thumb checkerboard empty" />;
  }
  const assetId = material.textureSlots?.[0]?.assetId ?? material.assetId;
  const asset = assetId ? scene.assets.find((item) => item.assetId === assetId) : undefined;
  if (asset && ["image", "svg"].includes(asset.kind) && asset.status !== "MISSING") {
    return (
      <div className="materials-face-thumb checkerboard">
        <img src={asset.thumbnailSource ?? asset.source} alt="" />
      </div>
    );
  }
  const swatch = String(material.parameters?.baseColor ?? material.color ?? "#46586d");
  return <div className="materials-face-thumb" style={{ background: swatch }} />;
}
