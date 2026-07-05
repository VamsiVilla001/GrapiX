import {
  Cloud,
  Download,
  FileCheck2,
  FileJson,
  PackageCheck,
  RotateCcw,
  Upload
} from "lucide-react";
import { preflightScenePackage } from "@grapix/shared-types";
import { useEffect, useRef, useState } from "react";
import {
  getApiHealth,
  preflightSceneOnApi,
  publishSceneOnApi,
  saveSceneToApi
} from "../lib/apiClient";
import { downloadScene, readSceneFile } from "../lib/files";
import { publishScenePackage, summarizePreflight } from "../lib/packagePublisher";
import { useEditorStore } from "../store/editorStore";

export function TopBar() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const scene = useEditorStore((state) => state.scene);
  const setSceneName = useEditorStore((state) => state.setSceneName);
  const loadScene = useEditorStore((state) => state.loadScene);
  const resetScene = useEditorStore((state) => state.resetScene);

  useEffect(() => {
    let active = true;

    getApiHealth()
      .then(() => {
        if (active) {
          setApiOnline(true);
        }
      })
      .catch(() => {
        if (active) {
          setApiOnline(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="topbar">
      <div className="brand-block">
        <div className="brand-mark">GX</div>
        <div>
          <div className="brand-title">GrapiX</div>
          <div className="brand-subtitle">Editor MVP</div>
        </div>
      </div>

      <label className="scene-name">
        <FileJson size={16} aria-hidden="true" />
        <input
          value={scene.name}
          onChange={(event) => setSceneName(event.target.value)}
          aria-label="Scene name"
        />
      </label>

      <div className="topbar-actions">
        <div className={`api-status ${apiOnline ? "online" : "offline"}`} title="Backend API status">
          API
        </div>
        <button className="icon-button" onClick={() => downloadScene(scene)} title="Save scene JSON">
          <Download size={18} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          onClick={async () => {
            try {
              const savedScene = await saveSceneToApi(scene);
              setApiOnline(true);
              window.alert(`Saved to backend: ${savedScene.name}`);
            } catch (error) {
              setApiOnline(false);
              window.alert(error instanceof Error ? error.message : "Backend save failed.");
            }
          }}
          title="Save scene to backend"
        >
          <Cloud size={18} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          onClick={async () => {
            try {
              const preflight = await preflightSceneOnApi(scene);
              setApiOnline(true);
              window.alert(summarizePreflight(preflight));
            } catch {
              setApiOnline(false);
              window.alert(summarizePreflight(preflightScenePackage(scene)));
            }
          }}
          title="Run backend package preflight"
        >
          <FileCheck2 size={18} aria-hidden="true" />
        </button>
        <button
          className="icon-button primary"
          onClick={async () => {
            try {
              const result = await publishSceneOnApi(scene);
              setApiOnline(true);

              if (result.package) {
                window.alert(`Published on backend: ${result.package.fileName}`);
                return;
              }

              window.alert(summarizePreflight(result.preflight));
            } catch {
              setApiOnline(false);
              const result = await publishScenePackage(scene);
              if (!result.published) {
                window.alert(summarizePreflight(result.preflight));
              }
            }
          }}
          title="Publish .gfxpkg through backend"
        >
          <PackageCheck size={18} aria-hidden="true" />
        </button>
        <button className="icon-button" onClick={() => inputRef.current?.click()} title="Load scene JSON">
          <Upload size={18} aria-hidden="true" />
        </button>
        <button className="icon-button" onClick={resetScene} title="Reset scene">
          <RotateCcw size={18} aria-hidden="true" />
        </button>
      </div>

      <input
        ref={inputRef}
        className="hidden-input"
        type="file"
        accept="application/json,.json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }

          loadScene(await readSceneFile(file));
          event.target.value = "";
        }}
      />
    </header>
  );
}
