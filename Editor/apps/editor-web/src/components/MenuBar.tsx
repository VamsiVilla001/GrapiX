import { useEffect, useRef, useState } from "react";
import { publishSavedSceneOnApi, saveSceneToApi } from "../lib/apiClient";
import { captureParityFrame } from "../rendering/parityCapture";
import { useDockStore, type DockPanelId } from "../store/dockStore";
import { useEditorStore, type LibraryObjectKind } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { ProjectViewportDialog } from "./ProjectViewportDialog";
import { ImportDesignDialog } from "./ImportDesignDialog";
import { OpenSceneDialog } from "./OpenSceneDialog";
import { PublishToPlayoutDialog } from "./PublishToPlayoutDialog";

interface MenuItem {
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * Viz Artist / XPression–style application menu bar. Menus mirror Viz Artist's
 * structure (File / Edit / Insert / Windows / Project / Display / Animation /
 * Help). Every item is wired to a real action through visible controls.
 */
export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [viewportDialogOpen, setViewportDialogOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [designImportOpen, setDesignImportOpen] = useState(false);
  const [openSceneOpen, setOpenSceneOpen] = useState(false);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const setSaveStatus = useEditorStore((state) => state.setSaveStatus);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const canUndo = useEditorStore((state) => state.undoStack.length > 0);
  const canRedo = useEditorStore((state) => state.redoStack.length > 0);
  const loadScene = useEditorStore((state) => state.loadScene);
  const deleteSelectedObject = useEditorStore((state) => state.deleteSelectedObject);
  const duplicateSelectedObject = useEditorStore((state) => state.duplicateSelectedObject);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const addLibraryObject = useEditorStore((state) => state.addLibraryObject);
  const refreshAssetAvailability = useEditorStore((state) => state.refreshAssetAvailability);
  const addNewTemplate = useTemplateStore((state) => state.addNewTemplate);
  const templates = useTemplateStore((state) => state.templates);

  const resetDockLayout = useDockStore((state) => state.resetDockLayout);
  const activatePanel = useDockStore((state) => state.activatePanel);

  const setActiveTool = useUiStore((state) => state.setActiveTool);
  const setPenTarget = useUiStore((state) => state.setPenTarget);
  const snapping = useUiStore((state) => state.snapping);
  const toggleSnapping = useUiStore((state) => state.toggleSnapping);
  const toggleTimelinePlayback = useUiStore((state) => state.toggleTimelinePlayback);

  async function save() {
    if (!hasActiveScene) return;
    try {
      setSaveStatus("saving");
      await saveSceneToApi(scene);
      setSaveStatus("saved");
    } catch (error) {
      setSaveStatus("error", error instanceof Error ? error.message : "Save failed");
    }
  }

  async function publish() {
    if (!hasActiveScene) return;
    try {
      await saveSceneToApi(scene);
      const result = await publishSavedSceneOnApi(scene.id);
      window.alert(result.package ? `Published ${result.package.fileName}` : "Publish blocked by preflight.");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Publish failed");
    }
  }


  /**
   * Save the viewport as a lossless PNG for pixel-parity comparison.
   *
   * Says where to put the file rather than assuming: a browser can only write to the
   * download directory, and the harness reads from the repository.
   */
  async function captureParity() {
    if (!hasActiveScene) return;
    const captured = await captureParityFrame();
    window.alert(
      captured
        ? [
            `Saved ${captured.fileName} (${captured.width}x${captured.height}).`,
            "",
            "Move it into artifacts/pixel-parity/browser/ and run:",
            "  npm run certify:parity"
          ].join(String.fromCharCode(10))
        : "The viewport could not be read back, so no capture was saved."
    );
  }

  function newScene() {
    if (hasActiveScene && !window.confirm("Start a new scene template? Unsaved changes are lost.")) {
      return;
    }

    const template = addNewTemplate();
    loadScene(template.scene);
  }

  const insert = (kind: LibraryObjectKind) => () => {
    if (hasActiveScene) addLibraryObject(kind);
  };
  const showPanel = (panelId: DockPanelId) => () => activatePanel(panelId);
  const chooseTool = (tool: "select" | "move" | "rotate" | "scale" | "pivot" | "pen") => {
    setPenTarget("shape");
    setActiveTool(tool);
  };

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!barRef.current?.contains(event.target as Node)) setOpen(null);
    }
    function onEsc(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, []);

  const menus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "Project Settings…", onSelect: () => setProjectSettingsOpen(true) },
        { separator: true },
        { label: "New Scene…", onSelect: newScene },
        { label: "Open Scene…", onSelect: () => setOpenSceneOpen(true) },
        { label: "Import Design File…", onSelect: () => setDesignImportOpen(true) },
        { separator: true },
        { label: "Save", disabled: !hasActiveScene, onSelect: () => void save() },
        { label: "Publish to Playout…", disabled: templates.length === 0, onSelect: () => setPublishDialogOpen(true) },
        { label: "Export Package…", disabled: !hasActiveScene, onSelect: () => void publish() },
        { separator: true },
        { label: "Reload", onSelect: () => window.location.reload() },
        { label: "Exit", onSelect: () => window.close() }
      ]
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", disabled: !canUndo, onSelect: undo },
        { label: "Redo", disabled: !canRedo, onSelect: redo },
        { separator: true },
        { label: "Select Tool", onSelect: () => chooseTool("select") },
        { label: "Move Tool", onSelect: () => chooseTool("move") },
        { label: "Rotate Tool", onSelect: () => chooseTool("rotate") },
        { label: "Scale Tool", onSelect: () => chooseTool("scale") },
        { label: "Pivot Tool", onSelect: () => chooseTool("pivot") },
        { label: "Pen Tool", onSelect: () => chooseTool("pen") },
        { separator: true },
        { label: "Duplicate", disabled: !selectedObjectId, onSelect: duplicateSelectedObject },
        { label: "Delete Selected", disabled: !selectedObjectId, danger: true, onSelect: deleteSelectedObject }
      ]
    },
    {
      label: "Insert",
      items: [
        { label: "Text", disabled: !hasActiveScene, onSelect: insert("text") },
        { label: "Quad", disabled: !hasActiveScene, onSelect: insert("quad") },
        { label: "Shape (Pen)", disabled: !hasActiveScene, onSelect: insert("shape") },
        { label: "Sphere", disabled: !hasActiveScene, onSelect: insert("sphere") },
        { label: "Cube", disabled: !hasActiveScene, onSelect: insert("cube") },
        { label: "Cylinder", disabled: !hasActiveScene, onSelect: insert("cylinder") },
        { separator: true },
        { label: "Camera", disabled: !hasActiveScene, onSelect: insert("perspective-camera") },
        { label: "Directional Light", disabled: !hasActiveScene, onSelect: insert("directional-light") }
      ]
    },
    {
      label: "Windows",
      items: [
        { label: "Reset Docking Layout", onSelect: resetDockLayout },
        { separator: true },
        { label: "Snapping", checked: snapping, onSelect: toggleSnapping }
      ]
    },
    {
      label: "Project",
      items: [
        { label: "Project Settings…", onSelect: () => setProjectSettingsOpen(true) },
        { separator: true },
        { label: "New Scene…", onSelect: newScene },
        { label: "Import PSD, AI or Figma…", onSelect: () => setDesignImportOpen(true) },
        { label: "Refresh Assets", disabled: !hasActiveScene, onSelect: () => void refreshAssetAvailability() },
        { label: "Viewport Rulers & Margins…", disabled: !hasActiveScene, onSelect: () => setViewportDialogOpen(true) },
        { separator: true },
        { label: "Export Package…", disabled: !hasActiveScene, onSelect: () => void publish() }
      ]
    },
    {
      label: "Display",
      items: [
        { label: "Object Library", onSelect: showPanel("object-library") },
        { label: "Object Manager", onSelect: showPanel("scene-manager") },
        { label: "Object Inspector", onSelect: showPanel("object-inspector") },
        { label: "Material Manager", onSelect: showPanel("material-manager") },
        { label: "Font Manager", onSelect: showPanel("font-manager") },
        { label: "Scene Automation", onSelect: showPanel("automation") },
        { label: "Templates", onSelect: showPanel("templates") },
        { label: "Timeline", onSelect: showPanel("timeline") },
        { label: "Sequencer", onSelect: showPanel("sequencer") }
      ]
    },
    {
      label: "Animation",
      items: [
        { label: "Timeline", onSelect: showPanel("timeline") },
        { label: "Sequencer", onSelect: showPanel("sequencer") },
        { label: "Play / Pause", disabled: !hasActiveScene, onSelect: toggleTimelinePlayback }
      ]
    },
    {
      label: "Help",
      items: [
        { label: "About GrapiX", onSelect: () => window.alert("GrapiX — broadcast graphics editor\nTauri 2 + WebView2 · PixiJS renderer.") }
      ]
    }
  ];

  return (
    <>
    <div className="menu-bar" ref={barRef}>
      {menus.map((menu) => (
        <div className="menu-root" key={menu.label}>
          <button
            className={`menu-label ${open === menu.label ? "active" : ""}`}
            onClick={() => setOpen((current) => (current === menu.label ? null : menu.label))}
            onPointerEnter={() => setOpen((current) => (current ? menu.label : current))}
          >
            {menu.label}
          </button>
          {open === menu.label ? (
            <div className="menu-dropdown" role="menu">
              {menu.items.map((item, index) =>
                item.separator ? (
                  <div className="menu-sep" key={index} />
                ) : (
                  <button
                    key={index}
                    className={`menu-item ${item.danger ? "danger" : ""}`}
                    disabled={item.disabled}
                    role="menuitem"
                    onClick={() => { item.onSelect?.(); setOpen(null); }}
                  >
                    <span className="menu-check">{item.checked ? "✓" : ""}</span>
                    <span className="menu-item-label">{item.label}</span>
                  </button>
                )
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
    {projectSettingsOpen ? <ProjectSettingsDialog onClose={() => setProjectSettingsOpen(false)} /> : null}
    {viewportDialogOpen ? <ProjectViewportDialog onClose={() => setViewportDialogOpen(false)} /> : null}
    {designImportOpen ? <ImportDesignDialog onClose={() => setDesignImportOpen(false)} /> : null}
    {openSceneOpen ? <OpenSceneDialog onClose={() => setOpenSceneOpen(false)} /> : null}
    {publishDialogOpen ? <PublishToPlayoutDialog onClose={() => setPublishDialogOpen(false)} /> : null}
    </>
  );
}
