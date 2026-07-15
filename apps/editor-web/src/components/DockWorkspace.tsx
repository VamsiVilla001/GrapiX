import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, GripHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { type DockAreaId, type DockPanelId, type DockStack, useDockStore } from "../store/dockStore";

const dockLabels: Record<DockAreaId, string> = {
  left: "Left",
  right: "Right",
  bottom: "Bottom"
};

export function DockArea(props: {
  areaId: DockAreaId;
  childrenForPanel: (panelId: DockPanelId) => ReactNode;
}) {
  const stacks = useDockStore((state) => state.areas[props.areaId]);
  const movePanelToArea = useDockStore((state) => state.movePanelToArea);
  const orientation = props.areaId === "bottom" ? "horizontal" : "vertical";

  return (
    <section
      className={`dock-area dock-area-${props.areaId}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const panelId = event.dataTransfer.getData("application/x-grapix-dock-panel") as DockPanelId;

        if (panelId) {
          movePanelToArea(panelId, props.areaId);
        }
      }}
    >
      {stacks.length === 0 ? <div className="dock-empty">Drop panel here</div> : null}
      {stacks.length > 0 ? (
        <Group className="dock-panel-group" orientation={orientation}>
          {stacks.flatMap((stack, index) => {
            const dockedItems: ReactNode[] = [];

            if (index > 0) {
              dockedItems.push(
                <Separator
                  className={`dock-resize-handle ${
                    orientation === "horizontal" ? "dock-resize-handle-vertical" : "dock-resize-handle-horizontal"
                  }`}
                  key={`${stack.id}-separator`}
                />
              );
            }

            dockedItems.push(
              <Panel id={`${props.areaId}-${stack.id}`} key={stack.id} minSize={12}>
                <DockStackPanel
                  areaId={props.areaId}
                  childrenForPanel={props.childrenForPanel}
                  stack={stack}
                />
              </Panel>
            );

            return dockedItems;
          })}
        </Group>
      ) : null}
    </section>
  );
}

function DockStackPanel(props: {
  areaId: DockAreaId;
  stack: DockStack;
  childrenForPanel: (panelId: DockPanelId) => ReactNode;
}) {
  const movePanelToArea = useDockStore((state) => state.movePanelToArea);
  const movePanelToStack = useDockStore((state) => state.movePanelToStack);
  const setActivePanel = useDockStore((state) => state.setActivePanel);
  const activePanelId = props.stack.panels.includes(props.stack.activePanelId)
    ? props.stack.activePanelId
    : props.stack.panels[0];
  const title = titleForPanel(activePanelId);

  return (
    <article
      className="dockable-panel"
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        const panelId = event.dataTransfer.getData("application/x-grapix-dock-panel") as DockPanelId;

        if (panelId) {
          event.stopPropagation();
          movePanelToStack(panelId, props.areaId, props.stack.id);
        }
      }}
    >
      <header
        className="dockable-panel-header"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-grapix-dock-panel", activePanelId);
          event.dataTransfer.effectAllowed = "move";
        }}
        title={`Drag ${title}`}
      >
        <span className="dock-grip"><GripHorizontal size={15} /></span>
        <strong>{title}</strong>
        <div className="dock-actions" aria-label={`${title} dock controls`}>
          <button disabled={props.areaId === "left"} onClick={() => movePanelToArea(activePanelId, "left")} title={`Dock ${dockLabels.left}`}>
            <ArrowLeftToLine size={14} />
          </button>
          <button disabled={props.areaId === "bottom"} onClick={() => movePanelToArea(activePanelId, "bottom")} title={`Dock ${dockLabels.bottom}`}>
            <ArrowDownToLine size={14} />
          </button>
          <button disabled={props.areaId === "right"} onClick={() => movePanelToArea(activePanelId, "right")} title={`Dock ${dockLabels.right}`}>
            <ArrowRightToLine size={14} />
          </button>
        </div>
      </header>
      <div className="dock-tab-strip" role="tablist" aria-label={`${dockLabels[props.areaId]} dock tabs`}>
        {props.stack.panels.map((panelId, index) => (
          <button
            aria-selected={panelId === activePanelId}
            className={`dock-tab ${panelId === activePanelId ? "active" : ""}`}
            draggable
            key={panelId}
            onClick={() => setActivePanel(props.areaId, props.stack.id, panelId)}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-grapix-dock-panel", panelId);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDrop={(event) => {
              const draggedPanelId = event.dataTransfer.getData("application/x-grapix-dock-panel") as DockPanelId;

              if (draggedPanelId) {
                event.stopPropagation();
                movePanelToStack(draggedPanelId, props.areaId, props.stack.id, index);
              }
            }}
            role="tab"
            title={titleForPanel(panelId)}
          >
            {titleForPanel(panelId)}
          </button>
        ))}
      </div>
      <div className="dockable-panel-body" role="tabpanel">
        {props.childrenForPanel(activePanelId)}
      </div>
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
    case "material-manager":
      return "Material Manager";
    case "timeline":
      return "Timeline";
  }
}
