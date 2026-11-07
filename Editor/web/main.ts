// The Editor shell's web layer (build plan 11.1).
//
// This file is wiring, deliberately. Every decision it could get wrong lives
// somewhere already tested:
//
//   - what a scene is, whether it is valid, and whether an edit may happen:
//     Rust. Every authoring change is one `EditorCommand` sent through
//     `Editor/src/command-client.ts` (11.36); Rust owns the open documents,
//     their history and the project store, and refuses by name;
//   - how the scene is drawn: `Editor/src/viewport.ts`, tested headless;
//   - what a colour means: `Editor/src/color-policy.ts` and the contracts.
//
// What is left here is turning clicks into commands and pure reads, and
// rendering the `SessionView` Rust answers with. In particular this layer
// never decides that an object "could not be drawn" quietly: `SceneViewport`
// collects reasons, and they are shown.

import type {
  AnimationSurface,
  RationalRate,
  SessionKey,
  CommandOutcome,
  ImportReport,
  ControlField,
  ControlValue,
  EditEffect,
  EditorModule,
  EditorCommand,
  MotionPreset,
  Refusal,
  SceneDocument,
  SceneEasing,
  SceneEdit,
  SceneKeyframe,
  AssetLibraryItem,
  PreparedAssetBatch,
  PreparedFontBatch,
  SceneTarget,
  SessionView,
  TextStyle,
  TakePage,
  TimelinePhase,
} from "@grapix/contracts";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { presetBlocker, presetBrowserPanel } from "../src/motion-preset-browser";
import { SceneViewport } from "../src/viewport";
import { GraphicPreviewRenderer } from "../src/graphic-preview";
import { renderNode } from "../src/agent-surface";
import { BROADCAST_RATES, parseRateChoice, rateKey, sameRate } from "../src/frame-rate";
import { sceneImportPanel } from "../src/import-panel";
import {
  objectManagerPanel,
  selectionRoots,
  setObjectExpanded,
} from "../src/object-manager";
import {
  fieldEditLabel,
  inspectorEdits,
  inspectorPanel,
  inspectorSections,
  isRefused,
  parseFieldInput,
} from "../src/inspector";
import {
  FONT_LINK_SOURCES,
  FONT_STATUS_FILTERS,
  fontAssignTargets,
  fontLinkFor,
  fontManagerPanel,
  fontStatus,
  fontUpdateRefused,
  fontUsers,
  isFontRemovalRefused,
  parseFallbackFamilies,
  planFontRemoval,
  withIngestNames,
  type FontLinkSource,
  type FontManagerState,
  type FontPatch,
  type FontStatusFilter,
} from "../src/font-manager";
import {
  browserFontEnvironment,
  FontRegistry,
  registrationFailureSummary,
  type FontRegistrationReport,
} from "../src/font-registration";
import {
  materialManagerPanel,
  usersOf,
} from "../src/material-manager";
import {
  ASSET_FILE_EXTENSIONS,
  assetManagerPanel,
  assetUsers,
  describeVideoCodec,
  planAssetRelink,
  type AssetPreview,
} from "../src/asset-manager";
import { textStylePanel, textStyleUsers } from "../src/text-style";
import {
  sceneManagerPanel,
  type ManagedScene,
} from "../src/scene-manager";
import {
  bindingLabel,
  bindingPanel,
  dataFields,
  describeBindingIssue,
  formatSampleData,
  parseSampleData,
  resolveSceneBindings,
  sceneBindingIssues,
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
  customBezierFromInputs,
  keyframeContextItems,
  keyframeForValue,
  keyframePanelModel,
  propertyValueAt,
  renderPropertyKeyControls,
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
  applySessionView,
  captureWorkingCopy,
  emptyWorkspace,
  isRefused as isWorkspaceRefused,
  removeSession,
  sceneTabs,
  sessionFor,
  type SceneSession,
} from "../src/workspace";
import { execute, shell, wireFrame } from "../src/command-client";
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
import { timelineLayers as describeTimelineLayers, layerSignature } from "../src/timeline/layers";
import { formatTimecode, formatFrameLine, formatRate } from "../src/timeline/clock";
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
  scrollViewportByWheel,
  timelineSnapshotFor,
  viewportForBounds,
  watchSurfaceSize,
} from "../src/timeline/surface";
import {
  DEFAULT_PIXELS_PER_FRAME,
  DEFAULT_ROW_HEIGHT,
  frameToX,
  rowWindow,
  xToFrame,
  type TimelineViewport,
} from "../src/timeline/viewport";

/** What `cmd_publish` answers with: the shell's own transport shape. Both
 *  fields are serde newtypes, which arrive bare or as a one-field tuple. */
interface PublishResult {
  takeId: string | { 0: string };
  revision: number | { 0: number };
  /** The content hash Playout must pin to load this revision (11.38). */
  contentHash: string | { 0: string };
}

/** The shell's structured errors (`EditorError` in Editor/shell). Every
 *  variant carries enough to say what actually happened; a bare string would
 *  let a refusal read as a crash. `cause` is the named contract refusal. */
interface ShellError {
  error: string;
  detail?: string;
  endpoint?: string;
  path?: string;
  cause?: Refusal;
}

interface ListedScene {
  readonly sceneId: string;
  readonly name: string;
  readonly publishedRevision?: number;
  readonly unavailableReason?: string;
}

interface ProjectSceneCatalog {
  readonly project: string;
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
  importSvg: need<HTMLButtonElement>("import-svg"),
  importReportDialog: need<HTMLDialogElement>("import-report-dialog"),
  importReportMount: need<HTMLDivElement>("import-report-mount"),
  saveScene: need<HTMLButtonElement>("save-scene"),
  projectSelect: need<HTMLSelectElement>("project-select"),
  projectCreate: need<HTMLButtonElement>("project-create"),
  projectRefresh: need<HTMLButtonElement>("project-refresh"),
  projectSaveScene: need<HTMLButtonElement>("project-save-scene"),
  graphicCreate: need<HTMLButtonElement>("graphic-create"),
  graphicSearch: need<HTMLInputElement>("graphic-search"),
  managerDialog: need<HTMLDialogElement>("manager-create-dialog"),
  managerForm: need<HTMLFormElement>("manager-create-form"),
  managerName: need<HTMLInputElement>("manager-create-name"),
  managerError: need<HTMLParagraphElement>("manager-create-error"),
  sceneManagerMount: need<HTMLDivElement>("scene-manager-mount"),
  sceneManagerEmpty: need<HTMLParagraphElement>("scene-manager-empty"),
  canvas: need<HTMLCanvasElement>("viewport"),
  previewPlay: need<HTMLButtonElement>("preview-play"),
  previewStatus: need<HTMLSpanElement>("preview-status"),
  overlay: need<SVGSVGElement>("viewport-overlay"),
  sceneTabs: need<HTMLElement>("scene-tabs"),
  canvasSize: need<HTMLSpanElement>("canvas-size"),
  canvasRate: need<HTMLSelectElement>("canvas-rate"),
  managerRate: need<HTMLSelectElement>("manager-create-rate"),
  managerRateRow: need<HTMLDivElement>("manager-create-rate-row"),
  managerCustomRate: need<HTMLDivElement>("manager-create-custom-rate"),
  managerRateNum: need<HTMLInputElement>("manager-create-rate-num"),
  managerRateDen: need<HTMLInputElement>("manager-create-rate-den"),
  timelineRulerTicks: need<HTMLDivElement>("timeline-ruler-ticks"),
  timelinePlayhead: need<HTMLDivElement>("timeline-playhead"),
  objectManager: need<HTMLDivElement>("object-manager"),
  objectKind: need<HTMLSelectElement>("object-kind"),
  objectCreate: need<HTMLButtonElement>("object-create"),
  objectDuplicate: need<HTMLButtonElement>("object-duplicate"),
  objectRename: need<HTMLButtonElement>("object-rename"),
  objectDelete: need<HTMLButtonElement>("object-delete"),
  bindings: need<HTMLDivElement>("bindings-mount"),
  sampleDataText: need<HTMLTextAreaElement>("sample-data-text"),
  sampleDataApply: need<HTMLButtonElement>("sample-data-apply"),
  sampleDataRevert: need<HTMLButtonElement>("sample-data-revert"),
  sampleDataStatus: need<HTMLParagraphElement>("sample-data-status"),
  sampleDataIssues: need<HTMLUListElement>("sample-data-issues"),
  controlMount: need<HTMLDivElement>("control-mount"),
  fontMount: need<HTMLDivElement>("font-mount"),
  fontEmpty: need<HTMLParagraphElement>("font-empty"),
  fontSearch: need<HTMLInputElement>("font-search"),
  fontStatusFilter: need<HTMLSelectElement>("font-status-filter"),
  fontLinkSource: need<HTMLSelectElement>("font-link-source"),
  fontLink: need<HTMLInputElement>("font-link"),
  fontFamilyOverride: need<HTMLInputElement>("font-family-override"),
  fontDisplayName: need<HTMLInputElement>("font-display-name"),
  fontLicence: need<HTMLInputElement>("font-licence"),
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
  timelinePresetApplyOut: need<HTMLButtonElement>("timeline-preset-apply-out"),
  timelinePresetDuration: need<HTMLInputElement>("timeline-preset-duration"),
  timelinePresetSave: need<HTMLButtonElement>("timeline-preset-save"),
  timelineJumpHold: need<HTMLButtonElement>("timeline-jump-hold"),
  timelinePresetDurationError: need<HTMLSpanElement>("timeline-preset-duration-error"),
  presetSaveDialog: need<HTMLDialogElement>("preset-save-dialog"),
  closeConfirmDialog: need<HTMLDialogElement>("close-confirm-dialog"),
  closeConfirmMessage: need<HTMLParagraphElement>("close-confirm-message"),
  presetSaveForm: need<HTMLFormElement>("preset-save-form"),
  presetSaveId: need<HTMLInputElement>("preset-save-id"),
  presetSaveSummary: need<HTMLParagraphElement>("preset-save-summary"),
  presetSaveExisting: need<HTMLParagraphElement>("preset-save-existing"),
  presetSaveError: need<HTMLParagraphElement>("preset-save-error"),
  presetSaveSubmit: need<HTMLButtonElement>("preset-save-submit"),
  presetBrowserMount: need<HTMLDivElement>("preset-browser-mount"),
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
// State. The active session's working copy, and one viewport over it.
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
/** The data context the sample-data editor was last filled from. The text is
 *  rewritten only when the document's data changes (apply, undo, open, tab
 *  switch), so an ordinary re-render never discards the author's draft. */
let sampleDataShown: SceneDocument["dataContext"] | undefined;
/** Every open scene. The session is the owner of record; the flat state below
 *  is the working copy of whichever one is active (11.29). */
const workspace = emptyWorkspace();
let selection: string[] = [];

let projects: string[] = [];
let currentProject: string | undefined;
let projectCatalog: ProjectSceneCatalog | undefined;
const graphicPreviews = new Map<string, { document?: SceneDocument; src?: string; note: string }>();
const graphicPreviewsPending = new Set<string>();
let graphicPreviewRenderer: GraphicPreviewRenderer | undefined;
let graphicPreviewQueue = Promise.resolve();
let graphicPreviewGeneration = 0;
let takePageCatalog: ProjectTakePageCatalog | undefined;
/** The active session's project origin, mirrored from its `SessionView`. */
let projectSceneId: string | undefined;
let projectSceneProject: string | undefined;
let collapsed: string[] = [];
let selectedFontId: string | undefined;
/// Font ingest state (11.13). `registeredFonts` is the font list the browser's
/// font set was last synced to; rendering waits until it matches the scene.
let fontIngesting = false;
let fontNotice: string | undefined;
let fontReport: FontRegistrationReport | undefined;
let registeredFonts = "";
const fontRegistry = new FontRegistry(browserFontEnvironment(), async (asset) => {
  if (!asset.checksum) throw new Error(`asset ${asset.assetId} has no content hash`);
  try {
    // The project's own copy first, so a project opened on another machine
    // (or after the import cache is cleared) still has its fonts.
    return await shell().invoke<ArrayBuffer>("cmd_asset_bytes", {
      project: projectSceneProject ?? null,
      checksum: asset.checksum,
    });
  } catch (error) {
    // The shell's error is structured; the registry reports `message`, so the
    // refusal's name has to be put there or the author reads "[object Object]".
    throw new Error(describe(error));
  }
});
let selectedMaterialId: string | undefined;
let selectedAssetId: string | undefined;
/// Asset import state (11.39), shown in the Assets panel.
let assetImporting = false;
let assetNotice: string | undefined;
/** Previews by content hash: the same bytes preview the same everywhere. */
const assetPreviews = new Map<string, AssetPreview>();
/** The project folder's own asset records, and which hashes it holds. */
let projectAssetLibrary: readonly AssetLibraryItem[] = [];
let projectAssetStored: ReadonlySet<string> = new Set();
let projectAssetProblems: readonly string[] = [];
/** Project and hash pairs already offered to the project, so a view update
 *  does not re-copy files it has already taken in. */
const adoptionTried = new Set<string>();
/** The project whose folder listing is held in projectAssetLibrary. */
let projectAssetListing: string | undefined;
/** Folder listings asked for, and the newest one shown: a slower, older
 *  reply never replaces a newer one. */
let projectAssetListingsAsked = 0;
let projectAssetListingShown = 0;
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
let animationBusy = false;
const pendingInspectorFields = new Set<string>();
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

/** Turn a rejected command or read into one operator-facing line.
 *
 *  The shell's errors are structured, so the distinct cases stay distinct:
 *  an unreachable asset plane and a refused edit are different problems and
 *  an author can only act differently on them if the message says which it
 *  was (invariant 17). A refusal is shown by its contract name. */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const failure = error as ShellError;
    switch (failure.error) {
      case "commandRefused":
        return `refused [${failure.cause?.refusal ?? "unknown"}]: ${failure.detail ?? ""}`;
      case "projectFailed":
        return `project store failed: ${failure.detail ?? ""}`;
      case "readScene":
        return `cannot read ${failure.path ?? "the file"}: ${failure.detail ?? ""}`;
      case "writeScene":
        return `cannot write ${failure.path ?? "the file"}: ${failure.detail ?? ""}`;
      case "invalidEndpoint":
        return `${failure.endpoint ?? "endpoint"} is not a host:port address`;
      case "unreachable":
        return `asset plane unreachable at ${failure.endpoint ?? ""}: ${failure.detail ?? ""}`;
      case "publishRefused":
        return `publication refused: ${failure.detail ?? ""}`;
      case "protocol":
        return `asset plane protocol failed: ${failure.detail ?? ""}`;
      default:
        return `${failure.error}: ${failure.detail ?? ""}`;
    }
  }
  return String(error);
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
  captureWorkingCopy(session, {
    selection,
    collapsed,
    timelineCollapsed: collapsedTimelineIds,
    currentFrame,
    takePage: takePageState,
    takePagePreview: takePagePreviewDocument,
  });
}

/// Mirror a session projection into the flat working copy. Shared by a tab
/// switch and a command's answer, so the two cannot disagree about which
/// document, file or project origin is active.
function adoptView(view: SessionView): void {
  scene = view.document;
  scenePath = view.path ?? null;
  projectSceneId = view.origin?.sceneId;
  projectSceneProject = view.origin?.project;
  if (view.origin) currentProject = view.origin.project;
  if ((projectSceneProject ?? currentProject) !== presetLibraryProject) void refreshPresetLibrary();
  void syncProjectAssets();
  ui.sceneId.readOnly = view.origin !== undefined;
  ui.sceneId.title =
    view.origin === undefined
      ? ""
      : "Project scene ids are stable; use Duplicate to create a new id.";
}

/** Make one Rust-owned session projection the one every panel renders. */
function restoreSession(session: SceneSession): void {
  pausePreview("switched scene");
  const { view } = session;
  adoptView(view);
  selection = session.selection;
  collapsed = session.collapsed;
  collapsedTimelineIds = session.timelineCollapsed;
  currentFrame = session.currentFrame;
  takePageState = session.takePage;
  takePagePreviewDocument = session.takePagePreview;
  // Transient interaction state belongs to a gesture, not to a scene: a
  // marquee half-drawn in one graphic must not reappear over another.
  marquee = undefined;
  guides = [];
  selectedKeys = new Set();
  graphTrack = undefined;
  ui.timelineGraphClose.hidden = true;
  ui.sceneId.value = view.document.id;
  ui.sceneName.value = view.document.name;
  updateHistoryButtons();
  contentRevision += 1;
  renderSceneState();
}

/// The scene id and name typed into the header but not yet applied.
///
/// Identity is document content, so it changes only through `setSceneId` /
/// `setSceneName`, sent just before a save or publish uses it. A bound
/// scene's id field is read-only: its id is its store address.
function pendingIdentityEdits(document_: SceneDocument): SceneEdit[] {
  const edits: SceneEdit[] = [];
  const id = ui.sceneId.value.trim();
  const name = ui.sceneName.value.trim();
  if (!ui.sceneId.readOnly && id !== document_.id) edits.push({ edit: "setSceneId", id });
  if (name !== document_.name) edits.push({ edit: "setSceneName", name });
  return edits;
}

