// The Editor shell's web layer (build plan 11.1).
//
// This file is wiring, deliberately. Every decision it could get wrong lives
// somewhere already tested:
//
//   - what a scene is, and whether one is valid: the Rust shell, which parses
//     through the same `parse_scene_document` the engine uses (invariant 45);
//   - how the scene is drawn: `Editor/src/viewport.ts`, tested headless;
//   - what a colour means: `Editor/src/color-policy.ts` and the contracts.
//
// What is left here is turning clicks into `invoke` calls and rendering the
// answers. In particular this layer never decides that an object "could not
// be drawn" quietly: `SceneViewport` collects reasons, and they are shown.

import type {
  AnimationSurface,
  ControlField,
  ControlValue,
  ObjectDeletion,
  ObjectDuplication,
  MotionPreset,
  SceneDocument,
  SceneEasing,
  SceneKeyframe,
  TextStyle,
  TakePage,
  TimelinePhase,
} from "@grapix/contracts";
import { presetBlocker } from "../src/motion-preset-browser";
import { SceneViewport } from "../src/viewport";
import { renderNode } from "../src/agent-surface";
import { objectManagerPanel } from "../src/object-manager";
import { inspectorPanel } from "../src/inspector";
import { fontManagerPanel, fontUsers } from "../src/font-manager";
import { materialManagerPanel, usersOf } from "../src/material-manager";
import { assetManagerPanel, assetUsers } from "../src/asset-manager";
import { textStylePanel, textStyleUsers } from "../src/text-style";
import {
  sceneManagerPanel,
  type ManagedScene,
} from "../src/scene-manager";
import {
  applyBindingEdit,
  bindingPanel,
  resolveSceneBindings,
  type BindingIssue,
} from "../src/bindings";
import {
  EMPTY_TAKE_PAGE_STATE,
  inputTypeFor,
  takePagePanel,
  valueForField,
  type TakePageState,
} from "../src/take-page";
import { controlContractPanel, type ControlProperty } from "../src/control-contract";
import {
  boundsFromDrag,
  buildViewportOverlay,
  hitTestOverlay,
  objectsInMarquee,
  renderViewportOverlay,
  scenePointFromClient,
  type OverlayBounds,
  type OverlayGuide,
  type OverlayPoint,
} from "../src/overlay";
import {
  baseValueOf,
  customBezierFromInputs,
  keyframeContextItems,
  keyframeForValue,
  keyframePanelModel,
  renderKeyframePanel,
  propertyLabel,
  toggleIntent,
  type KeyframePanelModel,
  type KeyframeRow,
} from "../src/keyframe-editor";
import { previewFrameAtElapsed, previewSceneAt } from "../src/preview-playback";
import {
  activate,
  activeSession,
  closeSession,
  emptyWorkspace,
  isRefused as isWorkspaceRefused,
  openSession,
  sceneTabs,
  MAX_HISTORY,
  type SceneSession,
} from "../src/workspace";
import { sizeCanvasForRatio, watchDevicePixelRatio } from "../src/dpi";
import { probeWebGpu, summariseGpuReport, type GpuReport } from "../src/gpu-probe";
import {
  allPanels,
  defaultLayout,
  isRefused as isLayoutRefused,
  movePanel,
  persistLayout,
  resizeRegion,
  restoreLayout,
  REGIONS,
  type Layout,
  type RegionId,
} from "../src/workspace-layout";
import { phaseAddress } from "../src/timeline/phases";
import { keyId, parseKeyId, timelineModel, type TimelineModel } from "../src/timeline/model";
import {
  isRefused as isKeyEditRefused,
  planCopy,
  planDelete,
  planMove,
  planPaste,
  snapFrame,
  SNAP_TOLERANCE_FRAMES,
  planSetEasing,
  type ClipboardKey,
  type EditPlan,
} from "../src/timeline/key-edit";
import { HIT_TOLERANCE_FRAMES, keyNear } from "../src/timeline/key-index";
import {
  paintLayer,
  renderTimelinePanel,
  visibleKeyCount,
  type DrawingContext,
} from "../src/timeline/panel";
import {
  planRepaint,
  type TimelineLayerId,
  type TimelineSnapshot,
} from "../src/timeline/repaint-plan";
import {
  clampViewport,
  DEFAULT_PIXELS_PER_FRAME,
  DEFAULT_ROW_HEIGHT,
  rowWindow,
  xToFrame,
  type TimelineViewport,
} from "../src/timeline/viewport";

/** Tauri v2's global bridge. Typed narrowly: this layer uses exactly one
 *  function from it, and pretending to know more would be fiction. */
interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  dialog?: {
    open(options?: Record<string, unknown>): Promise<string | string[] | null>;
    save(options?: Record<string, unknown>): Promise<string | null>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

/** What `cmd_publish` answers with. */
interface PublishResult {
  takeId: string | { 0: string };
  revision: number | { 0: number };
}

/** The shell's structured errors. Every variant carries enough to say what
 *  actually happened; a bare string would let a refusal read as a crash. */
interface ShellError {
  error: string;
  detail?: string;
  path?: string;
  endpoint?: string;
}

interface ListedScene {
  readonly sceneId: string;
  readonly name: string;
  readonly publishedRevision?: number;
  readonly unavailableReason?: string;
}

interface ProjectSceneCatalog {
  readonly project: string;
  readonly currentDesignSystemVersion?: number;
  readonly scenes: readonly ListedScene[];
}

interface ListedTakePage {
  readonly pageId: string;
  readonly name: string;
  readonly sceneId: string;
  readonly unavailableReason?: string;
}

interface ProjectTakePageCatalog {
  readonly project: string;
  readonly pages: readonly ListedTakePage[];
}

const tauri = window.__TAURI__;

// ---------------------------------------------------------------------------
// Element handles. Resolved once; a missing id is a build error, not a
// silently absent feature.
// ---------------------------------------------------------------------------

function need<T extends Element>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`the Editor markup is missing #${id}`);
  return element as T;
}

const ui = {
  curtain: need<HTMLDivElement>("not-in-shell"),
  sceneId: need<HTMLInputElement>("scene-id"),
  sceneName: need<HTMLInputElement>("scene-name"),
  newScene: need<HTMLButtonElement>("new-scene"),
  openScene: need<HTMLButtonElement>("open-scene"),
  saveScene: need<HTMLButtonElement>("save-scene"),
  projectSelect: need<HTMLSelectElement>("project-select"),
  projectCreate: need<HTMLButtonElement>("project-create"),
  projectRefresh: need<HTMLButtonElement>("project-refresh"),
  projectSaveScene: need<HTMLButtonElement>("project-save-scene"),
  sceneManagerMount: need<HTMLDivElement>("scene-manager-mount"),
  sceneManagerEmpty: need<HTMLParagraphElement>("scene-manager-empty"),
  canvas: need<HTMLCanvasElement>("viewport"),
  previewPlay: need<HTMLButtonElement>("preview-play"),
  previewStatus: need<HTMLSpanElement>("preview-status"),
  overlay: need<SVGSVGElement>("viewport-overlay"),
  sceneTabs: need<HTMLElement>("scene-tabs"),
  canvasSize: need<HTMLSpanElement>("canvas-size"),
  objectManager: need<HTMLDivElement>("object-manager"),
  objectKind: need<HTMLSelectElement>("object-kind"),
  objectCreate: need<HTMLButtonElement>("object-create"),
  objectDuplicate: need<HTMLButtonElement>("object-duplicate"),
  objectRename: need<HTMLButtonElement>("object-rename"),
  objectDelete: need<HTMLButtonElement>("object-delete"),
  bindings: need<HTMLDivElement>("bindings-mount"),
  controlMount: need<HTMLDivElement>("control-mount"),
  fontMount: need<HTMLDivElement>("font-mount"),
  fontEmpty: need<HTMLParagraphElement>("font-empty"),
  materialMount: need<HTMLDivElement>("material-mount"),
  textStyleMount: need<HTMLDivElement>("text-style-mount"),
  textStyleEmpty: need<HTMLParagraphElement>("text-style-empty"),
  materialEmpty: need<HTMLParagraphElement>("material-empty"),
  assetMount: need<HTMLDivElement>("asset-mount"),
  assetEmpty: need<HTMLParagraphElement>("asset-empty"),
  takePageId: need<HTMLInputElement>("take-page-id"),
  takePageName: need<HTMLInputElement>("take-page-name"),
  takePageMount: need<HTMLDivElement>("take-page-mount"),
  takePagePreview: need<HTMLButtonElement>("take-page-preview"),
  takePageSave: need<HTMLButtonElement>("take-page-save"),
  takePageSelect: need<HTMLSelectElement>("take-page-select"),
  takePageOpen: need<HTMLButtonElement>("take-page-open"),
  inspector: need<HTMLDivElement>("inspector-mount"),
  animationFrame: need<HTMLInputElement>("animation-frame"),
  autoKey: need<HTMLInputElement>("auto-key"),
  animationMount: need<HTMLDivElement>("animation-mount"),
  keyframeMenu: need<HTMLDivElement>("keyframe-context-menu"),
  timelineEasing: need<HTMLSelectElement>("timeline-easing"),
  timelinePreset: need<HTMLSelectElement>("timeline-preset"),
  timelinePresetApply: need<HTMLButtonElement>("timeline-preset-apply"),
  phaseKind: need<HTMLSelectElement>("phase-kind"),
  phaseSet: need<HTMLButtonElement>("phase-set"),
  phasePlay: need<HTMLButtonElement>("phase-play"),
  phaseRemove: need<HTMLButtonElement>("phase-remove"),
  undo: need<HTMLButtonElement>("undo"),
  redo: need<HTMLButtonElement>("redo"),
  objectEmpty: need<HTMLParagraphElement>("object-empty"),
  unsupportedPanel: need<HTMLElement>("unsupported-panel"),
  unsupportedList: need<HTMLUListElement>("unsupported-list"),
  endpoint: need<HTMLInputElement>("endpoint"),
  publish: need<HTMLButtonElement>("publish"),
  publishResult: need<HTMLDivElement>("publish-result"),
  log: need<HTMLUListElement>("log"),
  timelineMount: need<HTMLDivElement>("timeline-mount"),
  timelineMeta: need<HTMLSpanElement>("timeline-meta"),
  timelineZoom: need<HTMLInputElement>("timeline-zoom"),
  timelineGraphClose: need<HTMLButtonElement>("timeline-graph-close"),
};

// ---------------------------------------------------------------------------
// State. One open document, one viewport over it.
// ---------------------------------------------------------------------------

let scene: SceneDocument | null = null;
let viewport: SceneViewport | null = null;
let scenePath: string | null = null;
/** View state, deliberately not on the document: which rows the author has
 *  selected and which containers they have shut. A collapsed group is not a
 *  property of the scene, and saving it would make two authors' files differ
 *  over something neither would call an edit. */
let previewScene: SceneDocument | null = null;
let resolvedScene: SceneDocument | null = null;
let bindingPreviewIssues: string[] = [];
/** Every open scene. The session is the owner of record; the flat state below
 *  is the working copy of whichever one is active (11.29). */
const workspace = emptyWorkspace();
let selection: string[] = [];

/** The shell's authoring results. `ObjectDeletion` and `ObjectDuplication` are
 *  generated from Rust; the wrappers are the shell's own transport shape, which
 *  pairs the edited document with what the edit did. */
interface ObjectCreated {
  readonly scene: SceneDocument;
  readonly objectId: string;
}
interface ObjectDeleted {
  readonly scene: SceneDocument;
  readonly deletion: ObjectDeletion;
}
interface ObjectDuplicated {
  readonly scene: SceneDocument;
  readonly duplication: ObjectDuplication;
}
let projects: string[] = [];
let currentProject: string | undefined;
let projectCatalog: ProjectSceneCatalog | undefined;
/** Set only when the open document came from the selected project's store. */
let takePageCatalog: ProjectTakePageCatalog | undefined;
let projectSceneId: string | undefined;
let projectSceneProject: string | undefined;
let projectSceneDirty = false;

/** Selection an edit asked for, applied once the edited document is rendered.
 *  Set before `commitScene`, consumed by it: selecting against the old document
 *  would name an object that does not exist there yet. */
let pendingSelection: string[] | undefined;
let collapsed: string[] = [];
let selectedFontId: string | undefined;
let selectedMaterialId: string | undefined;
let selectedAssetId: string | undefined;
let takePageState: TakePageState = EMPTY_TAKE_PAGE_STATE;
let takePagePreviewDocument: SceneDocument | null = null;
let controlProperties: readonly ControlProperty[] | undefined;
let controlPropertiesKind: string | undefined;
let marquee: OverlayBounds | undefined;
let guides: OverlayGuide[] = [];
let animationSurface: AnimationSurface | null = null;
let currentFrame = 0;
let playback:
  | {
      readonly startFrame: number;
      /// Where this run stops: the scene's duration, or one phase's end.
      readonly stopFrame: number;
      readonly startTime: number;
      requestId: number;
      lastFrame: number;
      readonly renderTimes: number[];
      renderCount: number;
      totalRenderMs: number;
    }
  | undefined;

/** The WebGPU measurement from startup (11.2), kept so the probe result is
 *  readable from the running app rather than only in the log. */
let gpuReport: GpuReport | undefined;
let autoKey = false;
/** One-gesture-per-entry history over whole documents. Whole-scene snapshots
 *  are simple and correct: every edit already produces a new `SceneDocument`,
 *  and one undo restoring one prior document is exactly one gesture undone. */
let undoStack: SceneDocument[] = [];
let redoStack: SceneDocument[] = [];
let animationBusy = false;
let overlayDrag:
  | {
      readonly pointerId: number;
      readonly start: OverlayPoint;
      readonly startClient: OverlayPoint;
      readonly additive: boolean;
      moved: boolean;
    }
  | undefined;

// ---------------------------------------------------------------------------
// Logging. Append-only, newest first, and it records refusals as refusals.
// ---------------------------------------------------------------------------

type Outcome = "good" | "bad" | "plain";

function log(message: string, outcome: Outcome = "plain"): void {
  const entry = document.createElement("li");
  if (outcome !== "plain") entry.className = outcome;

  const when = document.createElement("span");
  when.className = "log-when";
  when.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });

  const what = document.createElement("span");
  what.className = "log-what";
  what.textContent = message;

  entry.append(when, what);
  ui.log.prepend(entry);

  // A log that grows without bound is a memory leak in a long authoring
  // session. The oldest lines are the least useful.
  while (ui.log.childElementCount > 200) ui.log.lastElementChild?.remove();
}

