import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, GripHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { type DockAreaId, type DockPanelId, useDockStore } from "../store/dockStore";

const dockLabels: Record<DockAreaId, string> = {
  left: "Left",
  right: "Right",
  bottom: "Bottom"
};

export function DockArea(props: {
  areaId: DockAreaId;
  childrenForPanel: (panelId: DockPanelId) => ReactNode;
}) {
  const panels = useDockStore((state) => state.areas[props.areaId]);
  const movePanel = useDockStore((state) => state.movePanel);
  const orientation = props.areaId === "bottom" ? "horizontal" : "vertical";

  return (
    <section
      className={`dock-area dock-area-${props.areaId}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const panelId = event.dataTransfer.getData("application/x-grapix-dock-panel") as DockPanelId;

        if (panelId) {
          movePanel(panelId, props.areaId);
        }
      }}
    >
      {panels.length === 0 ? <div className="dock-empty">Drop panel here</div> : null}
      {panels.length > 0 ? (
        <Group className="dock-panel-group" orientation={orientation}>
          {panels.flatMap((panelId, index) => {
            const dockedItems: ReactNode[] = [];

            if (index > 0) {
              dockedItems.push(
                <Separator
                  className={`dock-resize-handle ${
                    orientation === "horizontal" ? "dock-resize-handle-vertical" : "dock-resize-handle-horizontal"
                  }`}
                  key={`${panelId}-separator`}
                />
              );
            }

            dockedItems.push(
              <Panel id={`${props.areaId}-${panelId}`} key={panelId} minSize={12}>
                <DockablePanel areaId={props.areaId} panelId={panelId} title={titleForPanel(panelId)}>
                  {props.childrenForPanel(panelId)}
                </DockablePanel>
              </Panel>
            );

            return dockedItems;
          })}
        </Group>
      ) : null}
    </section>
  );
}

function DockablePanel(props: {
  areaId: DockAreaId;
  panelId: DockPanelId;
  title: string;
  children: ReactNode;
}) {
  const movePanel = useDockStore((state) => state.movePanel);

  return (
    <article className="dockable-panel">
      <header
        className="dockable-panel-header"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-grapix-dock-panel", props.panelId);
          event.dataTransfer.effectAllowed = "move";
        }}
        title={`Drag ${props.title}`}
      >
        <span className="dock-grip"><GripHorizontal size={15} /></span>
        <strong>{props.title}</strong>
        <div className="dock-actions" aria-label={`${props.title} dock controls`}>
          <button disabled={props.areaId === "left"} onClick={() => movePanel(props.panelId, "left")} title={`Dock ${dockLabels.left}`}>
            <ArrowLeftToLine size={14} />
          </button>
          <button disabled={props.areaId === "bottom"} onClick={() => movePanel(props.panelId, "bottom")} title={`Dock ${dockLabels.bottom}`}>
            <ArrowDownToLine size={14} />
          </button>
          <button disabled={props.areaId === "right"} onClick={() => movePanel(props.panelId, "right")} title={`Dock ${dockLabels.right}`}>
            <ArrowRightToLine size={14} />
          </button>
        </div>
      </header>
      <div className="dockable-panel-body">{props.children}</div>
    </article>
  );
}

function titleForPanel(panelId: DockPanelId): string {
  switch (panelId) {
    case "templates":
      return "Templates";
    case "object-library":
      return "Object Library";
    case "scene-manager":
      return "Scene Manager";
    case "properties":
      return "Properties";
    case "timeline":
      return "Timeline";
  }
}
