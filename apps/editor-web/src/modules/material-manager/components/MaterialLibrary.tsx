import {
  findAssetUsageDetails,
  findMaterialUsage,
  getMaterialBindingId,
  isMaterialCompatible,
  type AssetLibraryItem,
  type Material,
  type MaterialInstance,
  type ShaderDefinition
} from "@grapix/shared-types";
import { AlertTriangle, Braces, CheckCircle2, FileImage, Link2, Palette } from "lucide-react";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { useEditorStore } from "../../../store/editorStore";
import {
  type MaterialManagerSelection,
  useMaterialManagerStore
} from "../stores/materialManagerStore";

type LibraryItem =
  | { kind: "material"; id: string; name: string; material: Material }
  | { kind: "asset"; id: string; name: string; asset: AssetLibraryItem }
  | { kind: "shader"; id: string; name: string; shader: ShaderDefinition }
  | { kind: "instance"; id: string; name: string; instance: MaterialInstance; base?: Material };

export function MaterialLibrary() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const assignMaterialToObjects = useEditorStore((state) => state.assignMaterialToObjects);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const updateAsset = useEditorStore((state) => state.updateAsset);
  const updateMaterialInstance = useEditorStore((state) => state.updateMaterialInstance);
  const deleteMaterial = useEditorStore((state) => state.deleteMaterial);
  const deleteAsset = useEditorStore((state) => state.deleteAsset);
  const deleteMaterialInstance = useEditorStore((state) => state.deleteMaterialInstance);
  const duplicateMaterial = useEditorStore((state) => state.duplicateMaterial);
  const search = useMaterialManagerStore((state) => state.search.trim().toLowerCase());
  const filter = useMaterialManagerStore((state) => state.filter);
  const view = useMaterialManagerStore((state) => state.view);
  const thumbnailSize = useMaterialManagerStore((state) => state.thumbnailSize);
  const selectedItems = useMaterialManagerStore((state) => state.multiSelection);
  const select = useMaterialManagerStore((state) => state.select);
  const toggleSelection = useMaterialManagerStore((state) => state.toggleSelection);
  const openContextMenu = useMaterialManagerStore((state) => state.openContextMenu);
  const items = useMemo(() => createItems(scene, filter, search), [filter, scene, search]);

  function choose(item: LibraryItem, event?: MouseEvent) {
    const selection = toSelection(item);
    if (event?.ctrlKey || event?.metaKey) toggleSelection(selection);
    else select(selection);
  }

  function handleKey(event: KeyboardEvent, item: LibraryItem) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(toSelection(item));
    }
    if (event.key === "F2" && item.kind !== "shader") {
      event.preventDefault();
      const name = window.prompt(`Rename ${item.kind}`, item.name)?.trim();
      if (name && item.kind === "material") updateMaterial(item.id, { name });
      if (name && item.kind === "asset") updateAsset(item.id, { name });
      if (name && item.kind === "instance") updateMaterialInstance(item.id, { name });
    }
    if (event.key === "Delete" && item.kind !== "shader" && window.confirm(`Delete ${item.name}?`)) {
      if (item.kind === "material") deleteMaterial(item.id);
      if (item.kind === "asset") deleteAsset(item.id);
      if (item.kind === "instance") deleteMaterialInstance(item.id);
    }
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const index = items.findIndex((value) => value.kind === item.kind && value.id === item.id);
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const next = items[Math.max(0, Math.min(items.length - 1, index + direction))];
      if (next) {
        select(toSelection(next));
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-material-library-key="${next.kind}:${next.id}"]`)?.focus();
        });
      }
    }
  }

  return (
    <div
      className={`material-library material-library-${view}`}
      style={view === "grid" ? { gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize}px, 1fr))` } : undefined}
      role="listbox"
      aria-label="Materials and assets"
    >
      {items.map((item) => {
        const selection = toSelection(item);
        const selected = selectedItems.some((value) => value.kind === selection.kind && value.id === selection.id);
        return (
          <article
            aria-selected={selected}
            className={`material-library-item ${selected ? "selected" : ""}`}
            data-material-library-key={`${item.kind}:${item.id}`}
            draggable={item.kind === "material" || item.kind === "instance"}
            key={`${item.kind}-${item.id}`}
            onClick={(event) => choose(item, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              choose(item);
              openContextMenu(event.clientX, event.clientY, selection);
            }}
            onDoubleClick={() => {
              if (item.kind === "material" && selectedObjectId) assignMaterialToObjects([selectedObjectId], item.id);
              if (item.kind === "instance" && selectedObjectId) assignMaterialSlot(selectedObjectId, "main", { materialId: item.instance.baseMaterialId, instanceId: item.id });
            }}
            onDragStart={(event) => {
              if (item.kind !== "material" && item.kind !== "instance") return;
              event.dataTransfer.setData("application/x-grapix-material", item.kind === "material" ? item.id : item.instance.baseMaterialId);
              if (item.kind === "instance") event.dataTransfer.setData("application/x-grapix-material-instance", item.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onKeyDown={(event) => handleKey(event, item)}
            role="option"
            tabIndex={0}
            title={item.kind === "material" ? "Drag to a canvas primitive or scene-tree row" : item.name}
          >
            <Thumbnail item={item} />
            <div className="material-library-label">
              <strong>{item.name}</strong>
              <span>{itemMeta(item, scene)}</span>
            </div>
            <StatusBadge item={item} />
          </article>
        );
      })}
      {items.length === 0 ? <div className="material-empty">No assets match the current search and filter.</div> : null}
      <MaterialContextMenu
        onAssign={(materialId) => selectedObjectId && assignMaterialToObjects([selectedObjectId], materialId)}
        onDuplicate={duplicateMaterial}
        onDelete={(materialId, name) => window.confirm(`Delete ${name}?`) && deleteMaterial(materialId)}
      />
    </div>
  );
}

function MaterialContextMenu(props: {
  onAssign: (id: string) => void;
  onDuplicate: (id: string) => unknown;
  onDelete: (id: string, name: string) => unknown;
}) {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const createMaterial = useEditorStore((state) => state.createMaterial);
  const createMaterialInstance = useEditorStore((state) => state.createMaterialInstance);
  const deleteMaterialInstance = useEditorStore((state) => state.deleteMaterialInstance);
  const menu = useMaterialManagerStore((state) => state.contextMenu);
  const close = useMaterialManagerStore((state) => state.closeContextMenu);
  const select = useMaterialManagerStore((state) => state.select);
  if (!menu) return null;
  const material = menu.selection.kind === "material"
    ? scene.materials.find((item) => item.materialId === menu.selection.id)
    : undefined;
  const asset = menu.selection.kind === "asset"
    ? scene.assets.find((item) => item.assetId === menu.selection.id)
    : undefined;

  return (
    <div className="material-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseLeave={close}>
      {material ? (
        <>
          <button disabled={!selectedObjectId} onClick={() => { props.onAssign(material.materialId); close(); }}>Assign to Selected</button>
          <button onClick={() => { const id = createMaterialInstance(material.materialId); if (id) select({ kind: "instance", id }); close(); }}>Create Material Instance</button>
          <button onClick={() => { props.onDuplicate(material.materialId); close(); }}>Duplicate</button>
          <button onClick={() => { select({ kind: "material", id: material.materialId }); close(); }}>Open in Inspector</button>
          <button className="danger" disabled={Boolean(material.builtIn)} onClick={() => { props.onDelete(material.materialId, material.name); close(); }}>Delete</button>
        </>
      ) : null}
      {menu.selection.kind === "instance" ? (
        <>
          <button disabled={!selectedObjectId} onClick={() => {
            const instance = (scene.materialInstances ?? []).find((item) => item.materialInstanceId === menu.selection.id);
            if (instance && selectedObjectId) assignMaterialSlot(selectedObjectId, "main", { materialId: instance.baseMaterialId, instanceId: instance.materialInstanceId });
            close();
          }}>Assign Instance to Selected</button>
          <button className="danger" onClick={() => { if (window.confirm("Delete this material instance?")) deleteMaterialInstance(menu.selection.id); close(); }}>Delete Instance</button>
        </>
      ) : null}
      {asset && ["image", "svg"].includes(asset.kind) ? (
        <button onClick={() => { const id = createMaterial("image", asset.assetId); select({ kind: "material", id }); close(); }}>Create Material</button>
      ) : null}
      {menu.selection.kind === "shader" ? <button onClick={() => { select(menu.selection); close(); }}>View Source and Status</button> : null}
    </div>
  );
}

function Thumbnail({ item }: { item: LibraryItem }) {
  if (item.kind === "material") {
    const texture = item.material.textureSlots?.[0];
    return (
      <div className="material-thumb checkerboard">
        {item.material.type === "solid-color"
          ? <span className="material-swatch" style={{ background: String(item.material.parameters?.baseColor ?? item.material.color ?? "#fff") }} />
          : texture ? <Palette size={28} /> : <Palette size={28} />}
      </div>
    );
  }
  if (item.kind === "asset") {
    return <div className="material-thumb checkerboard">{["image", "svg"].includes(item.asset.kind) && item.asset.status !== "MISSING" ? <img src={item.asset.thumbnailSource ?? item.asset.source} alt="" /> : <FileImage size={28} />}</div>;
  }
  if (item.kind === "instance") {
    return <div className="material-thumb checkerboard"><span className="material-swatch" style={{ background: String(item.base?.parameters?.baseColor ?? item.base?.color ?? "#46586d") }} /><Link2 className="instance-thumb-icon" size={20} /></div>;
  }
  return <div className="material-thumb shader-thumb"><Braces size={30} /></div>;
}

function StatusBadge({ item }: { item: LibraryItem }) {
  if (item.kind === "shader") return item.shader.validationStatus === "VALID" ? <CheckCircle2 className="item-status ok" size={14} /> : <AlertTriangle className="item-status error" size={14} />;
  if (item.kind === "asset" && (item.asset.status === "MISSING" || item.asset.status === "ERROR" || item.asset.status === "UNSUPPORTED")) return <AlertTriangle className="item-status error" size={14} />;
  return null;
}

function createItems(scene: ReturnType<typeof useEditorStore.getState>["scene"], filter: string, search: string): LibraryItem[] {
  const materials = scene.materials.map((material): LibraryItem => ({ kind: "material", id: material.materialId, name: material.name, material }));
  const instances = (scene.materialInstances ?? []).map((instance): LibraryItem => ({ kind: "instance", id: instance.materialInstanceId, name: instance.name, instance, base: scene.materials.find((material) => material.materialId === instance.baseMaterialId) }));
  const assets = scene.assets.map((asset): LibraryItem => ({ kind: "asset", id: asset.assetId, name: asset.name, asset }));
  const shaders = (scene.shaders ?? []).map((shader): LibraryItem => ({ kind: "shader", id: shader.shaderId, name: shader.name, shader }));
  const items = filter === "materials" ? [...materials, ...instances]
    : filter === "images" ? assets.filter((item) => item.kind === "asset" && ["image", "svg"].includes(item.asset.kind))
      : filter === "shaders" ? shaders
        : filter === "missing" ? assets.filter((item) => item.kind === "asset" && ["MISSING", "ERROR", "UNSUPPORTED"].includes(item.asset.status ?? "READY"))
          : filter === "in-use" ? [
              ...materials.filter((item) => item.kind === "material" && findMaterialUsage(scene, item.id).objectIds.length > 0),
              ...assets.filter((item) => {
                if (item.kind !== "asset") return false;
                const usage = findAssetUsageDetails(scene, item.id);
                return usage.materialIds.length > 0 || usage.shaderIds.length > 0;
              })
            ]
            : [...materials, ...instances, ...assets, ...shaders];
  if (!search) return items;
  return items.filter((item) => {
    const tags = item.kind === "material" ? item.material.tags : item.kind === "asset" ? item.asset.tags : [];
    return `${item.name} ${item.kind} ${(tags ?? []).join(" ")}`.toLowerCase().includes(search);
  });
}

function itemMeta(item: LibraryItem, scene: ReturnType<typeof useEditorStore.getState>["scene"]): string {
  if (item.kind === "material") return `${item.material.type} / ${findMaterialUsage(scene, item.id).objectIds.length} use`;
  if (item.kind === "instance") return `instance / ${item.base?.name ?? "missing base"}`;
  if (item.kind === "shader") return `${item.shader.validationStatus.toLowerCase()} / WGSL v${item.shader.version}`;
  const size = item.asset.sizeBytes ? `${Math.max(1, Math.round(item.asset.sizeBytes / 1024))} KiB` : "embedded";
  return `${item.asset.kind} / ${size}`;
}

function toSelection(item: LibraryItem): MaterialManagerSelection {
  return { kind: item.kind, id: item.id };
}

export function selectedMaterialIds(scene: ReturnType<typeof useEditorStore.getState>["scene"], objectIds: string[]): string[] {
  const ids = new Set(objectIds.flatMap((id) => {
    const object = scene.objects.find((item) => item.id === id);
    return object ? Object.values(object.materialSlots).map((binding) => getMaterialBindingId(binding)).filter(Boolean) as string[] : [];
  }));
  return [...ids].filter((id) => {
    const material = scene.materials.find((item) => item.materialId === id);
    const object = scene.objects.find((item) => objectIds.includes(item.id));
    return Boolean(material && object && isMaterialCompatible(material, object.type));
  });
}