/** Turn a rejected `invoke` into one operator-facing line.
 *
 *  The shell's errors are structured, so the distinct cases stay distinct:
 *  an unreachable asset plane and a refused document are different problems
 *  and an author can only act differently on them if the message says which
 *  it was (invariant 17). */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const shell = error as ShellError;
    switch (shell.error) {
      case "readScene":
        return `cannot read ${shell.path ?? "the file"}: ${shell.detail ?? ""}`;
      case "writeScene":
        return `cannot write ${shell.path ?? "the file"}: ${shell.detail ?? ""}`;
      case "invalidScene":
        return `scene refused: ${shell.detail ?? ""}`;
      case "invalidEndpoint":
        return `${shell.endpoint ?? "endpoint"} is not a host:port address`;
      case "unreachable":
        return `asset plane unreachable at ${shell.endpoint ?? ""}: ${shell.detail ?? ""}`;
      case "publishRefused":
        return `publication refused: ${shell.detail ?? ""}`;
      case "animationRefused":
        return `animation refused: ${shell.detail ?? "the edit did not apply"}`;
      default:
        return `${shell.error}: ${shell.detail ?? ""}`;
    }
  }
  return String(error);
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauri) return Promise.reject(new Error("not running inside the Editor shell"));
  return tauri.core.invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Rendering the open document.
// ---------------------------------------------------------------------------

/** Unwrap a newtype that serde may emit either bare or as a tuple struct. */
function plain(value: unknown): string {
  if (value !== null && typeof value === "object" && "0" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)[0]);
  }
  return String(value);
}

/// Capture the author's place in the active scene before leaving it.
///
/// The globals below are the *working copy* of whatever session is active;
/// this writes them back so a switch loses nothing. Keeping the working copy
/// flat avoids rewriting two thousand lines of panel code to reach through a
/// session on every access, while the session remains the owner of record.
function captureActiveSession(): void {
  const session = activeSession(workspace);
  if (!session || !scene) return;
  session.document = scene;
  session.selection = selection;
  session.collapsed = collapsed;
  session.currentFrame = currentFrame;
  session.undoStack = undoStack;
  session.redoStack = redoStack;
  session.path = scenePath;
  session.takePage = takePageState;
  session.takePagePreview = takePagePreviewDocument;
  session.dirty = projectSceneDirty;
}

/// Make one open scene the one every panel renders.
function restoreSession(session: SceneSession): void {
  pausePreview("switched scene");
  scene = session.document;
  scenePath = session.path;
  selection = session.selection;
  collapsed = session.collapsed;
  currentFrame = session.currentFrame;
  undoStack = session.undoStack;
  redoStack = session.redoStack;
  projectSceneId = session.origin?.sceneId;
  projectSceneProject = session.origin?.project;
  projectSceneDirty = session.dirty;
  takePageState = session.takePage;
  takePagePreviewDocument = session.takePagePreview;
  if (session.origin) currentProject = session.origin.project;
  // Transient interaction state belongs to a gesture, not to a scene: a
  // marquee half-drawn in one graphic must not reappear over another.
  marquee = undefined;
  guides = [];
  selectedKeys = new Set();
  graphTrack = undefined;
  ui.timelineGraphClose.hidden = true;

  ui.sceneId.value = session.document.id;
  ui.sceneId.readOnly = session.origin !== undefined;
  ui.sceneId.title =
    session.origin === undefined
      ? ""
      : "Project scene ids are stable; use Duplicate to create a new id.";
  ui.sceneName.value = session.document.name;
  updateHistoryButtons();
  contentRevision += 1;
  renderSceneState();
}

/// Draw the scene switcher. One button per open scene, plus its own close.
function renderSceneTabs(): void {
  const tabs = sceneTabs(workspace);
  ui.sceneTabs.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = tab.active ? "scene-tab active" : "scene-tab";

    const open = document.createElement("button");
    open.type = "button";
    open.dataset.sceneKey = tab.key;
    open.dataset.sceneAction = "activate";
    open.textContent = tab.dirty ? `${tab.label} •` : tab.label;
    // The origin disambiguates two graphics that share a name in different
    // shows; an unbound scene says so rather than borrowing a project.
    open.title = tab.origin ?? "not saved to a project";
    open.setAttribute("aria-pressed", String(tab.active));
    if (tab.dirty) open.setAttribute("aria-description", "unsaved changes");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "scene-tab-close";
    close.dataset.sceneKey = tab.key;
    close.dataset.sceneAction = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.label}`);

    item.append(open, close);
    ui.sceneTabs.append(item);
  }
  ui.sceneTabs.hidden = tabs.length === 0;
}

function switchToScene(key: string): void {
  if (key === workspace.activeKey) return;
  captureActiveSession();
  const result = activate(workspace, key);
  if (isWorkspaceRefused(result)) {
    log(result.refused, "bad");
    return;
  }
  restoreSession(result);
  renderSceneTabs();
  log(`Switched to ${result.document.name}`, "good");
}

function closeScene(key: string): void {
  captureActiveSession();
  const session = workspace.sessions.find((candidate) => candidate.key === key);
  const result = closeSession(workspace, key);
  if (isWorkspaceRefused(result)) {
    // Offer the explicit confirmation rather than discarding the work; a tab
    // click must never be able to lose an edit on its own.
    const name = session?.document.name ?? "this scene";
    if (!window.confirm(`${name} has unsaved changes. Close it and lose them?`)) {
      log(result.refused, "bad");
      return;
    }
    const forced = closeSession(workspace, key, { force: true });
    if (isWorkspaceRefused(forced)) {
      log(forced.refused, "bad");
      return;
    }
    log(`Closed ${forced.document.name}, discarding unsaved changes`, "bad");
  } else {
    log(`Closed ${result.document.name}`, "good");
  }

  const next = activeSession(workspace);
  if (next) {
    restoreSession(next);
  } else {
    // Nothing open. Say so rather than leaving the last scene's pixels on
    // screen, which would show a graphic the author has closed.
    scene = null;
    previewScene = null;
    resolvedScene = null;
    selection = [];
    undoStack = [];
    redoStack = [];
    viewport?.dispose();
    viewport = null;
    ui.overlay.replaceChildren();
    updateHistoryButtons();
  }
  renderSceneTabs();
}

function onSceneTabsClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-scene-key][data-scene-action]");
  const key = button?.dataset.sceneKey;
  if (!key) return;
  if (button?.dataset.sceneAction === "close") closeScene(key);
  else switchToScene(key);
}

function showScene(
  next: SceneDocument,
  path: string | null,
  projectSource?: { readonly project: string; readonly sceneId: string },
): void {
  captureActiveSession();
  const session = openSession(workspace, next, {
    ...(projectSource === undefined ? {} : { origin: projectSource }),
    path,
  });
  // `openSession` reveals an already-open scene rather than duplicating it;
  // in that case the stored document is the author's in-progress one, and
  // overwriting it with what was just read from disk would discard their work.
  if (session.document !== next && !session.dirty) {
    session.document = next;
    session.path = path;
  }
  restoreSession(session);
  renderSceneTabs();
}

/** Resolve live data before constructing the preview.
 *
 * Binding does not belong inside Three.js: the renderer accepts one resolved
 * scene, just as a later engine-backed viewport will. An invalid binding
 * refuses the whole resolution rather than mixing new and stale values. */
function renderSceneState(): void {
  if (!scene) return;
  // An edit, undo, load or history change rebuilds the viewport's scene graph,
  // which invalidates the meshes the playback loop is mutating. Stop the clock
  // before the graph is torn down rather than let it write into disposed
  // objects.
  pausePreview("the document changed");
  ui.canvasSize.textContent = `${scene.canvas.width} × ${scene.canvas.height} @ ${scene.canvas.frameRate.num}/${scene.canvas.frameRate.den}`;
  ui.canvas.width = scene.canvas.width;
  ui.canvas.height = scene.canvas.height;

  const previewInput = takePagePreviewDocument ?? scene;
  const resolution = resolveSceneBindings(previewInput);
  bindingPreviewIssues = resolution.ok
    ? []
    : resolution.issues.map(
        (issue) =>
          `Binding ${issue.objectId}.${issue.property} refused [${issue.code}]: ${issue.reason}`,
      );
  resolvedScene = resolution.ok ? resolution.document : previewInput;
  const animation = previewSceneAt(resolvedScene, currentFrame, animationSurface);
  previewScene = animation.document;
  viewport?.dispose();
  viewport = new SceneViewport(ui.canvas, previewScene);
  viewport.render();

  renderPanels(scene);
  renderOverlayLayer();
  renderUnsupported([
    ...viewport.unsupported,
    ...bindingPreviewIssues,
    ...animation.issues,
  ]);
}

/** Render the object manager and the inspector from their node trees.
 *
 *  Both panels are built as `UiNode` trees and rendered through the shared
 *  `renderNode`, so the ARIA a screen reader announces is written from the
 *  same description an agent reads via `agentView`. Building the DOM by hand
 *  here would be a second description of the same panel, free to drift from
 *  the one the tests hold (invariant 27). */
function managedProjectScenes(catalog: ProjectSceneCatalog): ManagedScene[] {
  return catalog.scenes.map((listed) => ({
    sceneId: listed.sceneId,
    name: listed.name,
    unsavedChanges:
      projectSceneDirty &&
      projectSceneId === listed.sceneId &&
      projectSceneProject === catalog.project,
    // Scene documents predate design-system stamping. A revision proves
    // publication, but not which token version was used; call that unknown
    // rather than inventing a version from the publication revision.
    ...(listed.publishedRevision === undefined ? {} : { publishedUnstamped: true }),
    ...(listed.unavailableReason === undefined
      ? {}
      : { unavailableReason: listed.unavailableReason }),
  }));
}

function renderProjectManager(): void {
  const catalog = projectCatalog;
  if (!catalog || catalog.project !== currentProject) {
    ui.sceneManagerMount.replaceChildren();
    ui.sceneManagerEmpty.hidden = false;
    ui.sceneManagerEmpty.textContent =
      projects.length === 0
        ? "No projects. Create one before saving a project scene."
        : "Select a project to list its scenes.";
    return;
  }
  const managed = managedProjectScenes(catalog);
  ui.sceneManagerEmpty.hidden = managed.length > 0;
  ui.sceneManagerEmpty.textContent = `No scenes in ${catalog.project}. Use New, then Save here.`;
  ui.sceneManagerMount.replaceChildren(
    renderNode(
      document,
      sceneManagerPanel({
        project: catalog.project,
        scenes: managed,
        ...(catalog.currentDesignSystemVersion === undefined
          ? {}
          : { currentDesignSystemVersion: catalog.currentDesignSystemVersion }),
      }),
    ) as unknown as Node,
  );
}

function hexForTakePageColor(value: ControlValue | undefined): string {
  if (value?.type !== "color" || value.value.type !== "solid") return "#000000";
  const component = (channel: number): string =>
    Math.round(Math.max(0, Math.min(1, channel)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${component(value.value.color.r)}${component(value.value.color.g)}${component(value.value.color.b)}`;
}

function takePageValueFromInput(field: ControlField, input: HTMLInputElement): ControlValue {
  switch (field.kind) {
    case "text":
      return { type: "text", value: input.value };
    case "asset":
      return { type: "asset", value: input.value };
    case "boolean":
      return { type: "boolean", value: input.checked };
    case "color": {
      const hex = input.value;
      const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
      return {
        type: "color",
        value: {
          type: "solid",
          color: { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: 1, space: "srgb" },
        },
      };
    }
    case "number": {
      const number = Number(input.value);
      // A malformed numeric entry deliberately remains a text control value.
      // Rust owns rejection and returns ControlValueTypeMismatch by field id.
      return Number.isFinite(number) && input.value.trim() !== ""
        ? { type: "number", value: number }
        : { type: "text", value: input.value };
    }
  }
}

function renderTakePagePanel(document_: SceneDocument): void {

  ui.takePageId.value = takePageState.pageId;
  ui.takePageName.value = takePageState.name;
  ui.takePageMount.replaceChildren(
    renderNode(document, takePagePanel(document_, takePageState)) as unknown as Node,
  );
  for (const field of document_.controls) {
    const row = document.getElementById(`take-page/field/${field.fieldId}`);
    if (!row) throw new Error(`take-page panel omitted declared field ${field.fieldId}`);
    row.textContent = "";
    const input = document.createElement("input");
    input.type = inputTypeFor(field.kind);
    input.setAttribute("aria-label", field.label);
    input.dataset.takePageField = field.fieldId;
    const value = valueForField(field, takePageState);
    if (field.kind === "boolean") {
      input.checked = value?.type === "boolean" ? value.value : false;
    } else if (field.kind === "color") {
      input.value = hexForTakePageColor(value);
    } else if (value?.type === field.kind) {
      input.value = String(value.value);
    }
    input.addEventListener("input", () => {
      takePageState = {
        ...takePageState,
        values: { ...takePageState.values, [field.fieldId]: takePageValueFromInput(field, input) },
      };
      takePagePreviewDocument = null;
      document.getElementById("take-page/refusal")?.remove();
    });
    row.append(input);
  }

  // Narrowed into a local so the optional-chain guard actually applies to the
  // access below; `takePageCatalog?.x === y` does not narrow the field itself.
  const pageCatalog = takePageCatalog;
  const catalog =
    pageCatalog && pageCatalog.project === projectSceneProject
      ? pageCatalog.pages.filter((page) => page.sceneId === document_.id)
      : [];
  ui.takePageSelect.replaceChildren();
  for (const page of catalog) {
    const option = document.createElement("option");
    option.value = page.pageId;
    option.textContent = page.unavailableReason ? `${page.name} — ${page.unavailableReason}` : page.name;
    option.disabled = page.unavailableReason !== undefined;
    ui.takePageSelect.append(option);
  }
  ui.takePageSelect.disabled = catalog.length === 0;
  ui.takePageOpen.disabled = catalog.length === 0;
  ui.takePageSave.disabled = projectSceneProject === undefined;
}
async function loadControlProperties(kind: string): Promise<void> {
  try {
    const pairs = await invoke<readonly [string, ControlField["kind"]][]>("cmd_control_properties", { kind });
    if (controlPropertiesKind !== kind) return;
    controlProperties = pairs.map(([property, fieldKind]) => ({ property, kind: fieldKind }));
  } catch (error) {
    controlProperties = [];
    log(`control vocabulary unavailable: ${describe(error)}`, "bad");
  }
  if (scene) renderPanels(scene);
}

