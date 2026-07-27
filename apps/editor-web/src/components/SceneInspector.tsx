import {
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatibleWithFace,
  sampleChannel,
  type AnimatableProperty,
  type SceneObject
} from "@grapix/shared-types";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Clock3,
  Diamond,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Pencil,
  Search,
  Trash2,
  Unlock
} from "lucide-react";
import { useMemo, useState } from "react";
import { sortObjectsForRender } from "../rendering/sceneMaterial";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";
import {
  PropertyInspectorContent,
  propertyInspectorTabs,
  type PropertyInspectorTab
} from "./PropertiesSidebar";

interface ObjectTreeNode {
  object: SceneObject;
  children: ObjectTreeNode[];
}

interface LayerStack {
  layerId: string;
  objects: SceneObject[];
  roots: ObjectTreeNode[];
}

type SceneInspectorView = "Objects" | PropertyInspectorTab;
type TransformColumnId = "alpha" | "x" | "y" | "z" | "rx" | "ry" | "rz" | "sx" | "sy" | "sz";

const transformColumns: Array<{ id: TransformColumnId; label: string }> = [
  { id: "alpha", label: "Alpha" },
  { id: "x", label: "X-Pos" },
  { id: "y", label: "Y-Pos" },
  { id: "z", label: "Z-Pos" },
  { id: "rx", label: "X-Rot" },
  { id: "ry", label: "Y-Rot" },
  { id: "rz", label: "Z-Rot" },
  { id: "sx", label: "X-Scale" },
  { id: "sy", label: "Y-Scale" },
  { id: "sz", label: "Z-Scale" }
];

/**
 * XPression-style scene table. Object hierarchy and transform properties share
 * one grid, while detailed Properties/Materials/Text/Data Binding live as tabs
 * inside this same inspector instead of occupying a separate dock.
 */