/// Whether the active scene holds work its project copy does not: Rust's
/// project-dirty mark, or an identity typed into the header and not yet saved.
function projectChangesUnsaved(): boolean {
  const view = activeSession(workspace)?.view;
  if (view?.origin === undefined) return false;
  return view.projectDirty || pendingIdentityEdits(view.document).length > 0;
}

function renderSceneTabs(): void {
  const tabs = sceneTabs(workspace);
  ui.sceneTabs.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement("div");
    item.className = tab.active ? "scene-tab active" : "scene-tab";
    // A name typed but not yet applied is unsaved work in the active tab.
    const dirty = tab.dirty || (tab.active && scene !== null && pendingIdentityEdits(scene).length > 0);
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.sceneKey = String(tab.key);
    open.dataset.sceneAction = "activate";
    open.textContent = dirty ? `${tab.label} •` : tab.label;
    // The origin disambiguates two graphics that share a name in different
    // shows; an unbound scene says so rather than borrowing a project.
    open.title = tab.origin ?? "not saved to a project";
    open.setAttribute("aria-pressed", String(tab.active));
    if (dirty) open.setAttribute("aria-description", "unsaved changes");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "scene-tab-close";
    close.dataset.sceneKey = String(tab.key);
    close.dataset.sceneAction = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.label}`);
    item.append(open, close);
    ui.sceneTabs.append(item);
  }
  ui.sceneTabs.hidden = tabs.length === 0;
}

function switchToScene(key: number): void {
  if (key === workspace.activeKey) return;
  captureActiveSession();
  const result = activate(workspace, key);
  if (isWorkspaceRefused(result)) {
    log(result.refused, "bad");
    return;
  }
  restoreSession(result);
  renderSceneTabs();
  log(`Switched to ${result.view.document.name}`, "good");
}

/// Ask, in the page, whether to close a graphic and lose its unsaved changes.
/// Not `window.confirm`: in the shell the dialog plugin replaces it with an
/// asynchronous call whose Promise is always truthy, so a guard written as
/// `!window.confirm(...)` never stopped a close. Escape, the close button and
/// "Keep editing" all answer no; only the explicit discard answers yes.
function confirmDiscard(name: string): Promise<boolean> {
  const dialog = ui.closeConfirmDialog;
  ui.closeConfirmMessage.textContent = `${name} has unsaved changes. Close it and lose them?`;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "discard"), { once: true });
    dialog.showModal();
  });
}

async function closeScene(key: number): Promise<void> {
  captureActiveSession();
  const session = workspace.sessions.find((candidate) => candidate.key === key);
  if (!session) return;
  const name = session.view.document.name;
  // Offer the explicit confirmation rather than discarding the work; a tab
  // click must never be able to lose an edit on its own. Rust refuses an
  // unforced close of a dirty session by name if this view is stale.
  const force = session.view.dirty;
  if (force && !(await confirmDiscard(name))) {
    log(`close refused: ${name} has unsaved changes`, "bad");
    return;
  }
  try {
    await execute({ command: "closeScene", session: key, force });
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  removeSession(workspace, key);
  if (session.view.origin) {
    graphicPreviews.delete(`${session.view.origin.project}/${session.view.origin.sceneId}`);
    graphicPreviewGeneration += 1;
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
    viewport?.dispose();
    viewport = null;
    ui.overlay.replaceChildren();
    updateHistoryButtons();
  }
  renderSceneTabs();
  log(force ? `Closed ${name}, discarding unsaved changes` : `Closed ${name}`, force ? "bad" : "good");
  renderProjectManager();
}

function onSceneTabsClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-scene-key][data-scene-action]");
  const key = Number(button?.dataset.sceneKey);
  if (!button || !Number.isSafeInteger(key)) return;
  if (button.dataset.sceneAction === "close") void closeScene(key);
  else switchToScene(key);
}

/// Render the projection a command returned.
///
/// The active session keeps its view state — an edit is not a tab switch, so
/// the selection, playhead, key selection and open graph survive it. Any
/// other key (a scene just opened, or one revealed by origin) becomes the
/// active tab. `nextSelection` is what an edit asked to have selected; it is
/// applied against the edited document, which is the one that contains it.
function presentView(view: SessionView, nextSelection?: readonly string[]): void {
  const active = activeSession(workspace);
  if (active === undefined || active.key !== view.session) {
    captureActiveSession();
    const session = applySessionView(workspace, view);
    activate(workspace, session.key);
    restoreSession(session);
    renderSceneTabs();
    return;
  }
  const previous = active.view.document;
  applySessionView(workspace, view);
  adoptView(view);
  // The header is overwritten only where the document's identity changed
  // (an identity edit, or undoing one): a name typed and not yet applied
  // survives an unrelated edit.
  if (previous.id !== view.document.id) ui.sceneId.value = view.document.id;
  if (previous.name !== view.document.name) ui.sceneName.value = view.document.name;
  if (nextSelection !== undefined) selection = [...new Set(nextSelection)];
  contentRevision += 1;
  renderSceneState();
  updateHistoryButtons();
  renderSceneTabs();
}

/** Resolve live data before constructing the preview.
 *
 * Binding does not belong inside Three.js: the renderer accepts one resolved
 * scene, just as a later engine-backed viewport will. An invalid binding
 * refuses the whole resolution rather than mixing new and stale values. */
function renderSceneState(): void {
  if (!scene) return;
  // Fonts register before anything is drawn or measured (11.13). Text laid out
  // against a face the browser has not loaded is laid out in whatever face it
  // substituted, and no check would see it.
  const fontsKey = JSON.stringify([scene.fonts, scene.assets.filter((asset) => asset.kind === "font")]);
  if (fontsKey !== registeredFonts) {
    void registerSceneFonts(scene, fontsKey);
    return;
  }
  // An edit, undo, load or history change rebuilds the viewport's scene graph,
  // which invalidates the meshes the playback loop is mutating. Stop the clock
  // before the graph is torn down rather than let it write into disposed
  // objects.
  pausePreview("the document changed");
  ui.canvasSize.textContent = `${scene.canvas.width} × ${scene.canvas.height} · ${formatRate(scene.canvas.frameRate)}`;
  showRateChoice(ui.canvasRate, scene.canvas.frameRate);
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

async function registerSceneFonts(document_: SceneDocument, key: string): Promise<void> {
  fontReport = await fontRegistry.register(document_.fonts, document_.assets);
  registeredFonts = key;
  const failed = registrationFailureSummary(fontReport);
  if (failed) log(failed, "bad");
  renderSceneState();
}

/** Render the object manager and the inspector from their node trees.
 *
 *  Both panels are built as `UiNode` trees and rendered through the shared
 *  `renderNode`, so the ARIA a screen reader announces is written from the
 *  same description an agent reads via `agentView`. Building the DOM by hand
 *  here would be a second description of the same panel, free to drift from
 *  the one the tests hold (invariant 27). */
function managedProjectScenes(catalog: ProjectSceneCatalog): ManagedScene[] {
  return catalog.scenes.map((listed) => {
    const opened = sessionFor(workspace, { project: catalog.project, sceneId: listed.sceneId });
    return {
    sceneId: listed.sceneId,
    name: listed.name,
    unsavedChanges:
      opened?.view.projectDirty === true || (opened?.key === workspace.activeKey && projectChangesUnsaved()),
    open: opened !== undefined,
    active: opened !== undefined && opened.key === workspace.activeKey,
    ...(graphicPreviews.has(`${catalog.project}/${listed.sceneId}`)
      ? { preview: graphicPreviews.get(`${catalog.project}/${listed.sceneId}`)! } : {}),
    ...(listed.publishedRevision === undefined ? {} : { publishedRevision: listed.publishedRevision }),
    ...(listed.unavailableReason === undefined
      ? {}
      : { unavailableReason: listed.unavailableReason }),
    };
  });
}

function renderProjectManager(): void {
  ui.graphicCreate.disabled = currentProject === undefined;
  ui.projectSaveScene.disabled = currentProject === undefined;
  const catalog = projectCatalog;
  if (!catalog || catalog.project !== currentProject) {
    ui.sceneManagerMount.replaceChildren();
    ui.sceneManagerEmpty.hidden = false;
    ui.sceneManagerEmpty.textContent =
      projects.length === 0
        ? "Create a scene to keep your graphics together."
        : "Choose a scene to browse its graphics.";
    return;
  }
  const managed = managedProjectScenes(catalog);
  const panel = sceneManagerPanel({ project: catalog.project, scenes: managed, query: ui.graphicSearch.value });
  const matches = panel.children?.[0]?.children?.length ?? 0;
  ui.sceneManagerEmpty.hidden = matches > 0;
  ui.sceneManagerEmpty.textContent = managed.length === 0
    ? `No graphics in ${catalog.project}. Add your first graphic.`
    : "No graphics match your search.";
  ui.sceneManagerMount.replaceChildren(
    renderNode(
      document,
      panel,
    ) as unknown as Node,
  );
  queueGraphicPreviews(catalog);
}

function queueGraphicPreviews(catalog: ProjectSceneCatalog): void {
  for (const listed of catalog.scenes) {
    const address = `${catalog.project}/${listed.sceneId}`;
    const opened = sessionFor(workspace, { project: catalog.project, sceneId: listed.sceneId });
    const cached = graphicPreviews.get(address);
    if (graphicPreviewsPending.has(address) || (cached && (!opened || cached.document === opened.view.document))) continue;
    graphicPreviewsPending.add(address);
    const generation = graphicPreviewGeneration;
    graphicPreviewQueue = graphicPreviewQueue.then(async () => {
      try {
        if (listed.unavailableReason) throw new Error(listed.unavailableReason);
        const loaded = opened?.view.document ?? await shell().invoke<SceneDocument>("cmd_scene_read", { project: catalog.project, sceneId: listed.sceneId });
        const latest = sessionFor(workspace, { project: catalog.project, sceneId: listed.sceneId })?.view.document ?? loaded;
        // Yield between tiles; one renderer/context is reused for the list.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        graphicPreviewRenderer ??= new GraphicPreviewRenderer(document.createElement("canvas"));
        const preview = graphicPreviewRenderer.capture(latest, animationSurface);
        if (generation === graphicPreviewGeneration) graphicPreviews.set(address, { document: latest, ...preview });
      } catch (error) {
        if (generation === graphicPreviewGeneration) graphicPreviews.set(address, {
          ...(opened ? { document: opened.view.document } : {}), note: `Preview unavailable: ${describe(error)}`,
        });
      } finally {
        graphicPreviewsPending.delete(address);
        if (projectCatalog?.project === catalog.project) renderProjectManager();
      }
    });
  }
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
    const pairs = await shell().invoke<readonly [string, ControlField["kind"]][]>("cmd_control_properties", { kind });
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

/** Control-contract edits name their panel when Rust refuses them. */
const CONTROL_REFUSED = "control field refused";

async function replaceControlField(next: ControlField, label: string): Promise<void> {
  await runEdits([{ edit: "replaceControl", field: next }], { label, refusal: CONTROL_REFUSED });
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
    await runEdits(
      [{
        edit: "declareControl",
        field: { fieldId: fieldId.trim(), label: label.trim(), objectId, property, kind: candidate.kind },
      }],
      { label: `declare control ${fieldId.trim()}`, refusal: CONTROL_REFUSED },
    );
    return;
  }

  if (!nodeId.startsWith("control/field/")) return;
  const fieldId = nodeId.slice("control/field/".length);
  const field = scene.controls.find((candidate) => candidate.fieldId === fieldId);
  if (!field) return;
  if (action === "remove") {
    await runEdits(
      [{ edit: "removeControl", fieldId }],
      { label: `remove control ${fieldId}`, refusal: CONTROL_REFUSED },
    );
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
  // The row carries its own state for styling: the toggles say what pressing does, this says what is.
  for (const row of ui.objectManager.querySelectorAll<HTMLElement>('[role="row"]')) {
    row.dataset.hidden = String(row.querySelector('[id$="/visible"]')?.textContent === "hidden");
    row.dataset.locked = String(row.querySelector('[id$="/locked"]')?.textContent === "locked");
  }

  renderFontManager(document_);

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
  const assetProject = projectSceneProject;
  const assets = assetManagerPanel(document_, {
    ...(selectedAssetId === undefined ? {} : { selectedAssetId }),
    previews: assetPreviews,
    ...(assetProject === undefined
      ? {}
      : {
          project: assetProject,
          projectStored: projectAssetStored,
          projectLibrary: projectAssetLibrary,
          projectProblems: projectAssetProblems,
        }),
    ...(assetImporting ? { importing: true } : {}),
    ...(assetNotice === undefined ? {} : { notice: assetNotice }),
  });
  ui.assetMount.replaceChildren(renderNode(document, assets) as unknown as Node);
  renderTakePagePanel(document_);


  renderInspector(document_);
  renderPresetBrowser(document_);
  syncTimelineControls();
  updateTimeReadouts();
  const animation = keyframePanelModel(document_, selection, animationSurface, currentFrame);
  ui.animationFrame.value = String(animation.currentFrame);
  ui.animationFrame.max = String(animation.durationFrames);
  ui.animationMount.replaceChildren(renderKeyframePanel(document, animation, animationSurface));

  const bindings = bindingPanel(document_, selection);
  ui.bindings.replaceChildren(renderNode(document, bindings) as unknown as Node);
  renderSampleData(document_);
  renderControlContract(document_);
  renderTimeline(document_);
}

function renderInspector(document_: SceneDocument): void {
  const metadataOpen = ui.inspector.querySelector<HTMLDetailsElement>("details.property-section")?.open ?? false;
  const focused = document.activeElement instanceof HTMLInputElement && ui.inspector.contains(document.activeElement)
    ? { field: document.activeElement.dataset.inspectorField, value: document.activeElement.value,
        start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : undefined;
  // Bindings and take-page previews must never become editable authored defaults.
  const inspector = inspectorPanel(document_, selection);
  const model = keyframePanelModel(document_, selection, animationSurface, currentFrame);
  const sections = inspectorSections(inspector);
  if (sections.length === 0) {
    ui.inspector.replaceChildren(renderNode(document, inspector) as unknown as Node);
  } else {
    ui.inspector.replaceChildren(...sections.map((section) => {
      // Keep identity/switch metadata reachable without pushing transform
      // controls below the fold in the compact Properties dock.
      const metadata = section.title === "Layer";
      const group = document.createElement(metadata ? "details" : "section");
      group.className = "property-section";
      if (group instanceof HTMLDetailsElement) group.open = metadataOpen;
      const heading = document.createElement(metadata ? "summary" : "h3");
      heading.textContent = section.title;
      group.append(heading, ...section.fields.map((field) => {
        const element = renderNode(document, field) as unknown as HTMLElement;
        const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (checkbox && field.input?.mixed) {
          checkbox.indeterminate = true;
          checkbox.setAttribute("aria-checked", "mixed");
        }
        return element;
      }));
      return group;
    }));
  }
  refreshInspectorFrame(model);
  if (focused?.field) {
    const input = [...ui.inspector.querySelectorAll<HTMLInputElement>("[data-inspector-field]")]
      .find((candidate) => candidate.dataset.inspectorField === focused.field);
    if (input && !input.disabled) {
      if (!pendingInspectorFields.has(focused.field)) input.value = focused.value;
      input.focus({ preventScroll: true });
      if (input.type === "text" && focused.start !== null && focused.end !== null) input.setSelectionRange(focused.start, focused.end);
    }
  }
}

function refreshInspectorFrame(model: KeyframePanelModel): void {
  if (!model.available) return;
  for (const row of model.rows) {
    const element = document.getElementById(`inspector/${row.property}`);
    if (!element) continue;
    const input = element.querySelector<HTMLInputElement>("[data-inspector-field]");
    if (input && document.activeElement !== input) {
      input.value = row.value === null ? "" : row.property === "opacity" ? `${row.value * 100}%` : String(row.value);
      input.placeholder = row.value === null ? "Mixed" : "";
    }
    const previousControls = element.querySelector(".property-key-controls");
    const focusedControl = document.activeElement instanceof HTMLButtonElement && previousControls?.contains(document.activeElement)
      ? document.activeElement.getAttribute("aria-label") : undefined;
    previousControls?.remove();
    const controls = renderPropertyKeyControls(document, row, model.currentFrame);
    element.append(controls);
    if (focusedControl) {
      const buttons = [...controls.querySelectorAll<HTMLButtonElement>("button")];
      (buttons.find((button) => button.getAttribute("aria-label") === focusedControl && !button.disabled)
        ?? buttons.find((button) => !button.disabled))?.focus({ preventScroll: true });
    }
  }
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
  // The real rendered row window and scroll offset, so a scroll is geometry.
  return timelineSnapshotFor({
    viewport: timelineViewport,
    rowCount: model.rows.length,
    devicePixelRatio: window.devicePixelRatio,
    contentRevision,
    selectionRevision,
    phaseRevision,
    currentFrame,
  });
}

/// The DOM's shape: the rows present and the canvas sizes. A change to this
/// needs new elements; anything else is a repaint.
let timelineStructure = "";
let layerPresentation = new Map<string, string>();

/// The timeline's view of the document: driven by the object selection, with
/// collapsed groups folded away.
function currentTimelineModel(document_: SceneDocument): TimelineModel {
  return timelineModel(document_, {
    selectedIds: selection,
    allObjects: true,
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
  const layers = describeTimelineLayers(document_);
  layerPresentation = new Map([...layers].map(([id, layer]) => [id, layer.barColour]));
  const bounds = ui.timelineMount.getBoundingClientRect();
  // The header column is 210px of the grid; the stage gets the rest.
  timelineViewport = viewportForBounds(
    timelineViewport,
    bounds,
    model.durationFrames,
    model.rows.length,
  );

  ui.timelineMeta.textContent =
    model.tracks.length === 0
      ? "no animated properties"
      : `${model.tracks.length} track(s) · ${model.keyCount} key(s) · ${visibleKeyCount(model, timelineViewport)} drawn`;

  if (model.rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "Create a layer to begin. Select it to edit its properties and add keyframes.";
    ui.timelineMount.replaceChildren(empty);
    timelineLayers = null;
    lastSnapshot = null;
    timelineStructure = "";
    // The ruler and its playhead still belong to the graphic: an empty
    // timeline has a rate, a duration and a current frame to scrub.
    renderTimelineRuler(model);
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
    layerSignature(layers),
    selection.join(","),
  ].join("#");

  if (structure !== timelineStructure || !timelineLayers) {
    const parts = renderTimelinePanel(document, model, timelineViewport, layers);
    for (const header of parts.headers.querySelectorAll<HTMLElement>(".timeline-group-header")) {
      header.setAttribute("aria-selected", String(selection.includes(header.dataset.objectId!)));
    }
    ui.timelineMount.replaceChildren(parts.root);
    timelineLayers = parts.canvases;
    timelineStructure = structure;
    // Fresh canvases retain nothing, so this is a first paint.
    lastSnapshot = null;
  }
  // The header column scrolls with the canvases: its spacers place row r at
  // r * rowHeight, and the layers draw it at that minus `scrollTop`.
  const headers = ui.timelineMount.querySelector<HTMLElement>(".timeline-headers");
  if (headers) headers.scrollTop = timelineViewport.scrollTop;
  paintTimeline(model);
  renderTimelineRuler(model);
}

function renderTimelineRuler(model: TimelineModel): void {
  const host = document.getElementById("timeline-ruler-ticks");
  if (!host) return;
  const framesPerSecond = Math.max(1, Math.round(model.frameRate.num / model.frameRate.den));
  const step = framesPerSecond * Math.max(1, Math.ceil(70 / (framesPerSecond * timelineViewport.pixelsPerFrame)));
  const start = Math.ceil(timelineViewport.startFrame / step) * step;
  const end = Math.min(model.durationFrames, timelineViewport.startFrame + timelineViewport.width / timelineViewport.pixelsPerFrame);
  const ticks: HTMLElement[] = [];
  for (let frame = start; frame <= end; frame += step) {
    const tick = document.createElement("span");
    tick.style.left = `${frameToX(timelineViewport, frame)}px`;
    tick.textContent = formatTimecode(frame, model.frameRate);
    ticks.push(tick);
  }
  host.replaceChildren(...ticks);
  positionPlayhead();
}

/** Put the ruler's playhead handle on the current frame. Cheap on purpose:
 *  one style and three attributes, so a scrub never touches the ticks. */
function positionPlayhead(): void {
  const handle = ui.timelinePlayhead;
  if (!scene) {
    handle.hidden = true;
    return;
  }
  const duration = Number(scene.timeline.durationFrames);
  const x = frameToX(timelineViewport, currentFrame);
  handle.hidden = x < 0 || x > timelineViewport.width;
  handle.style.left = `${x}px`;
  handle.setAttribute("aria-valuenow", String(currentFrame));
  handle.setAttribute("aria-valuemax", String(duration));
  handle.setAttribute("aria-valuetext", formatTimecode(currentFrame, scene.canvas.frameRate));
}

/** The frame under a pointer on the ruler, clamped to the scene. */
function rulerFrameAt(clientX: number): number {
  const bounds = ui.timelineRulerTicks.getBoundingClientRect();
  const frame = xToFrame(timelineViewport, clientX - bounds.left);
  return Math.min(Number(scene?.timeline.durationFrames ?? 0), Math.max(0, frame));
}

let rulerScrub: { pointerId: number } | undefined;

/// Press or drag on the ruler, or on its handle, scrubs. Playback is paused
/// first: a scrub during playback would be overwritten by the next tick.
function onRulerPointerDown(event: PointerEvent): void {
  if (!scene || event.button !== 0) return;
  event.preventDefault();
  if (playback) pausePreview("scrubbing");
  rulerScrub = { pointerId: event.pointerId };
  ui.timelineRulerTicks.setPointerCapture(event.pointerId);
  setCurrentFrame(rulerFrameAt(event.clientX));
}

function onRulerPointerMove(event: PointerEvent): void {
  if (!rulerScrub || rulerScrub.pointerId !== event.pointerId) return;
  const frame = rulerFrameAt(event.clientX);
  if (frame !== currentFrame) setCurrentFrame(frame);
}

function onRulerPointerUp(event: PointerEvent): void {
  if (!rulerScrub || rulerScrub.pointerId !== event.pointerId) return;
  rulerScrub = undefined;
  if (ui.timelineRulerTicks.hasPointerCapture(event.pointerId)) ui.timelineRulerTicks.releasePointerCapture(event.pointerId);
}

/// The handle is a slider: arrows step a frame, Home/End jump, Page keys
/// move a timecode second.
function onPlayheadKeyDown(event: KeyboardEvent): void {
  if (!scene) return;
  const second = Math.max(1, Math.round(scene.canvas.frameRate.num / scene.canvas.frameRate.den));
  const steps: Record<string, number | "home" | "end"> = {
    ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -second, PageUp: second, Home: "home", End: "end",
  };
  const step = steps[event.key];
  if (step === undefined) return;
  event.preventDefault();
  if (playback) pausePreview("scrubbing");
  setCurrentFrame(step === "home" ? 0 : step === "end" ? Number(scene.timeline.durationFrames) : currentFrame + step);
}

/** Wheel over the timeline: rows vertically, frames with Shift or a
 *  horizontal wheel. Geometry only, so this repaints; the DOM is rebuilt only
 *  when the row window moves, and stays bounded by the viewport either way. */
function onTimelineWheel(event: WheelEvent): void {
  if (!scene || !timelineLayers) return;
  const model = currentTimelineModel(scene);
  const next = scrollViewportByWheel(
    timelineViewport,
    event,
    model.durationFrames,
    model.rows.length,
  );
  const unchanged =
    next.scrollTop === timelineViewport.scrollTop &&
    next.startFrame === timelineViewport.startFrame;
  if (unchanged) return;
  event.preventDefault();
  timelineViewport = next;
  renderTimeline(scene, false);
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
    layerBars: layerPresentation,
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
  positionPlayhead();
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
  await runGesture(plan.edits, plan.label);
}

function setKeySelection(next: Iterable<string>): void {
  selectedKeys = new Set(next);
  selectionRevision += 1;
  syncTimelineControls();
  if (scene) paintTimeline(currentTimelineModel(scene));
}

/** Click: a group row collapses, a track row opens its curve, a key selects,
 *  and empty stage moves the playhead. */
function onTimelineClick(event: MouseEvent): void {
  if (!scene || !timelineLayers) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  const caret = target.closest<HTMLElement>("[data-timeline-toggle]");
  if (caret?.dataset.timelineToggle) {
    const objectId = caret.dataset.timelineToggle;
    collapsedTimelineIds = collapsedTimelineIds.includes(objectId)
      ? collapsedTimelineIds.filter((id) => id !== objectId)
      : [...collapsedTimelineIds, objectId];
    renderTimeline(scene);
    // Rebuilding the track headers replaces the focused disclosure button.
    // Keep keyboard users on the same track after expanding or collapsing it.
    const replacement = [...ui.timelineMount.querySelectorAll<HTMLButtonElement>("[data-timeline-toggle]")]
      .find((button) => button.dataset.timelineToggle === objectId);
    replacement?.focus({ preventScroll: true });
    return;
  }

  const group = target.closest<HTMLElement>(".timeline-group-header");
  if (target.closest("[data-layer-action]")) {
    onObjectManagerClick(event);
    return;
  }
  if (group?.dataset.objectId) {
    const objectId = group.dataset.objectId;
    setSelection(event.shiftKey || event.ctrlKey || event.metaKey ? additiveSelection([objectId]) : [objectId]);
    if (!event.altKey && event.detail < 2) return;
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

/** The starter presets and the open project's saved ones, exactly what
 *  `ApplyPreset` resolves (11.15). Loaded from Rust, never from a local list. */
let motionPresets: readonly MotionPreset[] = [];
let starterPresetIds: ReadonlySet<string> = new Set();
/** The project the library was last loaded for; the sentinel means never. */
const PRESETS_UNLOADED = "unloaded:no-project-asked-yet";
let presetLibraryProject: string | undefined = PRESETS_UNLOADED;

/** Populate the easing and preset pickers from Rust, never from a local list. */
async function loadMotionLibrary(): Promise<void> {
  for (const easing of animationSurface?.easings ?? []) {
    const option = document.createElement("option");
    option.value = easing;
    option.textContent = propertyLabel(easing);
    ui.timelineEasing.append(option);
  }
  try {
    starterPresetIds = new Set(
      (await shell().invoke<MotionPreset[]>("cmd_starter_presets")).map((preset) => preset.id),
    );
  } catch (error) {
    log(`motion library unavailable: ${describe(error)}`, "bad");
  }
  await refreshPresetLibrary();
}

/** Reload the picker and the browser from the project's library. A project
 *  that cannot be read leaves the starters and says so, never a quietly
 *  shorter list. */
async function refreshPresetLibrary(preferred?: string): Promise<void> {
  const project = projectSceneProject ?? currentProject;
  presetLibraryProject = project;
  const wanted = preferred ?? ui.timelinePreset.value;
  try {
    motionPresets = await shell().invoke<MotionPreset[]>("cmd_motion_presets", {
      project: project ?? null,
    });
  } catch (error) {
    log(`saved presets unavailable: ${describe(error)}`, "bad");
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "—";
  ui.timelinePreset.replaceChildren(placeholder);
  for (const preset of motionPresets) {
    const option = document.createElement("option");
    option.value = preset.id;
    const unusable = presetBlocker(preset, {});
    option.textContent =
      preset.id + (starterPresetIds.has(preset.id) ? "" : " (saved)") + (unusable ? " — unusable" : "");
    ui.timelinePreset.append(option);
  }
  ui.timelinePreset.value = motionPresets.some((preset) => preset.id === wanted) ? wanted : "";
  syncPresetDuration();
  if (scene) renderPresetBrowser(scene);
}

/** Show the chosen preset's declared duration range on the duration field, so
 *  the limit the caller is held to is visible before Rust enforces it. */
function syncPresetDuration(): void {
  const preset = motionPresets.find((candidate) => candidate.id === ui.timelinePreset.value);
  const param = preset?.params.find((candidate) => candidate.type === "duration");
  if (param?.type === "duration") {
    ui.timelinePresetDuration.title = `${preset?.id} allows ${param.min}–${param.max} ms`;
    ui.timelinePresetDuration.placeholder = typeof param.default === "number" ? `${param.default} ms` : "preset default";
    ui.timelinePresetDuration.disabled = false;
  } else {
    ui.timelinePresetDuration.title = preset ? `${preset.id} declares no duration parameter` : "choose a preset";
    ui.timelinePresetDuration.placeholder = "preset default";
    ui.timelinePresetDuration.disabled = preset !== undefined;
    ui.timelinePresetDuration.value = "";
  }
  if (param?.type === "duration") {
    ui.timelinePresetDuration.min = String(param.min);
    ui.timelinePresetDuration.max = String(param.max);
  } else {
    ui.timelinePresetDuration.removeAttribute("max");
    ui.timelinePresetDuration.min = "1";
  }
  syncTimelineControls();
}

/** The declared duration range of the chosen preset, if it declares one. */
function presetDurationRange(): { min: number; max: number } | undefined {
  const preset = motionPresets.find((candidate) => candidate.id === ui.timelinePreset.value);
  const param = preset?.params.find((candidate) => candidate.type === "duration");
  return param?.type === "duration" ? { min: param.min, max: param.max } : undefined;
}

/** What is wrong with the duration field, said before anything is sent. */
function presetDurationProblem(): string | undefined {
  const raw = ui.timelinePresetDuration.value.trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  const preset = motionPresets.find((candidate) => candidate.id === ui.timelinePreset.value);
  const range = presetDurationRange();
  if (!Number.isFinite(value)) return "Enter a number of milliseconds.";
  if (preset && !range) return `${preset.id} has no duration setting: leave this empty.`;
  if (range && (value < range.min || value > range.max)) {
    return `${preset?.id ?? "This preset"} allows ${range.min}\u2013${range.max} ms; ${value} ms is outside that.`;
  }
  return undefined;
}

function syncPresetDurationError(): void {
  const problem = presetDurationProblem();
  ui.timelinePresetDurationError.textContent = problem ?? "";
  ui.timelinePresetDurationError.hidden = problem === undefined;
  if (problem === undefined) ui.timelinePresetDuration.removeAttribute("aria-invalid");
  else ui.timelinePresetDuration.setAttribute("aria-invalid", "true");
}

/** Each group says what it acts on, and controls with nothing to act on are
 *  disabled with the reason on them, never silently inert. */
function syncTimelineControls(): void {
  const keyCount = selectedKeys.size;
  const objects = scene ? scene.objects.filter((object) => selection.includes(object.id)) : [];
  const keysLegend = document.getElementById("tl-legend-keys");
  const presetsLegend = document.getElementById("tl-legend-presets");
  if (keysLegend) keysLegend.textContent = keyCount === 0 ? "Keys \u00b7 none selected" : `Keys \u00b7 ${keyCount} selected`;
  if (presetsLegend) {
    presetsLegend.textContent =
      objects.length === 0 ? "Presets \u00b7 select an object" : objects.length === 1 ? `Presets \u00b7 ${objects[0]!.name}` : `Presets \u00b7 ${objects.length} objects`;
  }
  document.getElementById("tl-group-keys")?.setAttribute("data-idle", String(keyCount === 0));
  document.getElementById("tl-group-presets")?.setAttribute("data-idle", String(objects.length === 0));

  const set = (element: HTMLButtonElement | HTMLSelectElement, reason: string | undefined): void => {
    element.disabled = reason !== undefined;
    if (reason === undefined) element.removeAttribute("title");
    else element.title = reason;
  };
  set(ui.timelineEasing, keyCount === 0 ? "Select keys in the timeline to change their easing" : undefined);
  const noObject = objects.length === 0 ? "Select an object to apply a preset to" : undefined;
  const noPreset = ui.timelinePreset.value === "" ? "Choose a preset first" : undefined;
  set(ui.timelinePresetApply, noObject ?? noPreset);
  set(ui.timelinePresetApplyOut, noObject ?? noPreset);
  set(ui.timelinePresetSave, presetSaveBlocker());
  set(ui.phaseSet, keyCount === 0 ? "Select the keys the phase should cover" : undefined);
  syncPresetDurationError();
}

/** The frame where the build-in is done: the hold phase if one is set, else
 *  the end of the in phase, else the end of each track's first move. */
function holdFrame(document_: SceneDocument): number | undefined {
  const phases = document_.timeline.phases;
  const hold = phases.find((phase) => phase.kind === "hold");
  if (hold) return Number(hold.startFrame);
  const buildIn = phases.find((phase) => phase.kind === "in");
  if (buildIn) return Number(buildIn.endFrame);
  const seconds = document_.timeline.channels
    .map((channel) => channel.keys[1]?.frame)
    .filter((frame): frame is NonNullable<typeof frame> => frame !== undefined)
    .map(Number);
  return seconds.length === 0 ? undefined : Math.max(...seconds);
}

function jumpToHold(): void {
  if (!scene) return;
  const frame = holdFrame(scene);
  if (frame === undefined) {
    log("jump to hold: nothing in this graphic animates, so there is no build-in to finish", "bad");
    return;
  }
  pausePreview("jump to hold");
  setCurrentFrame(frame);
  log(`jumped to frame ${frame}, the end of the build-in`, "good");
}

/** Why the current key selection cannot be saved as a preset, if it cannot. */
function presetSaveBlocker(): string | undefined {
  if (projectSceneProject === undefined) {
    return "save this graphic into a scene first: presets live in the project library";
  }
  const objects = new Set(
    [...selectedKeys].map((id) => parseKeyId(id)?.objectId).filter((id): id is string => id !== undefined),
  );
  if (objects.size === 0) return "select the keys to save in the timeline";
  if (objects.size > 1) return "select keys of one object: a preset is one object's motion";
  const frames = [...selectedKeys].flatMap((id) => {
    const key = parseKeyId(id);
    return key ? [key.frame] : [];
  });
  if (new Set(frames).size < 2) return "select keys at two different frames: a preset needs a motion span";
  return undefined;
}

function renderPresetBrowser(document_: SceneDocument): void {
  const kinds = [
    ...new Set(document_.objects.filter((object) => selection.includes(object.id)).map((object) => object.type)),
  ];
  const saveBlocker = presetSaveBlocker();
  ui.presetBrowserMount.replaceChildren(
    renderNode(
      document,
      presetBrowserPanel(motionPresets, document_.canvas.frameRate, {
        selectionKinds: kinds,
        ...(ui.timelinePreset.value === "" ? {} : { selectedPresetId: ui.timelinePreset.value }),
        ...(saveBlocker === undefined ? {} : { saveBlocker }),
      }),
    ) as unknown as Node,
  );
}

/** Populate the object menu from Rust, so it can only offer kinds
 *  `create_object` will accept. A kind that appears and then refuses is the
 *  drift invariant 18 exists to prevent. */
async function loadObjectKinds(): Promise<void> {
  try {
    for (const kind of await shell().invoke<string[]>("cmd_object_kinds")) {
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
  const chosen = ui.timelineEasing.value;
  if (chosen === "") return;
  // `find` narrows to the contract's easing union: the picker only offers
  // what Rust declared, so an unknown value here is a stale option.
  const easing = animationSurface?.easings.find((candidate) => candidate === chosen);
  if (!easing) {
    log(`timeline: ${chosen} is not a declared easing`, "bad");
    return;
  }
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
async function applyStarterPreset(phase: "in" | "out" = "in"): Promise<void> {
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
  const durationProblem = presetDurationProblem();
  if (durationProblem !== undefined) {
    syncPresetDurationError();
    ui.timelinePresetDuration.focus();
    log(`preset refused: ${durationProblem}`, "bad");
    return;
  }
  const preset = motionPresets.find((candidate) => candidate.id === presetId);
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
      edit: "applyPreset",
      objectId,
      presetId,
      phase,
      atFrame: wireFrame(currentFrame),
      ...(ui.timelinePresetDuration.value.trim() === ""
        ? {}
        : { durationMs: Number(ui.timelinePresetDuration.value) }),
    })),
    selection.length === 1
      ? `Apply ${presetId} ${phase} at frame ${currentFrame}`
      : `Apply ${presetId} ${phase} to ${selection.length} objects at frame ${currentFrame}`,
  );
}


/** The keys the preset dialog will save, held while it is open. */
let pendingPresetSave:
  | { session: SessionKey; project: string; objectId: string; refs: { property: string; frame: number }[] }
  | undefined;
/** True from the moment Save is pressed until Rust answers. */
let presetSaving = false;

/** Describe what saving under the typed name would do, and whether it can. */
function presetSaveCheck(): void {
  const id = ui.presetSaveId.value.trim();
  const phase = (ui.presetSaveForm.elements.namedItem("preset-save-phase") as RadioNodeList).value === "out" ? "out" : "in";
  let problem: string | undefined;
  if (id === "") problem = "Give the preset a name.";
  else if (!/^[A-Za-z0-9_-]+$/.test(id)) problem = "Use letters, digits, - and _ only.";
  else if (starterPresetIds.has(id)) problem = `${id} is a starter preset and cannot be replaced. Choose another name.`;
  const existing = motionPresets.find((preset) => preset.id === id && !starterPresetIds.has(id));
  if (existing && problem === undefined) {
    const has = (name: "in" | "out"): boolean => {
      const phaseSpec = existing.phases[name];
      return phaseSpec.channels.length > 0 || (typeof phaseSpec.duration === "number" && phaseSpec.duration > 0);
    };
    ui.presetSaveExisting.textContent =
      `${id} is saved: in ${has("in") ? "present" : "missing"}, out ${has("out") ? "present" : "missing"}. ` +
      (has(phase) ? `Saving will replace its ${phase} phase.` : `Saving will add its ${phase} phase.`);
  } else {
    ui.presetSaveExisting.textContent = id === "" || problem ? "" : `New preset. Save its other phase later under the same name to make it usable.`;
  }
  ui.presetSaveError.textContent = problem ?? "";
  if (problem !== undefined && id !== "") ui.presetSaveId.setAttribute("aria-invalid", "true");
  else ui.presetSaveId.removeAttribute("aria-invalid");
  // Editing the form while a save is in flight must not re-enable Save.
  ui.presetSaveSubmit.disabled = problem !== undefined || presetSaving;
}

/** Open the save dialog for the selected keys of one object (11.15). */
function saveSelectionAsPreset(suggestedId?: string): void {
  if (presetSaving || ui.presetSaveDialog.open) return;
  const session = activeSession(workspace);
  if (!scene || !session) return;
  const blocker = presetSaveBlocker();
  if (blocker !== undefined || projectSceneProject === undefined) {
    log(`preset save refused: ${blocker ?? "save this graphic into a scene first"}`, "bad");
    return;
  }
  const refs = [...selectedKeys].flatMap((id) => {
    const parsed = parseKeyId(id);
    return parsed ? [{ property: parsed.property, frame: parsed.frame, objectId: parsed.objectId }] : [];
  });
  const objectId = refs[0]!.objectId;
  const object = scene.objects.find((candidate) => candidate.id === objectId);
  const frames = refs.map((ref) => ref.frame);
  pendingPresetSave = {
    session: session.key,
    project: projectSceneProject,
    objectId,
    refs: refs.map(({ property, frame }) => ({ property, frame })),
  };
  ui.presetSaveSummary.textContent =
    `${refs.length} key${refs.length === 1 ? "" : "s"} on ${object?.name ?? objectId}, frames ${Math.min(...frames)}\u2013${Math.max(...frames)}, saved into the ${projectSceneProject} project.`;
  ui.presetSaveForm.reset();
  ui.presetSaveId.value = suggestedId ?? (ui.timelinePreset.value !== "" && !starterPresetIds.has(ui.timelinePreset.value) ? ui.timelinePreset.value : "");
  presetSaveCheck();
  ui.presetSaveDialog.showModal();
  ui.presetSaveId.focus();
}

/** Keep one pending save attached to its dialog until the command responds. */
function setPresetSaving(saving: boolean): void {
  presetSaving = saving;
  ui.presetSaveForm.setAttribute("aria-busy", String(saving));
  for (const control of ui.presetSaveForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
    control.disabled = saving;
  }
  ui.presetSaveSubmit.textContent = saving ? "Saving…" : "Save preset";
  presetSaveCheck();
}

async function submitPresetSave(): Promise<void> {
  const pending = pendingPresetSave;
  if (!scene || !pending || presetSaving) return;
  presetSaveCheck();
  if (ui.presetSaveSubmit.disabled) return;
  const presetId = ui.presetSaveId.value.trim();
  const phase = (ui.presetSaveForm.elements.namedItem("preset-save-phase") as RadioNodeList).value === "out" ? "out" : "in";
  setPresetSaving(true);
  const outcome = await runCommand(
    {
      command: "saveMotionPreset",
      project: pending.project,
      target: { target: "session", session: pending.session },
      objectId: pending.objectId,
      presetId,
      phase,
      keys: pending.refs.map((ref) => ({ property: ref.property, frame: wireFrame(ref.frame) })),
    },
    {
      label: `Saved ${pending.refs.length} key(s) as the ${phase} phase of ${presetId}`,
      refusal: "preset save refused",
      onRefusal: (message) => {
        ui.presetSaveError.textContent = message;
      },
    },
  );
  setPresetSaving(false);
  if (outcome) {
    ui.presetSaveDialog.close();
    pendingPresetSave = undefined;
    await refreshPresetLibrary(presetId);
  } else {
    presetSaveCheck();
  }
}

/** Clicks inside the preset browser: apply a card's phase or save into it. */
function onPresetBrowserClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  if (!button) return;
  const presetId = button.dataset.for?.replace(/^preset\//, "");
  if (presetId === undefined) return;
  if (button.dataset.action === "apply") {
    ui.timelinePreset.value = presetId;
    void applyStarterPreset("in");
  } else if (button.dataset.action === "saveAsPreset") {
    saveSelectionAsPreset(presetId);
  }
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
  updateTimeReadouts();
  ui.animationMount.replaceChildren(renderKeyframePanel(document, animation, animationSurface));
  refreshInspectorFrame(animation);
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
  ui.previewPlay.replaceChildren(iconImage(playing ? "pause" : "play"));
  ui.previewPlay.setAttribute("aria-label", playing ? "Pause preview" : "Play preview");
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
// Undo/redo and edits. Rust owns each session's history (11.36): one command
// is one entry, and a batch of edits is applied atomically, so one gesture is
// one undo however many objects or keys it touched (11.9, 11.21). A refused
// command changes nothing and adds no entry; its refusal is shown by name.
// ---------------------------------------------------------------------------

function updateHistoryButtons(): void {
  const view = activeSession(workspace)?.view;
  ui.undo.disabled = view === undefined || view.undoDepth === 0;
  ui.redo.disabled = view === undefined || view.redoDepth === 0;
}

/// What a successful command reports, and how a refusal is introduced.
interface CommandReport {
  /** The history line. Computed from what Rust reported it did where the
   *  consequence is only known afterwards (a delete that took children). */
  readonly label: string | ((effects: readonly EditEffect[]) => string);
  /** The selection the edit asks for, applied against the edited document. */
  readonly select?: (effects: readonly EditEffect[]) => readonly string[] | undefined;
  /** Names the panel at the start of a refusal line. */
  readonly refusal?: string;
  /** Also shows the refusal where the gesture was made (a panel status). */
  readonly onRefusal?: (message: string) => void;
}

/** Run one session command: one at a time, rendering the view Rust returns. */
async function runCommand(
  command: EditorCommand,
  report: string | CommandReport,
): Promise<CommandOutcome | undefined> {
  const spec: CommandReport = typeof report === "string" ? { label: report } : report;
  if (animationBusy) {
    log("an edit is already in progress", "bad");
    return undefined;
  }
  animationBusy = true;
  ui.animationMount.setAttribute("aria-busy", "true");
  try {
    const outcome = await execute(command);
    if (outcome.session) {
      // A take-page preview is of the document as it was; only an edit,
      // undo or redo changes the active document.
      const changesDocument =
        command.command === "editScene" || command.command === "undo" || command.command === "redo";
      if (changesDocument) takePagePreviewDocument = null;
      presentView(outcome.session, spec.select?.(outcome.effects));
    }
    log(typeof spec.label === "string" ? spec.label : spec.label(outcome.effects), "good");
    return outcome;
  } catch (error) {
    const message = describe(error);
    spec.onRefusal?.(message);
    log(spec.refusal === undefined ? message : `${spec.refusal}: ${message}`, "bad");
    return undefined;
  } finally {
    animationBusy = false;
    ui.animationMount.removeAttribute("aria-busy");
  }
}

/// The module a panel's gestures belong to (11.37). A gesture is tagged with
/// the panel holding focus when it is issued, and Ctrl+Z inside a panel undoes
/// that panel's latest command; outside any panel it is project-level.
const PANEL_MODULE: Readonly<Record<string, EditorModule>> = {
  viewport: "viewport",
  "object-manager": "objectManager",
  inspector: "inspector",
  timeline: "timeline",
  animation: "animation",
  materials: "materials",
  fonts: "fonts",
  "text-styles": "textStyles",
  assets: "assets",
  "take-page": "takePage",
  bindings: "bindings",
  "control-contract": "controlContract",
};

function focusedPanelModule(): EditorModule | undefined {
  const panel = document.activeElement?.closest<HTMLElement>("[data-panel]")?.dataset.panel;
  return panel === undefined ? undefined : PANEL_MODULE[panel];
}

/** Send one gesture's edits to the active session as one atomic batch. */
async function runEdits(
  edits: readonly SceneEdit[],
  report: string | CommandReport,
  module: EditorModule = focusedPanelModule() ?? "scene",
): Promise<CommandOutcome | undefined> {
  const session = activeSession(workspace);
  if (!session || edits.length === 0) return undefined;
  const target: SceneTarget = { target: "session", session: session.key };
  return runCommand({ command: "editScene", target, edits: [...edits], module }, report);
}

/// Undo the active scene's latest command, or `module`'s latest command.
async function undo(module?: EditorModule): Promise<void> {
  const session = activeSession(workspace);
  if (!session) return;
  const scope = module === undefined ? {} : { module };
  await runCommand({ command: "undo", session: session.key, ...scope }, module ? `Undo (${module})` : "Undo");
}

async function redo(module?: EditorModule): Promise<void> {
  const session = activeSession(workspace);
  if (!session) return;
  const scope = module === undefined ? {} : { module };
  await runCommand({ command: "redo", session: session.key, ...scope }, module ? `Redo (${module})` : "Redo");
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
    startFrame: wireFrame(span.start),
    endFrame: wireFrame(span.end),
  } satisfies TimelinePhase;
  const outcome = await runEdits(
    [{ edit: "setPhase", phase }],
    `Set ${phaseAddress(phase)} over frames ${span.start}–${span.end}`,
  );
  if (outcome) phaseRevision += 1;
  if (outcome && scene) paintTimeline(currentTimelineModel(scene));
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
  const outcome = await runEdits([{ edit: "removePhase", address }], `Remove phase ${address}`);
  if (outcome) phaseRevision += 1;
  if (outcome && scene) paintTimeline(currentTimelineModel(scene));
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

/** Every timeline gesture is one ordered SceneEdit batch. */
async function runGesture(edits: readonly SceneEdit[], label: string): Promise<boolean> {
  return (await runEdits(edits, label)) !== undefined;
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
  const edits: SceneEdit[] = row.objectIds.map((objectId) => ({
    edit: "editProperty",
    objectId,
    property,
    value,
    frame: wireFrame(model.currentFrame),
    // Existing animated properties key edits at the playhead, as EffectCraft
    // does. Auto-Key additionally starts animation on unkeyed properties.
    autoKey: autoKey || (scene?.timeline.channels.some((channel) => channel.objectId === objectId && channel.property === property && channel.keys.length > 0) ?? false),
  }));
  const scope = row.objectIds.length > 1 ? ` on ${row.objectIds.length} objects` : "";
  const alreadyAnimated = scene?.timeline.channels.some((channel) => row.objectIds.includes(channel.objectId) && channel.property === property && channel.keys.length > 0);
  const label = autoKey || alreadyAnimated
    ? `Keyed ${row.label} = ${value} at frame ${model.currentFrame}${scope}`
    : `Set ${row.label} = ${value}${scope}`;
  await runGesture(edits, label);
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
    const edits: SceneEdit[] = intent.objectIds.map((objectId) => ({
      edit: "removeKeyframe",
      objectId,
      property,
      frame: wireFrame(model.currentFrame),
    }));
    await runGesture(edits, `Removed ${row.label} key at frame ${model.currentFrame}`);
    return;
  }

  // `find` narrows to the contract's own easing union, so the keyframe this
  // builds carries a declared curve rather than an arbitrary string.
  const easing = DEFAULT_EASING();
  if (!easing) {
    log("keyframe refused: the animation contract declares no easing", "bad");
    return;
  }
  const edits: SceneEdit[] = intent.objectIds.map((objectId) => ({
    edit: "createKeyframe",
    objectId,
    property,
    // Each object keys at its own current value, so a multi-select add does
    // not flatten differing values onto a shared one.
    keyframe: keyframeForValue(propertyValueAt(scene!, objectId, property, model.currentFrame) ?? 0, model.currentFrame, easing),
  }));
  await runGesture(edits, `Added ${row.label} key at frame ${model.currentFrame}`);
}

async function updateKeyframe(rowElement: HTMLElement, row: KeyframeRow): Promise<void> {
  const model = activeKeyframeModel();
  const objectId = row.objectIds[0];
  if (!model?.available || row.objectIds.length !== 1 || objectId === undefined || !row.currentKey) return;
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
    // The key's own frame, as Rust sent it: an update never moves a key.
    frame: row.currentKey.frame,
    value,
    easing,
    ...(bezier === undefined ? {} : { bezier }),
  };
  await runGesture(
    [{ edit: "updateKeyframe", objectId, property: row.property, keyframe }],
    `Updated ${row.label} key at frame ${model.currentFrame}`,
  );
}

async function moveKeyframe(rowElement: HTMLElement, row: KeyframeRow): Promise<void> {
  const model = activeKeyframeModel();
  const objectId = row.objectIds[0];
  if (!model?.available || row.objectIds.length !== 1 || objectId === undefined) return;
  const toFrame = Number(rowElement.querySelector<HTMLInputElement>(".keyframe-move-to")?.value);
  if (!Number.isInteger(toFrame) || toFrame < 0) {
    log("keyframe refused: destination frame must be a whole number from 0", "bad");
    return;
  }
  const moved = await runGesture(
    [{
      edit: "moveKeyframe",
      objectId,
      property: row.property,
      fromFrame: wireFrame(model.currentFrame),
      toFrame: wireFrame(toFrame),
    }],
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
  if (action === "create" || action === "remove") {
    void toggleKeyframe(property, action);
    return;
  }
  const rowElement = button.closest<HTMLElement>(".keyframe-row");
  const row = selectedAnimationRow(property);
  if (!rowElement || !row) return;
  if (action === "update") {
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

/** An inline inspector edit across the whole selection (11.9): one gesture, one
 *  atomic batch, one undo entry carrying every object's change. Rust applies
 *  it or refuses it whole, by name. */
function onInspectorChange(event: Event): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const field = target.dataset.inspectorField;
  if (!field) return;
  const raw = target.type === "checkbox" ? String(target.checked) : target.value;
  const parsed = parseFieldInput(field, raw);
  if (isRefused(parsed)) {
    log(`inspector edit refused: ${parsed.refused}`, "bad");
    renderInspector(scene);
    return;
  }
  if (typeof parsed.value === "number" && animationSurface?.properties.includes(field) && selectedAnimationRow(field)) {
    pendingInspectorFields.add(field);
    void editPropertyValue(field, parsed.value).finally(() => {
      if (scene) renderInspector(scene);
      pendingInspectorFields.delete(field);
    });
    return;
  }
  const edits = inspectorEdits(scene, selection, field, parsed.value);
  if (isRefused(edits)) {
    log(`inspector edit refused: ${edits.refused}`, "bad");
    renderInspector(scene);
    return;
  }
  pendingInspectorFields.add(field);
  void runEdits(edits, {
    // A field edit reports which objects actually changed; the count in the
    // undo label is that one, not the selection's size.
    label: (effects) => {
      const changed = effects.find((effect) => effect.effect === "objectsChanged");
      return fieldEditLabel(field, changed?.effect === "objectsChanged" ? changed.objectIds.length : edits.length);
    },
    refusal: "inspector edit refused",
    onRefusal: () => { if (scene) renderInspector(scene); },
  }).finally(() => {
    if (scene) renderInspector(scene);
    pendingInspectorFields.delete(field);
  });
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
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  const id = button?.dataset.for;
  const action = button?.dataset.action;
  if (!id || !action) return;
  if (action === "select") {
    setSelection(event.shiftKey || event.ctrlKey || event.metaKey ? additiveSelection([id]) : [id]);
    return;
  }
  if (!scene) return;

  // Visibility and lock are document edits: one click, one undo entry. Rust
  // refuses an inherited hide or lock by name and commits nothing
  // (invariant 18).
  if (action === "toggleVisibility" || action === "toggleLock") {
    const object = scene.objects.find((candidate) => candidate.id === id);
    if (!object) return;
    if (action === "toggleVisibility") {
      const visible = !object.visible;
      void runEdits([{ edit: "setObjectVisible", objectId: id, visible }], {
        label: `${visible ? "Showed" : "Hid"} ${object.name}`,
        refusal: `cannot change visibility of ${object.name}`,
      });
    } else {
      const locked = !object.locked;
      void runEdits([{ edit: "setObjectLocked", objectId: id, locked }], {
        label: `${locked ? "Locked" : "Unlocked"} ${object.name}`,
        refusal: `cannot change the lock on ${object.name}`,
      });
    }
    return;
  }

  // Expand/collapse is view state, kept on the active scene session by
  // `captureActiveSession`; it is never a document edit or an undo entry.
  if (action === "expand" || action === "collapse") {
    const change = setObjectExpanded(scene, collapsed, id, action === "expand");
    if (!change.ok) {
      log(change.reason, "bad");
      return;
    }
    collapsed = [...change.collapsedIds];
    const session = activeSession(workspace);
    if (session) session.collapsed = collapsed;
    renderPanels(scene);
  }
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
  if (name === null) return;
  await runEdits([{ edit: "createObject", kind, name }], {
    label: (effects) => {
      for (const effect of effects) {
        if (effect.effect === "objectCreated") return `Added ${kind} ${effect.objectId}`;
      }
      return `Added ${kind}`;
    },
    // Select what was just made: an author's next edit is almost always to it.
    select: (effects) => {
      for (const effect of effects) {
        if (effect.effect === "objectCreated") return [effect.objectId];
      }
      return undefined;
    },
  });
}

/** The selection's top-level objects (a group carries its children), or a
 *  named refusal when nothing is selected. */
function selectedRoots(verb: string): string[] {
  const roots = scene ? selectionRoots(scene, selection) : [];
  if (roots.length === 0) log(`select an object to ${verb}`, "bad");
  return roots;
}

/** Duplicate every selected object as one batch: one undo entry, and the
 *  copies become the selection. */
async function duplicateObject(): Promise<void> {
  const objectIds = selectedRoots("duplicate");
  if (objectIds.length === 0) return;
  await runEdits(
    objectIds.map((objectId) => ({ edit: "duplicateObject" as const, objectId })),
    {
      label: (effects) => {
        const lines = effects.flatMap((effect, index) => {
          if (effect.effect !== "objectDuplicated") return [];
          const { newObjectId, createdObjectIds, copiedChannelCount } = effect;
          const extra: string[] = [];
          if (createdObjectIds.length > 1) extra.push(`${createdObjectIds.length - 1} child object(s)`);
          if (copiedChannelCount > 0) extra.push(`${copiedChannelCount} channel(s)`);
          const from = objectIds[index] ?? "";
          return [extra.length ? `${from} as ${newObjectId}, with ${extra.join(" and ")}` : `${from} as ${newObjectId}`];
        });
        return lines.length ? `Duplicated ${lines.join("; ")}` : `Duplicated ${objectIds.join(", ")}`;
      },
      select: (effects) => {
        const copies = effects.flatMap((effect) => (effect.effect === "objectDuplicated" ? [effect.newObjectId] : []));
        return copies.length ? copies : undefined;
      },
    },
  );
}

async function renameObject(): Promise<void> {
  const objectId = soleSelection("rename");
  if (!objectId) return;
  const current = scene?.objects.find((object) => object.id === objectId)?.name ?? objectId;
  const name = window.prompt(`Rename ${objectId}`, current);
  if (name === null) return;
  await runEdits([{ edit: "renameObject", objectId, name }], `Renamed ${objectId} to ${name.trim()}`);
}

/** Delete every selected object as one batch: one undo entry. */
async function deleteObject(): Promise<void> {
  const objectIds = selectedRoots("delete");
  if (objectIds.length === 0) return;
  await runEdits(
    objectIds.map((objectId) => ({ edit: "deleteObject" as const, objectId })),
    {
      // Everything a delete took beyond the objects named, said out loud: a
      // group silently eating its children is how authors lose work.
      label: (effects) => {
        let children = 0;
        let channels = 0;
        let camera = false;
        for (const effect of effects) {
          if (effect.effect !== "objectDeleted") continue;
          children += effect.removedObjectIds.length - 1;
          channels += effect.removedChannelCount;
          camera ||= effect.clearedActiveCamera;
        }
        const also: string[] = [];
        if (children > 0) also.push(`${children} child object(s)`);
        if (channels > 0) also.push(`${channels} animation channel(s)`);
        if (camera) also.push("the scene's active camera");
        const named = objectIds.join(", ");
        return also.length ? `Deleted ${named}, and with it ${also.join(", ")}` : `Deleted ${named}`;
      },
      select: () => [],
    },
  );
}

/** What the font panel is drawn from: the document, the registry's last
 *  answer, the selection Assign would change, and the filters. */
function fontManagerState(): FontManagerState {
  return {
    ...(selectedFontId === undefined ? {} : { selectedFontId }),
    ...(fontReport === undefined
      ? {}
      : {
          unresolvedFontIds: fontReport.unresolvedFontIds,
          readyFontIds: fontReport.ready,
          problems: fontReport.failures,
        }),
    selectedObjectIds: selection,
    search: ui.fontSearch.value,
    statusFilter: ui.fontStatusFilter.value as FontStatusFilter,
    ...(fontIngesting ? { ingesting: true } : {}),
    ...(fontNotice === undefined ? {} : { notice: fontNotice }),
  };
}

function renderFontManager(document_: SceneDocument): void {
  ui.fontEmpty.hidden = document_.fonts.length > 0;
  const state = fontManagerState();
  ui.fontMount.replaceChildren(renderNode(document, fontManagerPanel(document_, state)) as unknown as Node);
  // The sample line is drawn in the font's own face, as 1.x did, but only
  // once the registry has the face: before that the browser would paint it
  // in a substitute and the sample would show the wrong typeface.
  for (const font of document_.fonts) {
    const row = document.getElementById(`font/${font.fontId}`);
    if (!row) continue;
    const { status } = fontStatus(font, state);
    row.dataset.status = status;
    const sample = document.getElementById(`font/${font.fontId}/sample`);
    if (sample && status === "ready") {
      sample.style.fontFamily = `"${(font.faces[0]?.family ?? font.family).replace(/["\\]/g, "\\$&")}"`;
    }
  }
}