function renderControlContract(document_: SceneDocument): void {
  const selected = selection.length === 1
    ? document_.objects.find((object) => object.id === selection[0])
    : undefined;
  if (selected?.type !== controlPropertiesKind) {
    controlPropertiesKind = selected?.type;
    controlProperties = selected === undefined ? [] : undefined;
    if (selected !== undefined) void loadControlProperties(selected.type);
  }
  ui.controlMount.replaceChildren(
    renderNode(
      document,
      controlContractPanel(document_, {
        selectedIds: selection,
        ...(selected?.type === controlPropertiesKind && controlProperties !== undefined
          ? { fillableProperties: controlProperties }
          : {}),
      }),
    ) as unknown as Node,
  );
}

async function replaceControlField(next: ControlField, label: string): Promise<void> {
  if (!scene) return;
  try {
    const updated = await invoke<SceneDocument>("cmd_control_replace", { scene, field: next });
    commitScene(scene, updated, label);
  } catch (error) {
    log(`control field refused: ${describe(error)}`, "bad");
  }
}

async function onControlContractClick(event: MouseEvent): Promise<void> {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const nodeId = button?.dataset.for;
  const action = button?.dataset.action;
  if (!nodeId || !action || button?.disabled) return;

  if (nodeId.startsWith("control/property/") && action === "declare") {
    const property = nodeId.slice("control/property/".length);
    const candidate = controlProperties?.find((entry) => entry.property === property);
    const objectId = selection.length === 1 ? selection[0] : undefined;
    if (!candidate || !objectId) return;
    const fieldId = window.prompt("Stable field id", property);
    if (fieldId === null || fieldId.trim() === "") return;
    const label = window.prompt("Operator label", property);
    if (label === null || label.trim() === "") return;
    try {
      const updated = await invoke<SceneDocument>("cmd_control_declare", {
        scene,
        field: { fieldId: fieldId.trim(), label: label.trim(), objectId, property, kind: candidate.kind },
      });
      commitScene(scene, updated, `declare control ${fieldId.trim()}`);
    } catch (error) {
      log(`control field refused: ${describe(error)}`, "bad");
    }
    return;
  }

  if (!nodeId.startsWith("control/field/")) return;
  const fieldId = nodeId.slice("control/field/".length);
  const field = scene.controls.find((candidate) => candidate.fieldId === fieldId);
  if (!field) return;
  if (action === "remove") {
    try {
      const updated = await invoke<SceneDocument>("cmd_control_remove", { scene, fieldId });
      commitScene(scene, updated, `remove control ${fieldId}`);
    } catch (error) {
      log(`control field refused: ${describe(error)}`, "bad");
    }
    return;
  }
  if (action === "setLabel") {
    const label = window.prompt("Operator label", field.label);
    if (label !== null && label.trim() !== "") {
      await replaceControlField({ ...field, label: label.trim() }, `label control ${fieldId}`);
    }
    return;
  }
  if (action !== "setDefault") return;
  const entered = window.prompt(
    `Default ${field.kind} value`,
    field.default?.value === undefined ? "" : String(field.default.value),
  );
  if (entered === null) return;
  let defaultValue: Exclude<ControlField["default"], undefined>;
  switch (field.kind) {
    case "text": defaultValue = { type: "text", value: entered }; break;
    case "asset": defaultValue = { type: "asset", value: entered }; break;
    case "boolean":
      if (entered !== "true" && entered !== "false") {
        log("control default refused: boolean must be true or false", "bad");
        return;
      }
      defaultValue = { type: "boolean", value: entered === "true" };
      break;
    case "number": {
      const value = Number(entered);
      if (!Number.isFinite(value)) {
        log("control default refused: number must be finite", "bad");
        return;
      }
      defaultValue = { type: "number", value };
      break;
    }
    case "color":
      try {
        defaultValue = JSON.parse(entered) as ControlValue;
      } catch {
        log("control default refused: color must be a ColorValue JSON object", "bad");
        return;
      }
      break;
  }
  await replaceControlField({ ...field, default: defaultValue }, `default control ${fieldId}`);
}

function renderPanels(document_: SceneDocument): void {
  renderProjectManager();
  ui.objectEmpty.hidden = document_.objects.length > 0;

  const objects = objectManagerPanel(document_, {
    selectedIds: selection,
    collapsedIds: collapsed,
  });
  ui.objectManager.replaceChildren(renderNode(document, objects) as unknown as Node);

  ui.fontEmpty.hidden = document_.fonts.length > 0;
  const fonts = fontManagerPanel(
    document_,
    selectedFontId === undefined ? {} : { selectedFontId },
  );
  ui.fontMount.replaceChildren(renderNode(document, fonts) as unknown as Node);

  ui.textStyleEmpty.hidden = document_.textStyles.length > 0;
  ui.textStyleMount.replaceChildren(
    renderNode(document, textStylePanel(document_, { selectedObjectIds: selection })) as unknown as Node,
  );

  ui.materialEmpty.hidden = document_.materials.length > 0;
  const materials = materialManagerPanel(
    document_,
    selectedMaterialId === undefined ? {} : { selectedMaterialId },
  );
  ui.materialMount.replaceChildren(renderNode(document, materials) as unknown as Node);
  ui.assetEmpty.hidden = document_.assets.length > 0;
  const assets = assetManagerPanel(
    document_,
    selectedAssetId === undefined ? {} : { selectedAssetId },
  );
  ui.assetMount.replaceChildren(renderNode(document, assets) as unknown as Node);
  renderTakePagePanel(document_);


  const inspector = inspectorPanel(document_, selection);
  ui.inspector.replaceChildren(renderNode(document, inspector) as unknown as Node);
  const animation = keyframePanelModel(document_, selection, animationSurface, currentFrame);
  ui.animationFrame.value = String(animation.currentFrame);
  ui.animationFrame.max = String(animation.durationFrames);
  ui.animationMount.replaceChildren(renderKeyframePanel(document, animation, animationSurface));

  const bindings = bindingPanel(document_, selection);
  ui.bindings.replaceChildren(renderNode(document, bindings) as unknown as Node);
  renderControlContract(document_);
  renderTimeline(document_);
}

// ---------------------------------------------------------------------------
// Timeline (11.10). Virtualised rows over three canvas layers, repainted
// through `planRepaint` so a scrub never re-rasterises the ruler.
// ---------------------------------------------------------------------------

let timelineViewport: TimelineViewport = {
  startFrame: 0,
  pixelsPerFrame: DEFAULT_PIXELS_PER_FRAME,
  width: 0,
  height: 0,
  scrollTop: 0,
  rowHeight: DEFAULT_ROW_HEIGHT,
};
let timelineLayers: Record<TimelineLayerId, HTMLCanvasElement> | null = null;
let lastSnapshot: TimelineSnapshot | null = null;
/// Bumped by the caller instead of deep-comparing key data: a deep compare is
/// where "did the keys change?" becomes O(keys) on every frame.
let contentRevision = 0;
let selectionRevision = 0;
/// Timeline view and edit state. Selection of *keys* is distinct from
/// selection of *objects*: the viewport selects objects, the timeline selects
/// keys, and conflating them would make deleting a key delete a rectangle.
let collapsedTimelineIds: string[] = [];
let selectedKeys = new Set<string>();
let keyClipboard: readonly ClipboardKey[] = [];
let keyDrag:
  | {
      readonly pointerId: number;
      readonly startFrame: number;
      readonly startClientX: number;
      moved: boolean;
    }
  | undefined;
/// Which track is open as a speed graph, if any. Advanced curves appear on
/// demand rather than permanently (11.23).
let graphTrack: number | undefined;
/// Bumped when a phase is added, moved or removed, so the static layer — and
/// only then — repaints. A scrub never touches this (11.25).
let phaseRevision = 0;

function timelineSnapshot(model: TimelineModel): TimelineSnapshot {
  return {
    startFrame: timelineViewport.startFrame,
    pixelsPerFrame: timelineViewport.pixelsPerFrame,
    width: timelineViewport.width,
    height: timelineViewport.height,
    devicePixelRatio: window.devicePixelRatio,
    rowWindowFirst: 0,
    rowWindowLast: model.tracks.length,
    contentRevision,
    selectionRevision,
    phaseRevision,
    currentFrame,
    marqueeRevision: 0,
    dragRevision: 0,
  };
}

/// The DOM's shape: the rows present and the canvas sizes. A change to this
/// needs new elements; anything else is a repaint.
let timelineStructure = "";

/// The timeline's view of the document: driven by the object selection, with
/// collapsed groups folded away.
function currentTimelineModel(document_: SceneDocument): TimelineModel {
  return timelineModel(document_, {
    selectedIds: selection,
    collapsedIds: collapsedTimelineIds,
  });
}

/** Bring the timeline up to date, rebuilding its DOM only if it has to.
 *
 *  A zoom or a scroll changes geometry, which `planRepaint` correctly treats
 *  as dirtying all three layers — but repainting three canvases is far cheaper
 *  than discarding and recreating them. Rebuilding on every tick of a zoom
 *  drag would throw away the layer architecture precisely where it pays. */
function renderTimeline(document_: SceneDocument, structureChanged = true): void {
  if (structureChanged) contentRevision += 1;
  const model = currentTimelineModel(document_);
  const bounds = ui.timelineMount.getBoundingClientRect();
  timelineViewport = clampViewport(
    {
      ...timelineViewport,
      // The header column is 210px of the grid; the stage gets the rest.
      width: Math.max(0, bounds.width - 210),
      height: Math.max(0, bounds.height),
    },
    model.durationFrames,
    model.rows.length,
  );

  ui.timelineMeta.textContent =
    model.tracks.length === 0
      ? "no animated properties"
      : `${model.tracks.length} track(s) · ${model.keyCount} key(s) · ${visibleKeyCount(model, timelineViewport)} drawn`;

  if (model.tracks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "Key a property to see its track here.";
    ui.timelineMount.replaceChildren(empty);
    timelineLayers = null;
    lastSnapshot = null;
    timelineStructure = "";
    return;
  }

  const window_ = rowWindow(timelineViewport, model.rows.length);
  // Keyed on the rows actually rendered, not on the tracks. Collapsing a group
  // leaves the track list untouched and changes only the rows, so a key built
  // from tracks would silently skip the rebuild a collapse needs.
  const structure = [
    model.rows
      .map((row) => (row.kind === "object" ? `g:${row.objectId}:${row.collapsed}` : `t:${row.track}`))
      .join("|"),
    window_.first,
    window_.last,
    Math.round(timelineViewport.width),
    Math.round(timelineViewport.height),
  ].join("#");

  if (structure !== timelineStructure || !timelineLayers) {
    const parts = renderTimelinePanel(document, model, timelineViewport);
    ui.timelineMount.replaceChildren(parts.root);
    timelineLayers = parts.canvases;
    timelineStructure = structure;
    // Fresh canvases retain nothing, so this is a first paint.
    lastSnapshot = null;
  }
  paintTimeline(model);
}

/** Paint only the layers the transition dirtied. */
function paintTimeline(model: TimelineModel): void {
  if (!timelineLayers) return;
  const next = timelineSnapshot(model);
  const dirty = planRepaint(lastSnapshot, next);
  lastSnapshot = next;
  if (dirty.size === 0) return;

  const state = {
    model,
    viewport: timelineViewport,
    currentFrame,
    selected: selectedKeys,
    phases: scene?.timeline.phases ?? [],
    ...(graphTrack === undefined ? {} : { graphTrack }),
  };
  // Every layer gets a backing store in *device* pixels and a transform that
  // keeps the drawing code in CSS pixels (ADR-0002 B.2). Sized here rather
  // than at creation because the ratio changes while the app runs — a window
  // dragged to a 125% monitor must not keep a 100% backing store.
  const ratio = window.devicePixelRatio;
  for (const layer of dirty) {
    const canvas = timelineLayers[layer];
    const context = canvas.getContext("2d");
    // A missing context is reported, never silently skipped: a timeline that
    // drew nothing and said nothing is the failure invariant 18 forbids.
    if (!context) {
      log(`timeline layer ${layer} has no 2D context`, "bad");
      continue;
    }
    sizeCanvasForRatio(canvas, timelineViewport.width, timelineViewport.height, ratio);
    // `setTransform` rather than `scale`: assigning `canvas.width` resets the
    // transform, and `scale` would compound across paints that did not.
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintLayer(context as unknown as DrawingContext, layer, state);
  }
}

/** Repaint after a scrub. Deliberately does NOT rebuild the DOM: only the
 *  interaction layer is dirty, which is 11.11's done-when in practice. */
function repaintTimelineForScrub(): void {
  if (!scene || !timelineLayers) return;
  paintTimeline(currentTimelineModel(scene));
}

function onTimelineZoom(): void {
  if (!scene) return;
  timelineViewport = { ...timelineViewport, pixelsPerFrame: Number(ui.timelineZoom.value) };
  // Geometry only: the tracks are unchanged, so this repaints rather than
  // rebuilding. `planRepaint` still dirties all three layers, which is right —
  // everything is positioned in the space that just changed.
  renderTimeline(scene, false);
}

/// The key under a point on the stage, if any.
///
/// The row comes from the scroll offset and the uniform row height; the key
/// from the index's binary search within a frame tolerance. Both are O(log n).
function keyAtStagePoint(
  model: TimelineModel,
  x: number,
  y: number,
): { objectId: string; property: string; frame: number } | undefined {
  const row = Math.floor((y + timelineViewport.scrollTop) / timelineViewport.rowHeight);
  const entry = model.rows[row];
  if (!entry || entry.kind !== "track") return undefined;
  const track = model.tracks[entry.track];
  if (!track) return undefined;
  const frame = keyNear(track.keys, xToFrame(timelineViewport, x), HIT_TOLERANCE_FRAMES);
  if (frame === undefined) return undefined;
  return { objectId: track.objectId, property: track.property, frame };
}