export function SceneInspector() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const updateObject = useEditorStore((state) => state.updateObject);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const moveObjectInStack = useEditorStore((state) => state.moveObjectInStack);
  const duplicateSelectedObject = useEditorStore((state) => state.duplicateSelectedObject);
  const deleteSelectedObject = useEditorStore((state) => state.deleteSelectedObject);
  const createLayerForObject = useEditorStore((state) => state.createLayerForObject);
  const renameLayer = useEditorStore((state) => state.renameLayer);
  const deleteLayer = useEditorStore((state) => state.deleteLayer);
  const setLayerVisibility = useEditorStore((state) => state.setLayerVisibility);
  const setLayerLocked = useEditorStore((state) => state.setLayerLocked);
  const setPropertyAnimationEnabled = useEditorStore((state) => state.setPropertyAnimationEnabled);
  const setAnimatedPropertyValue = useEditorStore((state) => state.setAnimatedPropertyValue);
  const addPropertyKeyframe = useEditorStore((state) => state.addPropertyKeyframe);
  const deletePropertyKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  const updateMask = useEditorStore((state) => state.updateMask);
  const duplicateMask = useEditorStore((state) => state.duplicateMask);
  const deleteMask = useEditorStore((state) => state.deleteMask);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const propertiesTab = useUiStore((state) => state.propertiesTab);
  const setPropertiesTab = useUiStore((state) => state.setPropertiesTab);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const openedTemplate = useTemplateStore((state) =>
    state.templates.find((template) => template.templateId === state.openedTemplateId) ?? null
  );
  const [view, setView] = useState<SceneInspectorView>("Objects");
  const [searchTerm, setSearchTerm] = useState("");
  const [materialDropTarget, setMaterialDropTarget] = useState<{ objectId: string; compatible: boolean } | null>(null);
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const layerStacks = useMemo(
    () => createLayerStacks(scene.objects, normalizedSearch),
    [normalizedSearch, scene.objects]
  );

  function selectView(nextView: SceneInspectorView) {
    setView(nextView);
    if (nextView !== "Objects") setPropertiesTab(nextView);
  }

  function commitLayerRename(layerId: string) {
    if (renameValue.trim()) renameLayer(layerId, renameValue);
    setRenamingLayerId(null);
    setRenameValue("");
  }

  function toggleCollapsed(id: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderObjectNode(node: ObjectTreeNode, depth: number): JSX.Element[] {
    const object = node.object;
    const collapsed = collapsedIds.has(object.id);
    const isSelected = object.id === selectedObjectId;
    const hasMaterial = Object.values(object.materialSlots).some(Boolean);
    const hasBinding = Object.keys(object.bindings).length > 0;
    const hasAnimation = Object.values(object.animation ?? {}).some((channel) => Boolean(channel?.keys.length));
    const rows: JSX.Element[] = [
      <div
        className={`scene-inspector-object-row ${isSelected ? "selected" : ""} ${
          materialDropTarget?.objectId === object.id
            ? materialDropTarget.compatible
              ? "material-drop-compatible"
              : "material-drop-blocked"
            : ""
        }`}
        key={object.id}
        onClick={() => selectObject(object.id)}
        onDragLeave={() => setMaterialDropTarget((value) => value?.objectId === object.id ? null : value)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("application/x-grapix-material")) return;
          event.preventDefault();
          event.stopPropagation();
          const materialId = event.dataTransfer.getData("application/x-grapix-material");
          const material = scene.materials.find((item) => item.materialId === materialId);
          const compatible = Boolean(
            material && getBindableFaces(object).some((face) =>
              isMaterialCompatibleWithFace(material, object, face.index)
            )
          );
          event.dataTransfer.dropEffect = compatible ? "copy" : "none";
          setMaterialDropTarget({ objectId: object.id, compatible });
        }}
        onDrop={(event) => {
          const materialId = event.dataTransfer.getData("application/x-grapix-material");
          const instanceId = event.dataTransfer.getData("application/x-grapix-material-instance");
          event.preventDefault();
          event.stopPropagation();
          if (materialId && materialDropTarget?.objectId === object.id && materialDropTarget.compatible) {
            assignMaterialToFaces(
              object.id,
              getBindableFaces(object).map((face) => face.index),
              instanceId ? { materialId, instanceId } : materialId
            );
          }
          setMaterialDropTarget(null);
        }}
        role="row"
      >
        <div className="scene-object-tree-cell" style={{ paddingLeft: `${8 + depth * 15}px` }}>
          {node.children.length > 0 ? (
            <button
              className="scene-tree-disclosure"
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(object.id);
              }}
              title={collapsed ? "Expand group" : "Collapse group"}
            >
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          ) : (
            <span className="scene-tree-disclosure-spacer" />
          )}
          <span className={`object-type-badge type-${object.type}`}>{labelForType(object)}</span>
          <span className="scene-object-name" title={object.name}>{object.name}</span>
        </div>
        <button
          className="scene-grid-icon-button"
          onClick={(event) => {
            event.stopPropagation();
            updateObject(object.id, { visible: !object.visible });
          }}
          title={object.visible ? "Hide object" : "Show object"}
        >
          {object.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <div className="scene-object-flags" title="M: material, K: animation key, P: data property binding">
          <i className={hasMaterial ? "active material" : ""}>M</i>
          <i className={hasAnimation ? "active key" : ""}>K</i>
          <i className={hasBinding ? "active binding" : ""}>P</i>
        </div>
        {transformColumns.map((column) => (
          <TransformCell
            column={column.id}
            currentFrame={currentFrame}
            key={column.id}
            object={object}
            onSetAnimationEnabled={(property, enabled) =>
              setPropertyAnimationEnabled(object.id, property, enabled, currentFrame)
            }
            onSetValue={(property, value) =>
              setAnimatedPropertyValue(object.id, property, value, currentFrame)
            }
            onToggleKeyAtFrame={(property) => {
              const existing = object.animation?.[property]?.keys.find((key) => key.frame === currentFrame);
              if (existing) deletePropertyKeyframe(object.id, property, existing.id);
              else addPropertyKeyframe(object.id, property, currentFrame);
            }}
          />
        ))}
      </div>
    ];

    if (!collapsed) {
      for (const mask of object.masks ?? []) {
        rows.push(
          <div
            className={`scene-inspector-mask-row ${selectedMaskId === mask.id ? "selected" : ""}`}
            key={`${object.id}:${mask.id}`}
            onClick={() => {
              selectObject(object.id);
              setSelectedMaskId(mask.id);
            }}
            role="row"
          >
            <div className="scene-object-tree-cell" style={{ paddingLeft: `${23 + (depth + 1) * 15}px` }}>
              <span className="scene-tree-disclosure-spacer" />
              <span className="object-type-badge type-mask">Mask</span>
              <input
                aria-label="Mask name"
                className="scene-mask-name-input"
                onChange={(event) => updateMask(object.id, mask.id, { name: event.target.value })}
                value={mask.name}
              />
            </div>
            <button
              className="scene-grid-icon-button"
              onClick={(event) => {
                event.stopPropagation();
                updateMask(object.id, mask.id, { visible: mask.visible === false });
              }}
              title={mask.visible === false ? "Show mask" : "Hide mask"}
            >
              {mask.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <div className="scene-mask-actions">
              <select
                aria-label="Mask mode"
                onChange={(event) => updateMask(object.id, mask.id, { mode: event.target.value as typeof mask.mode })}
                value={mask.mode}
              >
                {["add", "subtract", "intersect", "lighten", "darken", "difference", "none"].map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
              <button onClick={(event) => {
                event.stopPropagation();
                setSelectedMaskId(duplicateMask(object.id, mask.id));
              }} title="Duplicate mask"><Copy size={11} /></button>
              <button onClick={(event) => {
                event.stopPropagation();
                deleteMask(object.id, mask.id);
                if (selectedMaskId === mask.id) setSelectedMaskId(null);
              }} title="Delete mask"><Trash2 size={11} /></button>
            </div>
            {transformColumns.map((column) => (
              <div className="scene-mask-property" key={column.id}>
                {column.id === "alpha"
                  ? `${Math.round(mask.opacity * 100)}`
                  : column.id === "x"
                    ? `F ${Math.round(mask.feather.x)}`
                    : column.id === "y"
                      ? `F ${Math.round(mask.feather.y)}`
                      : column.id === "z"
                        ? `E ${Math.round(mask.expansion)}`
                        : "—"}
              </div>
            ))}
          </div>
        );
      }
    }

    if (!collapsed) {
      for (const child of node.children) rows.push(...renderObjectNode(child, depth + 1));
    }
    return rows;
  }

  return (
    <section className="scene-inspector-panel">
      <div className="scene-inspector-tabs" role="tablist" aria-label="Scene inspector views">
        {(["Objects", ...propertyInspectorTabs] as SceneInspectorView[]).map((tab) => (
          <button
            aria-selected={view === tab || (view !== "Objects" && propertiesTab === tab)}
            className={view === tab ? "active" : ""}
            key={tab}
            onClick={() => selectView(tab)}
            role="tab"
          >
            {tab}
          </button>
        ))}
      </div>

      {view !== "Objects" ? (
        <div className="scene-inspector-property-body">
          <PropertyInspectorContent tab={view} />
        </div>
      ) : !hasActiveScene ? (
        <div className="empty-panel scene-empty-state">
          <strong>No scene open</strong>
          <span>Create or open a scene template to inspect its objects and properties.</span>
        </div>
      ) : (
        <div className="scene-inspector-object-view">
          <div className="scene-inspector-toolbar">
            <div className="scene-order-controls" aria-label="Selected object stacking controls">
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<ArrowUpToLine size={14} />}
                onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "front")}
                title="Bring selected object to front"
              />
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<ArrowUp size={14} />}
                onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "up")}
                title="Move selected object up"
              />
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<ArrowDown size={14} />}
                onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "down")}
                title="Move selected object down"
              />
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<ArrowDownToLine size={14} />}
                onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "back")}
                title="Send selected object to back"
              />
              <span className="scene-toolbar-separator" />
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<Layers size={14} />}
                onClick={() => selectedObjectId && createLayerForObject(selectedObjectId)}
                title="Move selected object to a new layer"
              />
              <ToolbarButton
                disabled={!selectedObjectId}
                icon={<Copy size={14} />}
                onClick={duplicateSelectedObject}
                title="Duplicate selected object"
              />
              <ToolbarButton
                danger
                disabled={!selectedObjectId}
                icon={<Trash2 size={14} />}
                onClick={deleteSelectedObject}
                title="Delete selected object"
              />
            </div>
            <label className="scene-inspector-search">
              <Search size={13} />
              <input
                aria-label="Search scene objects"
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Find object"
                value={searchTerm}
              />
            </label>
          </div>

          <div className="scene-grid-scroll">
            <div className="scene-property-grid" role="table" aria-label="Scene objects and transform properties">
              <div className="scene-grid-header" role="row">
                <div>Object</div>
                <div title="Visibility"><Eye size={14} /></div>
                <div className="scene-grid-flag-heading" title="Material / Keyframe / Property binding">M K P</div>
                {transformColumns.map((column) => <div key={column.id}>{column.label}</div>)}
              </div>
              <div className="scene-grid-scene-row" role="row">
                <div>
                  {openedTemplate
                    ? `Template ${openedTemplate.shortLabel}: ${scene.name}`
                    : `Scene: ${scene.name}`}
                </div>
              </div>
              {scene.objects.length === 0 ? (
                <div className="scene-grid-empty">This scene contains no objects.</div>
              ) : null}
              {layerStacks.map((layer) => {
                const layerVisible = layer.objects.some((object) => object.visible);
                const layerLocked = layer.objects.every((object) => object.locked);

                return (
                  <div className="scene-grid-layer" key={layer.layerId}>
                    <div className="scene-inspector-layer-row" role="row">
                      <div className="scene-layer-tree-cell">
                        <ChevronDown size={13} />
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
                          <strong>{formatLayerName(layer.layerId)}</strong>
                        )}
                        <span>{layer.objects.length}</span>
                        <ToolbarButton
                          icon={<Pencil size={11} />}
                          onClick={() => {
                            setRenamingLayerId(layer.layerId);
                            setRenameValue(layer.layerId);
                          }}
                          title={`Rename ${formatLayerName(layer.layerId)}`}
                        />
                        {layer.layerId !== "main" ? (
                          <ToolbarButton
                            danger
                            icon={<Trash2 size={11} />}
                            onClick={() => deleteLayer(layer.layerId)}
                            title="Delete layer and move its objects to Main"
                          />
                        ) : null}
                      </div>
                      <ToolbarButton
                        icon={layerVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                        onClick={() => setLayerVisibility(layer.layerId, !layerVisible)}
                        title={layerVisible ? "Hide layer" : "Show layer"}
                      />
                      <ToolbarButton
                        icon={layerLocked ? <Lock size={13} /> : <Unlock size={13} />}
                        onClick={() => setLayerLocked(layer.layerId, !layerLocked)}
                        title={layerLocked ? "Unlock layer" : "Lock layer"}
                      />
                    </div>
                    {layer.roots.flatMap((node) => renderObjectNode(node, 0))}
                  </div>
                );
              })}
              {layerStacks.length === 0 && scene.objects.length > 0 ? (
                <div className="scene-grid-empty">No objects match the current search.</div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TransformCell(props: {
  column: TransformColumnId;
  currentFrame: number;
  object: SceneObject;
  onSetAnimationEnabled: (property: AnimatableProperty, enabled: boolean) => void;
  onSetValue: (property: AnimatableProperty, value: number) => void;
  onToggleKeyAtFrame: (property: AnimatableProperty) => void;
}) {
  const property = propertyForColumn(props.object, props.column);
  const supported = isTransformColumnSupported(props.object, props.column);
  const channel = supported ? props.object.animation?.[property] : undefined;
  const animatedValue = channel ? sampleChannel(channel, props.currentFrame) : undefined;
  const rawValue = animatedValue ?? readTransformValue(props.object, props.column);
  const displayValue = props.column === "alpha" ? rawValue * 100 : rawValue;
  const hasKeyAtFrame = Boolean(channel?.keys.some((key) => key.frame === props.currentFrame));

  if (!supported) {
    return <div className="scene-transform-cell unsupported">—</div>;
  }

  return (
    <div className={`scene-transform-cell ${channel ? "animated" : ""} ${hasKeyAtFrame ? "has-key" : ""}`}>
      <button
        aria-label={`${channel ? "Disable" : "Enable"} ${props.column} animation for ${props.object.name}`}
        className={`property-stopwatch ${channel ? "active" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onSetAnimationEnabled(property, !channel);
        }}
        title={channel
          ? "Stopwatch active. Click to stop animating this property (removes its keys)."
          : "Enable animation and add a key at the playhead."}
      >
        <Clock3 size={10} />
      </button>
      {channel ? (
        <button
          aria-label={`${hasKeyAtFrame ? "Remove" : "Add"} ${props.column} keyframe at frame ${props.currentFrame} for ${props.object.name}`}
          className={`property-key-toggle ${hasKeyAtFrame ? "on" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleKeyAtFrame(property);
          }}
          title={hasKeyAtFrame
            ? `Remove keyframe at frame ${props.currentFrame}`
            : `Add keyframe at frame ${props.currentFrame}`}
        >
          <Diamond size={9} />
        </button>
      ) : null}
      <input
        aria-label={`${props.column} for ${props.object.name}`}
        onChange={(event) => {
          const nextValue = Number(event.target.value);
          if (!Number.isFinite(nextValue)) return;
          props.onSetValue(property, props.column === "alpha" ? nextValue / 100 : nextValue);
        }}
        onClick={(event) => event.stopPropagation()}
        step={props.column.startsWith("s") ? 0.01 : props.column === "alpha" ? 1 : 0.1}
        type="number"
        value={roundDisplayValue(displayValue)}
      />
    </div>
  );
}

