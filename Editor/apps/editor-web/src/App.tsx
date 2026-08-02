import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { useEffect, useRef } from "react";
import { CanvasStage } from "./components/CanvasStage";
import { AutomationPanel } from "./components/AutomationPanel";
import { RenderEnginePanel } from "./components/RenderEnginePanel";
import { DockArea } from "./components/DockWorkspace";
import { MenuBar } from "./components/MenuBar";
import { FontManagerPanel } from "./components/FontManagerPanel";
import { ObjectLibrary } from "./components/ObjectLibrary";
import { ReferenceTopBar } from "./components/ReferenceTopBar";
import { ObjectManager } from "./components/ObjectManager";
import { ObjectInspector } from "./modules/object-inspector/components/ObjectInspector";
import { SequencerPanel } from "./components/SequencerPanel";
import { StatusBar } from "./components/StatusBar";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { MaterialManagerPanel } from "./modules/material-manager";
import { useSceneAutosave } from "./hooks/useSceneAutosave";
import { useSceneFonts } from "./hooks/useSceneFonts";
import type { DockPanelId } from "./store/dockStore";
import { useEditorStore } from "./store/editorStore";
import { useTemplateStore } from "./store/templateStore";
import { AssistantPanel } from "./components/AssistantPanel";
import { useAssistantStore } from "./store/assistantStore";

export function App() {
  useSceneAutosave();
  useSceneFonts();
  const scene = useEditorStore((state) => state.scene);
  const openedTemplateId = useTemplateStore((state) => state.openedTemplateId);
  const selectedTemplate = useTemplateStore((state) =>
    state.templates.find((template) => template.templateId === state.selectedTemplateId) ?? null
  );
  const openTemplateEditor = useTemplateStore((state) => state.openTemplateEditor);
  const updateTemplateScene = useTemplateStore((state) => state.updateTemplateScene);
  const sceneId = useEditorStore((state) => state.scene.id);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const refreshAssetAvailability = useEditorStore((state) => state.refreshAssetAvailability);
  const loadScene = useEditorStore((state) => state.loadScene);
  const restoredInitialTemplate = useRef(false);

  // Restore the selected template after a desktop/web restart. The catalogue is persistent,
  // but the editor store is intentionally transient; without this hand-off Object Manager,
  // Timeline and every animation stopwatch opened against an empty placeholder scene.
  useEffect(() => {
    if (restoredInitialTemplate.current) return;
    restoredInitialTemplate.current = true;
    if (hasActiveScene || !selectedTemplate) return;
    openTemplateEditor(selectedTemplate.templateId);
    loadScene(selectedTemplate.scene);
  }, [hasActiveScene, loadScene, openTemplateEditor, selectedTemplate]);

  useEffect(() => {
    if (!hasActiveScene) return;
    void refreshAssetAvailability();
  }, [hasActiveScene, refreshAssetAvailability, sceneId]);

  // The template catalogue must track the editor even when its dock panel is hidden.
  // Keeping this effect in TemplatesPanel made the stored scene stale as soon as the user
  // switched panels, which then published different content from the viewport.
  useEffect(() => {
    if (!hasActiveScene || !openedTemplateId) return;
    updateTemplateScene(openedTemplateId, scene);
  }, [hasActiveScene, openedTemplateId, scene, updateTemplateScene]);

  // Ctrl+Alt+A toggles the assistant dock, matching the Ctrl+Alt+P parity-capture chord.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        useAssistantStore.getState().toggleOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell reference-editor-shell">
      <MenuBar />
      <ReferenceTopBar />
      <Group
        className="reference-main-layout"
        defaultLayout={readLayout("grapix-reference-main-v2", { left: 18, center: 52, right: 30 })}
        id="grapix-reference-main-v2"
        onLayoutChanged={(layout) => saveLayout("grapix-reference-main-v2", layout)}
        orientation="horizontal"
      >
        <Panel id="left" minSize="15%" maxSize="28%">
          <div className="reference-left-area">
            <DockArea areaId="left" childrenForPanel={renderDockPanel} />
          </div>
        </Panel>
        <Separator className="panel-resize-handle panel-resize-handle-vertical" />
        <Panel id="center" minSize="42%">
          <Group
            className="reference-center-layout"
            defaultLayout={readLayout("grapix-reference-center-v2", { upper: 62, timeline: 38 })}
            id="grapix-reference-center-v2"
            onLayoutChanged={(layout) => saveLayout("grapix-reference-center-v2", layout)}
            orientation="vertical"
          >
            <Panel id="upper" minSize="38%">
              <main className="viewport-column">
                <CanvasStage />
              </main>
            </Panel>
            <Separator className="panel-resize-handle panel-resize-handle-horizontal" />
            <Panel id="timeline" minSize="18%" maxSize="48%">
              <DockArea areaId="bottom" childrenForPanel={renderDockPanel} />
            </Panel>
          </Group>
        </Panel>
        <Separator className="panel-resize-handle panel-resize-handle-vertical" />
        <Panel id="right" minSize="18%" maxSize="46%">
          <DockArea areaId="right" childrenForPanel={renderDockPanel} />
        </Panel>
      </Group>
      <StatusBar />
      <AssistantPanel />
    </div>
  );
}

function renderDockPanel(panelId: DockPanelId) {
  switch (panelId) {
    case "templates":
      return <TemplatesPanel />;
    case "object-library":
      return <ObjectLibrary />;
    case "scene-manager":
      return <ObjectManager />;
    case "object-inspector":
      return <ObjectInspector />;
    case "material-manager":
      return <MaterialManagerPanel />;
    case "font-manager":
      return <FontManagerPanel />;
    case "automation":
      return <AutomationPanel />;
    case "render-engine":
      return <RenderEnginePanel />;
    case "timeline":
      return <TimelinePanel />;
    case "sequencer":
      return <SequencerPanel />;
  }
}

function readLayout(key: string, fallback: Layout): Layout {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as Layout;
  } catch {
    return fallback;
  }
}

function saveLayout(key: string, layout: Layout): void {
  localStorage.setItem(key, JSON.stringify(layout));
}
