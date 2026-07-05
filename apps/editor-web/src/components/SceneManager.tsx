import type { SceneObject } from "@grapix/shared-types";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Trash2,
  Unlock
} from "lucide-react";
import { useMemo, useState } from "react";
import { sortObjectsForRender } from "../rendering/sceneMaterial";
import { useEditorStore } from "../store/editorStore";
import { CollapsiblePanel } from "./Collapsible";

interface LayerStack {
  layerId: string;
  objects: SceneObject[];
}

export function SceneManager() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const updateObject = useEditorStore((state) => state.updateObject);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const moveObjectInStack = useEditorStore((state) => state.moveObjectInStack);
  const duplicateSelectedObject = useEditorStore((state) => state.duplicateSelectedObject);
  const deleteSelectedObject = useEditorStore((state) => state.deleteSelectedObject);
  const duplicateObject = useEditorStore((state) => state.duplicateObject);
  const deleteObject = useEditorStore((state) => state.deleteObject);
  const [searchTerm, setSearchTerm] = useState("");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const layerStacks = useMemo(
    () => createLayerStacks(scene.objects, normalizedSearch),
    [normalizedSearch, scene.objects]
  );

  return (
    <CollapsiblePanel
      title="Scene Manager"
      className="dock-panel scene-manager"
      defaultOpen
      actions={
        <div className="mini-action-row">
          <button className="panel-icon-button" disabled={!selectedObjectId} onClick={duplicateSelectedObject} title="Duplicate selected"><Copy size={14} /></button>
          <button className="panel-icon-button danger" disabled={!selectedObjectId} onClick={deleteSelectedObject} title="Delete selected"><Trash2 size={14} /></button>
        </div>
      }
    >
      <input
        className="panel-search"
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
        placeholder="Search scene, layer, material"
        aria-label="Search scene objects"
      />
      <div className="scene-tree-root xpression-layer-stack">
        <div className="scene-root-label">Scene: {scene.name}</div>
        {layerStacks.map((layer) => (
          <section className="scene-layer-stack" key={layer.layerId}>
            <div className="scene-layer-label">
              Layer: {formatLayerName(layer.layerId)}
              <span>{layer.objects.length} obj</span>
            </div>
            {layer.objects.map((object) => (
              <div
                className={`scene-row layer-row ${object.id === selectedObjectId ? "selected" : ""}`}
                key={object.id}
                onClick={() => selectObject(object.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectObject(object.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className={`object-type-badge type-${object.type}`}>{labelForType(object)}</span>
                <div className="scene-row-main">
                  <span className="scene-row-name">{object.name}</span>
                  <div className="scene-row-meta">
                    <label onClick={(event) => event.stopPropagation()}>
                      Z
                      <input
                        type="number"
                        value={object.zDepth}
                        onChange={(event) => updateObject(object.id, { zDepth: Number(event.target.value) })}
                      />
                    </label>
                    <label onClick={(event) => event.stopPropagation()}>
                      Mat
                      <select
                        value={object.materialSlots.main ?? ""}
                        onChange={(event) => assignMaterialSlot(object.id, "main", event.target.value)}
                      >
                        <option value="">None</option>
                        {scene.materials.map((material) => (
                          <option value={material.materialId} key={material.materialId}>
                            {material.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <span className="scene-row-indicators">
                  <LayerButton title="Send to back" onClick={() => moveObjectInStack(object.id, "back")} icon={<ArrowDownToLine size={13} />} />
                  <LayerButton title="Move down" onClick={() => moveObjectInStack(object.id, "down")} icon={<ArrowDown size={13} />} />
                  <LayerButton title="Move up" onClick={() => moveObjectInStack(object.id, "up")} icon={<ArrowUp size={13} />} />
                  <LayerButton title="Bring to front" onClick={() => moveObjectInStack(object.id, "front")} icon={<ArrowUpToLine size={13} />} />
                  <LayerButton
                    title={object.visible ? "Hide object" : "Show object"}
                    onClick={() => updateObject(object.id, { visible: !object.visible })}
                    icon={object.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  />
                  <LayerButton
                    title={object.locked ? "Unlock object" : "Lock object"}
                    onClick={() => updateObject(object.id, { locked: !object.locked })}
                    icon={object.locked ? <Lock size={13} /> : <Unlock size={13} />}
                  />
                  <LayerButton title="Duplicate object" onClick={() => duplicateObject(object.id)} icon={<Copy size={13} />} />
                  <LayerButton danger title="Delete object" onClick={() => deleteObject(object.id)} icon={<Trash2 size={13} />} />
                  {Object.values(object.materialSlots).some(Boolean) ? <i title="Has material">M</i> : null}
                  {Object.keys(object.bindings).length ? <i title="Has binding">B</i> : null}
                </span>
              </div>
            ))}
          </section>
        ))}
        {layerStacks.length === 0 ? <div className="tree-note">No objects found</div> : null}
      </div>
    </CollapsiblePanel>
  );
}

function LayerButton(props: { icon: JSX.Element; title: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      className={`scene-row-control ${props.danger ? "danger" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      title={props.title}
    >
      {props.icon}
    </button>
  );
}

function createLayerStacks(objects: SceneObject[], search: string): LayerStack[] {
  const filteredObjects = objects.filter((object) => {
    if (!search) {
      return true;
    }

    return `${object.name} ${object.type} ${object.layerId} ${object.materialSlots.main ?? ""}`.toLowerCase().includes(search);
  });
  const grouped = new Map<string, SceneObject[]>();

  for (const object of filteredObjects) {
    const layerId = object.layerId || "main";
    grouped.set(layerId, [...(grouped.get(layerId) ?? []), object]);
  }

  return [...grouped.entries()].map(([layerId, layerObjects]) => ({
    layerId,
    objects: sortObjectsForRender(layerObjects).reverse()
  }));
}

function formatLayerName(layerId: string): string {
  if (layerId === "main") {
    return "Main";
  }

  return layerId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function labelForType(object: SceneObject): string {
  switch (object.type) {
    case "text":
      return "Ab";
    case "rect":
      return "rect";
    case "ellipse":
      return "ell";
    case "image":
      return "img";
    case "line":
      return "line";
    case "mesh":
      return object.meshKind;
    case "light":
      return object.lightKind;
    case "camera":
      return object.cameraKind === "perspective" ? "persp" : "ortho";
    case "layer":
      return object.layerKind;
    case "marker":
      return "evt";
    case "group":
      return "grp";
  }
}
