/**
 * The Editor workspace: one dockview grid holding the viewport and every tool panel.
 *
 * ## What this replaced, and why
 *
 * The previous workspace was three fixed regions — left, right, bottom — each holding stacks of
 * panels, with the viewport wedged in the middle as something the dock could not touch. A panel
 * could be moved between those three places with three buttons, and nowhere else. That is what made
 * the application feel rigid: not the framework, but a layout model with three slots in it.
 *
 * Here the workspace is a free grid. Any panel can be dragged against any edge of any other panel
 * to split it, dropped onto a panel to become a tab beside it, floated over the workspace, or torn
 * out into its own operating-system window. The viewport participates as a panel, so an author can
 * put the timeline above it, put two inspectors either side of it, or pop the viewport itself onto a
 * second monitor — which is the actual working arrangement in a gallery.
 *
 * ## Two behaviours that had to survive the change
 *
 * **History attribution.** Working inside a panel makes that panel the owner of the next history
 * step, so an untransacted mutation is still credited to the module that caused it. That was wired
 * on the old panel frame; it is wired here on each panel's content wrapper, on the capture phase,
 * so a panel's own handlers cannot swallow it first.
 *
 * **Per-module undo.** Every panel header carries undo/redo for the one document history. It drives
 * the shared stack — a private stack per panel would revert other panels' work — and names the step
 * with the module that made it. It is rendered as a dockview header action rather than inside each
 * panel, so it appears once per group, next to the tabs, exactly as before.
 */
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewHeaderActionsProps } from "dockview-react";
import { ExternalLink, Maximize2, Minimize2, PictureInPicture2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import {
  VIEWPORT_PANEL_ID,
  allDockPanels,
  buildDefaultLayout,
  readSavedDockLayout,
  saveDockLayout,
  useDockStore,
  type DockPanelId
} from "../store/dockStore";
import { useEditorStore } from "../store/editorStore";
import { HistoryControls } from "./HistoryControls";

/**
 * Panels that change nothing in the scene, so an undo control there would be a button about someone
 * else's work. The Render Engine panel is diagnostics and Templates manages the scene *catalogue*,
 * which is project state the scene history does not cover.
 */
const PANELS_WITHOUT_HISTORY: ReadonlySet<string> = new Set(["render-engine", "templates", VIEWPORT_PANEL_ID]);

/**
 * The per-group header controls: undo/redo for the active module, then layout actions.
 *
 * These are GrapiX's own buttons rather than dockview's tab context menu, because that menu is part
 * of dockview's paid module set — asking for it silently does nothing on a free build. Floating,
 * popping out and maximising are all core features, so they are driven straight through the api and
 * cost nothing.
 *
 * Reads the active panel from the group rather than taking it as a prop, because dockview renders
 * one of these per group and the active tab changes underneath it.
 */
function GroupHistoryActions(props: IDockviewHeaderActionsProps) {
  const activeId = props.activePanel?.id;
  const group = props.group;
  const isFloating = group.api.location.type === "floating";
  const isPopout = group.api.location.type === "popout";

  return (
    <div className="dock-header-actions">
      {activeId && !PANELS_WITHOUT_HISTORY.has(activeId) ? <HistoryControls compact /> : null}
      <div className="dock-layout-actions">
        {/* Maximise is a toggle: the same button restores, because a maximised group covers the
            control that would otherwise un-maximise it. */}
        <button
          onClick={() => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize())}
          title={group.api.isMaximized() ? "Restore panel size" : "Maximise panel"}
          type="button"
        >
          {group.api.isMaximized() ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        {/* Already floating or popped out: the useful action is coming back, not going further out. */}
        {isFloating || isPopout ? (
          <button onClick={() => group.api.moveTo({ position: "center" })} title="Dock back into the workspace" type="button">
            <PictureInPicture2 size={12} />
          </button>
        ) : (
          <>
            <button onClick={() => props.containerApi.addFloatingGroup(group)} title="Float this panel over the workspace" type="button">
              <PictureInPicture2 size={12} />
            </button>
            <button onClick={() => void props.containerApi.addPopoutGroup(group)} title="Move this panel to its own window" type="button">
              <ExternalLink size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function DockWorkspace(props: {
  childrenForPanel: (panelId: DockPanelId) => ReactNode;
  viewport: ReactNode;
}) {
  const setApi = useDockStore((state) => state.setApi);

  /*
   * The renderers read the current props through a ref.
   *
   * The map itself must be built exactly once: dockview looks a panel's renderer up by name on every
   * mount, and a map rebuilt each render would remount every panel — for the viewport that means
   * tearing down and recreating a WebGL context on an unrelated state change. Reading `props`
   * directly inside a `[]` memo would be a stale closure, and silencing the lint rule for it turns
   * the React Compiler off for this whole file, so the ref is both correct and cheaper.
   */
  const latest = useRef(props);
  latest.current = props;

  const components = useMemo(() => {
    const map: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
      [VIEWPORT_PANEL_ID]: () => <div className="dock-viewport-host">{latest.current.viewport}</div>
    };
    for (const panelId of allDockPanels) {
      map[panelId] = () => (
        <div
          className="dock-panel-body"
          // One wiring point credits every module's edits: a click, a drag or a key inside a panel
          // makes it the owner of the next history step. Capture phase, so the panel's own handlers
          // cannot swallow it first.
          onFocusCapture={() => useEditorStore.getState().setHistoryScope(panelId)}
          onPointerDownCapture={() => useEditorStore.getState().setHistoryScope(panelId)}
        >
          {latest.current.childrenForPanel(panelId)}
        </div>
      );
    }
    return map;
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      setApi(event.api);

      const saved = readSavedDockLayout();
      if (saved) {
        try {
          event.api.fromJSON(saved as never);
        } catch {
          // A layout saved by a build whose panels have since changed can fail to deserialise.
          // Falling back to the default beats presenting an empty workspace.
          event.api.clear();
          buildDefaultLayout(event.api);
        }
      } else {
        buildDefaultLayout(event.api);
      }

      // Saved after every mutation — a drag, a split, a float, a resize — so the arrangement an
      // author leaves is the one they return to.
      event.api.onDidLayoutChange(() => saveDockLayout(event.api.toJSON()));
    },
    [setApi]
  );

  return (
    <DockviewReact
      className="grapix-dock dockview-theme-abyss"
      components={components}
      // A floating panel stays reachable: unbounded, it can be dragged off-screen and lost.
      floatingGroupBounds="boundedWithinViewport"
      onReady={onReady}
      rightHeaderActionsComponent={GroupHistoryActions}
      // A panel dragged onto the very edge of the workspace splits the whole grid rather than the
      // group under the cursor, which is how an author moves a panel to "the far side".
      dndEdges={{ size: { value: 40, type: "pixels" }, activationSize: { value: 40, type: "pixels" } }}
      singleTabMode="fullwidth"
    />
  );
}