function onFontManagerClick(event: MouseEvent): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  // An input edits in place; redrawing the row now would replace the field
  // under the pointer and lose the edit.
  if (target instanceof HTMLInputElement) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  if (button?.dataset.for === "font-manager") {
    if (button.dataset.action === "ingestFiles") void ingestFontFiles();
    else if (button.dataset.action === "ingestLink") void ingestFontLink();
    // The same publish as the toolbar's; the panel only adds the font blocker.
    else if (button.dataset.action === "publish") void publish();
    return;
  }
  const row = target.closest<HTMLLIElement>('li[role="listitem"][id^="font/"]');
  const nodeId = button?.dataset.for ?? row?.id;
  const font = scene.fonts.find((candidate) => `font/${candidate.fontId}` === nodeId);
  if (!font) return;

  selectedFontId = font.fontId;
  renderPanels(scene);

  if (button?.dataset.action === "remove") {
    void removeFont(font.fontId);
    return;
  }
  if (button?.dataset.action === "assign") {
    void assignFont(font.fontId);
    return;
  }
  if (button?.dataset.action === "replace") {
    void replaceFont(font.fontId);
    return;
  }
  if (button?.dataset.action !== "reveal") return;
  const users = fontUsers(scene, font.fontId);
  log(
    users.length === 0
      ? `Font ${font.displayName} has no object users.`
      : `Font ${font.displayName} is used by object(s): ${users.join(", ")}.`,
  );
}

