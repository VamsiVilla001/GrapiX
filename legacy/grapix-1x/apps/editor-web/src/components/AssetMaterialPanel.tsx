import {
  getMaterialReadiness,
  type Material
} from "@grapix/shared-types";
import { ImagePlus, Layers3, PackageOpen } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";

export function AssetMaterialPanel() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scene = useEditorStore((state) => state.scene);
  const importAsset = useEditorStore((state) => state.importAsset);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const [selectedMaterialId, setSelectedMaterialId] = useState(scene.materials[0]?.materialId ?? "");
  const selectedMaterial = useMemo(
    () => scene.materials.find((material) => material.materialId === selectedMaterialId) ?? scene.materials[0],
    [scene.materials, selectedMaterialId]
  );

  function patchSelectedMaterial(patch: Partial<Material>) {
    if (selectedMaterial) {
      updateMaterial(selectedMaterial.materialId, patch);
    }
  }

  return (
    <section className="asset-material-panel">
      <div className="asset-column">
        <div className="panel-heading">
          <h2>
            <PackageOpen size={17} aria-hidden="true" />
            Asset Library
          </h2>
          <button className="compact-button" onClick={() => inputRef.current?.click()}>
            <ImagePlus size={15} aria-hidden="true" />
            Import
          </button>
        </div>
        <div className="asset-list">
          {scene.assets.map((asset) => (
            <div className="asset-row" key={asset.assetId}>
              {["image", "svg"].includes(asset.kind) ? (
                <img src={asset.source} alt="" />
              ) : asset.kind === "video" ? (
                <video src={asset.source} muted />
              ) : (
                <div className="asset-placeholder">{asset.kind.slice(0, 3).toUpperCase()}</div>
              )}
              <div>
                <strong>{asset.name}</strong>
                <span>{asset.kind}</span>
              </div>
            </div>
          ))}
        </div>
        <input
          ref={inputRef}
          className="hidden-input"
          type="file"
          multiple
          accept="image/*,video/*,.svg,.ttf,.otf,.woff,.woff2"
          onChange={async (event) => {
            const files = Array.from(event.target.files ?? []);
            for (const file of files) {
              await importAsset(file);
            }
            event.target.value = "";
          }}
        />
      </div>

      <div className="material-column">
        <div className="panel-heading">
          <h2>
            <Layers3 size={17} aria-hidden="true" />
            Material Manager
          </h2>
        </div>
        <div className="material-layout">
          <div className="material-list">
            {scene.materials.map((material) => (
              <button
                className={`material-row ${material.materialId === selectedMaterial?.materialId ? "selected" : ""}`}
                key={material.materialId}
                onClick={() => setSelectedMaterialId(material.materialId)}
              >
                <span>{material.name}</span>
                <MaterialStatus material={material} />
              </button>
            ))}
          </div>

          {selectedMaterial ? (
            <div className="material-properties">
              <label className="field">
                <span>Name</span>
                <input
                  value={selectedMaterial.name}
                  onChange={(event) => patchSelectedMaterial({ name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Asset</span>
                <select
                  value={selectedMaterial.assetId ?? ""}
                  onChange={(event) => patchSelectedMaterial({ assetId: event.target.value || undefined })}
                >
                  <option value="">None</option>
                  {scene.assets.map((asset) => (
                    <option value={asset.assetId} key={asset.assetId}>
                      {asset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={selectedMaterial.dynamic}
                  onChange={(event) =>
                    patchSelectedMaterial({
                      dynamic: event.target.checked,
                      binding: event.target.checked
                        ? selectedMaterial.binding ?? {
                            path: "",
                            type: selectedMaterial.type === "solid-color" ? "color" : "assetId",
                            fallbackAssetId: selectedMaterial.assetId
                          }
                        : undefined
                    })
                  }
                />
                <span>Dynamic</span>
              </label>
              {selectedMaterial.dynamic ? (
                <label className="field">
                  <span>Binding Path</span>
                  <input
                    value={selectedMaterial.binding?.path ?? ""}
                    onChange={(event) =>
                      patchSelectedMaterial({
                        binding: {
                          path: event.target.value,
                          type: selectedMaterial.binding?.type ?? "assetId",
                          fallbackAssetId: selectedMaterial.binding?.fallbackAssetId ?? selectedMaterial.assetId,
                          fallbackColor: selectedMaterial.binding?.fallbackColor
                        }
                      })
                    }
                  />
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function MaterialStatus(props: { material: Material }) {
  const scene = useEditorStore((state) => state.scene);
  const state = getMaterialReadiness(props.material, scene.assets, scene.dataContext);

  return <span className={`status-pill ${state.toLowerCase().replace("_", "-")}`}>{state}</span>;
}