/// Run an edit plan as one gesture, or report why it cannot run.
///
/// Every refusal here is named — a collision, a frame off the timeline, an
/// empty clipboard. Nothing is silently dropped, because a key that vanished
/// without a reason is motion an author cannot get back.
async function runKeyEdit(plan: EditPlan): Promise<void> {
  if (isKeyEditRefused(plan)) {
    log(`timeline: ${plan.refused}`, "bad");
    return;
  }
  await runGesture(plan.calls, plan.label);
}

function setKeySelection(next: Iterable<string>): void {
  selectedKeys = new Set(next);
  selectionRevision += 1;
  if (scene) paintTimeline(currentTimelineModel(scene));
}

/** Click: a group row collapses, a track row opens its curve, a key selects,
 *  and empty stage moves the playhead. */
function onTimelineClick(event: MouseEvent): void {
  if (!scene || !timelineLayers) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  const group = target.closest<HTMLElement>(".timeline-group-header");
  if (group?.dataset.objectId) {
    const objectId = group.dataset.objectId;
    collapsedTimelineIds = collapsedTimelineIds.includes(objectId)
      ? collapsedTimelineIds.filter((id) => id !== objectId)
      : [...collapsedTimelineIds, objectId];
    // Row count changed, so the DOM genuinely has to be rebuilt.
    renderTimeline(scene);
    return;
  }

  const header = target.closest<HTMLElement>(".timeline-row-header");
  if (header) {
    const model = currentTimelineModel(scene);
    const index = Number(header.dataset.track);
    if (Number.isInteger(index) && model.tracks[index]) {
      graphTrack = graphTrack === index ? undefined : index;
      ui.timelineGraphClose.hidden = graphTrack === undefined;
      contentRevision += 1;
      paintTimeline(model);
      log(
        graphTrack === undefined
          ? "timeline: dope sheet"
          : `timeline: speed graph for ${model.tracks[index]!.label}`,
      );
    }
    return;
  }

  const stage = target.closest<HTMLElement>(".timeline-stage");
  if (!stage) return;
  const bounds = stage.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  const model = currentTimelineModel(scene);
  const hit = keyAtStagePoint(model, x, y);

  if (hit) {
    const id = keyId(hit.objectId, hit.property, hit.frame);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (additive) {
      const next = new Set(selectedKeys);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setKeySelection(next);
    } else {
      setKeySelection([id]);
    }
    return;
  }

  // Empty stage: clear the key selection and move the playhead.
  if (selectedKeys.size > 0) setKeySelection([]);
  setCurrentFrame(xToFrame(timelineViewport, x));
}

/** Drag a selected key horizontally to move the whole selection. */
function onTimelinePointerDown(event: PointerEvent): void {
  if (!scene || !timelineLayers || event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const stage = target.closest<HTMLElement>(".timeline-stage");
  if (!stage) return;

  const bounds = stage.getBoundingClientRect();
  const hit = keyAtStagePoint(
    currentTimelineModel(scene),
    event.clientX - bounds.left,
    event.clientY - bounds.top,
  );
  if (!hit) return;

  keyDrag = {
    pointerId: event.pointerId,
    startFrame: hit.frame,
    startClientX: event.clientX,
    moved: false,
  };
  stage.setPointerCapture(event.pointerId);
}

function onTimelinePointerMove(event: PointerEvent): void {
  if (!keyDrag || keyDrag.pointerId !== event.pointerId) return;
  if (Math.abs(event.clientX - keyDrag.startClientX) >= 3) keyDrag.moved = true;
}

function finishKeyDrag(event: PointerEvent, cancelled: boolean): void {
  if (!scene || !keyDrag || keyDrag.pointerId !== event.pointerId) return;
  const drag = keyDrag;
  keyDrag = undefined;

  // Release the capture taken on pointerdown. The browser drops it on
  // pointerup anyway, but a cancelled gesture does not get one, and a stage
  // still holding capture retargets every later pointer event to itself.
  const stage = ui.timelineMount.querySelector<HTMLElement>(".timeline-stage");
  if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);

  if (cancelled || !drag.moved || selectedKeys.size === 0) return;

  const model = currentTimelineModel(scene);
  const pixels = event.clientX - drag.startClientX;
  const raw = drag.startFrame + pixels / timelineViewport.pixelsPerFrame;
  // Snap to the playhead or to a key already on the channel — the two things
  // an author is trying to line up with.
  const candidates = [currentFrame, ...collectSnapCandidates(model)];
  const landing = snapFrame(raw, candidates, SNAP_TOLERANCE_FRAMES);
  void runKeyEdit(planMove(model, [...selectedKeys], landing - drag.startFrame));
}

/// Frames worth snapping to: every key on the tracks holding the selection,
/// excluding the selected keys themselves.
function collectSnapCandidates(model: TimelineModel): number[] {
  const channels = new Set(
    [...selectedKeys].map((id) => id.split("/").slice(0, 2).join("/")),
  );
  const out: number[] = [];
  for (const track of model.tracks) {
    if (!channels.has(`${track.objectId}/${track.property}`)) continue;
    for (const frame of track.keys.frames) {
      if (!selectedKeys.has(keyId(track.objectId, track.property, frame))) out.push(frame);
    }
  }
  return out;
}

/** Delete, copy and paste over the key selection. */
function onTimelineKeyDown(event: KeyboardEvent): void {
  if (!scene) return;
  const target = event.target;
  // Never steal a text field's own editing keys.
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }
  const model = currentTimelineModel(scene);

  if ((event.key === "Delete" || event.key === "Backspace") && selectedKeys.size > 0) {
    event.preventDefault();
    void runKeyEdit(planDelete([...selectedKeys]));
    setKeySelection([]);
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;

  const key = event.key.toLowerCase();
  if (key === "c" && selectedKeys.size > 0) {
    event.preventDefault();
    keyClipboard = planCopy(model, [...selectedKeys]);
    log(`timeline: copied ${keyClipboard.length} key(s)`);
  } else if (key === "v" && keyClipboard.length > 0) {
    event.preventDefault();
    void runKeyEdit(planPaste(model, keyClipboard, currentFrame));
  }
}

// ---------------------------------------------------------------------------
// Easing and starter presets (11.23)
// ---------------------------------------------------------------------------

let starterPresets: readonly MotionPreset[] = [];

/** Populate the easing and preset pickers from Rust, never from a local list. */
async function loadMotionLibrary(): Promise<void> {
  for (const easing of animationSurface?.easings ?? []) {
    const option = document.createElement("option");
    option.value = easing;
    option.textContent = propertyLabel(easing);
    ui.timelineEasing.append(option);
  }
  try {
    starterPresets = await invoke<MotionPreset[]>("cmd_starter_presets");
    for (const preset of starterPresets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.id;
      ui.timelinePreset.append(option);
    }
  } catch (error) {
    log(`motion library unavailable: ${describe(error)}`, "bad");
  }
}

/** Populate the object menu from Rust, so it can only offer kinds
 *  `create_object` will accept. A kind that appears and then refuses is the
 *  drift invariant 18 exists to prevent. */
async function loadObjectKinds(): Promise<void> {
  try {
    for (const kind of await invoke<string[]>("cmd_object_kinds")) {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent = kind;
      ui.objectKind.append(option);
    }
  } catch (error) {
    // An empty menu with a stated reason; never a hard-coded stand-in list.
    ui.objectCreate.disabled = true;
    log(`object kinds unavailable: ${describe(error)}`, "bad");
  }
}

/** Apply the chosen easing to every selected key, as one gesture. */
function onEasingChosen(): void {
  if (!scene) return;
  const easing = ui.timelineEasing.value;
  if (easing === "") return;
  // A custom bezier needs control points, which the key detail editor owns;
  // the picker offers a sensible starting curve rather than refusing outright.
  const bezier = easing === "custom-bezier" ? { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } : undefined;
  void runKeyEdit(planSetEasing(currentTimelineModel(scene), [...selectedKeys], easing, bezier));
  ui.timelineEasing.value = "";
}

/** Apply a starter preset's `in` phase to the selected objects at the playhead.
 *
 *  The preset is selected and parameterised, never authored (G.6.7): this
 *  sends an id and a frame, and Rust resolves the phase's duration against the
 *  scene's own rate. */
async function applyStarterPreset(): Promise<void> {
  if (!scene) return;
  const presetId = ui.timelinePreset.value;
  if (presetId === "") {
    log("choose a preset first", "bad");
    return;
  }
  if (selection.length === 0) {
    log("select an object to apply a preset to", "bad");
    return;
  }
  const preset = starterPresets.find((candidate) => candidate.id === presetId);
  const kinds = new Set(
    scene.objects.filter((object) => selection.includes(object.id)).map((object) => object.type),
  );
  // The browser's own rule (11.15): a preset that does not apply is refused by
  // name, never silently skipped.
  const blocker = preset
    ? presetBlocker(preset, { selectionKinds: [...kinds] })
    : `no preset named ${presetId}`;
  if (blocker) {
    log(`preset refused: ${blocker}`, "bad");
    return;
  }
  await runGesture(
    selection.map((objectId) => ({
      command: "cmd_preset_apply",
      args: { objectId, presetId, phase: "in", atFrame: currentFrame },
    })),
    selection.length === 1
      ? `Apply ${presetId} at frame ${currentFrame}`
      : `Apply ${presetId} to ${selection.length} objects at frame ${currentFrame}`,
  );
}


function closeSpeedGraph(): void {
  if (!scene) return;
  graphTrack = undefined;
  ui.timelineGraphClose.hidden = true;
  contentRevision += 1;
  paintTimeline(timelineModel(scene));
}


/** Render interaction separately from the raster canvas (11.7). */
function renderOverlayLayer(): void {
  const active = previewScene ?? scene;
  if (!active) {
    ui.overlay.replaceChildren();
    return;
  }
  renderViewportOverlay(
    document,
    ui.overlay,
    buildViewportOverlay(active, {
      selectedIds: selection,
      ...(marquee === undefined ? {} : { marquee }),
      ...(guides.length === 0 ? {} : { guides }),
    }),
  );
}

function setSelection(next: readonly string[]): void {
  selection = [...new Set(next)];
  if (!scene) return;
  renderPanels(scene);
  renderOverlayLayer();
}
function activeKeyframeModel(): KeyframePanelModel | null {
  return scene ? keyframePanelModel(scene, selection, animationSurface, currentFrame) : null;
}

function selectedAnimationRow(property: string): KeyframeRow | undefined {
  const model = activeKeyframeModel();
  return model?.available ? model.rows.find((row) => row.property === property) : undefined;
}

/** Move the playhead and draw the evaluated local preview.
 *
 * Deliberately NOT `renderPanels`: a scrub or playback tick changes one
 * integer. Static timeline layers and unrelated panels stay untouched. The
 * same `previewSceneAt` path serves a manual scrub and the rAF clock, so the
 * two cannot disagree about the frame being shown. */
function setCurrentFrame(next: number): void {
  if (!scene) return;
  currentFrame = Math.min(
    Number(scene.timeline.durationFrames),
    Math.max(0, Math.round(Number.isFinite(next) ? next : 0)),
  );
  const evaluated = previewSceneAt(resolvedScene ?? scene, currentFrame, animationSurface);
  previewScene = evaluated.document;
  const viewportIssues = viewport?.updateDocument(previewScene) ?? [];
  viewport?.render();
  renderOverlayLayer();

  const animation = keyframePanelModel(scene, selection, animationSurface, currentFrame);
  ui.animationFrame.value = String(animation.currentFrame);
  ui.animationMount.replaceChildren(renderKeyframePanel(document, animation, animationSurface));
  ui.previewStatus.textContent = `${playback === undefined ? "Paused" : "Playing"} at frame ${currentFrame}`;
  renderUnsupported([
    ...(viewport?.unsupported ?? []),
    ...bindingPreviewIssues,
    ...evaluated.issues,
    ...viewportIssues,
  ]);
  repaintTimelineForScrub();
}

function updatePlaybackControls(): void {
  const playing = playback !== undefined;
  ui.previewPlay.textContent = playing ? "Pause" : "Play";
  ui.previewPlay.setAttribute("aria-pressed", String(playing));
  ui.previewStatus.textContent = `${playing ? "Playing" : "Paused"} at frame ${currentFrame}`;
}