/// Ingest several font files in one action (11.13). The shell verifies and
/// caches every file; the batch lands as one `addFonts` edit, so one ingest is
/// one undo entry. A file that records no licence is not assumed packageable:
/// the author states its licence, or keeps it on this workstation.
async function ingestFontFiles(): Promise<void> {
  const paths = await pickFontFiles(true);
  if (paths.length === 0) return;
  await ingestFonts(`${paths.length} font file(s)`, (target) => prepareFontFiles(target, paths));
}

async function pickFontFiles(multiple: boolean): Promise<string[]> {
  try {
    const picked = await openFileDialog({
      multiple,
      filters: [{ name: "Fonts", extensions: ["otf", "ttf", "woff", "woff2"] }],
    });
    return picked === null || picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
  } catch (error) {
    log(describe(error), "bad");
    return [];
  }
}

/// Verify and cache font files under the licence the author stated, or ask
/// for one when a file records none.
async function prepareFontFiles(target: SceneTarget, paths: readonly string[]): Promise<PreparedFontBatch> {
  const stated = ui.fontLicence.value.trim();
  const prepare = (embeddingPolicy: "package" | "restricted", license: string | null) =>
    shell().invoke<PreparedFontBatch>("cmd_font_prepare_files", { target, paths, embeddingPolicy, license });
  try {
    return await prepare("package", stated === "" ? null : stated);
  } catch (error) {
    if (refusalCode(error) !== "fontEmbeddingRefused") throw error;
    const entered = window.prompt(
      `${describe(error)}\nEnter the licence these fonts are under to package them, ` +
        "or leave blank to keep them on this workstation only.",
      "",
    );
    if (entered === null) throw error;
    return entered.trim() === "" ? prepare("restricted", null) : prepare("package", entered.trim());
  }
}

