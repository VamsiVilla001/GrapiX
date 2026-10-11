import { useEffect } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { CanvasStage } from "./components/CanvasStage";
import { DesignImportPanel } from "./components/DesignImportPanel";
import { DockArea } from "./components/DockWorkspace";
import { ProfileLauncher } from "./components/ProfileLauncher";
import { PropertiesSidebar } from "./components/PropertiesSidebar";
import { ReferenceTopBar } from "./components/ReferenceTopBar";
import { SceneManager } from "./components/SceneManager";
import { StatusBar } from "./components/StatusBar";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { useSceneAutosave } from "./hooks/useSceneAutosave";
import { useDockStore, type DockPanelId } from "./store/dockStore";
import { useProfileStore } from "./store/profileStore";

/**
 * GrapiX launches into the profile picker. The workspace only mounts once a profile is
 * active, because the profile carries the layout and the importer credentials.
 */
export function App() {
  const activeProfile = useProfileStore((state) => state.activeProfile);

  if (!activeProfile) {
    return <ProfileLauncher />;
  }

  return <Workspace />;
}

function Workspace() {
  const activeProfile = useProfileStore((state) => state.activeProfile);
  const saveWorkspaceLayout = useProfileStore((state) => state.saveWorkspaceLayout);
  const applyProfileLayout = useDockStore((state) => state.applyProfileLayout);

  useSceneAutosave();

  const profileId = activeProfile?.profileId;

  useEffect(() => {
    // Seed the dock from the launched profile once, then let dockStore own it.
    applyProfileLayout(activeProfile?.workspaceLayout?.dock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, applyProfileLayout]);

  const panelSizes = activeProfile?.workspaceLayout?.panelSizes ?? {};

  const readLayout = (key: string, fallback: Layout): Layout =>
    (panelSizes[key] as Layout | undefined) ?? fallback;

  const saveLayout = (key: string, layout: Layout): void => {
    if (!activeProfile) {
      return;
    }

    saveWorkspaceLayout({
      dock: activeProfile.workspaceLayout?.dock ?? {},
      panelSizes: {
        ...panelSizes,
        [key]: layout as Record<string, number>
      }
    });
  };

  return (
    <div className="app-shell reference-editor-shell">
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
    case "design-import":
      return <DesignImportPanel />;
    case "scene-manager":
      return <SceneManager />;
    case "properties":
      return <PropertiesSidebar />;
    case "timeline":
      return <TimelinePanel />;
  }
}
