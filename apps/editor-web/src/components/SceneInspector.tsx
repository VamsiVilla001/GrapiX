import { getMaterialBindingId, isMaterialCompatible, type SceneObject } from "@grapix/shared-types";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Pencil,
  Trash2,
  Unlock
} from "lucide-react";
import { useMemo, useState } from "react";
import { sortObjectsForRender } from "../rendering/sceneMaterial";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { CollapsiblePanel } from "./Collapsible";

interface LayerStack {
  layerId: string;
  objects: SceneObject[];
}

/**
 * Scene Inspector: shows the contents of the scene/template that is
 * currently open in the editor (switching templates loads their scene into
 * the editor store, so this panel always reflects the active one) and
 * manages the layers those contents live on.
 */
export function SceneInspector() {
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
  const moveObjectToLayer = useEditorStore((state) => state.moveObjectToLayer);
  const createLayerForObject = useEditorStore((state) => state.createLayerForObject);
  const renameLayer = useEditorStore((state) => state.renameLayer);
  const deleteLayer = useEditorStore((state) => state.deleteLayer);
  const setLayerVisibility = useEditorStore((state) => state.setLayerVisibility);
  const setLayerLocked = useEditorStore((state) => state.setLayerLocked);
  const openedTemplate = useTemplateStore((state) =>
    state.templates.find((template) => template.templateId === state.openedTemplateId) ?? null
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [materialDropTarget, setMaterialDropTarget] = useState<{ objectId: string; compatible: boolean } | null>(null);
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const layerStacks = useMemo(
    () => createLayerStacks(scene.objects, normalizedSearch),
    [normalizedSearch, scene.objects]
  );
  const allLayerIds = useMemo(
    () => [...new Set(scene.objects.map((object) => object.layerId || "main"))].sort(),
    [scene.objects]
  );

  function commitLayerRename(layerId: string) {
    if (renameValue.trim()) {
      renameLayer(layerId, renameValue);
    }
    setRenamingLayerId(null);
    setRenameValue("");
  }

  return (
    <CollapsiblePanel
      title="Scene Inspector"
      className="dock-panel scene-manager"
      defaultOpen
      actions={
        <div className="mini-action-row">
          <button
            className="panel-icon-button"
            disabled={!selectedObjectId}
            onClick={() => selectedObjectId && createLayerForObject(selectedObjectId)}
            title="Move selected object to a new layer"
          >
            <Layers size={14} />
          </button>
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
        <div className="scene-root-label">
          {openedTemplate ? `Template ${openedTemplate.shortLabel}: ${scene.name}` : `Scene: ${scene.name}`}
        </div>
        {layerStacks.map((layer) => {
          const layerVisible = layer.objects.some((object) => object.visible);
          const layerLocked = layer.objects.every((object) => object.locked);

          return (
            <section className="scene-layer-stack" key={layer.layerId}>
              <div className="scene-layer-label">
                {renamingLayerId === layer.layerId ? (
                  <input
                    autoFocus
                    className="layer-rename-input"
                    value={renameValue}
                    aria-label={`Rename layer ${formatLayerName(layer.layerId)}`}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => commitLayerRename(layer.layerId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitLayerRename(layer.layerId);
                      if (event.key === "Escape") {
                        setRenamingLayerId(null);
                        setRenameValue("");
                      }
                    }}
                  />
                ) : (
                  <>Layer: {formatLayerName(layer.layerId)}</>
                )}
                <span className="scene-layer-controls">
                  <span>{layer.objects.length} obj</span>
                  <LayerButton
                    title={`Rename layer ${formatLayerName(layer.layerId)}`}
                    onClick={() => {
                      setRenamingLayerId(layer.layerId);
                      setRenameValue(layer.layerId);
                    }}
                    icon={<Pencil size={12} />}
                  />
                  <LayerButton
                    title={layerVisible ? "Hide all objects in layer" : "Show all objects in layer"}
                    onClick={() => setLayerVisibility(layer.layerId, !layerVisible)}
                    icon={layerVisible ? <Eye size={12} /> : <EyeOff size={12} />}
                  />
                  <LayerButton
                    title={layerLocked ? "Unlock all objects in layer" : "Lock all objects in layer"}
                    onClick={() => setLayerLocked(layer.layerId, !layerLocked)}
                    icon={layerLocked ? <Lock size={12} /> : <Unlock size={12} />}
                  />
                  {layer.layerId !== "main" ? (
                    <LayerButton
                      danger
                      title="Delete layer (objects move to Main)"
                      onClick={() => deleteLayer(layer.layerId)}
                      icon={<Trash2 size={12} />}
                    />
                  ) : null}
                </span>
              </div>
              {layer.objects.map((object) => (
                <div
                  className={`scene-row layer-row ${object.id === selectedObjectId ? "selected" : ""} ${materialDropTarget?.objectId === object.id ? materialDropTarget.compatible ? "material-drop-compatible" : "material-drop-blocked" : ""}`}
                  key={object.id}
                  onClick={() => selectObject(object.id)}
                  onDragLeave={() => setMaterialDropTarget((value) => value?.objectId === object.id ? null : value)}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("application/x-grapix-material")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const materialId = event.dataTransfer.getData("application/x-grapix-material");
                    const material = scene.materials.find((item) => item.materialId === materialId);
                    const compatible = Boolean(material && isMaterialCompatible(material, object.type));
                    event.dataTransfer.dropEffect = compatible ? "copy" : "none";
                    setMaterialDropTarget({ objectId: object.id, compatible });
                  }}
                  onDrop={(event) => {
                    const materialId = event.dataTransfer.getData("application/x-grapix-material");
                    const instanceId = event.dataTransfer.getData("application/x-grapix-material-instance");
                    event.preventDefault();
                    event.stopPropagation();
                    if (materialId && materialDropTarget?.objectId === object.id && materialDropTarget.compatible) assignMaterialSlot(object.id, "main", instanceId ? { materialId, instanceId } : materialId);
                    setMaterialDropTarget(null);
                  }}
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
                        Lyr
                        <select
                          aria-label={`Layer for ${object.name}`}
                          value={object.layerId || "main"}
                          onChange={(event) => {
                            if (event.target.value === "__new__") {
                              createLayerForObject(object.id);
                            } else {
                              moveObjectToLayer(object.id, event.target.value);
                            }
                          }}
                        >
                          {allLayerIds.map((layerId) => (
                            <option value={layerId} key={layerId}>
                              {formatLayerName(layerId)}
                            </option>
                          ))}
                          <option value="__new__">+ New layer</option>
                        </select>
                      </label>
                      <label onClick={(event) => event.stopPropagation()}>
                        Mat
                        <select
                          value={getMaterialBindingId(object.materialSlots.main) ?? ""}
                          onChange={(event) => assignMaterialSlot(object.id, "main", event.target.value)}
                        >
                          <option value="">None</option>
                          {scene.materials.filter((material) => isMaterialCompatible(material, object.type)).map((material) => (
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
          );
        })}
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

    return `${object.name} ${object.type} ${object.layerId} ${getMaterialBindingId(object.materialSlots.main) ?? ""}`.toLowerCase().includes(search);
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