/// Replace a font's file under the same id (1.x's Replace), as one
/// `replaceFont` edit: text and styles stay on the font, and its display
/// name, fallbacks and enabled state are kept.
async function replaceFont(fontId: string): Promise<void> {
  const session = activeSession(workspace);
  const font = scene?.fonts.find((candidate) => candidate.fontId === fontId);
  if (!session || !font || fontIngesting) return;
  const [path] = await pickFontFiles(false);
  if (path === undefined) return;
  fontIngesting = true;
  fontNotice = `Replacing ${font.displayName}…`;
  if (scene) renderFontManager(scene);
  try {
    const batch = await prepareFontFiles({ target: "session", session: session.key }, [path]);
    const [replacement] = batch.fonts;
    if (replacement === undefined) {
      const already = batch.sources.find((source) => source.disposition.kind !== "added");
      fontNotice = `Font replace refused: ${already ? `${already.source} is already in this scene` : "the file held no font"}`;
      log(fontNotice, "bad");
      return;
    }
    const replaced = `Replaced ${font.displayName}'s file with ${batch.sources[0]?.source ?? path}`;
    const outcome = await runEdits(
      [{ edit: "replaceFont", fontId, font: replacement, assets: batch.assets }],
      replaced,
      "fonts",
    );
    fontNotice = outcome ? replaced : undefined;
  } catch (error) {
    fontNotice = `Font replace refused: ${describe(error)}`;
    log(fontNotice, "bad");
  } finally {
    fontIngesting = false;
    if (scene) renderPanels(scene);
  }
}

/// An in-place edit of a font's display name, fallbacks or enabled state
/// (1.x's card fields): one `updateFont` edit and one undo entry, checked
/// the way Rust checks it before it is sent.
function onFontManagerChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const match = /^font\/(.+)\/(displayName|fallbacks|enabled)$/.exec(target.dataset.for ?? "");
  if (!match) return;
  const [, fontId = "", field] = match;
  const patch: FontPatch =
    field === "enabled"
      ? { enabled: target.checked }
      : field === "displayName"
        ? { displayName: target.value.trim() }
        : { fallbackFamilies: parseFallbackFamilies(target.value) };
  void updateFont(fontId, patch);
}