function ToolbarButton(props: {
  icon: JSX.Element;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`scene-toolbar-button ${props.danger ? "danger" : ""}`}
      disabled={props.disabled}
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

function propertyForColumn(object: SceneObject, column: TransformColumnId): AnimatableProperty {
  switch (column) {
    case "alpha": return "opacity";
    case "x": return "x";
    case "y": return "y";
    case "z": return "zDepth";
    case "rx": return "rotationX";
    case "ry": return "rotationY";
    case "rz": return object.type === "mesh" ? "rotationZ" : "rotation";
    case "sx": return "scaleX";
    case "sy": return "scaleY";
    case "sz": return "scaleZ";
  }
}

function isTransformColumnSupported(object: SceneObject, column: TransformColumnId): boolean {
  return !["rx", "ry", "sz"].includes(column)
    || ["mesh", "layer", "group"].includes(object.type);
}

function readTransformValue(object: SceneObject, column: TransformColumnId): number {
  switch (column) {
    case "alpha": return object.opacity;
    case "x": return object.x;
    case "y": return object.y;
    case "z": return object.zDepth;
    case "rx": return object.rotationX ?? 0;
    case "ry": return object.rotationY ?? 0;
    case "rz": return object.type === "mesh" ? object.rotationZ ?? object.rotation : object.rotation;
    case "sx": return object.scaleX ?? 1;
    case "sy": return object.scaleY ?? 1;
    case "sz": return object.scaleZ ?? 1;
  }
}

function roundDisplayValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createLayerStacks(objects: SceneObject[], search: string): LayerStack[] {
  const filteredObjects = objects.filter((object) => {
    if (!search) return true;
    return `${object.name} ${object.type} ${object.layerId} ${
      getMaterialBindingId(object.materialSlots.main) ?? ""
    }`.toLowerCase().includes(search);
  });
  const grouped = new Map<string, SceneObject[]>();

  for (const object of filteredObjects) {
    const layerId = object.layerId || "main";
    grouped.set(layerId, [...(grouped.get(layerId) ?? []), object]);
  }

  return [...grouped.entries()].map(([layerId, layerObjects]) => ({
    layerId,
    objects: sortObjectsForRender(layerObjects).reverse(),
    roots: createObjectTree(layerObjects)
  }));
}

function createObjectTree(objects: SceneObject[]): ObjectTreeNode[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const childIds = new Set<string>();

  for (const object of objects) {
    if (object.type !== "group" && object.type !== "layer") continue;
    for (const childId of object.childIds) {
      if (byId.has(childId) && childId !== object.id) childIds.add(childId);
    }
  }

  const buildNode = (object: SceneObject, ancestors: Set<string>): ObjectTreeNode => {
    if ((object.type !== "group" && object.type !== "layer") || ancestors.has(object.id)) return { object, children: [] };
    const nextAncestors = new Set(ancestors).add(object.id);
    const children = object.childIds
      .map((childId) => byId.get(childId))
      .filter((child): child is SceneObject => Boolean(child))
      .map((child) => buildNode(child, nextAncestors));
    return { object, children };
  };

  const roots = sortObjectsForRender(objects.filter((object) => !childIds.has(object.id))).reverse();
  const nodes = roots.map((object) => buildNode(object, new Set()));
  const included = new Set<string>();
  const visit = (node: ObjectTreeNode) => {
    included.add(node.object.id);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);

  // Malformed cyclic legacy groups must remain inspectable instead of
  // disappearing from the table.
  for (const object of sortObjectsForRender(objects).reverse()) {
    if (!included.has(object.id)) nodes.push(buildNode(object, new Set()));
  }
  return nodes;
}

function formatLayerName(layerId: string): string {
  if (layerId === "main") return "Main";
  return layerId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function labelForType(object: SceneObject): string {
  switch (object.type) {
    case "text": return "Ab";
    case "rect": return "Box";
    case "ellipse": return "Ell";
    case "image": return "Img";
    case "line": return "Line";
    case "shape": return "Path";
    case "paint": return "Paint";
    case "mesh": return object.meshKind;
    case "light": return object.lightKind;
    case "camera": return object.cameraKind === "perspective" ? "Persp" : "Ortho";
    case "layer": return object.layerKind;
    case "marker": return "Evt";
    case "group": return "Grp";
  }
}
