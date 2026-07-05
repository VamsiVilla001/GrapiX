import { Box, Database, FileJson, Folder, Images, Layers3, ListVideo, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type ApiSceneSummary, listScenesFromApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";
import { CollapsiblePanel, CollapsibleSection } from "./Collapsible";

export function ProjectManager() {
  const scene = useEditorStore((state) => state.scene);
  const [scenes, setScenes] = useState<ApiSceneSummary[]>([]);
  const [apiState, setApiState] = useState<"idle" | "ok" | "offline">("idle");

  async function refreshScenes() {
    try {
      setScenes(await listScenesFromApi());
      setApiState("ok");
    } catch {
      setApiState("offline");
    }
  }

  useEffect(() => {
    void refreshScenes();
  }, []);

  return (
    <aside className="project-manager">
      <CollapsiblePanel
        title="Project Manager"
        defaultOpen
        actions={<button className="panel-icon-button" onClick={refreshScenes} title="Refresh scenes"><RefreshCcw size={14} /></button>}
      >
      <div className="project-tree">
        <TreeGroup icon={<Folder size={15} />} label="Scenes">
          <TreeItem icon={<FileJson size={14} />} label={scene.name} meta="open" active />
          {scenes
            .filter((savedScene) => savedScene.id !== scene.id)
            .map((savedScene) => (
              <TreeItem icon={<FileJson size={14} />} label={savedScene.name} meta={`${savedScene.objectCount} obj`} key={savedScene.id} />
            ))}
          {apiState === "offline" ? <div className="tree-note">Backend scene list offline</div> : null}
        </TreeGroup>
        <TreeGroup icon={<Images size={15} />} label="Assets">
          <TreeItem icon={<Box size={14} />} label="Images" meta={String(scene.assets.filter((asset) => ["image", "svg"].includes(asset.kind)).length)} />
          <TreeItem icon={<Box size={14} />} label="Fonts" meta={String(scene.assets.filter((asset) => asset.kind === "font").length)} />
        </TreeGroup>
        <TreeGroup icon={<Layers3 size={15} />} label="Materials">
          {scene.materials.map((material) => (
            <TreeItem icon={<Layers3 size={14} />} label={material.name} meta={material.dynamic ? "dyn" : material.type} key={material.materialId} />
          ))}
        </TreeGroup>
        <TreeGroup icon={<Database size={15} />} label="Data Sources">
          <TreeItem icon={<FileJson size={14} />} label="sample-match.json" meta="local" />
        </TreeGroup>
        <TreeGroup icon={<ListVideo size={15} />} label="Rundowns">
          <TreeItem icon={<ListVideo size={14} />} label="Match Day Rundown" meta="placeholder" />
        </TreeGroup>
      </div>
      </CollapsiblePanel>
    </aside>
  );
}

function TreeGroup(props: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <CollapsibleSection title={props.label} icon={props.icon}>
      <div className="tree-group-items">{props.children}</div>
    </CollapsibleSection>
  );
}

function TreeItem(props: { icon: ReactNode; label: string; meta?: string; active?: boolean }) {
  return (
    <div className={`tree-item ${props.active ? "active" : ""}`}>
      {props.icon}
      <span>{props.label}</span>
      {props.meta ? <em>{props.meta}</em> : null}
    </div>
  );
}