async function updateFont(fontId: string, patch: FontPatch): Promise<void> {
  if (!scene) return;
  const refused = fontUpdateRefused(scene, fontId, patch);
  if (refused !== undefined) {
    // An edit that changes nothing is not an error; the field is just redrawn.
    if (refused.code !== "unchanged") {
      fontNotice = `Font change refused [${refused.code}]: ${refused.refused}`;
      log(fontNotice, "bad");
    }
    renderFontManager(scene);
    return;
  }
  const name = scene.fonts.find((candidate) => candidate.fontId === fontId)?.displayName ?? fontId;
  const outcome = await runEdits(
    [
      {
        edit: "updateFont",
        fontId,
        ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
        ...(patch.fallbackFamilies === undefined ? {} : { fallbackFamilies: [...patch.fallbackFamilies] }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      },
    ],
    `Changed font ${name}`,
    "fonts",
  );
  // A refusal leaves the document as it was; redraw so the field says so.
  if (!outcome && scene) renderFontManager(scene);
}

/// Download a Google Fonts, CSS, Adobe Fonts or direct file link into the
/// project (docs/p2-licensing-positions.md §5) and add it as one `addFonts`
/// edit. The link is read under the source the author chose (1.x's tabs).
async function ingestFontLink(): Promise<void> {
  const request = fontLinkFor(ui.fontLinkSource.value as FontLinkSource, ui.fontLink.value);
  if ("refused" in request) {
    fontNotice = `Font link refused: ${request.refused}`;
    if (scene) renderFontManager(scene);
    ui.fontLink.focus();
    return;
  }
  const added = await ingestFonts(request.link, (target) =>
    shell().invoke<PreparedFontBatch>("cmd_font_prepare_link", { target, link: request.link }),
  );
  if (added) ui.fontLink.value = "";
}

function showFontLinkSource(): void {
  const chosen = FONT_LINK_SOURCES.find((entry) => entry.source === ui.fontLinkSource.value);
  ui.fontLink.placeholder = chosen?.placeholder ?? "";
}

/// Give the selected text this font, as one undoable edit (1.x's Assign).
async function assignFont(fontId: string): Promise<void> {
  if (!scene) return;
  const font = scene.fonts.find((candidate) => candidate.fontId === fontId);
  if (!font) return;
  const objectIds = fontAssignTargets(scene, font, fontManagerState());
  if (objectIds.length === 0) return;
  await runEdits(
    [{ edit: "setObjectField", objectIds, field: { name: "fontId", value: fontId } }],
    `Assigned ${font.displayName} to ${objectIds.join(", ")}`,
    "fonts",
  );
}

/// Prepare a batch, apply the author's optional names, and add it as one edit.
/// True when fonts were added.
async function ingestFonts(
  label: string,
  prepare: (target: SceneTarget) => Promise<PreparedFontBatch>,
): Promise<boolean> {
  const session = activeSession(workspace);
  if (!session || fontIngesting) return false;
  fontIngesting = true;
  fontNotice = `Adding ${label}…`;
  if (scene) renderPanels(scene);
  try {
    const prepared = await prepare({ target: "session", session: session.key });
    const batch = {
      ...prepared,
      fonts: withIngestNames(prepared.fonts, {
        family: ui.fontFamilyOverride.value,
        displayName: ui.fontDisplayName.value,
      }),
    };
    const skipped = batch.sources
      .filter((source) => source.disposition.kind !== "added")
      .map((source) =>
        source.disposition.kind === "duplicateInBatch"
          ? `${source.source} (same font as ${source.disposition.firstSource})`
          : `${source.source} (already in this scene)`,
      );
    const skippedNote = skipped.length === 0 ? "" : `; skipped ${skipped.join(", ")}`;
    if (batch.fonts.length === 0) {
      fontNotice = `Nothing added${skippedNote}`;
      log(fontNotice);
      return false;
    }
    const added = `Added ${batch.fonts.length} font(s): ${batch.fonts.map((font) => font.displayName).join(", ")}`;
    const outcome = await runEdits([{ edit: "addFonts", fonts: batch.fonts, assets: batch.assets }], added, "fonts");
    fontNotice = outcome ? `${added}${skippedNote}` : undefined;
    if (!outcome) return false;
    // The names and licence were for this ingest; the next one starts blank.
    ui.fontFamilyOverride.value = "";
    ui.fontDisplayName.value = "";
    ui.fontLicence.value = "";
    return true;
  } catch (error) {
    fontNotice = `Font ingest refused: ${describe(error)}`;
    log(fontNotice, "bad");
    return false;
  } finally {
    fontIngesting = false;
    if (scene) renderPanels(scene);
  }
}

/// Remove one font explicitly (11.13). The panel refuses a font in use before
/// asking; Rust refuses it again (`fontInUse`), so the two cannot disagree.
async function removeFont(fontId: string): Promise<void> {
  if (!scene) return;
  const plan = planFontRemoval(scene, fontId);
  if (isFontRemovalRefused(plan)) {
    log(`font removal refused [${plan.code}]: ${plan.refused}`, "bad");
    return;
  }
  const outcome = await runEdits([{ edit: "removeFont", fontId }], `Removed font ${plan.displayName}`, "fonts");
  if (outcome && selectedFontId === fontId) selectedFontId = undefined;
}

function refusalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("refusal" in cause)) return undefined;
  return typeof cause.refusal === "string" ? cause.refusal : undefined;
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
  await runEdits([{ edit: "saveTextStyle", style }], `Saved text style ${style.name}`);
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
  // The design system comes from the session's own project origin, in Rust.
  await runGesture(
    selection.map((objectId) => ({ edit: "applyTextStyle", objectId, styleId })),
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

  if (button?.dataset.action === "relink") {
    relinkSelectedMaterial(scene, material.materialId, material.name);
    return;
  }
  if (button?.dataset.action === "delete") {
    selectedMaterialId = undefined;
    void runEdits([{ edit: "deleteMaterial", materialId: material.materialId }], {
      label: `Deleted material ${material.name}`,
      refusal: "material delete refused",
    });
    return;
  }
  if (button?.dataset.action !== undefined && button.dataset.action !== "reveal") return;
  const users = usersOf(scene, material.materialId);
  log(
    users.length === 0
      ? `Material ${material.name} has no object users.`
      : `Material ${material.name} is used by object(s): ${users.join(", ")}.`,
  );
}

/** Relink every user of one material onto another as one undo entry (11.12).
 *  The prompt shows the blast radius first — the objects `relinkMaterial`
 *  previews — so the author confirms a known set, never a blind repoint. Rust
 *  performs the relink and reports the objects it changed. */
function relinkSelectedMaterial(document_: SceneDocument, fromId: string, fromName: string): void {
  const preview = usersOf(document_, fromId);
  const others = document_.materials
    .filter((candidate) => candidate.materialId !== fromId)
    .map((candidate) => candidate.materialId);
  if (others.length === 0) {
    log(`material relink refused: there is no other material to relink ${fromName} onto`, "bad");
    return;
  }
  const toId = window.prompt(
    `Relink ${preview.length} object(s) from ${fromName} (${preview.join(", ")}) to which material? ` +
      `One of: ${others.join(", ")}`,
    others[0],
  );
  if (toId === null) return;
  const target = toId.trim();
  void runEdits([{ edit: "relinkMaterial", fromMaterialId: fromId, toMaterialId: target }], {
    label: (effects) => {
      for (const effect of effects) {
        if (effect.effect !== "materialsRelinked") continue;
        return `Relinked ${effect.changed.length} object(s) from ${fromId} to ${target}: ${effect.changed.join(", ")}`;
      }
      return `Relinked ${fromId} to ${target}`;
    },
    refusal: "material relink refused",
  });
}

// ---------------------------------------------------------------------------
// Project-owned assets and previews (11.18)
//
// A project is a container: its folder owns the asset files, scenes reference
// them by id, and a graphic saved into a project brings its assets along. The
// shell copies bytes from the import cache into <project>/assets and keeps a
// record beside each file; this layer asks it to, shows the result, and builds
// previews from the project's verified bytes.
// ---------------------------------------------------------------------------

const PREVIEW_PX = 240;

interface AdoptReport {
  adopted: string[];
  alreadyPresent: string[];
  missing: { assetId: string; reason: string }[];
}

/** Bring the open graphic's assets into its project, refresh the project's
 *  library, and start previews. Idempotent and quiet when nothing changed.
 *  A reply that arrives after the author has moved to another project is
 *  dropped: it describes a folder no panel is showing. */
async function syncProjectAssets(): Promise<void> {
  const project = projectSceneProject;
  const document_ = scene;
  if (!document_) return;
  if (project !== projectAssetListing && (projectAssetListing !== undefined || projectAssetLibrary.length > 0)) {
    // Another project's library must not stand in for this one while its
    // own listing is on the way.
    projectAssetLibrary = [];
    projectAssetStored = new Set();
    projectAssetProblems = [];
    projectAssetListing = undefined;
  }
  if (project === undefined) {
    startAssetPreviews(document_.assets);
    return;
  }
  const pending = document_.assets.filter(
    (asset) => asset.checksum !== undefined && !adoptionTried.has(`${project}|${asset.checksum}`),
  );
  let problems = projectAssetProblems;
  if (pending.length > 0) {
    for (const asset of pending) adoptionTried.add(`${project}|${asset.checksum}`);
    try {
      const report = await shell().invoke<AdoptReport>("cmd_project_assets_adopt", { project, items: pending });
      problems = report.missing.map((missing) => {
        const name = pending.find((asset) => asset.assetId === missing.assetId)?.name ?? missing.assetId;
        return `${name}: ${missing.reason}`;
      });
      // A missing asset is retried next time, so re-importing it heals it.
      for (const missing of report.missing) {
        const asset = pending.find((candidate) => candidate.assetId === missing.assetId);
        if (asset) adoptionTried.delete(`${project}|${asset.checksum}`);
      }
      if (report.adopted.length > 0) {
        log(`Took ${report.adopted.length} asset(s) into project ${project}`, "good");
      }
    } catch (error) {
      for (const asset of pending) adoptionTried.delete(`${project}|${asset.checksum}`);
      problems = [`could not take assets into project ${project}: ${describe(error)}`];
    }
    if (projectSceneProject !== project) return;
  }
  // Read the folder only when something may have changed: a different
  // project, or assets just taken in. Not on every edit.
  if (pending.length === 0 && projectAssetListing === project) {
    startAssetPreviews([...document_.assets, ...projectAssetLibrary]);
    return;
  }
  const asked = ++projectAssetListingsAsked;
  let library: AssetLibraryItem[] | undefined;
  try {
    library = await shell().invoke<AssetLibraryItem[]>("cmd_project_assets", { project });
  } catch (error) {
    problems = [...problems, `project assets unreadable: ${describe(error)}`];
  }
  if (projectSceneProject !== project || asked < projectAssetListingShown) return;
  projectAssetListingShown = asked;
  if (library) {
    projectAssetListing = project;
    projectAssetLibrary = library;
    projectAssetStored = new Set(library.flatMap((asset) => (asset.checksum === undefined ? [] : [asset.checksum])));
  }
  projectAssetProblems = problems;
  startAssetPreviews([...document_.assets, ...projectAssetLibrary]);
  if (scene) renderPanels(scene);
}

/** Make a preview for every asset that does not have one yet. */
function startAssetPreviews(assets: readonly AssetLibraryItem[]): void {
  for (const asset of assets) {
    const hash = asset.checksum;
    if (hash === undefined || assetPreviews.has(hash)) continue;
    assetPreviews.set(hash, { kind: "loading" });
    void (async () => {
      let preview: AssetPreview;
      try {
        const bytes = await shell().invoke<ArrayBuffer>("cmd_asset_bytes", {
          project: projectSceneProject ?? null,
          checksum: hash,
        });
        preview = await buildAssetPreview(asset, bytes);
      } catch (error) {
        preview = { kind: "unavailable", reason: describe(error) };
      }
      assetPreviews.set(hash, preview);
      if (scene) renderPanels(scene);
    })();
  }
}

async function buildAssetPreview(asset: AssetLibraryItem, bytes: ArrayBuffer): Promise<AssetPreview> {
  const mime = asset.mimeType ?? "";
  if (asset.kind === "image" || asset.kind === "svg") {
    return rasterPreview(new Blob([bytes], { type: mime || (asset.kind === "svg" ? "image/svg+xml" : "image/png") }));
  }
  if (asset.kind === "video") {
    const preview = await videoPreview(new Blob([bytes], { type: mime || "video/mp4" }));
    if (preview.kind === "ready") return preview;
    // Say what the file is, so the author knows it is the format and not a
    // broken import: a browser engine cannot decode ProRes, for one.
    const codec = describeVideoCodec(new Uint8Array(bytes));
    return codec === undefined
      ? preview
      : {
          kind: "unavailable",
          reason: `${codec} video cannot be decoded in this window; the file is kept in the project unchanged`,
        };
  }
  if (asset.kind === "model") {
    return { kind: "unavailable", reason: "3D models have no preview yet; the file is in the project" };
  }
  return { kind: "unavailable", reason: `${asset.kind} assets have no preview` };
}

/** Scale a drawable into a small PNG so a 17 MB image costs a thumbnail. */
function thumbnailOf(source: CanvasImageSource, width: number, height: number): string {
  const scale = Math.min(1, PREVIEW_PX / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("a 2D canvas is not available to draw the preview");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function rasterPreview(blob: Blob): Promise<AssetPreview> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      return { kind: "unavailable", reason: "the file could not be decoded as an image" };
    }
    // An SVG with no intrinsic size is drawn at the preview size.
    const width = image.naturalWidth > 0 ? image.naturalWidth : PREVIEW_PX;
    const height = image.naturalHeight > 0 ? image.naturalHeight : PREVIEW_PX;
    return { kind: "ready", src: thumbnailOf(image, width, height) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoPreview(blob: Blob): Promise<AssetPreview> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    const once = (name: "loadeddata" | "seeked"): Promise<boolean> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 8000);
        video.addEventListener(name, () => { window.clearTimeout(timer); resolve(true); }, { once: true });
        video.addEventListener("error", () => { window.clearTimeout(timer); resolve(false); }, { once: true });
      });
    if (!(await once("loadeddata"))) {
      return { kind: "unavailable", reason: "this video cannot be decoded in this window (codec or container)" };
    }
    const target = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0;
    if (target > 0) {
      const seeked = once("seeked");
      video.currentTime = target;
      if (!(await seeked)) return { kind: "unavailable", reason: "the first frame could not be read" };
    }
    if (video.videoWidth === 0) return { kind: "unavailable", reason: "the video has no picture" };
    return { kind: "ready", src: thumbnailOf(video, video.videoWidth, video.videoHeight) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function onAssetManagerClick(event: MouseEvent): void {
  if (!scene) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action][data-for]");
  if (button?.dataset.for === "asset-manager") {
    if (button.dataset.action === "importFiles" && !button.disabled) void importAssetFiles();
    return;
  }
  if (button?.dataset.action === "addToScene" && button.dataset.for?.startsWith("project-asset/") && !button.disabled) {
    const assetId = button.dataset.for.slice("project-asset/".length);
    const item = projectAssetLibrary.find((candidate) => candidate.assetId === assetId);
    if (item) {
      void runEdits([{ edit: "addAssets", assets: [item] }], `Added ${item.name} from the project library`, "assets");
    }
    return;
  }
  const row = target.closest<HTMLLIElement>('li[role="listitem"][id^="asset/"]');
  const asset = scene.assets.find((candidate) => `asset/${candidate.assetId}` === row?.id);
  if (!asset) return;

  selectedAssetId = asset.assetId;
  renderPanels(scene);
  if (button?.dataset.action === "relink" && !button.disabled) {
    void relinkAsset(asset.assetId);
    return;
  }

  const users = assetUsers(scene, asset.assetId);
  log(
    users.length === 0
      ? `Asset ${asset.name} is used by no objects.`
      : `Asset ${asset.name} is used by object(s): ${users.join(", ")}.`,
  );
}

/// Import image, SVG, video and 3D model files (11.39). The shell classifies
/// each file by its bytes, caches it by content hash and fills in its
/// provenance; the batch lands as one `addAssets` edit, so one import is one
/// undo entry. The same file imported again is reported, not added twice.
async function importAssetFiles(): Promise<void> {
  const session = activeSession(workspace);
  if (!session || assetImporting) return;
  let paths: string[];
  try {
    const picked = await openFileDialog({
      multiple: true,
      filters: [{ name: "Images, SVG, video and 3D models", extensions: ASSET_FILE_EXTENSIONS }],
    });
    paths = picked === null || picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  if (paths.length === 0) return;
  assetImporting = true;
  assetNotice = `Importing ${paths.length} file(s)…`;
  if (scene) renderPanels(scene);
  try {
    const batch = await shell().invoke<PreparedAssetBatch>("cmd_asset_prepare_files", {
      target: { target: "session", session: session.key },
      paths,
    });
    const skipped = batch.sources
      .filter((source) => source.disposition.kind !== "added")
      .map((source) =>
        source.disposition.kind === "duplicateInBatch"
          ? `${source.source} (same file as ${source.disposition.firstSource})`
          : `${source.source} (already in this scene as ${source.assetId})`,
      );
    const skippedNote = skipped.length === 0 ? "" : `; skipped ${skipped.join(", ")}`;
    if (batch.assets.length === 0) {
      assetNotice = `Nothing added${skippedNote}`;
      log(assetNotice);
      return;
    }
    const where = projectSceneProject === undefined
      ? "held in the import cache until this graphic is saved into a project"
      : `kept in project ${projectSceneProject}`;
    const added = `Imported ${batch.assets.length} asset(s), ${where}: ${batch.assets.map((asset) => asset.name).join(", ")}`;
    const outcome = await runEdits([{ edit: "addAssets", assets: batch.assets }], added, "assets");
    assetNotice = outcome ? `${added}${skippedNote}` : undefined;
  } catch (error) {
    assetNotice = `Asset import refused: ${describe(error)}`;
    log(assetNotice, "bad");
  } finally {
    assetImporting = false;
    if (scene) renderPanels(scene);
  }
}

/// Point one asset at another file of the same kind (1.x's Relink), as one
/// `relinkAsset` edit: the asset keeps its id, so every object using it
/// follows. The file is verified and cached as an import would be.
async function relinkAsset(assetId: string): Promise<void> {
  const session = activeSession(workspace);
  const asset = scene?.assets.find((candidate) => candidate.assetId === assetId);
  if (!session || !asset || assetImporting) return;
  let path: string | undefined;
  try {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images, SVG, video and 3D models", extensions: ASSET_FILE_EXTENSIONS }],
    });
    path = (Array.isArray(picked) ? picked[0] : picked) ?? undefined;
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  if (path === undefined) return;
  assetImporting = true;
  assetNotice = `Relinking ${asset.name}…`;
  if (scene) renderPanels(scene);
  try {
    const batch = await shell().invoke<PreparedAssetBatch>("cmd_asset_prepare_files", {
      target: { target: "session", session: session.key },
      paths: [path],
    });
    // A file already in this graphic is offered as that asset's bytes.
    const already = batch.sources.find((source) => source.disposition.kind === "alreadyInScene");
    const replacement =
      batch.assets[0] ?? scene?.assets.find((candidate) => candidate.assetId === already?.assetId);
    if (!scene || !replacement) {
      assetNotice = "Relink refused: the picked file held no asset";
      log(assetNotice, "bad");
      return;
    }
    const plan = planAssetRelink(scene, assetId, replacement);
    if ("refused" in plan) {
      assetNotice = `Relink refused: ${plan.refused}`;
      log(assetNotice, "bad");
      return;
    }
    const relinked = `Relinked ${asset.name} to ${replacement.name}`;
    const outcome = await runEdits([{ edit: "relinkAsset", ...plan }], relinked, "assets");
    assetNotice = outcome ? relinked : undefined;
  } catch (error) {
    assetNotice = `Relink refused: ${describe(error)}`;
    log(assetNotice, "bad");
  } finally {
    assetImporting = false;
    if (scene) renderPanels(scene);
  }
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

  const object = scene.objects.find((candidate) => candidate.id === objectId);
  if (!object) return;
  const previous = object.bindings?.[property];
  let path: string | undefined;
  if (action === "bind") {
    const entered = window.prompt(
      `Data path for ${property} (for example match.homeScore)`,
      typeof previous === "string" ? previous : "",
    );
    if (entered === null) return;
    path = entered.trim();
  } else if (action !== "removeBinding") {
    return;
  }

  // Rust checks the path against the data context and the property's type,
  // and refuses an unbind of nothing, by name.
  const verb = path === undefined ? "Remove" : previous === undefined ? "Bind" : "Change";
  void runEdits([{ edit: "setBinding", objectId, property, ...(path === undefined ? {} : { path }) }], {
    label: `${verb} ${bindingLabel(object, property)} binding`,
    refusal: "binding refused",
  });
}