function pausePreview(reason: string): void {
  const active = playback;
  if (!active) return;
  cancelAnimationFrame(active.requestId);
  playback = undefined;
  updatePlaybackControls();

  const samples = [...active.renderTimes].sort((a, b) => a - b);
  const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
  const mean = active.renderCount === 0 ? 0 : active.totalRenderMs / active.renderCount;
  log(
    `Preview paused (${reason}) at frame ${currentFrame}; ${active.renderCount} frame update(s), mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
    "good",
  );
}

function previewTick(now: number): void {
  const active = playback;
  if (!active || !scene) return;
  const next = previewFrameAtElapsed(
    active.startFrame,
    now - active.startTime,
    scene.canvas.frameRate,
    // A phase stops at its own end; the whole scene stops at its duration.
    // One clock, one stop frame — not a second playback implementation.
    active.stopFrame,
  );
  if (next.frame !== active.lastFrame) {
    const began = performance.now();
    setCurrentFrame(next.frame);
    const renderMs = performance.now() - began;
    const sampleIndex = active.renderCount % 600;
    if (active.renderTimes.length < 600) active.renderTimes.push(renderMs);
    else active.renderTimes[sampleIndex] = renderMs;
    active.renderCount += 1;
    active.totalRenderMs += renderMs;
    active.lastFrame = next.frame;
  }
  if (next.ended) {
    pausePreview("reached the end");
  } else {
    active.requestId = requestAnimationFrame(previewTick);
  }
}

/// Start the clock from the playhead, stopping at `stopFrame`.
///
/// Shared by whole-scene preview and single-phase preview so the two cannot
/// disagree about timing; `what` only names it in the log.
function startPreview(stopFrame: number, what: string): void {
  if (!scene) {
    log("preview refused: nothing is open", "bad");
    return;
  }
  if (stopFrame <= 0) {
    log(`preview refused: ${what} has no frames`, "bad");
    return;
  }
  const startFrame = currentFrame >= stopFrame ? 0 : currentFrame;
  if (startFrame !== currentFrame) setCurrentFrame(startFrame);
  const active = {
    startFrame,
    stopFrame,
    startTime: performance.now(),
    requestId: 0,
    lastFrame: startFrame,
    renderTimes: [] as number[],
    renderCount: 0,
    totalRenderMs: 0,
  };
  playback = active;
  updatePlaybackControls();
  active.requestId = requestAnimationFrame(previewTick);
  log(
    `Preview playing ${what} from frame ${startFrame} at ${scene.canvas.frameRate.num}/${scene.canvas.frameRate.den} fps`,
    "good",
  );
}

function togglePreview(): void {
  if (playback) {
    pausePreview("paused");
    return;
  }
  if (!scene) {
    log("preview refused: nothing is open", "bad");
    return;
  }
  startPreview(Number(scene.timeline.durationFrames), "the scene");
}

function previewShortcutOwnsTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="slider"]',
    ) !== null
  );
}

function onPreviewShortcut(event: KeyboardEvent): void {
  if (
    (event.key !== " " && event.code !== "Space") ||
    event.repeat ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    previewShortcutOwnsTarget(event)
  ) {
    return;
  }
  event.preventDefault();
  togglePreview();
}

// ---------------------------------------------------------------------------
// Undo/redo. One gesture is one entry (11.21). A multi-object gesture threads
// the scene through several shell calls and records only the pre-gesture
// document, so undoing it reverses the whole gesture at once.
// ---------------------------------------------------------------------------

function updateHistoryButtons(): void {
  ui.undo.disabled = undoStack.length === 0;
  ui.redo.disabled = redoStack.length === 0;
}

/** Record a completed edit and make it the current document.
 *
 *  The edit is recorded against the session that owns the document, not
 *  against a global stack: a shared history would let Ctrl+Z in one graphic
 *  restore a document belonging to another (11.29). */
function commitScene(previous: SceneDocument, next: SceneDocument, label: string): void {
  undoStack.push(previous);
  // A runaway history is a memory leak in a long session; the oldest gesture
  // is the least likely to be undone.
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  scene = next;
  markActiveDirty();
  // An edit that created or removed objects says what should now be selected;
  takePagePreviewDocument = null;
  // applied here, against the document that actually contains them.
  if (pendingSelection !== undefined) {
    selection = [...new Set(pendingSelection)];
    pendingSelection = undefined;
  }
  renderSceneState();
  updateHistoryButtons();
  renderSceneTabs();
  log(label, "good");
}

/** Mark the open scene edited, in both the project-save sense and the tab. */
function markActiveDirty(): void {
  if (projectSceneId !== undefined) projectSceneDirty = true;
  const session = activeSession(workspace);
  if (session) session.dirty = true;
}

function undo(): void {
  const previous = undoStack.pop();
  if (!scene || !previous) return;
  redoStack.push(scene);
  scene = previous;
  takePagePreviewDocument = null;
  markActiveDirty();
  renderSceneState();
  updateHistoryButtons();
  renderSceneTabs();
  log("Undo", "good");
}

function redo(): void {
  const next = redoStack.pop();
  if (!scene || !next) return;
  undoStack.push(scene);
  scene = next;
  takePagePreviewDocument = null;
  markActiveDirty();
  renderSceneState();
  updateHistoryButtons();
  renderSceneTabs();
  log("Redo", "good");
}

/** The scaffolding every document edit shares: one edit at a time, one undo
 *  entry, and a refusal that leaves the document exactly as it was.
 *
 *  `apply` receives the document the gesture started from and returns the one
 *  it produced, together with the sentence describing what it did — the label
 *  is computed from the result because an edit's consequence (three objects
 *  removed, two channels with them) is only known once Rust has reported it. */
async function runEdit(
  apply: (start: SceneDocument) => Promise<{ next: SceneDocument; label: string }>,
): Promise<boolean> {
  if (!scene) return false;
  if (animationBusy) {
    log("an edit is already in progress", "bad");
    return false;
  }
  animationBusy = true;
  ui.animationMount.setAttribute("aria-busy", "true");
  const start = scene;
  try {
    const { next, label } = await apply(start);
    commitScene(start, next, label);
    return true;
  } catch (error) {
    log(describe(error), "bad");
    return false;
  } finally {
    animationBusy = false;
    ui.animationMount.removeAttribute("aria-busy");
  }
}

// ---------------------------------------------------------------------------
// Named timeline phases (11.25). The span comes from the author's key
// selection, because that is the thing they already framed: selecting the keys
// of a build and naming them `in` is one gesture, where typing two frame
// numbers is two chances to be wrong.
// ---------------------------------------------------------------------------

/// The half-open span the selected keys cover.
///
/// `end` is one past the last selected key, matching Rust's `[start, end)`.
/// A single selected key would otherwise produce an empty span, which the
/// contract refuses — so one key means "from here to the next frame".
function selectedKeySpan(): { start: number; end: number } | undefined {
  const frames = [...selectedKeys]
    .map((id) => parseKeyId(id)?.frame)
    .filter((frame): frame is number => frame !== undefined);
  if (frames.length === 0) return undefined;
  const start = Math.min(...frames);
  const end = Math.max(...frames);
  return { start, end: end > start ? end : start + 1 };
}

async function setPhaseFromSelection(): Promise<void> {
  if (!scene) return;
  const span = selectedKeySpan();
  if (!span) {
    log("phase refused: select the keys the phase should cover", "bad");
    return;
  }
  const kind = ui.phaseKind.value as TimelinePhase["kind"];
  // Only `continue` needs a name, because it is the only kind a timeline may
  // carry more than one of. Naming the others would invent an address.
  let name: string | undefined;
  if (kind === "continue") {
    const entered = window.prompt("Name for this continue phase", "continue");
    if (entered === null) return;
    if (entered.trim() === "") {
      log("phase refused: a continue phase needs a name to be addressable", "bad");
      return;
    }
    name = entered.trim();
  }
  const phase = {
    kind,
    ...(name === undefined ? {} : { name }),
    startFrame: span.start as unknown as bigint,
    endFrame: span.end as unknown as bigint,
  } satisfies TimelinePhase;

  await runEdit(async (start) => ({
    next: await invoke<SceneDocument>("cmd_phase_set", { scene: start, phase }),
    label: `Set ${phaseAddress(phase)} over frames ${span.start}–${span.end}`,
  }));
  phaseRevision += 1;
  if (scene) paintTimeline(currentTimelineModel(scene));
}

/// The phase under the playhead, which is what the phase buttons act on.
function phaseAtPlayhead(): TimelinePhase | undefined {
  return scene?.timeline.phases.find(
    (phase) => currentFrame >= Number(phase.startFrame) && currentFrame < Number(phase.endFrame),
  );
}

async function removePhaseAtPlayhead(): Promise<void> {
  const phase = phaseAtPlayhead();
  if (!phase) {
    log(`no phase covers frame ${currentFrame}`, "bad");
    return;
  }
  const address = phaseAddress(phase);
  await runEdit(async (start) => ({
    next: await invoke<SceneDocument>("cmd_phase_remove", { scene: start, address }),
    label: `Remove phase ${address}`,
  }));
  phaseRevision += 1;
  if (scene) paintTimeline(currentTimelineModel(scene));
}

/// Play one phase, and stop at its end rather than the scene's.
///
/// Reuses the same clock as the whole-scene preview — there is one playback
/// implementation, and a phase is a different stop frame, not a second one.
function playPhaseAtPlayhead(): void {
  const phase = phaseAtPlayhead();
  if (!phase) {
    log(`no phase covers frame ${currentFrame}`, "bad");
    return;
  }
  if (playback) pausePreview("starting a phase");
  setCurrentFrame(Number(phase.startFrame));
  startPreview(Number(phase.endFrame), phaseAddress(phase));
}

/** Run a sequence of shell calls as one gesture, threading the scene through
 *  each and committing the result as a single undo entry. Any refusal aborts
 *  the whole gesture and leaves the document untouched. */
async function runGesture(
  calls: readonly { readonly command: string; readonly args: Record<string, unknown> }[],
  label: string,
): Promise<boolean> {
  if (calls.length === 0) return false;
  return runEdit(async (start) => {
    let working = start;
    for (const call of calls) {
      working = await invoke<SceneDocument>(call.command, { scene: working, ...call.args });
    }
    return { next: working, label };
  });
}

const DEFAULT_EASING = (): SceneEasing | undefined =>
  animationSurface?.easings.find((candidate) => candidate === "ease-in-out") ??
  animationSurface?.easings[0];

/** Edit a property's value across the selection. Auto-Key decides whether the
 *  edit also writes a key at the playhead (defined base-value/first-key/off
 *  behavior lives in the Rust contract). */
async function editPropertyValue(property: string, value: number): Promise<void> {
  const model = activeKeyframeModel();
  const row = selectedAnimationRow(property);
  if (!model?.available || !row) return;
  if (!Number.isFinite(value)) {
    log(`edit refused: ${row.label} needs a finite value`, "bad");
    return;
  }
  const calls = row.objectIds.map((objectId) => ({
    command: "cmd_property_edit",
    args: { objectId, property, value, frame: model.currentFrame, autoKey },
  }));
  const scope = row.objectIds.length > 1 ? ` on ${row.objectIds.length} objects` : "";
  const label = autoKey
    ? `Keyed ${row.label} = ${value} at frame ${model.currentFrame}${scope}`
    : `Set ${row.label} = ${value}${scope}`;
  await runGesture(calls, label);
}

/** Toggle keys for a property across the selection: remove when every selected
 *  object has one at the playhead, otherwise create on those that do not. */
async function toggleKeyframe(property: string, requestedAction?: "create" | "remove"): Promise<void> {
  const model = activeKeyframeModel();
  const row = selectedAnimationRow(property);
  if (!scene || !model?.available || !row) {
    log(`keyframe refused: ${property} is not editable on this selection`, "bad");
    return;
  }
  const intent = toggleIntent(row);
  if (requestedAction !== undefined && requestedAction !== intent.action) {
    log(`keyframe action changed before it could run: ${property} is now ${intent.action}`, "bad");
    return;
  }
  if (intent.objectIds.length === 0) return;

  if (intent.action === "remove") {
    const calls = intent.objectIds.map((objectId) => ({
      command: "cmd_keyframe_remove",
      args: { objectId, property, frame: model.currentFrame },
    }));
    await runGesture(calls, `Removed ${row.label} key at frame ${model.currentFrame}`);
    return;
  }

  // `find` narrows to the contract's own easing union, so the keyframe this
  // builds carries a declared curve rather than an arbitrary string.
  const easing = DEFAULT_EASING();
  if (!easing) {
    log("keyframe refused: the animation contract declares no easing", "bad");
    return;
  }
  const calls = intent.objectIds.map((objectId) => ({
    command: "cmd_keyframe_create",
    args: {
      objectId,
      property,
      // Each object keys at its own current value, so a multi-select add does
      // not flatten differing values onto a shared one.
      keyframe: keyframeForValue(baseValueOf(scene!, objectId, property) ?? 0, model.currentFrame, easing),
    },
  }));
  await runGesture(calls, `Added ${row.label} key at frame ${model.currentFrame}`);
}

async function updateKeyframe(rowElement: HTMLElement, row: KeyframeRow): Promise<void> {
  const model = activeKeyframeModel();
  if (!model?.available || row.objectIds.length !== 1 || !row.currentKey) return;
  const value = Number(rowElement.querySelector<HTMLInputElement>(".keyframe-value")?.value);
  const easing = rowElement.querySelector<HTMLSelectElement>(".keyframe-easing")
    ?.value as SceneEasing | undefined;
  if (!Number.isFinite(value) || !easing || !animationSurface?.easings.includes(easing)) {
    log(`keyframe refused: ${row.label} needs a finite value and declared easing`, "bad");
    return;
  }
  let bezier;
  if (easing === "custom-bezier") {
    const values = ["x1", "y1", "x2", "y2"].map((name) =>
      Number(rowElement.querySelector<HTMLInputElement>(`.bezier-${name}`)?.value),
    );
    bezier = customBezierFromInputs(values);
    if (!bezier) {
      log("keyframe refused: Bezier x controls must be 0–1 and all controls finite", "bad");
      return;
    }
  }
  const keyframe: SceneKeyframe = {
    frame: row.currentKey.frame,
    value,
    easing,
    ...(bezier === undefined ? {} : { bezier }),
  };
  await runGesture(
    [{ command: "cmd_keyframe_update", args: { objectId: row.objectIds[0], property: row.property, keyframe } }],
    `Updated ${row.label} key at frame ${model.currentFrame}`,
  );
}

async function moveKeyframe(rowElement: HTMLElement, row: KeyframeRow): Promise<void> {
  const model = activeKeyframeModel();
  if (!model?.available || row.objectIds.length !== 1) return;
  const toFrame = Number(rowElement.querySelector<HTMLInputElement>(".keyframe-move-to")?.value);
  if (!Number.isInteger(toFrame)) {
    log("keyframe refused: destination frame must be an integer", "bad");
    return;
  }
  const moved = await runGesture(
    [
      {
        command: "cmd_keyframe_move",
        args: { objectId: row.objectIds[0], property: row.property, fromFrame: model.currentFrame, toFrame },
      },
    ],
    `Moved ${row.label} key from frame ${model.currentFrame} to ${toFrame}`,
  );
  if (moved) setCurrentFrame(toFrame);
}

function onAnimationClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-animation-action]");
  const action = button?.dataset.animationAction;
  const property = button?.dataset.property;
  if (!button || !action || !property) return;
  if (action === "seek") {
    setCurrentFrame(Number(button.dataset.frame));
    return;
  }
  const rowElement = button.closest<HTMLElement>(".keyframe-row");
  const row = selectedAnimationRow(property);
  if (!rowElement || !row) return;
  if (action === "create" || action === "remove") {
    void toggleKeyframe(property, action);
  } else if (action === "update") {
    void updateKeyframe(rowElement, row);
  } else if (action === "move") {
    void moveKeyframe(rowElement, row);
  }
}

function onAnimationChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // A base-value edit: dispatch through Auto-Key.
  if (target instanceof HTMLInputElement && target.classList.contains("keyframe-authored-value")) {
    const property = target.dataset.property;
    if (property && target.value.trim() !== "") void editPropertyValue(property, Number(target.value));
    return;
  }
  // The key detail easing select reveals its Bezier controls.
  if (target instanceof HTMLSelectElement && target.classList.contains("keyframe-easing")) {
    const controls = target
      .closest<HTMLElement>(".keyframe-detail")
      ?.querySelector<HTMLElement>("[data-bezier-controls]");
    if (controls) controls.hidden = target.value !== "custom-bezier";
  }
}

function closeKeyframeMenu(): void {
  ui.keyframeMenu.hidden = true;
  ui.keyframeMenu.replaceChildren();
}

function openKeyframeMenu(event: MouseEvent, onlyProperty?: string): void {
  const model = activeKeyframeModel();
  if (!model) return;
  event.preventDefault();
  const items = keyframeContextItems(model, onlyProperty);
  ui.keyframeMenu.replaceChildren();
  if (items.length === 0) {
    const reason = document.createElement("p");
    reason.className = "empty";
    reason.textContent = model.available ? "No keyframe action for this property" : model.reason;
    ui.keyframeMenu.append(reason);
  } else {
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.textContent = item.label;
      button.dataset.animationAction = item.action;
      button.dataset.property = item.property;
      ui.keyframeMenu.append(button);
    }
  }
  ui.keyframeMenu.hidden = false;
  const width = ui.keyframeMenu.offsetWidth;
  const height = ui.keyframeMenu.offsetHeight;
  ui.keyframeMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  ui.keyframeMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  ui.keyframeMenu.querySelector<HTMLButtonElement>("button")?.focus();
}

function onKeyframeMenuClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-animation-action][data-property]");
  const action = button?.dataset.animationAction;
  const property = button?.dataset.property;
  if (!property || (action !== "create" && action !== "remove")) return;
  closeKeyframeMenu();
  void toggleKeyframe(property, action);
}

function onInspectorContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const field = target.closest<HTMLElement>('[id^="inspector/"]');
  const property = field?.id.slice("inspector/".length);
  if (!property || !animationSurface?.properties.includes(property)) return;
  openKeyframeMenu(event, property);
}


function eventScenePoint(event: PointerEvent): OverlayPoint {
  const active = previewScene ?? scene;
  if (!active) return { x: 0, y: 0 };
  return scenePointFromClient(ui.overlay.getBoundingClientRect(), active.canvas, {
    x: event.clientX,
    y: event.clientY,
  });
}

function additiveSelection(ids: readonly string[]): string[] {
  const next = new Set(selection);
  for (const id of ids) next.add(id);
  return [...next];
}

function onOverlayPointerDown(event: PointerEvent): void {
  if (!previewScene || event.button !== 0) return;
  const start = eventScenePoint(event);
  overlayDrag = {
    pointerId: event.pointerId,
    start,
    startClient: { x: event.clientX, y: event.clientY },
    additive: event.shiftKey || event.ctrlKey || event.metaKey,
    moved: false,
  };
  ui.overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onOverlayPointerMove(event: PointerEvent): void {
  if (!previewScene || !overlayDrag || overlayDrag.pointerId !== event.pointerId) return;
  const current = eventScenePoint(event);
  const cssDistance = Math.hypot(
    event.clientX - overlayDrag.startClient.x,
    event.clientY - overlayDrag.startClient.y,
  );
  overlayDrag.moved ||= cssDistance >= 3;
  if (!overlayDrag.moved) return;

  marquee = boundsFromDrag(overlayDrag.start, current);
  // Crosshair guides are ephemeral interaction data, not scene objects. They
  // disappear with the gesture and never contaminate a production raster.
  guides = [
    { axis: "x", position: current.x, label: "Pointer X" },
    { axis: "y", position: current.y, label: "Pointer Y" },
  ];
  renderOverlayLayer();
}

function finishOverlayPointer(event: PointerEvent, cancelled: boolean): void {
  const active = previewScene ?? scene;
  if (!active || !overlayDrag || overlayDrag.pointerId !== event.pointerId) return;
  const drag = overlayDrag;
  overlayDrag = undefined;
  if (ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);

  if (!cancelled) {
    if (drag.moved && marquee !== undefined) {
      const hits = objectsInMarquee(active, marquee);
      setSelection(drag.additive ? additiveSelection(hits) : hits);
    } else {
      const hit = hitTestOverlay(active, eventScenePoint(event));
      setSelection(
        hit === undefined
          ? drag.additive
            ? selection
            : []
          : drag.additive
            ? additiveSelection([hit])
            : [hit],
      );
    }
  }
  marquee = undefined;
  guides = [];
  renderOverlayLayer();
}

function onObjectManagerClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-action="select"][data-for]');
  const id = button?.dataset.for;
  if (!id) return;
  setSelection(event.shiftKey || event.ctrlKey || event.metaKey ? additiveSelection([id]) : [id]);
}

// ---------------------------------------------------------------------------
// Object lifecycle (11.18). Each is one gesture and one undo entry, and each
// reports what Rust said it did rather than what the click asked for — a
// delete that also took three children and two channels says so.
// ---------------------------------------------------------------------------

/** The single selected object, or a named refusal. Every lifecycle edit except
 *  create needs exactly one, and "nothing happened" is not an answer. */
function soleSelection(verb: string): string | undefined {
  if (selection.length === 1) return selection[0];
  log(
    selection.length === 0
      ? `select an object to ${verb}`
      : `${verb} takes one object; ${selection.length} are selected`,
    "bad",
  );
  return undefined;
}

async function createObject(): Promise<void> {
  const kind = ui.objectKind.value;
  if (!kind) {
    log("no object kind is selected", "bad");
    return;
  }
  const name = window.prompt(`Name for the new ${kind}`, kind);
  // A cancelled prompt is a cancelled gesture, not an unnamed object.
  if (name === null) return;
  await runEdit(async (start) => {
    const created = await invoke<ObjectCreated>("cmd_object_create", {
      scene: start,
      kind,
      name,
    });
    // Select what was just made: an author's next edit is almost always to it.
    pendingSelection = [created.objectId];
    return { next: created.scene, label: `Added ${kind} ${created.objectId}` };
  });
}

async function duplicateObject(): Promise<void> {
  const objectId = soleSelection("duplicate");
  if (!objectId) return;
  await runEdit(async (start) => {
    const copied = await invoke<ObjectDuplicated>("cmd_object_duplicate", {
      scene: start,
      objectId,
    });
    const { newObjectId, createdObjectIds, copiedChannelCount } = copied.duplication;
    pendingSelection = [newObjectId];
    const extra: string[] = [];
    if (createdObjectIds.length > 1) extra.push(`${createdObjectIds.length - 1} child object(s)`);
    if (copiedChannelCount > 0) extra.push(`${copiedChannelCount} channel(s)`);
    return {
      next: copied.scene,
      label: extra.length
        ? `Duplicated ${objectId} as ${newObjectId}, with ${extra.join(" and ")}`
        : `Duplicated ${objectId} as ${newObjectId}`,
    };
  });
}

async function renameObject(): Promise<void> {
  const objectId = soleSelection("rename");
  if (!objectId) return;
  const current = scene?.objects.find((object) => object.id === objectId)?.name ?? objectId;
  const name = window.prompt(`Rename ${objectId}`, current);
  if (name === null) return;
  await runEdit(async (start) => ({
    next: await invoke<SceneDocument>("cmd_object_rename", { scene: start, objectId, name }),
    label: `Renamed ${objectId} to ${name.trim()}`,
  }));
}

async function deleteObject(): Promise<void> {
  const objectId = soleSelection("delete");
  if (!objectId) return;
  await runEdit(async (start) => {
    const deleted = await invoke<ObjectDeleted>("cmd_object_delete", {
      scene: start,
      objectId,
    });
    const { removedObjectIds, removedChannelCount, clearedActiveCamera } = deleted.deletion;
    pendingSelection = [];
    // Everything a delete took beyond the object named, said out loud: a
    // group silently eating its children is how authors lose work.
    const also: string[] = [];
    if (removedObjectIds.length > 1) also.push(`${removedObjectIds.length - 1} child object(s)`);
    if (removedChannelCount > 0) also.push(`${removedChannelCount} animation channel(s)`);
    if (clearedActiveCamera) also.push("the scene's active camera");
    return {
      next: deleted.scene,
      label: also.length
        ? `Deleted ${objectId}, and with it ${also.join(", ")}`
        : `Deleted ${objectId}`,
    };
  });
}

function onFontManagerClick(event: MouseEvent): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const row = target.closest<HTMLLIElement>('li[role="listitem"][id^="font/"]');
  const nodeId = button?.dataset.for ?? row?.id;
  const font = scene.fonts.find((candidate) => `font/${candidate.fontId}` === nodeId);
  if (!font) return;

  selectedFontId = font.fontId;
  renderPanels(scene);

  if (button?.dataset.action !== "reveal") return;
  const users = fontUsers(scene, font.fontId);
  log(
    users.length === 0
      ? `Font ${font.displayName} has no object users.`
      : `Font ${font.displayName} is used by object(s): ${users.join(", ")}.`,
  );
}

async function saveSelectedTextStyle(): Promise<void> {
  if (!scene) return;
  const objectId = soleSelection("save as a text style");
  if (!objectId) return;
  const object = scene.objects.find((candidate) => candidate.id === objectId);
  if (!object || object.type !== "text") {
    log("text style save refused: the selected object is not text", "bad");
    return;
  }
  const name = window.prompt("Text style name", object.name);
  if (name === null || name.trim() === "") return;
  let index = scene.textStyles.length + 1;
  let styleId = `text-style-${index}`;
  while (scene.textStyles.some((style) => style.styleId === styleId)) {
    index += 1;
    styleId = `text-style-${index}`;
  }
  const style: TextStyle = {
    styleId,
    name: name.trim(),
    fontId: object.fontId,
    size: object.size,
    textCase: object.textCase,
    ...(object.lineHeight === undefined ? {} : { lineHeight: object.lineHeight }),
    ...(object.letterSpacing === undefined ? {} : { letterSpacing: object.letterSpacing }),
    ...(object.fill === undefined ? {} : { fill: object.fill }),
    ...(object.stroke === undefined ? {} : { stroke: object.stroke }),
    ...(object.strokeWidth === undefined ? {} : { strokeWidth: object.strokeWidth }),
  };
  await runEdit(async (start) => ({
    next: await invoke<SceneDocument>("cmd_text_style_save", { scene: start, style }),
    label: `Saved text style ${style.name}`,
  }));
}

async function onTextStyleClick(event: MouseEvent): Promise<void> {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const action = button?.dataset.action;
  const nodeId = button?.dataset.for;
  if (!action || !nodeId || button.disabled) return;

  if (nodeId === "text-styles" && action === "save") {
    await saveSelectedTextStyle();
    return;
  }
  if (!nodeId.startsWith("text-style/")) return;
  const styleId = nodeId.slice("text-style/".length);
  if (!styleId || styleId.includes("/")) return;
  if (action === "reveal") {
    const users = textStyleUsers(scene, styleId);
    log(
      users.length === 0
        ? `Text style ${styleId} has no object users.`
        : `Text style ${styleId} is used by object(s): ${users.join(", ")}.`,
    );
    return;
  }
  if (action !== "apply") return;
  if (selection.length === 0) {
    log("text style apply refused: select one or more text objects", "bad");
    return;
  }
  await runGesture(
    selection.map((objectId) => ({
      command: "cmd_text_style_apply",
      args: {
        objectId,
        styleId,
        ...(projectSceneProject === undefined ? {} : { project: projectSceneProject }),
      },
    })),
    selection.length === 1
      ? `Applied text style ${styleId}`
      : `Applied text style ${styleId} to ${selection.length} objects`,
  );
}

function onMaterialManagerClick(event: MouseEvent): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const row = target.closest<HTMLLIElement>('li[role="listitem"][id^="material/"]');
  const nodeId = button?.dataset.for ?? row?.id;
  const material = scene.materials.find(
    (candidate) => `material/${candidate.materialId}` === nodeId,
  );
  if (!material) return;

  selectedMaterialId = material.materialId;
  renderPanels(scene);

  if (button?.dataset.action !== undefined && button.dataset.action !== "reveal") return;
  const users = usersOf(scene, material.materialId);
  log(
    users.length === 0
      ? `Material ${material.name} has no object users.`
      : `Material ${material.name} is used by object(s): ${users.join(", ")}.`,
  );
}

function onAssetManagerClick(event: MouseEvent): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLLIElement>('li[role="listitem"][id^="asset/"]');
  const asset = scene.assets.find((candidate) => `asset/${candidate.assetId}` === row?.id);
  if (!asset) return;

  selectedAssetId = asset.assetId;
  renderPanels(scene);

  const users = assetUsers(scene, asset.assetId);
  log(
    users.length === 0
      ? `Asset ${asset.name} is used by no objects.`
      : `Asset ${asset.name} is used by object(s): ${users.join(", ")}.`,
  );
}

function onBindingsClick(event: MouseEvent): void {
  if (!scene || selection.length !== 1) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const nodeId = button?.dataset.for;
  const action = button?.dataset.action;
  if (!nodeId?.startsWith("binding/property/") || !action) return;
  const property = nodeId.slice("binding/property/".length);
  const objectId = selection[0];
  if (!objectId) return;

  let path: string | undefined;
  if (action === "bind") {
    const object = scene.objects.find((candidate) => candidate.id === objectId);
    const previous = object?.bindings?.[property];
    const entered = window.prompt(
      `Data path for ${property} (for example match.homeScore)`,
      typeof previous === "string" ? previous : "",
    );
    if (entered === null) return;
    path = entered.trim();
  } else if (action !== "removeBinding") {
    return;
  }

  const outcome = applyBindingEdit(scene, objectId, property, path);
  if (!outcome.ok) {
    log(`binding refused: ${outcome.reason}`, "bad");
    return;
  }
  commitScene(scene, outcome.document, outcome.transaction.label);
}

/** Show what the preview could not draw.
 *
 *  Never silently skipped: an object missing from the picture with no
 *  explanation is the failure mode invariant 18 exists to prevent, and the
 *  preview obeys the same rule the engine does. */
function renderUnsupported(reasons: readonly string[]): void {
  ui.unsupportedList.replaceChildren();
  ui.unsupportedPanel.hidden = reasons.length === 0;
  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    ui.unsupportedList.append(item);
  }
  if (reasons.length > 0) {
    log(`${reasons.length} object(s) not drawn by the preview`, "bad");
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

function setProjectOptions(next: readonly string[], preferred?: string): void {
  projects = [...next];
  ui.projectSelect.replaceChildren();
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project;
    option.textContent = project;
    ui.projectSelect.append(option);
  }
  currentProject =
    (preferred && projects.includes(preferred) ? preferred : undefined) ??
    (currentProject && projects.includes(currentProject) ? currentProject : undefined) ??
    projects[0];
  ui.projectSelect.disabled = currentProject === undefined;
  if (currentProject !== undefined) ui.projectSelect.value = currentProject;
}

async function refreshProjectCatalog(): Promise<void> {
  const project = currentProject;
  if (project === undefined) {
    projectCatalog = undefined;
    takePageCatalog = undefined;
    renderProjectManager();
    if (scene) renderTakePagePanel(scene);
    return;
  }
  const [scenes, pages] = await Promise.all([
    invoke<ProjectSceneCatalog>("cmd_scene_list", { project }),
    invoke<ProjectTakePageCatalog>("cmd_take_page_list", { project }),
  ]);
  projectCatalog = scenes;
  takePageCatalog = pages;
  renderProjectManager();
  if (scene) renderTakePagePanel(scene);
}


/// Drop a stale refusal from the take-page state.
///
/// The key is removed rather than set to `undefined`: under
/// `exactOptionalPropertyTypes` "there is no refusal" is the absence of the
/// property, and the two must not become separately representable.
function withoutTakePageRefusal(state: TakePageState): TakePageState {
  const { refusal: _cleared, ...rest } = state;
  return rest;
}

function effectiveTakePageValues(template: SceneDocument): Record<string, ControlValue> {
  const defaults: Record<string, ControlValue> = {};
  for (const field of template.controls) {
    if (field.default !== undefined) defaults[field.fieldId] = field.default;
  }
  // An unknown saved field remains present deliberately: Rust then names it
  // instead of the UI silently deleting an operator's value.
  return { ...defaults, ...takePageState.values };
}

async function previewTakePageValues(): Promise<boolean> {
  if (!scene) {
    log("take-page preview refused: nothing is open", "bad");
    return false;
  }
  const template = JSON.stringify(scene);
  try {
    const filled = await invoke<SceneDocument>("cmd_take_page_preview", {
      scene,
      values: effectiveTakePageValues(scene),
    });
    if (JSON.stringify(scene) !== template) {
      throw new Error("take-page preview changed the open template");
    }
    takePageState = withoutTakePageRefusal(takePageState);
    takePagePreviewDocument = filled;
    renderSceneState();
    log(`previewed take-page values for ${scene.name}`, "good");
    return true;
  } catch (error) {
    takePageState = { ...takePageState, refusal: describe(error) };
    renderPanels(scene);
    log(`take-page preview refused: ${takePageState.refusal}`, "bad");
    return false;
  }
}

async function saveTakePage(): Promise<void> {
  if (!scene) {
    log("take-page save refused: nothing is open", "bad");
    return;
  }
  const project = projectSceneProject;
  if (project === undefined || projectSceneId !== scene.id) {
    log("take-page save refused: save this template in a project first", "bad");
    return;
  }
  const pageId = ui.takePageId.value.trim();
  const name = ui.takePageName.value.trim();
  if (!pageId || !name) {
    log("take-page save refused: page id and name are both required", "bad");
    return;
  }
  takePageState = {
    ...takePageState,
    pageId,
    name,
    values: effectiveTakePageValues(scene),
  };
  if (!(await previewTakePageValues())) return;
  const page: TakePage = { pageId, name, sceneId: scene.id, values: takePageState.values };
  try {
    takePageCatalog = await invoke<ProjectTakePageCatalog>("cmd_take_page_save", { project, page });
    renderPanels(scene);
    log(`saved take page ${project}/${pageId}`, "good");
  } catch (error) {
    log(`take-page save refused: ${describe(error)}`, "bad");
  }
}

async function openTakePage(): Promise<void> {
  if (!scene) return;
  const project = projectSceneProject;
  const pageId = ui.takePageSelect.value;
  if (project === undefined || !pageId) {
    log("take-page open refused: no saved page is selected", "bad");
    return;
  }
  try {
    const page = await invoke<TakePage>("cmd_take_page_read", { project, pageId });
    if (page.sceneId !== scene.id) {
      log(
        `take-page open refused: ${page.pageId} belongs to template ${page.sceneId}, not ${scene.id}`,
        "bad",
      );
      return;
    }
    // A `BTreeMap` generates with optional values, so a key present with no
    // value is expressible on the wire but meaningless here: an absent field
    // is absent, not set-to-nothing. Drop those rather than widening the
    // state type and letting `undefined` masquerade as an entered value.
    const stored: Record<string, ControlValue> = {};
    for (const [fieldId, value] of Object.entries(page.values)) {
      if (value !== undefined) stored[fieldId] = value;
    }
    takePageState = { pageId: page.pageId, name: page.name, values: stored };
    await previewTakePageValues();
    log(`opened take page ${project}/${pageId}`, "good");
  } catch (error) {
    log(`take-page open refused: ${describe(error)}`, "bad");
  }
}

async function loadProjects(preferred?: string): Promise<void> {
  try {
    setProjectOptions(await invoke<string[]>("cmd_project_list"), preferred);
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
    renderProjectManager();
  }
}

function refusesDiscard(action: string): boolean {
  if (!projectSceneDirty || projectSceneId === undefined) return false;
  log(
    `${action} refused: ${projectSceneId} has unsaved project changes; use Save here first`,
    "bad",
  );
  return true;
}

async function createProject(): Promise<void> {
  const proposed = window.prompt("Project name");
  if (proposed === null) return;
  const project = proposed.trim();
  if (!project) {
    log("project creation refused: project name is empty", "bad");
    return;
  }
  try {
    const listed = await invoke<string[]>("cmd_project_create", { project });
    setProjectOptions(listed, project);
    await refreshProjectCatalog();
    log(`created project ${project}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function selectProject(): Promise<void> {
  const project = ui.projectSelect.value;
  if (!project || project === currentProject) return;
  if (refusesDiscard("switch project")) {
    if (currentProject !== undefined) ui.projectSelect.value = currentProject;
    return;
  }
  currentProject = project;
  projectCatalog = undefined;
  renderProjectManager();
  try {
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function saveProjectScene(): Promise<void> {
  if (!scene) {
    log("project save refused: nothing is open", "bad");
    return;
  }
  const project = currentProject;
  if (project === undefined) {
    log("project save refused: no project exists", "bad");
    return;
  }
  const boundId = projectSceneProject === project ? projectSceneId : undefined;
  const boundHere = boundId !== undefined;
  const id = (boundId ?? ui.sceneId.value).trim();
  const name = ui.sceneName.value.trim();
  if (!id || !name) {
    log("project save refused: scene id and name are both required", "bad");
    return;
  }
  const next: SceneDocument = { ...scene, id, name };
  try {
    projectCatalog = await invoke<ProjectSceneCatalog>(
      boundHere ? "cmd_scene_update" : "cmd_scene_create",
      { project, scene: next },
    );
    scene = next;
    scenePath = null;
    projectSceneProject = project;
    projectSceneId = id;
    projectSceneDirty = false;
    ui.sceneId.value = id;
    ui.sceneId.readOnly = true;
    ui.sceneId.title = "Project scene ids are stable; use Duplicate to create a new id.";
    renderSceneState();
    log(`${boundHere ? "updated" : "created"} ${project}/${id}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function openProjectScene(sceneId: string): Promise<void> {
  if (refusesDiscard(`open ${sceneId}`)) return;
  const project = currentProject;
  if (project === undefined) return;
  try {
    const loaded = await invoke<SceneDocument>("cmd_scene_read", { project, sceneId });
    showScene(loaded, null, { project, sceneId });
    log(`opened ${project}/${sceneId}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function duplicateProjectScene(sceneId: string): Promise<void> {
  if (refusesDiscard(`duplicate ${sceneId}`)) return;
  const project = currentProject;
  if (project === undefined) return;
  const proposedId = window.prompt("Duplicate scene id", `${sceneId}-copy`);
  if (proposedId === null) return;
  const newId = proposedId.trim();
  if (!newId) {
    log("duplicate refused: scene id is empty", "bad");
    return;
  }
  try {
    const source = await invoke<SceneDocument>("cmd_scene_read", { project, sceneId });
    const proposedName = window.prompt("Duplicate scene name", `${source.name} Copy`);
    if (proposedName === null) return;
    const name = proposedName.trim();
    if (!name) {
      log("duplicate refused: scene name is empty", "bad");
      return;
    }
    const { revision: _publishedRevision, ...unpublished } = source;
    const duplicate = { ...unpublished, id: newId, name } as SceneDocument;
    projectCatalog = await invoke<ProjectSceneCatalog>("cmd_scene_create", {
      project,
      scene: duplicate,
    });
    showScene(duplicate, null, { project, sceneId: newId });
    log(`duplicated ${project}/${sceneId} as ${newId}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function publishProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  if (
    projectSceneDirty &&
    projectSceneProject === project &&
    projectSceneId === sceneId
  ) {
    log(`publish refused: ${sceneId} has unsaved changes`, "bad");
    return;
  }
  const endpoint = ui.endpoint.value.trim();
  try {
    const stored = await invoke<SceneDocument>("cmd_scene_read", { project, sceneId });
    const result = await invoke<PublishResult>("cmd_publish", { endpoint, scene: stored });
    const takeId = plain(result.takeId);
    const revision = Number(plain(result.revision));
    if (projectCatalog?.project === project) {
      projectCatalog = {
        ...projectCatalog,
        scenes: projectCatalog.scenes.map((candidate) =>
          candidate.sceneId === sceneId
            ? { ...candidate, publishedRevision: revision }
            : candidate,
        ),
      };
      renderProjectManager();
    }
    log(`published ${takeId} revision ${revision}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function deleteProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  if (
    projectSceneDirty &&
    projectSceneProject === project &&
    projectSceneId === sceneId
  ) {
    log(`delete refused: ${sceneId} has unsaved changes`, "bad");
    return;
  }
  try {
    projectCatalog = await invoke<ProjectSceneCatalog>("cmd_scene_delete", {
      project,
      sceneId,
    });
    if (projectSceneProject === project && projectSceneId === sceneId) {
      projectSceneProject = undefined;
      projectSceneId = undefined;
      projectSceneDirty = false;
      ui.sceneId.readOnly = false;
      ui.sceneId.title = "";
      renderProjectManager();
      log(`deleted ${project}/${sceneId}; the document remains open outside the project`, "good");
    } else {
      renderProjectManager();
      log(`deleted ${project}/${sceneId}`, "good");
    }
  } catch (error) {
    log(describe(error), "bad");
  }
}

function onSceneManagerClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  if (!button) return;
  const unavailable = button.dataset.unavailable;
  if (unavailable) {
    log(unavailable, "bad");
    return;
  }
  const forId = button.dataset.for;
  const sceneId = forId?.startsWith("scene/") ? forId.slice("scene/".length) : undefined;
  if (!sceneId) return;
  switch (button.dataset.action) {
    case "open":
      void openProjectScene(sceneId);
      break;
    case "duplicate":
      void duplicateProjectScene(sceneId);
      break;
    case "publish":
      void publishProjectScene(sceneId);
      break;
    case "delete":
      void deleteProjectScene(sceneId);
      break;
  }
}

async function newScene(): Promise<void> {
  if (refusesDiscard("new scene")) return;
  const id = ui.sceneId.value.trim() || "untitled";
  const name = ui.sceneName.value.trim() || "Untitled";
  try {
    const created = await invoke<SceneDocument>("cmd_new_scene", { id, name });
    showScene(created, null);
    log(`new scene ${created.id}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function openScene(): Promise<void> {
  if (refusesDiscard("open file")) return;
  try {
    const picked = await tauri?.dialog?.open({
      multiple: false,
      filters: [{ name: "Scene document", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;

    const loaded = await invoke<SceneDocument>("cmd_load_scene", { path });
    showScene(loaded, path);
    log(`opened ${path}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function saveScene(): Promise<void> {
  if (!scene) {
    log("nothing to save", "bad");
    return;
  }
  try {
    const path =
      scenePath ??
      (await tauri?.dialog?.save({
        defaultPath: `${scene.id}.json`,
        filters: [{ name: "Scene document", extensions: ["json"] }],
      }));
    if (!path) return;

    // Identity edits apply on save: the fields are the document's, not a
    // separate piece of UI state that could drift from it.
    scene = { ...scene, id: ui.sceneId.value.trim(), name: ui.sceneName.value.trim() };
    await invoke<void>("cmd_save_scene", { path, scene });
    scenePath = path;
    log(`saved ${path}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function publish(): Promise<void> {
  if (!scene) {
    log("nothing to publish", "bad");
    return;
  }
  const endpoint = ui.endpoint.value.trim();
  ui.publish.disabled = true;
  ui.publishResult.hidden = true;

  try {
    scene = { ...scene, id: ui.sceneId.value.trim(), name: ui.sceneName.value.trim() };
    const result = await invoke<PublishResult>("cmd_publish", { endpoint, scene });
    const takeId = plain(result.takeId);
    const revision = plain(result.revision);

    // The revision is the operative fact: Playout takes an exact revision, so
    // reporting "published" without it would leave the operator guessing.
    ui.publishResult.className = "result good";
    ui.publishResult.textContent = `${takeId} revision ${revision}`;
    ui.publishResult.hidden = false;
    log(`published ${takeId} revision ${revision}`, "good");
  } catch (error) {
    const message = describe(error);
    ui.publishResult.className = "result bad";
    ui.publishResult.textContent = message;
    ui.publishResult.hidden = false;
    log(message, "bad");
  } finally {
    ui.publish.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Start.
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  // The curtain is visible in the markup, so this is the only place it comes
  // down: no shell, no Editor. Everything below this line can assume `invoke`
  // actually reaches Rust.
  if (!tauri) return;
  ui.curtain.hidden = true;

  ui.newScene.addEventListener("click", () => void newScene());
  ui.openScene.addEventListener("click", () => void openScene());
  ui.saveScene.addEventListener("click", () => void saveScene());
  ui.projectCreate.addEventListener("click", () => void createProject());
  ui.projectRefresh.addEventListener("click", () => void loadProjects(currentProject));
  ui.projectSaveScene.addEventListener("click", () => void saveProjectScene());
  ui.projectSelect.addEventListener("change", () => void selectProject());
  ui.sceneManagerMount.addEventListener("click", onSceneManagerClick);
  ui.sceneName.addEventListener("input", () => {
    if (projectSceneId === undefined) return;
    projectSceneDirty = true;
    renderProjectManager();
  });
  ui.publish.addEventListener("click", () => void publish());
  ui.takePagePreview.addEventListener("click", () => void previewTakePageValues());
  ui.takePageSave.addEventListener("click", () => void saveTakePage());
  ui.takePageOpen.addEventListener("click", () => void openTakePage());
  ui.takePageId.addEventListener("input", () => {
    takePageState = { ...withoutTakePageRefusal(takePageState), pageId: ui.takePageId.value };
  });
  ui.takePageName.addEventListener("input", () => {
    takePageState = { ...withoutTakePageRefusal(takePageState), name: ui.takePageName.value };
  });
  ui.timelineEasing.addEventListener("change", onEasingChosen);
  ui.timelinePresetApply.addEventListener("click", () => void applyStarterPreset());
  ui.phaseSet.addEventListener("click", () => void setPhaseFromSelection());
  ui.phaseRemove.addEventListener("click", () => void removePhaseAtPlayhead());
  ui.phasePlay.addEventListener("click", () => playPhaseAtPlayhead());
  ui.objectManager.addEventListener("click", onObjectManagerClick);
  ui.sceneTabs.addEventListener("click", onSceneTabsClick);
  ui.objectCreate.addEventListener("click", () => void createObject());
  ui.objectDuplicate.addEventListener("click", () => void duplicateObject());
  ui.objectRename.addEventListener("click", () => void renameObject());
  ui.objectDelete.addEventListener("click", () => void deleteObject());
  ui.fontMount.addEventListener("click", onFontManagerClick);
  ui.textStyleMount.addEventListener("click", (event) => void onTextStyleClick(event));
  ui.materialMount.addEventListener("click", onMaterialManagerClick);
  ui.assetMount.addEventListener("click", onAssetManagerClick);
  ui.bindings.addEventListener("click", onBindingsClick);
  ui.controlMount.addEventListener("click", (event) => void onControlContractClick(event));
  ui.animationFrame.addEventListener("change", () => {
    setCurrentFrame(Number(ui.animationFrame.value));
  });
  ui.timelineGraphClose.addEventListener("click", closeSpeedGraph);
  ui.timelineZoom.addEventListener("input", onTimelineZoom);
  ui.timelineMount.addEventListener("click", onTimelineClick);
  ui.timelineMount.addEventListener("pointerdown", onTimelinePointerDown);
  ui.timelineMount.addEventListener("pointermove", onTimelinePointerMove);
  ui.timelineMount.addEventListener("pointerup", (event) => finishKeyDrag(event, false));
  ui.timelineMount.addEventListener("pointercancel", (event) => finishKeyDrag(event, true));
  document.addEventListener("keydown", onTimelineKeyDown);
  window.addEventListener("resize", () => {
    applyLayoutSizes();
    if (scene) renderTimeline(scene);
  });
  // B.2: recompute on a scale-factor change, never cache the ratio at
  // startup. A browser has no `ScaleFactorChanged`, so the ratio is observed
  // through a re-arming media query — see `Editor/src/dpi.ts` for why arming
  // it once would catch only the first monitor move.
  watchDevicePixelRatio(window, (ratio) => {
    if (!scene) return;
    // The document is untouched: a 1920×1080 scene is 1920×1080 on any
    // monitor. Only the backing stores and the raster change.
    renderTimeline(scene);
    viewport?.render();
    log(`display scale changed to ${Math.round(ratio * 100)}%`);
  });
  ui.undo.addEventListener("click", () => undo());
  ui.redo.addEventListener("click", () => redo());
  ui.previewPlay.addEventListener("click", () => togglePreview());
  document.addEventListener("keydown", onPreviewShortcut);
  ui.autoKey.addEventListener("change", () => {
    autoKey = ui.autoKey.checked;
    log(`Auto-Key ${autoKey ? "on" : "off"}`);
  });
  ui.animationMount.addEventListener("click", onAnimationClick);
  ui.animationMount.addEventListener("change", onAnimationChange);
  ui.animationMount.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const property = target.closest<HTMLElement>(".keyframe-row")?.dataset.property;
    if (property) openKeyframeMenu(event, property);
  });
  ui.inspector.addEventListener("contextmenu", onInspectorContextMenu);
  ui.overlay.addEventListener("contextmenu", (event) => openKeyframeMenu(event));
  ui.keyframeMenu.addEventListener("click", onKeyframeMenuClick);
  document.addEventListener("pointerdown", (event) => {
    if (!ui.keyframeMenu.hidden && !ui.keyframeMenu.contains(event.target as Node)) {
      closeKeyframeMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.keyframeMenu.hidden) {
      closeKeyframeMenu();
      event.stopPropagation();
      return;
    }
    // Undo/redo, but never steal a text field's own edit history.
    const target = event.target;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (editing || !(event.ctrlKey || event.metaKey) || animationBusy) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  });
  ui.overlay.addEventListener("pointerdown", onOverlayPointerDown);
  ui.overlay.addEventListener("pointermove", onOverlayPointerMove);
  ui.overlay.addEventListener("pointerup", (event) => finishOverlayPointer(event, false));
  ui.overlay.addEventListener("pointercancel", (event) => finishOverlayPointer(event, true));
  ui.overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    overlayDrag = undefined;
    marquee = undefined;
    guides = [];
    setSelection([]);
  });

  // 11.2: measure WebGPU once at startup and say what it means for the WASM
  // fallback. Recorded rather than acted on — this decides a later design
  // question, it does not change how the Editor draws today.
  gpuReport = await probeWebGpu(
    (navigator as Navigator & { gpu?: Parameters<typeof probeWebGpu>[0] }).gpu,
  );
  log(summariseGpuReport(gpuReport), gpuReport.kind === "available" ? "good" : "bad");

  try {
    animationSurface = await invoke<AnimationSurface>("cmd_animation_surface");
  } catch (error) {
    animationSurface = null;
    log(`animation contract unavailable: ${describe(error)}`, "bad");
  }
  await loadMotionLibrary();
  await loadObjectKinds();
  await loadProjects();
  applyStoredLayout();
  wireDocking();

  try {
    ui.endpoint.value = await invoke<string>("cmd_default_endpoint");
  } catch {
    // A default that cannot be read is not fatal; the author types one.
    ui.endpoint.value = "";
  }

  ui.sceneId.value = "untitled";
  ui.sceneName.value = "Untitled";
  await newScene();
}

// ---------------------------------------------------------------------------
// Dockable workspace (11.5). The model owns valid moves and sizes; this block
// turns pointer/keyboard gestures into those operations and persists them.
// ---------------------------------------------------------------------------

let layout: Layout = defaultLayout();
let draggedPanel: string | null = null;
let resizeGesture:
  | {
      readonly region: RegionId;
      readonly handle: HTMLElement;
      readonly startClient: number;
      readonly startSize: number;
      readonly axisSize: number;
    }
  | undefined;

function panelsInMarkup(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-panel]")).map(
    (element) => element.dataset.panel!,
  );
}

function regionElement(region: RegionId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.dock-region[data-region="${region}"]`);
}

function applyLayoutSizes(): void {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  const width = workspace?.getBoundingClientRect().width ?? window.innerWidth;
  for (const region of ["left", "right"] as const) {
    const host = regionElement(region);
    if (host) host.style.width = `${Math.round(layout.regions[region].size * width)}px`;
  }
  const bottom = regionElement("bottom");
  if (bottom) {
    bottom.style.height = `${Math.round(layout.regions.bottom.size * window.innerHeight)}px`;
  }
}

function configureDockHandles(): void {
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"))) {
    if (panel.dataset.panel === "viewport") continue;
    const handle = panel.querySelector<HTMLElement>(
      ":scope > .panel-title-row h2, :scope > h2, :scope > .timeline-head h2, :scope > .pane-head h2",
    );
    if (!handle) continue;
    handle.draggable = true;
    handle.dataset.dockHandle = "true";
    handle.title = `Drag ${handle.textContent?.trim() || panel.dataset.panel} to another dock`;
  }
}

function renderLayout(): void {
  for (const region of REGIONS) {
    const host = regionElement(region);
    if (!host) continue;
    for (const panel of layout.regions[region].panels) {
      const element = document.querySelector<HTMLElement>(`[data-panel="${panel}"]`);
      if (element && element !== host && element.parentElement !== host) host.append(element);
    }
    host.hidden = layout.regions[region].panels.length === 0;
    host.classList.toggle("collapsed", layout.regions[region].collapsed);
    const resizer = document.querySelector<HTMLElement>(
      `.dock-resizer[data-resize-region="${region}"]`,
    );
    if (resizer) resizer.hidden = host.hidden;
  }
  applyLayoutSizes();
  configureDockHandles();
}

function applyStoredLayout(): void {
  const restored = restoreLayout(window.localStorage, panelsInMarkup());
  layout = restored.layout;
  for (const note of restored.notes) log(`workspace layout: ${note}`);
  renderLayout();
}

function dockPanel(panel: string, region: RegionId, index?: number): void {
  const next = movePanel(layout, panel, region, index);
  if (isLayoutRefused(next)) {
    log(next.refused, "bad");
    return;
  }
  layout = next;
  persistLayout(window.localStorage, layout);
  renderLayout();
  log(`moved ${panel} to ${region}`, "good");
}

function dropIndex(host: HTMLElement, clientY: number): number {
  const panels = Array.from(host.querySelectorAll<HTMLElement>(":scope > [data-panel]")).filter(
    (panel) => panel.dataset.panel !== draggedPanel,
  );
  const before = panels.findIndex((panel) => clientY < panel.getBoundingClientRect().top + panel.getBoundingClientRect().height / 2);
  return before < 0 ? panels.length : before;
}

function clearDockGesture(): void {
  document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
  document.querySelectorAll(".dock-dragging").forEach((node) => node.classList.remove("dock-dragging"));
  draggedPanel = null;
}

function resizeBy(region: RegionId, delta: number): void {
  const next = resizeRegion(layout, region, layout.regions[region].size + delta);
  if (isLayoutRefused(next)) {
    log(next.refused, "bad");
    return;
  }
  layout = next;
  persistLayout(window.localStorage, layout);
  renderLayout();
}

function wireDocking(): void {
  document.addEventListener("dragstart", (event) => {
    const handle = (event.target as Element | null)?.closest<HTMLElement>("[data-dock-handle]");
    const panel = handle?.closest<HTMLElement>("[data-panel]");
    if (!panel?.dataset.panel || !event.dataTransfer) return;
    draggedPanel = panel.dataset.panel;
    panel.classList.add("dock-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPanel);
  });
  document.addEventListener("dragover", (event) => {
    if (!draggedPanel) return;
    const host = (event.target as Element | null)?.closest<HTMLElement>(".dock-region");
    if (!host?.dataset.region) return;
    event.preventDefault();
    document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    host.classList.add("drop-target");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  document.addEventListener("drop", (event) => {
    const host = (event.target as Element | null)?.closest<HTMLElement>(".dock-region");
    const region = host?.dataset.region as RegionId | undefined;
    if (!draggedPanel || !host || !region || !REGIONS.includes(region)) return;
    event.preventDefault();
    const panel = draggedPanel;
    const index = dropIndex(host, event.clientY);
    clearDockGesture();
    dockPanel(panel, region, index);
  });
  document.addEventListener("dragend", clearDockGesture);

  document.addEventListener("pointerdown", (event) => {
    const handle = (event.target as Element | null)?.closest<HTMLElement>(".dock-resizer");
    const region = handle?.dataset.resizeRegion as RegionId | undefined;
    if (!handle || !region || !REGIONS.includes(region)) return;
    const horizontal = region === "bottom";
    resizeGesture = {
      region,
      handle,
      startClient: horizontal ? event.clientY : event.clientX,
      startSize: layout.regions[region].size,
      axisSize: horizontal
        ? window.innerHeight
        : (document.querySelector<HTMLElement>(".workspace")?.getBoundingClientRect().width ??
          window.innerWidth),
    };
    handle.classList.add("resizing");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (!resizeGesture) return;
    const horizontal = resizeGesture.region === "bottom";
    const client = horizontal ? event.clientY : event.clientX;
    const sign = resizeGesture.region === "left" ? 1 : -1;
    const next = resizeRegion(
      layout,
      resizeGesture.region,
      resizeGesture.startSize + (sign * (client - resizeGesture.startClient)) / resizeGesture.axisSize,
    );
    if (!isLayoutRefused(next)) {
      layout = next;
      renderLayout();
    }
  });
  const finishResize = (): void => {
    if (!resizeGesture) return;
    resizeGesture.handle.classList.remove("resizing");
    persistLayout(window.localStorage, layout);
    log(`resized ${resizeGesture.region} dock`, "good");
    resizeGesture = undefined;
  };
  document.addEventListener("pointerup", finishResize);
  document.addEventListener("pointercancel", finishResize);
  document.addEventListener("keydown", (event) => {
    const handle = (event.target as Element | null)?.closest<HTMLElement>(".dock-resizer");
    const region = handle?.dataset.resizeRegion as RegionId | undefined;
    if (!region || !REGIONS.includes(region)) return;
    const grows =
      (region === "left" && event.key === "ArrowRight") ||
      (region === "right" && event.key === "ArrowLeft") ||
      (region === "bottom" && event.key === "ArrowUp");
    const shrinks =
      (region === "left" && event.key === "ArrowLeft") ||
      (region === "right" && event.key === "ArrowRight") ||
      (region === "bottom" && event.key === "ArrowDown");
    if (!grows && !shrinks) return;
    event.preventDefault();
    resizeBy(region, grows ? 0.025 : -0.025);
  });
  document.getElementById("workspace-reset")?.addEventListener("click", resetLayout);
}

function resetLayout(): void {
  layout = defaultLayout();
  persistLayout(window.localStorage, layout);
  renderLayout();
  log("workspace layout reset to the card-sort layout", "good");
}

void start();
