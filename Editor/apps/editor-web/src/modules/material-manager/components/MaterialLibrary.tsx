import {
  findAssetUsageDetails,
  findMaterialUsage,
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatibleWithFace,
  type AssetLibraryItem,
  type Material,
  type MaterialInstance,
  type ProjectAssetReference,
  type ShaderDefinition
} from "@grapix/shared-types";
import {
  AlertTriangle,
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  FileImage,
  Link2,
  Palette
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { createPortal } from "react-dom";
import { useEditorStore } from "../../../store/editorStore";
import {
  type MaterialManagerSelection,
  useMaterialManagerStore
} from "../stores/materialManagerStore";
import { placeMaterialContextMenu } from "./materialContextMenu";
import { projectAssetLibraryItem } from "../../../lib/projectAssets";
import { AssetThumbnail } from "../../../components/AssetThumbnail";
import { useProjectAssetStore, watchProjectAssets, type ProjectAssetStatus } from "../../../store/projectAssetStore";

type LibraryItem =
  | { kind: "material"; id: string; name: string; material: Material }
  | { kind: "asset"; id: string; name: string; asset: AssetLibraryItem }
  | { kind: "shader"; id: string; name: string; shader: ShaderDefinition }
  | { kind: "instance"; id: string; name: string; instance: MaterialInstance; base?: Material };

interface MaterialLibraryProps {
  importing: boolean;
  onImportFolder: () => void;
  onImportImages: () => void;
  onImportModels: () => void;
  onImportShaders: () => void;
}

export function MaterialLibrary(props: MaterialLibraryProps) {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectedFaceIndices = useEditorStore((state) => state.selectedFaceIndices);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const assignAssetToFaces = useEditorStore((state) => state.assignAssetToFaces);
  const addModelObjectFromAsset = useEditorStore((state) => state.addModelObjectFromAsset);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const updateAsset = useEditorStore((state) => state.updateAsset);
  const updateMaterialInstance = useEditorStore((state) => state.updateMaterialInstance);
  const refreshAssetAvailability = useEditorStore((state) => state.refreshAssetAvailability);
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
  const [newMaterialDialogOpen, setNewMaterialDialogOpen] = useState(false);
  const projectAssets = useProjectAssetStore((state) => state.assets);
  const libraryStatus = useProjectAssetStore((state) => state.status);
  const libraryError = useProjectAssetStore((state) => state.error);
  const projectOpen = useProjectAssetStore((state) => state.projectOpen);

  /*
   * Read the project's asset folders now, and again on every window focus.
   *
   * The filesystem raises no event we could subscribe to, and the way an asset usually arrives is
   * that the author alt-tabs to Explorer, drops a file in, and comes back — so returning focus is
   * the moment the panel is most likely to be wrong. A directory watcher was the alternative and
   * is worse: it holds handles on folders the operator is editing, which on Windows is how a
   * directory becomes undeletable.
   */
  useEffect(() => watchProjectAssets(), []);

  const items = useMemo(
    () => createItems(scene, filter, search, projectAssets),
    [filter, projectAssets, scene, search]
  );

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
    if (event.key === "Delete") {
      // TemplatesPanel owns a separate Delete shortcut. Contain this native
      // event so deleting a library resource can never delete the open scene.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (item.kind !== "shader" && window.confirm(`Delete ${item.name}?`)) {
        if (item.kind === "material") deleteMaterial(item.id);
        if (item.kind === "asset") deleteAsset(item.id);
        if (item.kind === "instance") deleteMaterialInstance(item.id);
      }
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      void refreshAssetAvailability();
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openContextMenu(bounds.left + Math.min(28, bounds.width / 2), bounds.top + Math.min(28, bounds.height / 2), toSelection(item));
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
      title="Right-click to create or import materials and sources"
      onContextMenu={(event) => {
        const target = event.target as Element;
        if (target.closest(".material-library-item")) return;
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY, null);
      }}
    >
      {items.map((item) => {
        const selection = toSelection(item);
        const selected = selectedItems.some((value) => value.kind === selection.kind && value.id === selection.id);
        return (
          <article
            aria-selected={selected}
            className={`material-library-item ${selected ? "selected" : ""}`}
            data-material-library-key={`${item.kind}:${item.id}`}
            draggable={item.kind === "material" || item.kind === "instance" || (item.kind === "asset" && ["image", "svg"].includes(item.asset.kind))}
            key={`${item.kind}-${item.id}`}
            onClick={(event) => choose(item, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!selected) choose(item);
              openContextMenu(event.clientX, event.clientY, selection);
            }}
            onDoubleClick={(event) => {
              // XPression semantics: a NORMAL double-click assigns the material
              // to the object's currently-selected faces; the additive gesture
              // opens it in the Material Editor (the Material Inspector form) —
              // double-click must NOT open the editor.
              if (event.shiftKey) {
                if (item.kind === "material" || item.kind === "instance") select(toSelection(item));
                return;
              }
              // Passing "" when nothing is selected lets the central binding
              // action surface the non-blocking "Select a compatible object or
              // material face first." message instead of silently no-opping.
              if (item.kind === "material") assignMaterialToFaces(selectedObjectId ?? "", selectedFaceIndices, item.id);
              else if (item.kind === "instance") assignMaterialToFaces(selectedObjectId ?? "", selectedFaceIndices, { materialId: item.instance.baseMaterialId, instanceId: item.id });
              else if (item.kind === "asset" && item.asset.kind === "model") addModelObjectFromAsset(item.id);
              else if (item.kind === "asset") assignAssetToFaces(selectedObjectId ?? "", selectedFaceIndices, item.id);
            }}
            onDragStart={(event) => {
              if (item.kind === "asset") {
                if (!["image", "svg"].includes(item.asset.kind)) return;
                event.dataTransfer.setData("application/x-grapix-asset", item.id);
                event.dataTransfer.effectAllowed = "copy";
                return;
              }
              if (item.kind !== "material" && item.kind !== "instance") return;
              event.dataTransfer.setData("application/x-grapix-material", item.kind === "material" ? item.id : item.instance.baseMaterialId);
              if (item.kind === "instance") event.dataTransfer.setData("application/x-grapix-material-instance", item.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onKeyDown={(event) => handleKey(event, item)}
            role="option"
            tabIndex={0}
            title={item.kind === "material" ? "Double-click to apply to the selected primitive, or drag onto a canvas primitive"
              : item.kind === "asset" && ["image", "svg"].includes(item.asset.kind) ? "Double-click to apply to the selected surface, or drag onto a canvas primitive or mesh"
              : item.kind === "asset" && item.asset.kind === "model" ? "Double-click to add this real 3D model to the current scene"
              : item.name}
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
      {items.length === 0 ? <div className="material-empty">{emptyLibraryMessage(libraryStatus, libraryError, projectOpen)}</div> : null}
      <MaterialContextMenu
        importing={props.importing}
        onImportFolder={props.onImportFolder}
        onImportImages={props.onImportImages}
        onImportModels={props.onImportModels}
        onImportShaders={props.onImportShaders}
        onNewMaterial={() => setNewMaterialDialogOpen(true)}
      />
      {newMaterialDialogOpen ? <NewMaterialDialog onClose={() => setNewMaterialDialogOpen(false)} /> : null}
    </div>
  );
}

function MaterialContextMenu(props: {
  importing: boolean;
  onImportFolder: () => void;
  onImportImages: () => void;
  onImportModels: () => void;
  onImportShaders: () => void;
  onNewMaterial: () => void;
}) {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectedFaceIndices = useEditorStore((state) => state.selectedFaceIndices);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const assignAssetToFaces = useEditorStore((state) => state.assignAssetToFaces);
  const addModelObjectFromAsset = useEditorStore((state) => state.addModelObjectFromAsset);
  const createMaterialInstance = useEditorStore((state) => state.createMaterialInstance);
  const duplicateMaterial = useEditorStore((state) => state.duplicateMaterial);
  const deleteMaterial = useEditorStore((state) => state.deleteMaterial);
  const deleteAllUnusedMaterials = useEditorStore((state) => state.deleteUnusedMaterials);
  const deleteAsset = useEditorStore((state) => state.deleteAsset);
  const deleteMaterialInstance = useEditorStore((state) => state.deleteMaterialInstance);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const updateAsset = useEditorStore((state) => state.updateAsset);
  const updateMaterialInstance = useEditorStore((state) => state.updateMaterialInstance);
  const refreshAssetAvailability = useEditorStore((state) => state.refreshAssetAvailability);
  const menu = useMaterialManagerStore((state) => state.contextMenu);
  const close = useMaterialManagerStore((state) => state.closeContextMenu);
  const select = useMaterialManagerStore((state) => state.select);
  const previewBackground = useMaterialManagerStore((state) => state.previewBackground);
  const setPreviewBackground = useMaterialManagerStore((state) => state.setPreviewBackground);
  const setFilter = useMaterialManagerStore((state) => state.setFilter);
  const setSearch = useMaterialManagerStore((state) => state.setSearch);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return undefined;

    function closeFromOutside(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }

    function closeFromKeyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    window.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("contextmenu", closeFromOutside, true);
    window.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("contextmenu", closeFromOutside, true);
      window.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("blur", close);
    };
  }, [close, menu]);

  if (!menu) return null;
  const target = menu.selection;
  const material = target?.kind === "material"
    ? scene.materials.find((item) => item.materialId === target.id)
    : undefined;
  const instance = target?.kind === "instance"
    ? (scene.materialInstances ?? []).find((item) => item.materialInstanceId === target.id)
    : undefined;
  const asset = target?.kind === "asset"
    ? scene.assets.find((item) => item.assetId === target.id)
    : undefined;
  const shader = target?.kind === "shader"
    ? (scene.shaders ?? []).find((item) => item.shaderId === target.id)
    : undefined;
  const targetName = material?.name ?? instance?.name ?? asset?.name ?? shader?.name;
  const selectedObject = scene.objects.find((item) => item.id === selectedObjectId);
  const instanceBase = instance
    ? scene.materials.find((item) => item.materialId === instance.baseMaterialId)
    : undefined;
  const linkedAssetMaterial = asset
    ? scene.materials.find((candidate) =>
        candidate.assetId === asset.assetId
        || candidate.textureSlots?.some((slot) => slot.assetId === asset.assetId))
    : undefined;
  const assignableMaterial = material ?? instanceBase ?? linkedAssetMaterial;
  const bindableFaces = selectedObject ? getBindableFaces(selectedObject) : [];
  const assetCanAssign = Boolean(asset
    && ["image", "svg"].includes(asset.kind)
    && !["MISSING", "ERROR", "UNSUPPORTED"].includes(asset.status ?? "READY"));
  const canAssign = Boolean(
    selectedObject
      && selectedFaceIndices.length
      && (material || instance || assetCanAssign)
      && selectedFaceIndices.every((faceIndex) =>
        Boolean(bindableFaces[faceIndex])
        && (!assignableMaterial || isMaterialCompatibleWithFace(assignableMaterial, selectedObject, faceIndex)))
  );
  const materialUsage = material ? findMaterialUsage(scene, material.materialId) : undefined;
  const assetUsage = asset ? findAssetUsageDetails(scene, asset.assetId) : undefined;
  const canDelete = Boolean(
    (material
      && !material.builtIn
      && !materialUsage?.objectIds.length
      && !materialUsage?.instanceIds.length)
    || (asset
      && !assetUsage?.materialIds.length
      && !assetUsage?.shaderIds.length
      && !assetUsage?.objectIds.length)
    || instance
  );
  const refreshable = Boolean(
    asset
      || material?.assetId
      || material?.textureSlots?.some((slot) => slot.assetId)
      || instanceBase?.assetId
      || instanceBase?.textureSlots?.some((slot) => slot.assetId)
  );
  const placement = placeMaterialContextMenu(
    menu.x,
    menu.y,
    window.innerWidth,
    window.innerHeight,
    248,
    target ? 430 : 330
  );
  const submenuClassName = `material-context-submenu ${placement.openSubmenusLeft ? "opens-left" : ""}`;

  function assignTarget() {
    if (!selectedObjectId) return;
    if (material) assignMaterialToFaces(selectedObjectId, selectedFaceIndices, material.materialId);
    else if (instance) {
      assignMaterialToFaces(selectedObjectId, selectedFaceIndices, {
        materialId: instance.baseMaterialId,
        instanceId: instance.materialInstanceId
      });
    } else if (asset && ["image", "svg"].includes(asset.kind)) {
      assignAssetToFaces(selectedObjectId, selectedFaceIndices, asset.assetId);
    }
    close();
  }

  function renameTarget() {
    if (!target || !targetName || target.kind === "shader") return;
    const name = window.prompt(`Rename ${target.kind}`, targetName)?.trim();
    if (name && material) updateMaterial(material.materialId, { name });
    if (name && asset) updateAsset(asset.assetId, { name });
    if (name && instance) updateMaterialInstance(instance.materialInstanceId, { name });
    close();
  }

  function deleteTarget() {
    if (!target || !targetName || target.kind === "shader") return;
    if (!window.confirm(`Delete ${targetName}?`)) {
      close();
      return;
    }
    if (material) deleteMaterial(material.materialId);
    if (asset) deleteAsset(asset.assetId);
    if (instance) deleteMaterialInstance(instance.materialInstanceId);
    close();
  }

  function confirmDeleteUnusedMaterials() {
    const unused = scene.materials.filter((candidate) => {
      if (candidate.builtIn) return false;
      const usage = findMaterialUsage(scene, candidate.materialId);
      return usage.objectIds.length === 0 && usage.instanceIds.length === 0;
    });
    if (!unused.length) {
      window.alert("There are no unused project materials.");
      close();
      return;
    }
    if (window.confirm(`Delete ${unused.length} unused project material${unused.length === 1 ? "" : "s"}?`)) {
      deleteAllUnusedMaterials();
    }
    close();
  }

  function showUsage() {
    if (!targetName) return;
    setFilter("in-use");
    setSearch(targetName);
    if (target) select(target);
    close();
  }

  function runNewAction(action: () => void) {
    close();
    action();
  }

  return createPortal(
    <div
      className="material-context-menu"
      ref={menuRef}
      style={{ left: placement.left, top: placement.top }}
      role="menu"
      aria-label="Material library actions"
    >
      <ContextMenuButton
        disabled={!canAssign}
        label="Assign To Selection"
        onClick={assignTarget}
      />
      {asset?.kind === "model" ? (
        <ContextMenuButton
          label="Add Model To Scene"
          onClick={() => {
            addModelObjectFromAsset(asset.assetId);
            close();
          }}
        />
      ) : null}
      <ContextMenuSeparator />
      <div className="material-context-submenu-host">
        <ContextMenuButton hasSubmenu label="New" />
        <div className={submenuClassName} role="menu" aria-label="New material or source">
          <ContextMenuButton label="Material…" onClick={() => runNewAction(props.onNewMaterial)} />
          <ContextMenuButton disabled={props.importing} label="Image…" onClick={() => runNewAction(props.onImportImages)} />
          <ContextMenuButton disabled label="Video…" title="Video sources are planned but not enabled in this renderer." />
          <ContextMenuButton disabled label="Mask" title="Mask materials are planned but not enabled in this renderer." />
          <ContextMenuButton disabled label="Live Source…" title="Live sources are planned but not enabled in this renderer." />
          <ContextMenuSeparator />
          <ContextMenuButton disabled={props.importing} label="3D Model…" onClick={() => runNewAction(props.onImportModels)} />
          <ContextMenuButton disabled={props.importing} label="Shader…" onClick={() => runNewAction(props.onImportShaders)} />
          <ContextMenuButton disabled={props.importing} label="Import Folder…" onClick={() => runNewAction(props.onImportFolder)} />
        </div>
      </div>
      <div className="material-context-submenu-host">
        <ContextMenuButton hasSubmenu label="Preview Background" />
        <div className={submenuClassName} role="menu" aria-label="Preview background">
          {(["checker", "light", "dark"] as const).map((background) => (
            <ContextMenuButton
              checked={previewBackground === background}
              key={background}
              label={background[0].toUpperCase() + background.slice(1)}
              onClick={() => {
                setPreviewBackground(background);
                close();
              }}
            />
          ))}
        </div>
      </div>
      <ContextMenuSeparator />
      <ContextMenuButton
        disabled={!target}
        label={target?.kind === "shader" ? "View Source And Status…" : "Edit…"}
        onClick={() => {
          if (target) select(target);
          close();
        }}
      />
      <ContextMenuButton
        disabled={!target || target.kind === "shader" || Boolean(material?.builtIn)}
        label="Rename"
        onClick={renameTarget}
      />
      <ContextMenuButton
        disabled={!refreshable}
        label="Refresh Sources"
        onClick={() => {
          close();
          void refreshAssetAvailability();
        }}
        title={refreshable ? "Recheck linked asset availability." : "This item has no linked source to refresh."}
      />
      {material ? (
        <ContextMenuButton
          label="Create Material Instance"
          onClick={() => {
            const id = createMaterialInstance(material.materialId);
            if (id) select({ kind: "instance", id });
            close();
          }}
        />
      ) : null}
      <ContextMenuButton
        disabled={!material}
        label="Duplicate"
        onClick={() => {
          if (material) {
            const id = duplicateMaterial(material.materialId);
            if (id) select({ kind: "material", id });
          }
          close();
        }}
      />
      <ContextMenuSeparator />
      <ContextMenuButton disabled={!material && !asset} label="Find Usage…" onClick={showUsage} />
      <ContextMenuButton label="Delete All Unused Materials…" onClick={confirmDeleteUnusedMaterials} />
      <ContextMenuSeparator />
      <ContextMenuButton
        danger
        disabled={!canDelete}
        label="Delete…"
        onClick={deleteTarget}
        title={target && !canDelete ? "Built-in or referenced items cannot be deleted." : undefined}
      />
    </div>,
    document.body
  );
}

interface ContextMenuButtonProps {
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  hasSubmenu?: boolean;
  label: string;
  onClick?: () => void;
  title?: string;
}

function ContextMenuButton(props: ContextMenuButtonProps) {
  return (
    <button
      className={`material-context-menu-item ${props.danger ? "danger" : ""}`}
      disabled={props.disabled}
      onClick={props.onClick}
      role="menuitem"
      title={props.title}
      type="button"
    >
      <span className="material-context-check">{props.checked ? <Check size={13} /> : null}</span>
      <span className="material-context-label">{props.label}</span>
      {props.hasSubmenu ? <ChevronRight className="material-context-chevron" size={14} /> : null}
    </button>
  );
}

function ContextMenuSeparator() {
  return <div className="material-context-separator" role="separator" />;
}

function NewMaterialDialog({ onClose }: { onClose: () => void }) {
  const createMaterial = useEditorStore((state) => state.createMaterial);
  const updateMaterial = useEditorStore((state) => state.updateMaterial);
  const select = useMaterialManagerStore((state) => state.select);
  const [name, setName] = useState("New Material");
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
    function closeFromKeyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = createMaterial();
    const normalizedName = name.trim();
    if (normalizedName) updateMaterial(id, { name: normalizedName });
    select({ kind: "material", id });
    onClose();
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form className="material-create-dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-material-title">
        <header>
          <strong id="new-material-title">New Material</strong>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>
        <label>
          Name
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="material-dialog-note">
          One physical surface material. Add colour or image layers, then shape
          its response to the scene lights with the surface controls.
        </p>
        <footer>
          <button onClick={onClose} type="button">Cancel</button>
          <button className="primary" type="submit">Create</button>
        </footer>
      </form>
    </div>,
    document.body
  );
}

function Thumbnail({ item }: { item: LibraryItem }) {
  if (item.kind === "material") {
    const texture = item.material.textureSlots?.[0];
    return (
      <div className="material-thumb checkerboard">
        {texture?.assetId
          ? <Palette size={28} />
          : <span className="material-swatch" style={{ background: String(item.material.parameters?.baseColor ?? item.material.parameters?.tint ?? item.material.color ?? "#fff") }} />}
      </div>
    );
  }
  if (item.kind === "asset") {
    return (
      <div className="material-thumb checkerboard">
        {["image", "svg"].includes(item.asset.kind) && item.asset.status !== "MISSING"
          ? <AssetThumbnail source={item.asset.thumbnailSource ?? item.asset.source} fallback={<FileImage size={28} />} />
          : item.asset.kind === "model" ? <Box size={28} /> : <FileImage size={28} />}
      </div>
    );
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

/**
 * Every asset the library offers: the ones the scene carries, then the rest of the project's
 * asset folders.
 *
 * The scene's own entry wins where both exist. It is the same file — they share an id derived from
 * the path — but the scene's copy carries what the author did to it: the name they gave it, their
 * tags, an alpha mode they chose. Preferring the folder's plain entry would make those edits
 * disappear from the panel every time it refreshed.
 *
 * Folder entries are appended rather than interleaved so the assets this scene actually uses stay
 * together at the top, instead of being scattered through everything else in the project.
 */
function libraryAssets(
  scene: ReturnType<typeof useEditorStore.getState>["scene"],
  projectAssets: readonly ProjectAssetReference[]
): AssetLibraryItem[] {
  const carried = new Set(scene.assets.map((asset) => asset.assetId));
  return [
    ...scene.assets,
    ...projectAssets
      .map(projectAssetLibraryItem)
      .filter((asset) => !carried.has(asset.assetId))
  ];
}

function createItems(
  scene: ReturnType<typeof useEditorStore.getState>["scene"],
  filter: string,
  search: string,
  projectAssets: readonly ProjectAssetReference[]
): LibraryItem[] {
  const materials = scene.materials.map((material): LibraryItem => ({ kind: "material", id: material.materialId, name: material.name, material }));
  const instances = (scene.materialInstances ?? []).map((instance): LibraryItem => ({ kind: "instance", id: instance.materialInstanceId, name: instance.name, instance, base: scene.materials.find((material) => material.materialId === instance.baseMaterialId) }));
  const assets = libraryAssets(scene, projectAssets).map((asset): LibraryItem => ({ kind: "asset", id: asset.assetId, name: asset.name, asset }));
  // Hide load-compatibility shader aliases (e.g. the legacy "Basic Lit Mesh",
  // which is the same WGSL as the Standard Material). Scenes authored before the
  // unified material still reference them, but showing them would re-introduce
  // the lit/unlit/PBR split that no longer exists in authoring.
  const shaders = (scene.shaders ?? [])
    .filter((shader) => shader.userFacing !== false && !shader.compatibilityAliasFor)
    .map((shader): LibraryItem => ({ kind: "shader", id: shader.shaderId, name: shader.name, shader }));
  const items = filter === "materials" ? [...materials, ...instances]
    : filter === "images" ? assets.filter((item) => item.kind === "asset" && ["image", "svg"].includes(item.asset.kind))
      : filter === "models" ? assets.filter((item) => item.kind === "asset" && item.asset.kind === "model")
      : filter === "shaders" ? shaders
        : filter === "missing" ? assets.filter((item) => item.kind === "asset" && ["MISSING", "ERROR", "UNSUPPORTED"].includes(item.asset.status ?? "READY"))
          : filter === "in-use" ? [
              ...materials.filter((item) => item.kind === "material" && findMaterialUsage(scene, item.id).objectIds.length > 0),
              ...assets.filter((item) => {
                if (item.kind !== "asset") return false;
                const usage = findAssetUsageDetails(scene, item.id);
                return usage.materialIds.length > 0 || usage.shaderIds.length > 0 || usage.objectIds.length > 0;
              })
            ]
            // "All" is the authoring library. Shader definitions are
            // implementation resources and remain available under Shaders,
            // where they cannot be mistaken for assignable materials.
            : [...materials, ...instances, ...assets];
  if (!search) return items;
  return items.filter((item) => {
    const tags = item.kind === "material" ? item.material.tags : item.kind === "asset" ? item.asset.tags : [];
    return `${item.name} ${item.kind} ${(tags ?? []).join(" ")}`.toLowerCase().includes(search);
  });
}

/**
 * Why the library is empty, which is four different situations wearing one appearance.
 *
 * "No assets match the current search and filter" was said for all of them, including the two that
 * are not about filtering at all: a project that was never saved, and a read that failed. An author
 * whose service had restarted was told their filter was too narrow, and clearing it changed
 * nothing — the panel has to say which of these it is or it sends people looking in the wrong place.
 */
export function emptyLibraryMessage(
  status: ProjectAssetStatus,
  error: string | null,
  projectOpen: boolean
): string {
  if (status === "error") {
    return `${error ?? "The project's assets could not be read."} The list may be out of date; it refreshes when this window regains focus.`;
  }
  if (status === "loading") return "Reading the project's asset folders…";
  if (!projectOpen) return "No project yet. Save the project to a folder, then its Assets folders become this library.";
  return "No assets match the current search and filter.";
}

function itemMeta(item: LibraryItem, scene: ReturnType<typeof useEditorStore.getState>["scene"]): string {
  if (item.kind === "material") {
    const textured = item.material.textureSlots?.some((slot) => Boolean(slot.assetId));
    return `${textured ? "textured material" : "material"} / ${findMaterialUsage(scene, item.id).objectIds.length} use`;
  }
  if (item.kind === "instance") return `instance / ${item.base?.name ?? "missing base"}`;
  if (item.kind === "shader") return `${item.shader.validationStatus.toLowerCase()} / WGSL v${item.shader.version}`;
  const size = item.asset.sizeBytes ? `${Math.max(1, Math.round(item.asset.sizeBytes / 1024))} KiB` : "embedded";
  /*
   * Geometry and alpha, when the file said so.
   *
   * These are the two facts an author actually chooses between two images on, and the second one
   * costs a show when it is wrong: a key with no alpha channel reaches air as a black rectangle.
   * Nothing is shown for an image whose header could not be read — an absent answer is honest,
   * where "opaque" invented for an unreadable file would be believed.
   */
  const geometry = item.asset.width && item.asset.height
    ? `${item.asset.width}×${item.asset.height}`
    : null;
  const alpha = item.asset.hasAlpha === true ? "alpha" : item.asset.hasAlpha === false ? "opaque" : null;
  return [item.asset.kind, geometry, alpha, size].filter(Boolean).join(" / ");
}

function toSelection(item: LibraryItem): MaterialManagerSelection {
  return { kind: item.kind, id: item.id };
}

export function selectedMaterialIds(scene: ReturnType<typeof useEditorStore.getState>["scene"], objectIds: string[]): string[] {
  const ids = new Set(objectIds.flatMap((id) => {
    const object = scene.objects.find((item) => item.id === id);
    return object ? Object.values(object.materialSlots).map((binding) => getMaterialBindingId(binding)).filter(Boolean) as string[] : [];
  }));
  return [...ids].filter((id) => scene.materials.some((material) => material.materialId === id));
}