/** Fill the sample-data editor and list every binding that does not resolve. */
function renderSampleData(document_: SceneDocument): void {
  if (document_.dataContext !== sampleDataShown) {
    sampleDataShown = document_.dataContext;
    ui.sampleDataText.value = formatSampleData(document_.dataContext);
    ui.sampleDataStatus.textContent = "";
  }
  ui.sampleDataIssues.replaceChildren(
    ...sceneBindingIssues(document_).map((issue) => {
      const item = document.createElement("li");
      item.textContent = describeBindingIssue(issue);
      return item;
    }),
  );
}

/** Replace the scene's data context from the editor text as one undo entry.
 *  The text is parsed strictly here so a refusal can point into it; Rust
 *  replaces the data and reports the bindings that stopped resolving. A
 *  refusal leaves the document and the author's text exactly as they were. */
function onSampleDataApply(): void {
  if (!scene) return;
  const parsed = parseSampleData(ui.sampleDataText.value);
  if (!parsed.ok) {
    ui.sampleDataStatus.textContent = `Refused [${parsed.code}]: ${parsed.reason}`;
    if (parsed.position) {
      ui.sampleDataText.focus();
      ui.sampleDataText.setSelectionRange(parsed.position.offset, parsed.position.offset + 1);
    }
    log(`sample data refused: ${parsed.reason}`, "bad");
    return;
  }
  const fields = dataFields(parsed.data).length;
  void runEdits([{ edit: "replaceDataContext", dataContext: parsed.data }], {
    label: `Replace sample data (${fields} field${fields === 1 ? "" : "s"})`,
    refusal: "sample data refused",
    onRefusal: (message) => {
      ui.sampleDataStatus.textContent = `Refused: ${message}`;
    },
  }).then((outcome) => {
    if (!outcome) return;
    const broken = outcome.effects.flatMap((effect) =>
      effect.effect === "dataContextReplaced" ? effect.newlyInvalid : [],
    );
    ui.sampleDataStatus.textContent =
      broken.length === 0
        ? "Applied."
        : `Applied. ${broken.length} binding(s) no longer resolve; they are kept as authored and listed below.`;
    for (const issue of broken) {
      log(`binding no longer resolves: ${issue.objectId}.${issue.property} (${issue.path}): ${issue.detail}`, "bad");
    }
  });
}

function onSampleDataRevert(): void {
  if (!scene) return;
  ui.sampleDataText.value = formatSampleData(scene.dataContext);
  ui.sampleDataStatus.textContent = "";
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

function iconImage(name: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = `icons/${name}.svg`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function updateTimeReadouts(): void {
  if (!scene) return;
  for (const id of ["viewer-timecode", "timeline-timecode"]) {
    const label = document.getElementById(id);
    if (label) label.textContent = formatTimecode(currentFrame, scene.canvas.frameRate);
  }
  const frame = document.getElementById("timeline-frame-line");
  if (frame) frame.textContent = formatFrameLine(currentFrame, scene.canvas.frameRate);
  for (const id of ["viewer-rate", "preview-rate"]) {
    const label = document.getElementById(id);
    if (label) label.textContent = formatRate(scene.canvas.frameRate);
  }
  const composition = document.getElementById("composition-name");
  if (composition) composition.textContent = scene.name;
}

function focusWorkspacePanel(id: string): void {
  const panel = document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
  if (!panel || panel.hidden) return;
  panel.classList.remove("panel-section-collapsed");
  panel.querySelector<HTMLButtonElement>(".panel-disclosure")?.setAttribute("aria-expanded", "true");
  panel.scrollIntoView({ block: "nearest" });
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
}

/** Workspace controls only invoke existing command and view-state paths. */
function wireWorkspaceChrome(): void {
  for (const button of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    button.prepend(iconImage(button.dataset.icon!));
  }
  for (const [id, icon] of [["open-scene", "folder-open"], ["save-scene", "floppy-disk"],
    ["undo", "arrow-counter-clockwise"], ["redo", "arrow-clockwise"]]) {
    document.getElementById(id!)?.prepend(iconImage(icon!));
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const invoke = target?.closest<HTMLElement>("[data-invoke]");
    if (invoke?.dataset.invoke) {
      const button = document.getElementById(invoke.dataset.invoke) as HTMLButtonElement | null;
      if (button?.disabled) log(`${invoke.textContent?.trim()} is unavailable in the current scene`);
      else button?.click();
    }
    const creation = target?.closest<HTMLElement>("[data-create-kind]");
    if (creation?.dataset.createKind) {
      ui.objectKind.value = creation.dataset.createKind;
      if (!ui.objectKind.value) log(`Object kind ${creation.dataset.createKind} is unavailable`, "bad");
      else void createObject();
    }
    const panel = target?.closest<HTMLElement>("[data-focus-panel]");
    if (panel?.dataset.focusPanel) focusWorkspacePanel(panel.dataset.focusPanel);
    if (invoke || creation || panel) {
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => { menu.open = false; });
    } else if (!target?.closest(".app-menu")) {
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => { menu.open = false; });
    }
  });
  document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((other) => {
        if (other !== menu) other.open = false;
      });
    });
  });
  document.getElementById("tool-selection")?.addEventListener("click", () => ui.overlay.focus());
  document.getElementById("viewer-transparency")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    document.querySelector(".viewport-stage")?.classList.toggle("show-transparency", on);
  });
  for (const [id, next] of [
    ["preview-first", () => 0], ["preview-previous", () => currentFrame - 1],
    ["preview-next", () => currentFrame + 1], ["preview-last", () => Math.max(0, Number(scene?.timeline.durationFrames ?? 1) - 1)],
  ] as const) {
    document.getElementById(id)?.addEventListener("click", () => { pausePreview("manual step"); setCurrentFrame(next()); });
  }
  // Animation stays open: it is where the current task lives. The rest are
  // reference panels and start folded.
  const defaults = new Set(["fonts", "text-styles", "materials", "assets", "bindings", "control-contract", "take-page", "publish"]);
  for (const panel of document.querySelectorAll<HTMLElement>(".panel[data-panel]")) {
    const heading = panel.querySelector<HTMLElement>(":scope > h2, :scope > .panel-title-row h2");
    if (!heading) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel-disclosure";
    button.append(iconImage("caret-down"));
    const folded = defaults.has(panel.dataset.panel!);
    button.setAttribute("aria-expanded", String(!folded));
    button.setAttribute("aria-label", `Expand or collapse ${heading.textContent}`);
    panel.classList.toggle("panel-section-collapsed", folded);
    const toggle = (): void => {
      const collapsed = panel.classList.toggle("panel-section-collapsed");
      button.setAttribute("aria-expanded", String(!collapsed));
    };
    button.addEventListener("click", toggle);
    heading.addEventListener("dblclick", toggle);
    heading.append(button);
    const menu = document.createElement("button");
    menu.type = "button";
    menu.dataset.focusPanel = panel.dataset.panel!;
    menu.textContent = heading.childNodes[0]?.textContent ?? panel.dataset.panel!;
    document.getElementById("window-panel-menu")?.append(menu);
  }
  for (const [id, label] of [["viewport", "Composition"], ["timeline", "Timeline"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.focusPanel = id!;
    button.textContent = label!;
    document.getElementById("window-panel-menu")?.append(button);
  }
}

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
    shell().invoke<ProjectSceneCatalog>("cmd_scene_list", { project }),
    shell().invoke<ProjectTakePageCatalog>("cmd_take_page_list", { project }),
  ]);
  projectCatalog = scenes;
  graphicPreviewGeneration += 1;
  graphicPreviews.clear();
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
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("take-page preview refused: nothing is open", "bad");
    return false;
  }
  // Rust fills the session's own document; nothing here is sent back. The
  // preview belongs to the template it was asked for, so an edit landing
  // during the round trip makes it stale rather than shown.
  const template = scene;
  const target: SceneTarget = { target: "session", session: session.key };
  try {
    const filled = await shell().invoke<SceneDocument>("cmd_take_page_preview", {
      target,
      values: effectiveTakePageValues(template),
    });
    if (scene !== template) {
      throw new Error("the template changed while its take-page preview was being filled");
    }
    takePageState = withoutTakePageRefusal(takePageState);
    takePagePreviewDocument = filled;
    renderSceneState();
    log(`previewed take-page values for ${template.name}`, "good");
    return true;
  } catch (error) {
    takePageState = { ...takePageState, refusal: describe(error) };
    if (scene) renderPanels(scene);
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
    await execute({ command: "saveTakePage", project, page });
  } catch (error) {
    log(`take-page save refused: ${describe(error)}`, "bad");
    return;
  }
  log(`saved take page ${project}/${pageId}`, "good");
  try {
    takePageCatalog = await shell().invoke<ProjectTakePageCatalog>("cmd_take_page_list", { project });
  } catch (error) {
    log(`take-page list unavailable: ${describe(error)}`, "bad");
  }
  if (scene) renderPanels(scene);
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
    const page = await shell().invoke<TakePage>("cmd_take_page_read", { project, pageId });
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
    setProjectOptions(await shell().invoke<string[]>("cmd_project_list"), preferred);
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
    renderProjectManager();
  }
}

function refusesDiscard(action: string): boolean {
  if (!projectChangesUnsaved() || projectSceneId === undefined) return false;
  log(
    `${action} refused: ${projectSceneId} has unsaved project changes; use Save here first`,
    "bad",
  );
  return true;
}

/// Apply a scene id or name typed into the header, as one edit, before a save
/// or publish uses it. Rust validates both and refuses by name.
async function applyPendingIdentity(): Promise<boolean> {
  if (!scene) return false;
  const edits = pendingIdentityEdits(scene);
  if (edits.length === 0) return true;
  const parts = edits.map((edit) =>
    edit.edit === "setSceneId" ? `id ${edit.id}` : edit.edit === "setSceneName" ? `name ${edit.name}` : edit.edit,
  );
  const outcome = await runEdits(edits, {
    label: `Set scene ${parts.join(" and ")}`,
    refusal: "scene identity refused",
  });
  return outcome !== undefined;
}

async function createProject(): Promise<void> {
  showManagerCreate("container");
}

let managerCreateKind: "container" | "graphic" = "container";
/** The contract's rate for a new graphic (`new_scene`): 50/1. */
const DEFAULT_RATE: RationalRate = { num: 50, den: 1 };

function showManagerCreate(kind: "container" | "graphic"): void {
  managerCreateKind = kind;
  ui.managerForm.reset();
  ui.managerError.textContent = "";
  document.getElementById("manager-create-title")!.textContent = kind === "container" ? "New scene" : "New graphic";
  document.getElementById("manager-create-name-label")!.textContent = kind === "container" ? "Scene name" : "Graphic name";
  document.getElementById("manager-create-description")!.textContent = kind === "container"
    ? "Keep multiple graphics together. Each graphic has its own layers and timeline."
    : currentProject === undefined ? "Create an independent graphic. Save it into a scene when ready."
      : `Add an independent graphic to ${currentProject}.`;
  ui.managerRateRow.hidden = kind === "container";
  ui.managerRate.value = "50/1";
  ui.managerCustomRate.hidden = true;
  ui.managerRateNum.value = "";
  ui.managerRateDen.value = "1";
  ui.managerDialog.showModal();
  ui.managerName.focus();
}

/** Fill a rate select: every broadcast rate, then Custom. */
function fillRateSelect(select: HTMLSelectElement): void {
  select.replaceChildren(
    ...BROADCAST_RATES.map((entry) => new Option(entry.label, entry.key)),
    new Option("Custom (num/den)…", "custom"),
  );
}

/** Show a document's rate in a select; a rate outside the list reads as
 *  Custom with its exact ratio in the label. */
function showRateChoice(select: HTMLSelectElement, rate: RationalRate): void {
  const key = rateKey(rate);
  const custom = [...select.options].find((option) => option.value === "custom");
  if (custom) custom.textContent = key === "custom" ? `Custom: ${rate.num}/${rate.den} (${formatRate(rate)})` : "Custom (num/den)…";
  select.value = key;
}

/// Change the open graphic's frame rate from the header: one setCanvas edit.
/// Frames are canonical, so every key keeps its frame; the clock, ruler and
/// playback follow the new rate.
async function changeCanvasRate(): Promise<void> {
  if (!scene) return;
  const current = scene.canvas.frameRate;
  let parsed = parseRateChoice(ui.canvasRate.value, "", "");
  if (ui.canvasRate.value === "custom") {
    const typed = window.prompt("Frame rate as a whole-number ratio, numerator/denominator (29.97 is 30000/1001)", `${current.num}/${current.den}`);
    if (typed === null) {
      showRateChoice(ui.canvasRate, current);
      return;
    }
    const [num = "", den = "1"] = typed.split("/");
    parsed = parseRateChoice("custom", num, den);
  }
  if (!parsed.ok) {
    log(`frame rate refused: ${parsed.refused}`, "bad");
    showRateChoice(ui.canvasRate, current);
    return;
  }
  if (sameRate(parsed.rate, current)) return;
  const outcome = await runEdits(
    [{ edit: "setCanvas", frameRate: parsed.rate }],
    `Set frame rate to ${formatRate(parsed.rate)} (${parsed.rate.num}/${parsed.rate.den}); frames keep their numbers`,
    "scene",
  );
  if (!outcome && scene) showRateChoice(ui.canvasRate, scene.canvas.frameRate);
}

async function submitManagerCreate(): Promise<void> {
  const name = ui.managerName.value.trim();
  const submit = ui.managerForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  if (!name || submit.disabled) return;
  // The rate is checked before anything is created, so a bad ratio leaves
  // nothing behind. The default keeps the contract's new-scene rate.
  const rate = managerCreateKind === "graphic"
    ? parseRateChoice(ui.managerRate.value, ui.managerRateNum.value, ui.managerRateDen.value)
    : undefined;
  if (rate && !rate.ok) {
    ui.managerError.textContent = rate.refused;
    return;
  }
  const chosenRate = rate?.ok && !sameRate(rate.rate, DEFAULT_RATE) ? rate.rate : undefined;
  submit.disabled = true;
  ui.managerError.textContent = "";
  try {
    if (managerCreateKind === "container") {
      await execute({ command: "createProject", project: name });
      ui.graphicSearch.value = "";
      await loadProjects(name);
      log(`Created scene ${name}`, "good");
    } else {
      const id = freshGraphicId(name);
      if (currentProject === undefined) {
        const opened = await runCommand({ command: "openScene", source: { source: "new", id, name } }, `Created graphic ${name}`);
        if (!opened) throw new Error("The graphic could not be opened. See Activity for the refusal.");
        if (chosenRate) await runEdits([{ edit: "setCanvas", frameRate: chosenRate }], `Set frame rate to ${formatRate(chosenRate)}`, "scene");
      } else {
        const project = currentProject;
        await execute({ command: "createScene", project, sceneId: id, name });
        // Applied to the stored copy before it opens, so the graphic is
        // created at its rate rather than opened dirty.
        if (chosenRate) {
          await execute({ command: "editScene", target: { target: "stored", project, sceneId: id }, edits: [{ edit: "setCanvas", frameRate: chosenRate }] });
        }
        ui.graphicSearch.value = "";
        await refreshProjectCatalog();
        const opened = await runCommand({ command: "openScene", source: { source: "project", project, sceneId: id } }, `Created graphic ${name}`);
        if (!opened) throw new Error("The graphic was saved but could not be opened. See Activity for the refusal.");
      }
    }
    ui.managerDialog.close();
  } catch (error) {
    ui.managerError.textContent = describe(error);
    log(ui.managerError.textContent, "bad");
  } finally {
    submit.disabled = false;
  }
}

