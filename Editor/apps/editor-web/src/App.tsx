import { useEffect, useRef, useState } from "react";
import { CanvasStage } from "./components/CanvasStage";
import { AutomationPanel } from "./components/AutomationPanel";
import { AeControlsPanel } from "./components/AeControlsPanel";
import { RenderEnginePanel } from "./components/RenderEnginePanel";
import { DockWorkspace } from "./components/DockWorkspace";
import { MenuBar } from "./components/MenuBar";
import { FontManagerPanel } from "./components/FontManagerPanel";
import { ObjectLibrary } from "./components/ObjectLibrary";
import { ReferenceTopBar } from "./components/ReferenceTopBar";
import { ObjectManager } from "./components/ObjectManager";
import { ObjectInspector } from "./modules/object-inspector/components/ObjectInspector";
import { StatusBar } from "./components/StatusBar";
import { TemplatesPanel } from "./components/TemplatesPanel";
import { TimelinePanel } from "./components/TimelinePanel";
import { MaterialManagerPanel } from "./modules/material-manager";
import { useSceneFonts } from "./hooks/useSceneFonts";
import { saveSceneWithProjectPrompt } from "./lib/ensureProject";
import { isSaveShortcut, resolveHistoryIntent } from "./lib/historyShortcut";
import type { DockPanelId } from "./store/dockStore";
import { useEditorStore } from "./store/editorStore";
import { useTemplateStore } from "./store/templateStore";
import { AssistantPanel } from "./components/AssistantPanel";
import { useAssistantStore } from "./store/assistantStore";
import { DiagnosticsConsole } from "./components/DiagnosticsConsole";
import { LoginScreen } from "./components/LoginScreen";
import { onAuthChange, currentUser, type SignedInUser } from "./lib/auth";

export function App() {
  // Sign-in gates the whole workspace. The gate lives outside the editor body so that no
  // scene, autosave or engine connection exists before there is a verified user to own it -
  // an author who has not signed in has nothing to author with.
  const [user, setUser] = useState<SignedInUser | null>(() => currentUser());
  useEffect(() => onAuthChange(setUser), []);
  if (!user) return <LoginScreen />;
  return <EditorWorkspace />;
}

function EditorWorkspace() {
  // Autosave is started once at bootstrap in `main.tsx`, not mounted here: it must outlive
  // any component and must not be re-armed by a re-render.
  useSceneFonts();
  // The console drawer: opened from the status-bar chip, the View menu, or Ctrl+Alt+C.
  const [consoleOpen, setConsoleOpen] = useState(false);
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
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setConsoleOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    const onToggleConsole = () => setConsoleOpen((current) => !current);
    window.addEventListener("grapix:toggle-console", onToggleConsole);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("grapix:toggle-console", onToggleConsole);
    };
  }, []);

  /**
   * Ctrl+S / Cmd+S saves, and asks where the project lives the first time.
   *
   * On `window` and without the text-entry refusal `resolveHistoryIntent` makes for undo. Save is a
   * document command, not a field command: an author who has just typed a headline and hits Ctrl+S
   * means save the scene, and no text input has a competing meaning for it. Every other editor they
   * use behaves this way.
   *
   * `preventDefault` runs before any of our own conditions, including "is a scene open". If it did
   * not, a Ctrl+S with an empty editor would open the browser's Save Page dialog — in the desktop
   * shell that is a WebView2 file picker offering to save the application's own HTML, which is a
   * confusing thing to hand someone who asked to save their work.
   *
   * Bare Ctrl+S only. Ctrl+Shift+S is Save As, which does not exist yet, and swallowing it would
   * make a real command look implemented while doing nothing.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      void saveSceneWithProjectPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) for the open scene's history.
   *
   * On `window`, because undo is not a panel's command — every module edits one `SceneDocument` and
   * there is one history over it, so the key has to work wherever the author's hands are. What keeps
   * that from crossing panel ownership the way a global Delete would is that undo is not
   * destructive-in-place: it takes the document back a step, whichever panel made that step, and the
   * menu and each panel's control name the step so nothing is reverted silently.
   *
   * Two refusals live in `resolveHistoryIntent`: a text-entry target keeps the browser's own text
   * undo, and an Alt chord belongs to the assistant and the console above.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const intent = resolveHistoryIntent(event);
      if (!intent) return;
      event.preventDefault();
      const store = useEditorStore.getState();
      if (intent === "undo") store.undo();
      else store.redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell reference-editor-shell">
      <MenuBar />
      <ReferenceTopBar />
      {/*
        One free-form dock for the whole workspace. The viewport is a panel inside it rather than a
        fixed centre column, which is what lets an author split against it, float a panel over it,
        or move it to a second monitor.
      */}
      <DockWorkspace childrenForPanel={renderDockPanel} viewport={<CanvasStage />} />
      <StatusBar />
      <DiagnosticsConsole open={consoleOpen} onClose={() => setConsoleOpen(false)} />
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
    case "ae-controls":
      return <AeControlsPanel />;
    case "automation":
      return <AutomationPanel />;
    case "render-engine":
      return <RenderEnginePanel />;
    case "timeline":
      return <TimelinePanel />;
  }
}
