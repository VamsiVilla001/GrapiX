import { useEffect, type FocusEvent } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { CanvasStage } from "./components/CanvasStage";
import { DockArea } from "./components/DockWorkspace";
import { ObjectLibrary } from "./components/ObjectLibrary";
import { PropertiesSidebar } from "./components/PropertiesSidebar";
import { ReferenceTopBar } from "./components/ReferenceTopBar";
import { SceneManager } from "./components/SceneManager";
import { StatusBar } from "./components/StatusBar";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { useSceneAutosave } from "./hooks/useSceneAutosave";
import type { DockPanelId } from "./store/dockStore";
import { useEditorStore } from "./store/editorStore";

export function App() {
  useSceneAutosave();
  const beginHistoryTransaction = useEditorStore((state) => state.beginHistoryTransaction);
  const endHistoryTransaction = useEditorStore((state) => state.endHistoryTransaction);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) useEditorStore.getState().redo();
        else useEditorStore.getState().undo();
      } else if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        useEditorStore.getState().redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function fieldFocus(event: FocusEvent<HTMLDivElement>) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement) {
      beginHistoryTransaction("Edit Field");
    }
  }

  function fieldBlur(event: FocusEvent<HTMLDivElement>) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement) {
      endHistoryTransaction();
    }
  }

  return (
    <div className="app-shell reference-editor-shell" onFocusCapture={fieldFocus} onBlurCapture={fieldBlur}>
      <ReferenceTopBar />
      <Group
        className="reference-main-layout"
        defaultLayout={readLayout("grapix-reference-main-v1", { left: 19, center: 59, right: 22 })}
        id="grapix-reference-main-v1"
        onLayoutChanged={(layout) => saveLayout("grapix-reference-main-v1", layout)}
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
            defaultLayout={readLayout("grapix-reference-center-v1", { upper: 72, timeline: 28 })}
            id="grapix-reference-center-v1"
            onLayoutChanged={(layout) => saveLayout("grapix-reference-center-v1", layout)}
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
        <Panel id="right" minSize="18%" maxSize="30%">
          <DockArea areaId="right" childrenForPanel={renderDockPanel} />
        </Panel>
      </Group>
      <StatusBar />
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
      return <SceneManager />;
    case "properties":
      return <PropertiesSidebar />;
    case "timeline":
      return <TimelinePanel />;
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