async function selectProject(): Promise<void> {
  const project = ui.projectSelect.value;
  if (!project || project === currentProject) return;
  currentProject = project;
  ui.graphicSearch.value = "";
  projectCatalog = undefined;
  renderProjectManager();
  try {
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function saveProjectScene(): Promise<void> {
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("project save refused: nothing is open", "bad");
    return;
  }
  const project = currentProject;
  if (project === undefined) {
    log("project save refused: no project exists", "bad");
    return;
  }
  const origin = session.view.origin;
  const boundHere = origin?.project === project;
  const id = boundHere ? origin.sceneId : ui.sceneId.value.trim();
  const name = ui.sceneName.value.trim();
  if (!id || !name) {
    log("project save refused: scene id and name are both required", "bad");
    return;
  }
  // Identity first, then the save: a bound scene updates its own store
  // address; an unbound one is created in the selected project and bound.
  if (!(await applyPendingIdentity())) return;
  const saved = await runCommand(
    { command: "saveScene", session: session.key, to: boundHere ? { to: "origin" } : { to: "project", project } },
    `${boundHere ? "updated" : "created"} ${project}/${id}`,
  );
  if (!saved) return;
  try {
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function openProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  // Rust reveals a scene that is already open rather than opening it twice,
  // so the author's in-progress copy is never replaced by the stored one.
  await runCommand(
    { command: "openScene", source: { source: "project", project, sceneId } },
    `opened ${project}/${sceneId}`,
  );
}

async function duplicateProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  const proposedId = window.prompt("Duplicate graphic id", `${sceneId}-copy`);
  if (proposedId === null) return;
  const newId = proposedId.trim();
  if (!newId) {
    log("duplicate refused: scene id is empty", "bad");
    return;
  }
  const listed = projectCatalog?.project === project
    ? projectCatalog.scenes.find((candidate) => candidate.sceneId === sceneId)
    : undefined;
  const proposedName = window.prompt("Duplicate graphic name", `${listed?.name ?? sceneId} Copy`);
  if (proposedName === null) return;
  const name = proposedName.trim();
  if (!name) {
    log("duplicate refused: scene name is empty", "bad");
    return;
  }
  try {
    await execute({ command: "duplicateScene", project, sourceSceneId: sceneId, sceneId: newId, name });
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  log(`duplicated ${project}/${sceneId} as ${newId}`, "good");
  try {
    await refreshProjectCatalog();
  } catch (error) {
    log(describe(error), "bad");
  }
  await runCommand(
    { command: "openScene", source: { source: "project", project, sceneId: newId } },
    `opened ${project}/${newId}`,
  );
}

async function publishProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  if (projectChangesUnsaved() && projectSceneProject === project && projectSceneId === sceneId) {
    log(`publish refused: ${sceneId} has unsaved changes`, "bad");
    return;
  }
  const endpoint = ui.endpoint.value.trim();
  const target: SceneTarget = { target: "stored", project, sceneId };
  try {
    const result = await shell().invoke<PublishResult>("cmd_publish", { endpoint, target });
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
    log(`published ${takeId} revision ${revision} hash ${plain(result.contentHash)}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function deleteProjectScene(sceneId: string): Promise<void> {
  const project = currentProject;
  if (project === undefined) return;
  if (projectChangesUnsaved() && projectSceneProject === project && projectSceneId === sceneId) {
    log(`delete refused: ${sceneId} has unsaved changes`, "bad");
    return;
  }
  let outcome: CommandOutcome;
  try {
    outcome = await execute({ command: "deleteScene", project, sceneId });
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  // An open session of the deleted scene stays open, now unbound; Rust
  // returns its projection so the tab and header say so.
  const unbound = outcome.session;
  if (unbound) {
    if (unbound.session === workspace.activeKey) presentView(unbound);
    else applySessionView(workspace, unbound);
    renderSceneTabs();
  }
  log(
    unbound
      ? `deleted ${project}/${sceneId}; the document remains open outside the project`
      : `deleted ${project}/${sceneId}`,
    "good",
  );
  try {
    await refreshProjectCatalog();
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
  showManagerCreate("graphic");
}

/// The display name is free text; the stable storage id is a safe slug no
/// stored or open graphic already uses.
function freshGraphicId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "graphic";
  const ids = new Set([...(projectCatalog?.scenes.map((item) => item.sceneId) ?? []),
    ...workspace.sessions.map((item) => item.view.document.id)]);
  let id = slug;
  for (let suffix = 2; ids.has(id); suffix += 1) id = `${slug}-${suffix}`;
  return id;
}

/// Import an SVG as a new unbound graphic (11.17 over 7.2). The shell keeps
/// the source bytes by hash and opens the session; the report arrives as the
/// command's `imported` effect and is shown before the author works on it.
async function importSvg(): Promise<void> {
  if (refusesDiscard("import")) return;
  let path: string | undefined;
  try {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "SVG document", extensions: ["svg"] }],
    });
    path = (Array.isArray(picked) ? picked[0] : picked) ?? undefined;
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  if (!path) return;
  const file = path.split(/[\\/]/).pop() || path;
  const id = freshGraphicId(file.replace(/\.svg$/i, ""));
  let outcome: CommandOutcome;
  try {
    outcome = await shell().invoke<CommandOutcome>("cmd_import_file", { path, id });
  } catch (error) {
    log(`import of ${file} refused: ${describe(error)}`, "bad");
    return;
  }
  if (outcome.session) presentView(outcome.session);
  for (const effect of outcome.effects) {
    if (effect.effect !== "imported") continue;
    const substitutions = effect.report.entries.reduce((sum, entry) => sum + entry.substitutions.length, 0);
    log(`Imported ${file}: ${effect.report.entries.length} element(s), ${substitutions} substitution(s)`, substitutions === 0 ? "good" : "bad");
    showImportReport(effect.report);
  }
}

function showImportReport(report: ImportReport): void {
  ui.importReportMount.replaceChildren(renderNode(document, sceneImportPanel(report)) as unknown as Node);
  if (!ui.importReportDialog.open) ui.importReportDialog.showModal();
}

async function openScene(): Promise<void> {
  if (refusesDiscard("open file")) return;
  let path: string | undefined;
  try {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Scene document", extensions: ["json"] }],
    });
    path = (Array.isArray(picked) ? picked[0] : picked) ?? undefined;
  } catch (error) {
    log(describe(error), "bad");
    return;
  }
  if (!path) return;
  await runCommand({ command: "openScene", source: { source: "file", path } }, `opened ${path}`);
}

async function saveScene(): Promise<void> {
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("nothing to save", "bad");
    return;
  }
  let path: string | null | undefined = scenePath;
  if (!path) {
    try {
      path = await saveFileDialog({
        defaultPath: `${scene.id}.json`,
        filters: [{ name: "Scene document", extensions: ["json"] }],
      });
    } catch (error) {
      log(describe(error), "bad");
      return;
    }
  }
  if (!path) return;
  // Identity edits apply on save: the fields are the document's, not a
  // separate piece of UI state that could drift from it.
  if (!(await applyPendingIdentity())) return;
  await runCommand(
    { command: "saveScene", session: session.key, to: { to: "file", path } },
    `saved ${path}`,
  );
}

async function publish(): Promise<void> {
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("nothing to publish", "bad");
    return;
  }
  const endpoint = ui.endpoint.value.trim();
  ui.publish.disabled = true;
  ui.publishResult.hidden = true;

  try {
    // The scene id is the TakeId, so a typed identity is applied first.
    if (!(await applyPendingIdentity())) return;
    const target: SceneTarget = { target: "session", session: session.key };
    const result = await shell().invoke<PublishResult>("cmd_publish", { endpoint, target });
    const takeId = plain(result.takeId);
    const revision = plain(result.revision);

    // The revision and its content hash are the operative facts: Playout
    // loads an exact revision only by its pinned hash (invariant 61), so
    // reporting "published" without them would leave the operator guessing.
    const contentHash = plain(result.contentHash);
    ui.publishResult.className = "result good";
    ui.publishResult.textContent = `${takeId} revision ${revision} · hash ${contentHash}`;
    ui.publishResult.hidden = false;
    log(`published ${takeId} revision ${revision} hash ${contentHash}`, "good");
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
  // down: no shell, no Editor. Everything below this line can assume the
  // shell bridge actually reaches Rust.
  if (!tauri) return;
  ui.curtain.hidden = true;
  wireWorkspaceChrome();

  ui.newScene.addEventListener("click", () => void newScene());
  ui.openScene.addEventListener("click", () => void openScene());
  ui.importSvg.addEventListener("click", () => void importSvg());
  ui.saveScene.addEventListener("click", () => void saveScene());
  ui.projectCreate.addEventListener("click", () => void createProject());
  ui.projectRefresh.addEventListener("click", () => void loadProjects(currentProject));
  ui.projectSaveScene.addEventListener("click", () => void saveProjectScene());
  ui.projectSelect.addEventListener("change", () => void selectProject());
  ui.graphicCreate.addEventListener("click", () => showManagerCreate("graphic"));
  ui.graphicSearch.addEventListener("input", renderProjectManager);
  ui.managerForm.addEventListener("submit", (event) => { event.preventDefault(); void submitManagerCreate(); });
  fillRateSelect(ui.managerRate);
  fillRateSelect(ui.canvasRate);
  ui.managerRate.addEventListener("change", () => {
    ui.managerCustomRate.hidden = ui.managerRate.value !== "custom";
    if (!ui.managerCustomRate.hidden) ui.managerRateNum.focus();
  });
  ui.canvasRate.addEventListener("change", () => void changeCanvasRate());
  ui.timelineRulerTicks.addEventListener("pointerdown", onRulerPointerDown);
  ui.timelinePlayhead.addEventListener("pointerdown", onRulerPointerDown);
  ui.timelineRulerTicks.addEventListener("pointermove", onRulerPointerMove);
  ui.timelineRulerTicks.addEventListener("pointerup", onRulerPointerUp);
  ui.timelineRulerTicks.addEventListener("pointercancel", onRulerPointerUp);
  ui.timelinePlayhead.addEventListener("keydown", onPlayheadKeyDown);
  document.getElementById("manager-create-cancel")!.addEventListener("click", () => ui.managerDialog.close());
  ui.sceneManagerMount.addEventListener("click", onSceneManagerClick);
  ui.sceneName.addEventListener("input", () => {
    // A typed name is unsaved work in any scene, bound to a project or not
    // (11.29). It becomes a `setSceneName` edit when a save or publish uses
    // it; until then the tab and the project list show it as pending.
    renderSceneTabs();
    if (projectSceneId === undefined) return;
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
  ui.timelinePresetApply.addEventListener("click", () => void applyStarterPreset("in"));
  ui.timelinePresetApplyOut.addEventListener("click", () => void applyStarterPreset("out"));
  ui.timelinePresetSave.addEventListener("click", () => saveSelectionAsPreset());
  ui.timelineJumpHold.addEventListener("click", jumpToHold);
  ui.timelinePresetDuration.addEventListener("input", syncPresetDurationError);
  ui.presetSaveForm.addEventListener("input", presetSaveCheck);
  ui.presetSaveForm.addEventListener("submit", (event) => { event.preventDefault(); void submitPresetSave(); });
  document.getElementById("preset-save-cancel")!.addEventListener("click", () => {
    if (!presetSaving) ui.presetSaveDialog.close();
  });
  ui.presetSaveDialog.addEventListener("cancel", (event) => {
    if (presetSaving) event.preventDefault();
  });
  ui.presetBrowserMount.addEventListener("click", onPresetBrowserClick);
  ui.timelinePreset.addEventListener("change", () => {
    syncPresetDuration();
    if (scene) renderPresetBrowser(scene);
  });
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
  ui.fontMount.addEventListener("change", onFontManagerChange);
  ui.fontMount.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.target.blur();
  });
  ui.fontStatusFilter.replaceChildren(
    ...FONT_STATUS_FILTERS.map((filter) => new Option(filter === "all" ? "All states" : filter, filter)),
  );
  ui.fontLinkSource.replaceChildren(...FONT_LINK_SOURCES.map((entry) => new Option(entry.label, entry.source)));
  showFontLinkSource();
  ui.fontLinkSource.addEventListener("change", showFontLinkSource);
  ui.fontSearch.addEventListener("input", () => scene && renderFontManager(scene));
  ui.fontStatusFilter.addEventListener("change", () => scene && renderFontManager(scene));
  ui.fontLink.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void ingestFontLink();
  });
  ui.textStyleMount.addEventListener("click", (event) => void onTextStyleClick(event));
  ui.materialMount.addEventListener("click", onMaterialManagerClick);
  ui.assetMount.addEventListener("click", onAssetManagerClick);
  ui.bindings.addEventListener("click", onBindingsClick);
  ui.sampleDataApply.addEventListener("click", onSampleDataApply);
  ui.sampleDataRevert.addEventListener("click", onSampleDataRevert);
  ui.controlMount.addEventListener("click", (event) => void onControlContractClick(event));
  // Commit the frame as it is typed. Committing only on blur re-rendered the
  // inspector between mousedown and mouseup of the next click, so the first
  // click on a key button after typing a frame was swallowed. A commit that
  // changes nothing renders nothing.
  const commitFrame = (): void => {
    const typed = Number(ui.animationFrame.value);
    if (ui.animationFrame.value.trim() === "" || !Number.isFinite(typed)) return;
    const duration = scene ? Number(scene.timeline.durationFrames) : typed;
    const next = Math.min(duration, Math.max(0, Math.round(typed)));
    if (next === currentFrame && String(next) === ui.animationFrame.value) return;
    setCurrentFrame(typed);
  };
  ui.animationFrame.addEventListener("input", commitFrame);
  ui.animationFrame.addEventListener("change", commitFrame);
  ui.timelineGraphClose.addEventListener("click", closeSpeedGraph);
  ui.timelineZoom.addEventListener("input", onTimelineZoom);
  ui.timelineMount.addEventListener("click", onTimelineClick);
  ui.timelineMount.addEventListener("pointerdown", onTimelinePointerDown);
  ui.timelineMount.addEventListener("pointermove", onTimelinePointerMove);
  ui.timelineMount.addEventListener("pointerup", (event) => finishKeyDrag(event, false));
  ui.timelineMount.addEventListener("pointercancel", (event) => finishKeyDrag(event, true));
  ui.timelineMount.addEventListener("wheel", onTimelineWheel, { passive: false });
  // Re-measure whenever the timeline's container changes size, whatever the
  // cause: a resizer drag, a keyboard resize, a dock move, a reset, a window
  // resize. Coalesced to one render per animation frame (11.10).
  watchSurfaceSize(
    ui.timelineMount,
    {
      createObserver: (callback) => new ResizeObserver(callback),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      measure: () => {
        const bounds = ui.timelineMount.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      },
    },
    () => {
      if (scene) renderTimeline(scene, false);
    },
  );
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
  ui.undo.addEventListener("click", () => void undo());
  ui.redo.addEventListener("click", () => void redo());
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
  ui.inspector.addEventListener("click", onAnimationClick);
  ui.inspector.addEventListener("change", onInspectorChange);
  ui.inspector.addEventListener("focusin", () => { if (playback) pausePreview("editing a property"); });
  ui.inspector.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    if (event.key === "Enter") event.target.blur();
    if (event.key === "Escape" && scene) {
      event.preventDefault();
      const field = event.target.dataset.inspectorField;
      if (field) {
        const wasPending = pendingInspectorFields.has(field);
        pendingInspectorFields.add(field);
        renderInspector(scene);
        if (!wasPending) pendingInspectorFields.delete(field);
      }
    }
  });
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
      void undo(focusedPanelModule());
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      void redo(focusedPanelModule());
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
    animationSurface = await shell().invoke<AnimationSurface>("cmd_animation_surface");
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
    ui.endpoint.value = await shell().invoke<string>("cmd_default_endpoint");
  } catch {
    // A default that cannot be read is not fatal; the author types one.
    ui.endpoint.value = "";
  }

  ui.sceneId.value = "untitled";
  ui.sceneName.value = "Untitled";
  // Startup opens an editable blank session; creation dialogs are explicit
  // author actions and must not block the initial workspace.
  await runCommand({ command: "openScene", source: { source: "new", id: "untitled", name: "Untitled" } }, "Opened blank graphic");
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

/** The element an event happened on. A drag of selected text starts on a
 *  Text node, and a few events target the document itself; neither has
 *  `closest`, so a text node answers with its parent and anything else with
 *  nothing, rather than throwing out of the handler. */
function eventElement(event: Event): Element | null {
  const target = event.target;
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function wireDocking(): void {
  document.addEventListener("dragstart", (event) => {
    const handle = eventElement(event)?.closest<HTMLElement>("[data-dock-handle]");
    const panel = handle?.closest<HTMLElement>("[data-panel]");
    if (!panel?.dataset.panel || !event.dataTransfer) return;
    draggedPanel = panel.dataset.panel;
    panel.classList.add("dock-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPanel);
  });
  document.addEventListener("dragover", (event) => {
    if (!draggedPanel) return;
    const host = eventElement(event)?.closest<HTMLElement>(".dock-region");
    if (!host?.dataset.region) return;
    event.preventDefault();
    document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    host.classList.add("drop-target");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  document.addEventListener("drop", (event) => {
    const host = eventElement(event)?.closest<HTMLElement>(".dock-region");
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
    const handle = eventElement(event)?.closest<HTMLElement>(".dock-resizer");
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
    const handle = eventElement(event)?.closest<HTMLElement>(".dock-resizer");
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
