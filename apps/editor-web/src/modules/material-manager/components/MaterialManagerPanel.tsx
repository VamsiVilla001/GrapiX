import {
  Box,
  Braces,
  FileImage,
  Grid2X2,
  List,
  Palette,
  Search,
  Video
} from "lucide-react";
import { useRef, type DragEvent } from "react";
import { useEditorStore } from "../../../store/editorStore";
import { MaterialLibrary } from "./MaterialLibrary";
import { MaterialPreview } from "./MaterialPreview";
import { MaterialInspector } from "./MaterialInspector";
import {
  type MaterialManagerFilter,
  useMaterialManagerStore
} from "../stores/materialManagerStore";

export function MaterialManagerPanel() {
  const importAsset = useEditorStore((state) => state.importAsset);
  const materialActionError = useEditorStore((state) => state.materialActionError);
  const search = useMaterialManagerStore((state) => state.search);
  const filter = useMaterialManagerStore((state) => state.filter);
  const view = useMaterialManagerStore((state) => state.view);
  const thumbnailSize = useMaterialManagerStore((state) => state.thumbnailSize);
  const importing = useMaterialManagerStore((state) => state.importing);
  const setSearch = useMaterialManagerStore((state) => state.setSearch);
  const setFilter = useMaterialManagerStore((state) => state.setFilter);
  const setView = useMaterialManagerStore((state) => state.setView);
  const setThumbnailSize = useMaterialManagerStore((state) => state.setThumbnailSize);
  const setImporting = useMaterialManagerStore((state) => state.setImporting);
  const select = useMaterialManagerStore((state) => state.select);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<HTMLInputElement | null>(null);
  const shaderRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  async function importFiles(files: FileList | File[]) {
    const accepted = Array.from(files);
    if (!accepted.length) return;
    setImporting(true);
    try {
      for (const file of accepted) {
        try {
          const assetId = await importAsset(file);
          if (assetId) {
            const importedScene = useEditorStore.getState().scene;
            const asset = importedScene.assets.find((item) => item.assetId === assetId);
            const shader = asset?.sourcePath
              ? (importedScene.shaders ?? []).find((item) => item.sourcePath === asset.sourcePath)
              : undefined;
            if (shader) select({ kind: "shader", id: shader.shaderId });
            else if (asset) select({ kind: "asset", id: asset.assetId });
          }
        } catch {
          // The editor store records the actionable validation/import error;
          // continue so one unsupported folder entry does not block the rest.
        }
      }
    } finally {
      setImporting(false);
    }
  }

  function handleDrop(event: DragEvent) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void importFiles(event.dataTransfer.files);
  }

  return (
    <section className="material-manager-panel" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={handleDrop}>
      <div className="material-manager-toolbar">
        <label className="material-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search materials, assets, tags" /></label>
        <span className="material-view-controls">
          <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} title="Grid view"><Grid2X2 size={14} /></button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} title="List view"><List size={14} /></button>
          {view === "grid" ? <input aria-label="Thumbnail size" type="range" min={72} max={220} value={thumbnailSize} onChange={(event) => setThumbnailSize(Number(event.target.value))} /> : null}
        </span>
        {importing ? <span className="material-import-status" role="status">Importing…</span> : null}
        <input hidden multiple ref={imageRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/tiff" onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ""; }} />
        <input hidden multiple ref={modelRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ""; }} />
        <input hidden multiple ref={shaderRef} type="file" accept=".wgsl" onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ""; }} />
        <input hidden multiple ref={(element) => { folderRef.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ""; }} />
      </div>
      {materialActionError ? <div className="material-manager-error">{materialActionError}</div> : null}
      <div className="material-manager-workspace">
        <nav className="material-folder-tree" aria-label="Material library folders">
          <strong>Library</strong>
          <FolderButton active={filter === "all"} icon={<Palette size={14} />} label="All" filter="all" onSelect={setFilter} />
          <FolderButton active={filter === "materials"} icon={<Palette size={14} />} label="Materials" filter="materials" onSelect={setFilter} />
          <FolderButton active={filter === "images"} icon={<FileImage size={14} />} label="Images" filter="images" onSelect={setFilter} />
          <FolderButton active={filter === "models"} icon={<Box size={14} />} label="3D Models" filter="models" onSelect={setFilter} />
          <FolderButton active={filter === "shaders"} icon={<Braces size={14} />} label="Shaders" filter="shaders" onSelect={setFilter} />
          <FolderButton active={filter === "missing"} icon={<FileImage size={14} />} label="Missing" filter="missing" onSelect={setFilter} />
          <FolderButton active={filter === "in-use"} icon={<Palette size={14} />} label="In Use" filter="in-use" onSelect={setFilter} />
          <strong className="folder-section-label">Prepared sources</strong>
          {[
            ["Videos", <Video size={14} />], ["Image Sequences", <FileImage size={14} />], ["Live Inputs", <Video size={14} />], ["Render Textures", <Palette size={14} />], ["Fonts", <FileImage size={14} />]
          ].map(([label, icon]) => <button disabled className="material-folder disabled" key={String(label)} title={`${label} are defined as extension points but not enabled in this renderer.`}>{icon}<span>{label}</span><small>planned</small></button>)}
        </nav>
        <div className="material-library-column">
          <MaterialLibrary
            importing={importing}
            onImportFolder={() => folderRef.current?.click()}
            onImportImages={() => imageRef.current?.click()}
            onImportModels={() => modelRef.current?.click()}
            onImportShaders={() => shaderRef.current?.click()}
          />
          <MaterialPreview />
        </div>
        <MaterialInspector />
      </div>
    </section>
  );
}

function FolderButton(props: { active: boolean; icon: JSX.Element; label: string; filter: MaterialManagerFilter; onSelect: (filter: MaterialManagerFilter) => void }) {
  return <button className={`material-folder ${props.active ? "active" : ""}`} onClick={() => props.onSelect(props.filter)}>{props.icon}<span>{props.label}</span></button>;
}
