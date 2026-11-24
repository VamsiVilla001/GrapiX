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
  CubicBezier,
  EditorCommand,
  EffectInstance,
  EffectSurface,
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
import {
  canCreate,
  previewGpx,
  projectSummary,
  renderingLabel,
  startRows,
  suggestCopyName,
  type DefaultProject,
  type ListedRecent,
  type OpenedProject,
  type StartRow,
} from "../src/project-start";
import type { HistoryView, MachineSettings, SettingsScope, UserSettings } from "@grapix/contracts";
import { historyRows, historySummary } from "../src/history-list";
import { arrangeEdits, arrangeLabel, arrangeWords, isArrangeCommand, parentsOf, type ArrangeCommand } from "../src/arrange";
import { effectivePlacement, pivotLabel, pivotPlan, type PivotRequest } from "../src/anchor-point";
import { pivotView } from "../src/pivot-panel";
import {
  FIT,
  ZOOM_STEP,
  atPercent,
  cameraTransform,
  clampPan,
  panBy,
  wheelFactor,
  zoomAt,
  zoomLabel,
  type Camera,
  type Point as ViewPoint,
  type Size as ViewSize,
} from "../src/viewport-camera";
import {
  EMPTY_PEN,
  addPoint,
  closePath,
  closeWithPull,
  constrain,
  moveLast,
  nearFirst,
  penEdits,
  penLabel,
  penMaskEdit,
  penMaskLabel,
  penPlan,
  penPlanWords,
  penSketch,
  pullHandles,
  removeLast,
  resumeEdits,
  resumeState,
  type PenCreates,
  type PenPlan,
  type PenState,
} from "../src/pen-tool";
import {
  PICK_RADIUS,
  applyOp,
  beginGesture,
  canvasPointOf,
  clickOp,
  deleteSelected,
  editPathEdit,
  editTarget,
  gestureOp,
  isClick,
  isSelected,
  joinEdits,
  kindEdits,
  pathEditFrame,
  pathEditRevision,
  pathEditSketch,
  pickPath,
  verticesInBox,
  type EditTarget,
  type PathGesture,
  type PathHit,
  type Selected,
} from "../src/path-edit";
import type { BezierPath, PathOp, VertexKind } from "@grapix/contracts";
import { animatesPath, linkUsersWords, linkedPathOf, pathChannelOf, pathKeyAt, pathLinkOf } from "../src/path-anim";
import {
  beginToolDrag,
  previewDocument,
  toolDragChanges,
  toolDragEdits,
  toolDragLabel,
  type ToolDrag,
  type ToolId,
} from "../src/transform-tools";
import { isFirstSave, saveRoute, versionLabel, type SaveState } from "../src/save-model";
import { APP_MENUS, actionOf, menuTitle } from "../src/app-menu";
import {
  commandById,
  decideKey,
  refusalLine,
  unavailable as commandUnavailable,
  type CommandContext,
  type KeyFocus,
} from "../src/command-registry";
import { MACHINE_FIELDS, toValue, USER_FIELDS, usageLine, type FieldSpec } from "../src/settings-form";
import { renderAppMenus, type PanelEntry } from "../src/app-menu-view";
import { presetBlocker, presetBrowserPanel } from "../src/motion-preset-browser";
import { SceneViewport } from "../src/viewport";
import { GraphicPreviewRenderer } from "../src/graphic-preview";
import { viewportSource, wantsEngineFrame, type ViewChoice } from "../src/viewport-source";
import { backdropLabel, parseBackdrop, serialiseBackdrop, type Backdrop } from "../src/viewport-backdrop";
import { createEnginePreview, statusWords, type Failure, type PreviewState } from "../src/engine-preview";
import { renderNode } from "../src/agent-surface";
import { BROADCAST_RATES, parseRateChoice, rateKey, sameRate } from "../src/frame-rate";
import { sceneImportPanel } from "../src/import-panel";
import {
  objectManagerPanel,
  selectionRoots,
  setObjectExpanded,
} from "../src/object-manager";
import { snapPoint, snapTargets, type SnapHold } from "../src/path-snap";
import { shapeSvgPath, writeSvgPath } from "../src/svg-path";
import {
  MASK_FALLOFFS,
  MASK_MODES,
  MASK_MODE_LABEL,
  MATTE_MODES,
  MATTE_MODE_LABEL,
  addFeatherPointAt,
  addMask,
  clearMatte,
  copyMaskToShape,
  copyShapeToMask,
  linkMaskToShape,
  MATTE_VIEWS,
  MATTE_VIEW_LABEL,
  matteViewInfo,
  matteWarning,
  unlinkPath,
  copyableShapes,
  isRefused as isMaskRefused,
  maskSketches,
  maskStatus,
  maskTarget,
  matteSources,
  moveMask,
  patchMask,
  removeMask,
  setMatte,
  setEffectMask,
  setMatteMode,
  setPreserve,
  type MaskPatch,
  type MaskTarget,
  type MatteViewChoice,
  MOST_FEATHER_POINTS,
} from "../src/mask-edit";
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
  addEffect,
  addPreset,
  availability,
  duplicateEffect,
  effectChannel,
  effectControlsPanel,
  effectsBrowserPanel,
  toggleGroup,
  isRefused as isEffectRefused,
  listingFor,
  moveEffect,
  parameterLabel,
  parameterValue,
  parseControlId,
  removeEffect,
  setEnabled,
  setParameter,
  type Stack as EffectStack,
} from "../src/effects-panel";
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
  type SceneListView,
} from "../src/scene-manager";
import { createDeleteArm, moveRow, rowCommand } from "../src/scene-list-nav";
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
import { execute, installShellCapture, shell, wireFrame } from "../src/command-client";
import { quoteCorr } from "../src/shell-bridge";
import { sizeCanvasForRatio, watchDevicePixelRatio } from "../src/dpi";
import { probeWebGpu, summariseGpuReport, type GpuReport } from "../src/gpu-probe";
import {
  activateTab,
  allPanels,
  clearSplit,
  defaultLayout,
  dragSplitter,
  entryIds,
  floorFractions,
  groupOf,
  isRefused as isLayoutRefused,
  movePanel,
  moveToGroup,
  persistLayout,
  regionEntries,
  resizeRegion,
  restoreLayout,
  splitRegion,
  MIN_SPLIT,
  REGIONS,
  type Layout,
  type RegionId,
  type TabGroup,
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
  planEasyEase,
  planSetSegmentBezier,
  type ClipboardKey,
  type EditPlan,
} from "../src/timeline/key-edit";
import {
  bezierFromHandleDrag,
  buildSpeedGraph,
  hitGraph,
  withDraftBezier,
  type GraphHit,
  type GraphMode,
  type SpeedGraphModel,
} from "../src/timeline/speed-graph";
import type { EasyEaseKind } from "../src/timeline/easing";
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
  /** How the engine's own declaration had this publication reach it (5.10):
   *  `localPath` (no asset bytes sent) or `chunkedUpload`. */
  handoff: "localPath" | "chunkedUpload";
  /** Asset bytes this Editor sent: none by path, the missing difference
   *  over a LAN. */
  transferredBytes: number;
}

/** The route and bytes of a publication, as the log and result line show them. */
function publishRoute(result: PublishResult): string {
  return `${result.handoff}, ${result.transferredBytes} asset bytes sent`;
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
  projectClose: need<HTMLButtonElement>("project-close"),
  projectSaveAs: need<HTMLButtonElement>("project-save-as"),
  projectSummary: need<HTMLElement>("project-summary"),
  settingsDialog: need<HTMLDialogElement>("settings-dialog"),
  settingsBody: need<HTMLElement>("settings-body"),
  settingsError: need<HTMLElement>("settings-error"),
  settingsResetUser: need<HTMLButtonElement>("settings-reset-user"),
  settingsResetMachine: need<HTMLButtonElement>("settings-reset-machine"),
  startDialog: need<HTMLDialogElement>("start-dialog"),
  startHome: need<HTMLElement>("start-home"),
  startNew: need<HTMLButtonElement>("start-new"),
  startOpen: need<HTMLButtonElement>("start-open"),
  startList: need<HTMLUListElement>("start-list"),
  startEmpty: need<HTMLElement>("start-empty"),
  startError: need<HTMLElement>("start-error"),
  startDismiss: need<HTMLButtonElement>("start-dismiss"),
  startForm: need<HTMLFormElement>("start-new-form"),
  startFormTitle: need<HTMLElement>("start-form-title"),
  startDepthField: need<HTMLElement>("start-depth-field"),
  startName: need<HTMLInputElement>("start-name"),
  startDepth: need<HTMLSelectElement>("start-depth"),
  startParent: need<HTMLInputElement>("start-parent"),
  startChoose: need<HTMLButtonElement>("start-choose"),
  startPreview: need<HTMLElement>("start-preview"),
  startNewError: need<HTMLElement>("start-new-error"),
  startBack: need<HTMLButtonElement>("start-back"),
  startCreate: need<HTMLButtonElement>("start-create"),
  projectRefresh: need<HTMLButtonElement>("project-refresh"),
  projectSaveScene: need<HTMLButtonElement>("project-save-scene"),
  graphicCreate: need<HTMLButtonElement>("graphic-create"),
  graphicSearch: need<HTMLInputElement>("graphic-search"),
  managerDialog: need<HTMLDialogElement>("manager-create-dialog"),
  managerForm: need<HTMLFormElement>("manager-create-form"),
  managerName: need<HTMLInputElement>("manager-create-name"),
  managerError: need<HTMLParagraphElement>("manager-create-error"),
  sceneManagerMount: need<HTMLDivElement>("scene-manager-mount"),
  sceneViewToggle: need<HTMLButtonElement>("scene-view-toggle"),
  sceneMenu: need<HTMLDivElement>("scene-context-menu"),
  sceneManagerEmpty: need<HTMLParagraphElement>("scene-manager-empty"),
  canvas: need<HTMLCanvasElement>("viewport"),
  previewPlay: need<HTMLButtonElement>("preview-play"),
  previewStatus: need<HTMLSpanElement>("preview-status"),
  overlay: need<SVGSVGElement>("viewport-overlay"),
  sceneTabs: need<HTMLElement>("scene-tabs"),
  canvasSize: need<HTMLSpanElement>("canvas-size"),
  canvasRate: need<HTMLSelectElement>("canvas-rate"),
  viewportView: need<HTMLSelectElement>("viewport-view"),
  viewportGrid: need<HTMLButtonElement>("viewport-grid"),
  viewportBg: need<HTMLInputElement>("viewport-bg"),
  viewportBackdrop: need<HTMLDivElement>("viewport-backdrop"),
  viewerZoomReadout: need<HTMLButtonElement>("viewer-zoom-readout"),
  viewportNote: need<HTMLSpanElement>("viewport-note"),
  viewportChip: need<HTMLSpanElement>("viewport-chip"),
  viewportEngine: need<HTMLImageElement>("viewport-engine"),
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
  objectJoin: need<HTMLButtonElement>("object-join"),
  objectCopySvg: need<HTMLButtonElement>("object-copy-svg"),
  pathKeying: need<HTMLInputElement>("path-keying"),
  pathKeySet: need<HTMLButtonElement>("path-key-set"),
  pathKeyRemove: need<HTMLButtonElement>("path-key-remove"),
  pathUnlink: need<HTMLButtonElement>("path-unlink"),
  subpathRemove: need<HTMLButtonElement>("path-subpath-remove"),
  autoTension: need<HTMLInputElement>("auto-tension"),
  guideAxis: need<HTMLSelectElement>("guide-axis"),
  guidePosition: need<HTMLInputElement>("guide-position"),
  guideAdd: need<HTMLButtonElement>("guide-add"),
  guideList: need<HTMLSelectElement>("guide-list"),
  guideMove: need<HTMLButtonElement>("guide-move"),
  guideRemove: need<HTMLButtonElement>("guide-remove"),
  guideShow: need<HTMLInputElement>("guide-show"),
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
  engineFrame: need<HTMLDivElement>("engine-frame"),
  engineImage: need<HTMLImageElement>("engine-image"),
  engineStatus: need<HTMLSpanElement>("engine-status"),
  engineTime: need<HTMLSpanElement>("engine-time"),
  engineDetail: need<HTMLParagraphElement>("engine-detail"),
  effectsMount: need<HTMLDivElement>("effects-mount"),
  effectsExpandAll: need<HTMLButtonElement>("effects-expand-all"),
  effectsCollapseAll: need<HTMLButtonElement>("effects-collapse-all"),
  effectsSearch: need<HTMLInputElement>("effects-search"),
  effectsShowUnported: need<HTMLInputElement>("effects-show-unported"),
  effectsSummary: need<HTMLParagraphElement>("effects-summary"),
  effectControlsMount: need<HTMLDivElement>("effect-controls-mount"),
  effectControlsEmpty: need<HTMLParagraphElement>("effect-controls-empty"),
  pivotBody: need<HTMLDivElement>("pivot-body"),
  pivotEmpty: need<HTMLParagraphElement>("pivot-empty"),
  pivotSummary: need<HTMLParagraphElement>("pivot-summary"),
  pivotScope: need<HTMLSelectElement>("pivot-scope"),
  pivotOffsetX: need<HTMLInputElement>("pivot-offset-x"),
  pivotOffsetY: need<HTMLInputElement>("pivot-offset-y"),
  pivotX: need<HTMLInputElement>("pivot-x"),
  pivotY: need<HTMLInputElement>("pivot-y"),
  pivotStep: need<HTMLInputElement>("pivot-step"),
  pivotKeep: need<HTMLInputElement>("pivot-keep"),
  pivotKeyedModify: need<HTMLInputElement>("pivot-keyed-modify"),
  pivotReset: need<HTMLButtonElement>("pivot-reset"),
  pivotError: need<HTMLParagraphElement>("pivot-error"),
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
  masks: need<HTMLDivElement>("masks-mount"),
  penCreates: need<HTMLSelectElement>("pen-creates"),
  penCreatesNote: need<HTMLSpanElement>("pen-creates-note"),
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
  historyOpen: need<HTMLButtonElement>("history-open"),
  historyDialog: need<HTMLDialogElement>("history-dialog"),
  historyClose: need<HTMLButtonElement>("history-close"),
  historyLead: need<HTMLElement>("history-lead"),
  historyList: need<HTMLOListElement>("history-list"),
  historyError: need<HTMLElement>("history-error"),
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
  timelineGraphMode: need<HTMLButtonElement>("timeline-graph-mode"),
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
/// The Scene Manager's view (11.72): a dense list by default, the way XPression's
/// Scene Manager is worked in; the author's choice is a per-user preference.
const SCENE_VIEW_KEY = "grapix.editor.sceneView";
let sceneView: SceneListView = readSceneView();
const sceneDeleteArm = createDeleteArm();

/// The Effects & Presets categories the author has opened (11.79), kept per user: the
/// tree is folded the way After Effects' is until a category is opened.
const EFFECTS_OPEN_KEY = "grapix.editor.effectsOpen";
let effectsOpen: Set<string> = readEffectsOpen();

function readEffectsOpen(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EFFECTS_OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function setEffectsOpen(next: Set<string>): void {
  effectsOpen = next;
  try {
    window.localStorage.setItem(EFFECTS_OPEN_KEY, JSON.stringify([...next]));
  } catch {
    // A preference that cannot be stored is used for this session only.
  }
  if (scene) renderEffects(scene);
}

function effectsGroupIds(): string[] {
  return Array.from(ui.effectsMount.querySelectorAll<HTMLElement>('[role="group"][id^="effects-browser/"]')).map((node) => node.id);
}

function readSceneView(): SceneListView {
  try {
    return window.localStorage.getItem(SCENE_VIEW_KEY) === "thumbnails" ? "thumbnails" : "list";
  } catch {
    return "list";
  }
}
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
/// 11.65: the engine's picture of the open scene. One render in flight and one
/// pending; a frame is current only when it is the latest request's.
// Explicit guides (11.44): the lines the author put on the canvas, kept with the scene, snapped to before any other line.
let guidesShown = true;

function guideWords(guide: { readonly id: number | bigint; readonly axis: "x" | "y"; readonly position: number }): string {
  return `${guide.axis === "x" ? "Vertical" : "Horizontal"} ${guide.position} (guide ${guide.id})`;
}

function renderGuides(document_: SceneDocument): void {
  const chosen = ui.guideList.value;
  ui.guideList.replaceChildren(...document_.guides.map((guide) => new Option(guideWords(guide), String(guide.id))));
  if ([...ui.guideList.options].some((option) => option.value === chosen)) ui.guideList.value = chosen;
  ui.guideList.disabled = document_.guides.length === 0;
  ui.guideMove.disabled = ui.guideRemove.disabled = document_.guides.length === 0;
}

function guideEdit(kind: "add" | "move" | "remove"): void {
  if (!scene) return;
  const position = Number(ui.guidePosition.value);
  if (kind !== "remove" && !Number.isFinite(position)) {
    log("Guide: give the position as a number of pixels.", "bad");
    return;
  }
  const id = Number(ui.guideList.value);
  if (kind !== "add" && !Number.isFinite(id)) {
    log("Guide: choose a guide first.", "bad");
    return;
  }
  const edit =
    kind === "add"
      ? { edit: "addGuide", axis: ui.guideAxis.value, position }
      : kind === "move"
        ? { edit: "moveGuide", id, position }
        : { edit: "removeGuide", id };
  void runEdits([edit as unknown as SceneEdit], { label: kind === "add" ? `Added a guide at ${position}` : kind === "move" ? `Moved guide ${id} to ${position}` : `Removed guide ${id}` }, "viewport");
}

/** The matte view being looked at (3.30): the engine draws a changed copy of the scene that shows one layer's matte, and nothing authored changes. */
let matteView: { readonly objectId: string; readonly view: "alpha" | "luma" | "applied" | "before" } | undefined;

interface EngineFrameRequest {
  readonly endpoint: string;
  readonly target: SceneTarget;
  readonly frame: number;
  /** A view of a layer's track matte instead of the scene (3.30). */
  readonly matteView?: { readonly objectId: string; readonly view: "alpha" | "luma" | "applied" | "before" };
}
const sceneVersions = new WeakMap<object, number>();
let sceneVersionCounter = 0;
function sceneVersion(document_: object): number {
  let version = sceneVersions.get(document_);
  if (version === undefined) {
    version = sceneVersionCounter += 1;
    sceneVersions.set(document_, version);
  }
  return version;
}
const enginePreview = createEnginePreview<EngineFrameRequest>({
  render: async ({ endpoint, target, frame, matteView }) =>
    new Uint8Array(await shell().invoke<ArrayBuffer>("cmd_engine_preview", { endpoint, target, frame, ...(matteView === undefined ? {} : { matteView }) })),
  makeUrl: (bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  onState: (state) => renderEngineFrame(state),
  classify: (error): Failure => {
    const kind = typeof error === "object" && error !== null && "error" in error ? String((error as { error: unknown }).error) : "";
    // The engine declined by name: a different thing from one that is not there.
    return { status: kind === "commandRefused" ? "refused" : "unavailable", detail: describe(error) };
  },
});

let lastPreviewState: PreviewState = { status: "idle" };
const VIEW_KEY = "grapix.editor.viewportView";

/// The main viewport shows the engine's frame (effects included) or the Draft canvas:
/// see viewport-source.ts for the rules. The overlay and its handles never change.
const BACKDROP_KEY = "grapix.editor.viewportBackdrop";
let backdrop: Backdrop = (() => {
  try {
    return parseBackdrop(localStorage.getItem(BACKDROP_KEY));
  } catch {
    return parseBackdrop(null);
  }
})();

/// The grid or the solid colour behind the composition, sized to the composition's own box.
function applyBackdrop(): void {
  const surface = ui.canvas.closest<HTMLElement>(".viewport-surface");
  if (surface) surface.dataset.backdrop = backdrop.grid ? "grid" : "solid";
  ui.viewportBackdrop.style.setProperty("--viewport-bg", backdrop.color);
  ui.viewportGrid.setAttribute("aria-pressed", String(backdrop.grid));
  ui.viewportGrid.title = backdropLabel(backdrop);
  ui.viewportBg.value = backdrop.color;
  ui.viewportBg.disabled = backdrop.grid;
  // The layout size: the view's transform scales the backdrop with the rest of the surface, so it must not be measured scaled.
  ui.viewportBackdrop.style.width = `${ui.canvas.offsetWidth}px`;
  ui.viewportBackdrop.style.height = `${ui.canvas.offsetHeight}px`;
}

function setBackdrop(next: Backdrop): void {
  backdrop = next;
  try {
    localStorage.setItem(BACKDROP_KEY, serialiseBackdrop(next));
  } catch {
    /* storage can be unavailable */
  }
  applyBackdrop();
}

ui.viewportGrid.addEventListener("click", () => setBackdrop({ ...backdrop, grid: !backdrop.grid }));
ui.viewportBg.addEventListener("input", () => setBackdrop({ ...backdrop, color: parseBackdrop(JSON.stringify({ color: ui.viewportBg.value })).color }));
// The canvas fits itself to the pane, so the backdrop follows its box.
new ResizeObserver(() => {
  applyBackdrop();
  syncCamera();
}).observe(ui.canvas);
applyBackdrop();

function readViewChoice(): ViewChoice {
  // A matte view is only the engine's to draw (3.30).
  if (matteView !== undefined) return "engine";
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "draft" || saved === "engine" || saved === "auto") return saved;
  } catch {
    /* storage can be unavailable */
  }
  return "auto";
}

function applyViewportSource(): void {
  const choice = readViewChoice();
  ui.viewportView.value = choice;
  const verdict = viewportSource({
    objects: scene?.objects ?? [],
    choice,
    status: lastPreviewState.status,
    hasImage: lastPreviewState.imageUrl !== undefined,
    playing: playback !== undefined,
  });
  const engine = verdict.source === "engine";
  const surface = ui.canvas.closest<HTMLElement>(".viewport-surface");
  if (surface) surface.dataset.source = verdict.source;
  ui.viewportEngine.hidden = !engine;
  ui.viewportEngine.dataset.status = lastPreviewState.status;
  if (engine && lastPreviewState.imageUrl !== undefined && ui.viewportEngine.src !== lastPreviewState.imageUrl) {
    ui.viewportEngine.src = lastPreviewState.imageUrl;
  }
  ui.viewportChip.textContent = engine ? "Engine" : "Draft";
  ui.viewportChip.dataset.source = verdict.source;
  ui.viewportNote.textContent = verdict.note ?? "";
}

function renderEngineFrame(state: PreviewState): void {
  lastPreviewState = state;
  applyViewportSource();
  const words = statusWords(state);
  ui.engineFrame.dataset.status = state.status;
  ui.engineStatus.textContent = words.word;
  ui.engineStatus.dataset.tone = words.tone;
  ui.engineTime.textContent = state.renderMs === undefined ? "" : `${Math.round(state.renderMs)} ms`;
  ui.engineDetail.textContent = state.status === "unavailable" || state.status === "refused" ? (state.detail ?? "") : "";
  ui.engineImage.hidden = state.imageUrl === undefined;
  if (state.imageUrl !== undefined && ui.engineImage.src !== state.imageUrl) ui.engineImage.src = state.imageUrl;
  if (state.imageUrl === undefined) ui.engineImage.removeAttribute("src");
}

/** Ask the engine for the open scene at the playhead. While the preview plays the
 *  Draft view carries the motion and the engine frame resumes on pause. */
function scheduleEnginePreview(): void {
  const session = activeSession(workspace);
  if (!scene || !session) {
    enginePreview.clear();
    return;
  }
  // While playing, ask only when the viewport is showing the engine's frame (effects present or
  // the Engine view chosen): a plain scene is carried by the Draft view and costs the engine nothing.
  if (playback !== undefined && !wantsEngineFrame(scene.objects, readViewChoice())) return;
  const endpoint = ui.endpoint.value.trim();
  const frame = currentFrame;
  enginePreview.request(`${session.key}/${sceneVersion(scene)}/${frame}/${endpoint}/${matteView === undefined ? "" : `${matteView.objectId}:${matteView.view}`}`, {
    endpoint,
    target: { target: "session", session: session.key },
    frame,
    ...(matteView === undefined ? {} : { matteView }),
  });
}

/// The effect and preset catalogue, read from Rust once (11.69): EffectCraft's
/// whole listing with the effects this engine renders marked available.
let effectSurface: EffectSurface | null = null;
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
      /** A Move, Rotate or Scale drag (11.102); without it the drag is a click or a marquee. */
      readonly tool?: ToolDrag;
      /** The tool was refused for what is selected: a click still selects, a drag says why and does nothing. */
      readonly refusal?: string;
      told?: boolean;
      moved: boolean;
    }
  | undefined;
/** The tool of the ribbon. Select picks; the others change what is selected as the pointer drags (11.102). */
/** The tool of the ribbon: the drag tools, the Pen, and the two that move the view (Hand and Zoom, 11.105). */
type PageTool = ToolId | "pen" | "hand" | "zoom" | "path" | "vertex-add" | "vertex-delete" | "vertex-convert";

/** The tools that edit the path of the selected shape (11.107). */
const isPathTool = (tool: PageTool): boolean => tool === "path" || tool === "vertex-add" || tool === "vertex-delete" || tool === "vertex-convert";
let activeTool: PageTool = "select";
/** The path the Pen tool is drawing, the pointer that is pulling its last point's handles, and where the pointer is. */
let pen: PenState = EMPTY_PEN;
let penPull: number | undefined;
let penHover: OverlayPoint | undefined;
/** The scene the path was started in, so a path is never finished in another one. */
let penScene: number | undefined;
/** When the last path was finished: the second click of a double click that closed it must not start another. */
let penFinishedAt = 0;
/** The shape whose path the pen is carrying on, when it is (a click on an end of the selected open shape). */
let penResume: string | undefined;
/** The pointer is down on the first point, closing the path; a drag then sets the tangents it closes with. */
let penClosing = false;
/** Space is held while a point is placed: the point moves with the pointer instead of its handles being pulled. */
let penSpace = false;
/** Where the pointer was at the last pen move, so Space can move the point by the difference. */
let penLastAt: OverlayPoint | undefined;
/** The document as the drag in progress would leave it, drawn instead of the real one until the pointer is released. */
let toolPreview: SceneDocument | null = null;

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
  // The id of the call that failed follows the text, so the author can quote it (2.13).
  return quoteCorr(describeFailure(error), error);
}

function describeFailure(error: unknown): string {
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
      case "writePackage":
        return `cannot write the package ${failure.path ?? ""}: ${failure.detail ?? ""}`;
      case "assetCache":
        return `asset cache unavailable: ${failure.detail ?? ""}`;
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
  scheduleEnginePreview();
  applyViewportSource();
  showRateChoice(ui.canvasRate, scene.canvas.frameRate);
  ui.canvas.width = scene.canvas.width;
  ui.canvas.height = scene.canvas.height;

  const previewInput = takePagePreviewDocument ?? scene;
  const resolution = resolveSceneBindings(previewInput);
  bindingPreviewIssues = resolution.ok
    ? []
    : resolution.issues.map((issue) => `Binding refused: ${describeBindingIssue(issue)}`);
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
        ? "Create a project to keep your scenes together."
        : "Choose a project to browse its scenes.";
    return;
  }
  const managed = managedProjectScenes(catalog);
  const panel = sceneManagerPanel({ project: catalog.project, scenes: managed, query: ui.graphicSearch.value, view: sceneView });
  const matches = panel.children?.[0]?.children?.length ?? 0;
  ui.sceneManagerEmpty.hidden = matches > 0;
  ui.sceneManagerEmpty.textContent = managed.length === 0
    ? `No scenes in ${catalog.project}. Add your first scene.`
    : "No scenes match your search.";
  // A re-render replaces every row; keep the keyboard on the row it was on.
  const focused = document.activeElement;
  const focusedRow = focused instanceof HTMLElement && ui.sceneManagerMount.contains(focused) ? focused.id : undefined;
  ui.sceneManagerMount.replaceChildren(
    renderNode(
      document,
      panel,
    ) as unknown as Node,
  );
  ui.sceneManagerMount.classList.toggle("list-view", sceneView === "list");
  ui.sceneViewToggle.setAttribute("aria-pressed", String(sceneView === "list"));
  // A list row is focusable so the keyboard can walk it; a preview is drawn only
  // for the thumbnail view, so a long list costs no rendering.
  for (const row of sceneRows()) {
    row.tabIndex = sceneView === "list" ? 0 : -1;
    row.classList.toggle("delete-armed", row.id === sceneDeleteArm.armed());
  }
  if (focusedRow?.startsWith("scene/")) document.getElementById(focusedRow)?.focus();
  if (sceneView === "thumbnails") queueGraphicPreviews(catalog);
}

function sceneRows(): HTMLElement[] {
  return Array.from(ui.sceneManagerMount.querySelectorAll<HTMLElement>('[role="listitem"][id^="scene/"]'));
}

function setSceneView(view: SceneListView): void {
  sceneView = view;
  try {
    window.localStorage.setItem(SCENE_VIEW_KEY, view);
  } catch {
    // A preference that cannot be stored is used for this session only.
  }
  renderProjectManager();
}

function closeSceneMenu(): void {
  ui.sceneMenu.hidden = true;
  ui.sceneMenu.replaceChildren();
}

/// A scene row's own action buttons, offered as a menu: the same commands, the same
/// refusals (a disabled item carries its reason), nothing the buttons do not already do.
function openSceneMenu(row: HTMLElement, x: number, y: number): void {
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>(":scope > button[data-action]"));
  ui.sceneMenu.replaceChildren();
  for (const source of buttons) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "menuitem";
    item.textContent = source.textContent;
    item.dataset.action = source.dataset.action ?? "";
    item.dataset.for = source.dataset.for ?? "";
    if (source.dataset.unavailable) {
      item.dataset.unavailable = source.dataset.unavailable;
      item.title = source.dataset.unavailable;
      item.classList.add("unavailable");
    }
    ui.sceneMenu.append(item);
  }
  ui.sceneMenu.hidden = false;
  const width = ui.sceneMenu.offsetWidth;
  const height = ui.sceneMenu.offsetHeight;
  ui.sceneMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  ui.sceneMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  ui.sceneMenu.querySelector<HTMLButtonElement>("button")?.focus();
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
  renderPivotPanel(document_);
  renderGuides(document_);
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

  renderEffects(document_);

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
  renderMasks(document_);
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

// ---------------------------------------------------------------------------
// Masks and track mattes (11.117). The edits are `mask-edit.ts`'s; this draws the controls and sends one edit per change.
// ---------------------------------------------------------------------------

/** Put SVG path data on the clipboard and say so (11.114). */
async function copySvg(data: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(data);
    log(`Copied ${what} as SVG path data (${data.length} characters)`, "good");
  } catch (error) {
    log(`Copy SVG: the clipboard refused (${describe(error)}); the data is ${data.length} characters`, "bad");
  }
}

function setMatteView(objectId: string, choice: MatteViewChoice): void {
  matteView = choice === "off" ? undefined : { objectId, view: choice };
  if (scene) {
    scheduleEnginePreview();
    applyViewportSource();
    renderMasks(scene);
  }
}

/** The mask whose variable feather gets a point where the next click on the canvas is (11.108); Escape lets it go. */
let featherArm: { readonly objectId: string; readonly index: number } | undefined;

function armFeatherPoint(objectId: string, index: number): void {
  featherArm = { objectId, index };
  document.body.classList.add("matte-whip");
  log("Feather point: click the edge of the mask where the point should go. Escape cancels.");
}

function takeFeatherPoint(at: { readonly x: number; readonly y: number }): void {
  const arm = featherArm;
  featherArm = undefined;
  document.body.classList.remove("matte-whip");
  if (arm === undefined || !scene) return;
  const target = maskTarget(scene, [arm.objectId]);
  if (isMaskRefused(target)) {
    log(`Feather point: ${target.refused}`, "bad");
    return;
  }
  sendMaskEdit(addFeatherPointAt(scene, target, arm.index, at), "Add a feather point");
}

/** The variable feather of one mask (11.108): its points, each with where it is on the path, its radius and its tension. */
function featherPointsRow(target: MaskTarget, index: number): HTMLElement {
  const mask = target.masks[index]!;
  const points = mask.featherPoints ?? [];
  const box = document.createElement("div");
  box.className = "mask-feather-points";
  const head = document.createElement("span");
  head.textContent =
    points.length === 0
      ? "Variable feather: none, so Feather above is used."
      : `Variable feather: ${points.length} point${points.length === 1 ? "" : "s"}; Feather above is not used. A radius is outward when positive and inward when negative.`;
  box.append(head);
  const setPoint = (k: number, patch: Partial<(typeof points)[number]>): void =>
    sendMaskEdit(patchMask(target, index, { featherPoints: points.map((p, i) => (i === k ? { ...p, ...patch } : p)) }), `Change feather point ${k + 1}`);
  points.forEach((point, k) => {
    const row = document.createElement("div");
    row.className = "mask-feather-point";
    row.append(
      `Point ${k + 1} `,
      maskNumber("Segment", point.segment, "0", (v) => setPoint(k, { segment: Math.max(0, Math.round(v ?? 0)) })),
      maskNumber("At", point.t, "0.5", (v) => setPoint(k, { t: v ?? 0.5 }), "0.05"),
      maskNumber("Radius", point.radius, "0", (v) => setPoint(k, { radius: v ?? 0 })),
      maskNumber("Tension", point.tension, "0", (v) => setPoint(k, { tension: v ?? 0 }), "0.1"),
      maskButton("Remove", "Take this feather point away", () => sendMaskEdit(patchMask(target, index, { featherPoints: points.filter((_, i) => i !== k) }), "Remove a feather point")),
    );
    box.append(row);
  });
  box.append(
    maskButton("Add feather point", "Put a feather point on the mask's first segment; change where it is above", () =>
      sendMaskEdit(patchMask(target, index, { featherPoints: [...points, { segment: 0, t: 0.5, radius: mask.feather > 0 ? mask.feather / 2 : 10, tension: 0.5 }] }), "Add a feather point"), points.length >= MOST_FEATHER_POINTS),
    maskButton("Add on canvas", "Click the mask's edge on the canvas to put a feather point there", () => armFeatherPoint(target.object.id, index), points.length >= MOST_FEATHER_POINTS),
    maskButton("Back to uniform", "Take every feather point away: the edge uses Feather again", () => sendMaskEdit(patchMask(target, index, { featherPoints: [] }), "Clear the variable feather"), points.length === 0),
  );
  return box;
}

/** The layer whose track matte source the next click chooses (the pick whip, 3.30): a click on a layer in the viewport or in the object
 *  list sets it as the matte, wherever it is in the stack; Escape lets it go. */
let matteWhip: string | undefined;

function startMatteWhip(objectId: string): void {
  matteWhip = objectId;
  document.body.classList.add("matte-whip");
  log("Pick whip: click the layer to use as the matte, in the viewport or in the object list. Escape cancels.");
}

function endMatteWhip(): string | undefined {
  const target = matteWhip;
  matteWhip = undefined;
  document.body.classList.remove("matte-whip");
  return target;
}

function takeMatteWhip(sourceId: string | undefined): void {
  const target = endMatteWhip();
  if (target === undefined || !scene) return;
  if (sourceId === undefined) {
    log("Pick whip: nothing was under the click, so the matte is as it was.", "bad");
    return;
  }
  const object = scene.objects.find((candidate) => candidate.id === target);
  sendMaskEdit(setMatte(scene, target, sourceId, object?.trackMatte?.mode ?? "alpha"), "Pick a track matte");
}

function sendMaskEdit(edit: SceneEdit | SceneEdit[] | { refused: string }, label: string): void {
  if (!Array.isArray(edit) && "refused" in edit) {
    log(edit.refused, "bad");
    return;
  }
  void runEdits(Array.isArray(edit) ? edit : [edit as SceneEdit], label, "scene");
}

function maskNumber(label: string, value: number | undefined, placeholder: string, change: (value: number | null) => void, step = "1"): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "mask-field";
  const input = document.createElement("input");
  input.type = "number";
  input.step = step;
  input.value = value === undefined ? "" : String(value);
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    if (input.value.trim() === "") change(null);
    else change(Number(input.value));
  });
  field.append(`${label} `, input);
  return field;
}

function maskSelect<T extends string>(label: string, values: readonly T[], current: T, text: (value: T) => string, change: (value: T) => void): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "mask-field";
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text(value);
    option.selected = value === current;
    select.append(option);
  }
  select.addEventListener("change", () => change(select.value as T));
  field.append(`${label} `, select);
  return field;
}

function maskButton(label: string, title: string, click: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener("click", click);
  return button;
}

function renderMasks(document_: SceneDocument): void {
  const target = maskTarget(document_, selection);
  const heading = document.createElement("h3");
  heading.textContent = "Masks and track matte";
  if (isMaskRefused(target)) {
    const note = document.createElement("p");
    note.className = "empty";
    note.textContent = target.refused;
    ui.masks.replaceChildren(heading, note);
    return;
  }
  const { object, masks } = target;
  // A shape's path copied in as a mask, or linked to one (Pen spec v2, 12 and 13): the picker serves both.
  const shapes = copyableShapes(document_, object.id);
  const shapePick = document.createElement("select");
  shapePick.setAttribute("aria-label", "Shape to copy or link as a mask");
  for (const shape of shapes) {
    const option = document.createElement("option");
    option.value = shape.id;
    option.textContent = shape.name;
    shapePick.append(option);
  }
  const rows = masks.map((mask, index) => {
    const row = document.createElement("div");
    row.className = "mask-row";
    row.dataset.maskIndex = String(index);
    const name = document.createElement("strong");
    name.textContent = `Mask ${index + 1}`;
    const change = (patch: MaskPatch, label = `Change mask ${index + 1}`): void => sendMaskEdit(patchMask(target, index, patch), label);
    const invert = document.createElement("label");
    invert.className = "mask-field";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = mask.inverted;
    box.addEventListener("change", () => change({ inverted: box.checked }));
    invert.append(box, " Invert");
    const status = document.createElement("p");
    status.className = "mask-status";
    const link = pathLinkOf(document_, object, { kind: "mask", index });
    status.textContent = `${maskStatus(mask)}${link === undefined ? "" : ` Linked with ${linkUsersWords(document_, link, linkedPathOf(object, { kind: "mask", index }))} (revision ${link.revision}).`}`;
    row.append(
      name,
      maskSelect("Mode", MASK_MODES, mask.mode, (mode) => MASK_MODE_LABEL[mode], (mode) => change({ mode })),
      invert,
      maskNumber("Opacity %", Math.round(mask.opacity * 100), "100", (value) => change({ opacity: (value ?? 100) / 100 })),
      maskNumber("Feather", mask.feather, "0", (value) => change({ feather: value ?? 0 })),
      maskNumber("Feather y", mask.featherY, "same", (value) => change({ featherY: value })),
      maskSelect("Falloff", MASK_FALLOFFS, mask.falloff ?? "smooth", (falloff) => (falloff === "smooth" ? "Smooth" : "Linear"), (falloff) => change({ falloff })),
      maskNumber("Expansion", mask.expansion, "0", (value) => change({ expansion: value ?? 0 })),
      featherPointsRow(target, index),
      maskButton("Up", "Move this mask up the stack", () => sendMaskEdit(moveMask(target, index, -1), "Reorder masks"), index === 0),
      maskButton("Down", "Move this mask down the stack", () => sendMaskEdit(moveMask(target, index, 1), "Reorder masks"), index === masks.length - 1),
      maskButton("Edit path", "Edit this mask's path on the canvas with the path tools", () => {
        pathMask = index;
        pathSelected = [];
        setActiveTool("path");
      }),
      maskButton("Copy SVG", "Copy this mask's path as SVG path data", () => void copySvg(writeSvgPath([mask.path]), `Mask ${index + 1}`)),
      maskButton("To shape", "Draw a copy of this mask's path as a new shape; the two are independent", () => sendMaskEdit(copyMaskToShape(document_, object, index), "Copy mask to a shape")),
      maskButton("Link to shape", "Make this mask's path the same path as the chosen shape's: its numbers are copied in and an edit of either changes both", () => sendMaskEdit(linkMaskToShape(document_, object, index, shapePick.value), "Link a mask to a shape"), shapes.length === 0 || link !== undefined),
      maskButton("Unlink", "Make this mask's path independent of what it is linked to; it keeps its shape", () => sendMaskEdit(unlinkPath(object.id, { kind: "mask", index }), "Unlink a mask path"), link === undefined),
      maskButton("Remove", "Remove this mask", () => sendMaskEdit(removeMask(target, index), "Remove mask")),
      status,
    );
    return row;
  });
  const add = maskButton("Add mask", "Add a rectangle mask over this layer", () => sendMaskEdit(addMask(target), "Add mask"));
  const copy = document.createElement("span");
  copy.className = "mask-field";
  copy.append(
    shapePick,
    maskButton("Copy as mask", "Add a copy of this shape's path as a mask on this layer; the two are independent", () => sendMaskEdit(copyShapeToMask(document_, target, shapePick.value), "Copy a shape to a mask"), shapes.length === 0),
  );
  // The track matte: a source layer by name, how it matters, and clear. The source's own eye is turned off when it is set.
  const matte = document.createElement("div");
  matte.className = "mask-matte";
  const source = document.createElement("select");
  source.setAttribute("aria-label", "Track matte source");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No track matte";
  source.append(none);
  for (const candidate of matteSources(document_, object.id)) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidate.name;
    option.selected = object.trackMatte?.sourceId === candidate.id;
    source.append(option);
  }
  source.addEventListener("change", () => {
    if (source.value === "") sendMaskEdit(clearMatte(object), "Clear track matte");
    else sendMaskEdit(setMatte(document_, object.id, source.value, object.trackMatte?.mode ?? "alpha"), "Set track matte");
  });
  matte.append(
    "Track matte ",
    source,
    maskSelect("Matte", MATTE_MODES, object.trackMatte?.mode ?? "alpha", (mode) => MATTE_MODE_LABEL[mode], (mode) => sendMaskEdit(setMatteMode(object, mode), "Change track matte")),
    maskSelect("View", MATTE_VIEWS, matteView?.objectId === object.id ? matteView.view : "off", (v) => MATTE_VIEW_LABEL[v], (v) => setMatteView(object.id, v)),
    maskButton("Pick whip", "Click the layer to use as the matte, in the viewport or the object list: it may be anywhere in the stack", () => startMatteWhip(object.id)),
    maskButton("Clear", "Take the track matte off; the source's eye stays as it is", () => sendMaskEdit(clearMatte(object), "Clear track matte"), object.trackMatte === undefined),
  );
  const looking = matteViewInfo(document_, object);
  if (looking !== undefined && object.trackMatte !== undefined) {
    const info = document.createElement("p");
    info.className = "mask-status";
    info.textContent = `${looking}${matteView?.objectId === object.id ? ` Showing: ${MATTE_VIEW_LABEL[matteView.view]}.` : ""}`;
    matte.append(info);
  }
  const missing = matteWarning(document_, object);
  if (missing !== undefined) {
    const warning = document.createElement("p");
    warning.className = "mask-status";
    warning.setAttribute("role", "status");
    warning.textContent = missing;
    matte.append(warning);
  }
  // Preserve Underlying Transparency (3.28): the layer shows only over what is already below it.
  const preserve = document.createElement("label");
  preserve.className = "mask-field";
  const preserveBox = document.createElement("input");
  preserveBox.type = "checkbox";
  preserveBox.checked = object.preserveUnderlyingTransparency === true;
  preserveBox.addEventListener("change", () => sendMaskEdit(setPreserve(object, preserveBox.checked), "Change preserve underlying transparency"));
  preserve.append(preserveBox, " Preserve underlying transparency");
  // Mask Reference (3.28): each effect can act only where one of the layer's masks covers. A mask in mode None still counts.
  const referable = masks.filter((mask) => mask.id !== undefined);
  const references = (object.effects ?? []).map((effect, effectIndex) => {
    const row = document.createElement("div");
    row.className = "mask-matte";
    const pick = document.createElement("select");
    pick.setAttribute("aria-label", `Mask reference of ${effect.effectId}`);
    const whole = document.createElement("option");
    whole.value = "";
    whole.textContent = "Whole layer";
    pick.append(whole);
    for (const mask of referable) {
      const option = document.createElement("option");
      option.value = mask.id!;
      option.textContent = mask.id!;
      option.selected = effect.maskIds?.[0] === mask.id;
      pick.append(option);
    }
    pick.disabled = referable.length === 0;
    pick.addEventListener("change", () => sendMaskEdit(setEffectMask(object, effectIndex, pick.value === "" ? null : pick.value), "Limit an effect to a mask"));
    row.append(`${effect.effectId} acts on `, pick);
    return row;
  });
  ui.masks.replaceChildren(heading, ...rows, add, copy, matte, preserve, ...references);
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
/// The open graph's view (11.68): the value graph is editable, the speed graph is for reading.
let graphMode: GraphMode = "value";
/// A handle drag in progress. `draft` is the curve under the pointer; nothing is
/// saved until the pointer is released, and then as one undoable gesture.
let graphDrag:
  | {
      readonly pointerId: number;
      readonly objectId: string;
      readonly property: string;
      readonly segment: number;
      readonly side: "out" | "in";
      draft?: CubicBezier;
    }
  | undefined;
/// The click that ends a handle drag is not a click on the stage: it would move
/// the playhead to wherever the handle was let go.
let suppressGraphClick = false;
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
  ui.timelineGraphMode.hidden = graphTrack === undefined;
  ui.timelineGraphMode.textContent = graphMode === "value" ? "Speed graph" : "Value graph";
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
    ...(graphTrack === undefined ? {} : { graphTrack, graphMode }),
    ...(graphDrag?.draft === undefined ? {} : { graphDraft: { segment: graphDrag.segment, bezier: graphDrag.draft } }),
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
/// The open graph, built the way it is painted (draft included), with the track it shows.
function openGraph(model: TimelineModel): { graph: SpeedGraphModel; objectId: string; property: string } | undefined {
  if (graphTrack === undefined) return undefined;
  const track = model.tracks[graphTrack];
  if (!track) return undefined;
  const keys = graphDrag?.draft
    ? withDraftBezier(track.sourceKeys, graphDrag.segment, graphDrag.draft)
    : track.sourceKeys;
  const graph = buildSpeedGraph({ keys }, timelineViewport, timelineViewport.height, model.durationFrames, {
    mode: graphMode,
    framesPerSecond: model.frameRate.num / model.frameRate.den,
  });
  return { graph, objectId: track.objectId, property: track.property };
}

/// What is under a point on the open graph: a handle (value graph only) or a key.
function graphHitAt(model: TimelineModel, x: number, y: number): GraphHit | undefined {
  const open = openGraph(model);
  return open ? hitGraph(open.graph, x, y) : undefined;
}

function keyAtStagePoint(
  model: TimelineModel,
  x: number,
  y: number,
): { objectId: string; property: string; frame: number } | undefined {
  // With a graph open the dope sheet's rows are not on screen: a key is whatever
  // the graph shows under the point.
  if (graphTrack !== undefined) {
    const open = openGraph(model);
    const hit = open ? hitGraph(open.graph, x, y) : undefined;
    return open && hit?.kind === "key" ? { objectId: open.objectId, property: open.property, frame: hit.frame } : undefined;
  }
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
  if (suppressGraphClick) {
    suppressGraphClick = false;
    return;
  }
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
  // A click that ends a handle drag lands on the handle: it is not a playhead move.
  if (graphTrack !== undefined && graphHitAt(model, x, y)?.kind === "handle") return;
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
  if (graphTrack !== undefined) {
    // With a graph open a drag edits a curve, never moves keys. Handles can be
    // grabbed on the value graph; the speed graph is for reading.
    const model = currentTimelineModel(scene);
    const open = openGraph(model);
    const grabbed = graphMode === "value" ? graphHitAt(model, event.clientX - bounds.left, event.clientY - bounds.top) : undefined;
    if (open && grabbed?.kind === "handle") {
      graphDrag = { pointerId: event.pointerId, objectId: open.objectId, property: open.property, segment: grabbed.segment, side: grabbed.side };
      stage.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    return;
  }
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

/// A handle under the pointer: the curve follows it live, unsaved.
function moveGraphHandle(event: PointerEvent): void {
  if (!scene || !graphDrag || graphDrag.pointerId !== event.pointerId || graphTrack === undefined) return;
  const stage = ui.timelineMount.querySelector<HTMLElement>(".timeline-stage");
  const track = currentTimelineModel(scene).tracks[graphTrack];
  const open = openGraph(currentTimelineModel(scene));
  if (!stage || !track || !open) return;
  const position = track.sourceKeys.findIndex((key) => Number(key.frame) === graphDrag!.segment);
  const from = track.sourceKeys[position];
  const to = track.sourceKeys[position + 1];
  if (!from || !to) return;
  const bounds = stage.getBoundingClientRect();
  graphDrag.draft = bezierFromHandleDrag(
    // The segment as it was when the drag began: the other handle is kept.
    track.sourceKeys[position]!,
    to,
    { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    timelineViewport,
    open.graph.min,
    open.graph.max,
    timelineViewport.height,
    graphDrag.side,
  );
  contentRevision += 1;
  paintTimeline(currentTimelineModel(scene));
}

function onTimelinePointerMove(event: PointerEvent): void {
  if (graphDrag) {
    moveGraphHandle(event);
    return;
  }
  if (!keyDrag || keyDrag.pointerId !== event.pointerId) return;
  if (Math.abs(event.clientX - keyDrag.startClientX) >= 3) keyDrag.moved = true;
}

/// Release a handle: one undoable gesture, or nothing if cancelled.
function finishGraphDrag(event: PointerEvent, cancelled: boolean): void {
  if (!scene || !graphDrag || graphDrag.pointerId !== event.pointerId) return;
  const drag = graphDrag;
  graphDrag = undefined;
  const stage = ui.timelineMount.querySelector<HTMLElement>(".timeline-stage");
  if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  contentRevision += 1;
  if (cancelled || drag.draft === undefined) {
    paintTimeline(currentTimelineModel(scene));
    return;
  }
  suppressGraphClick = true;
  setTimeout(() => { suppressGraphClick = false; }, 80);
  void runKeyEdit(planSetSegmentBezier(currentTimelineModel(scene), drag.objectId, drag.property, drag.segment, drag.draft));
}

function finishKeyDrag(event: PointerEvent, cancelled: boolean): void {
  if (graphDrag) {
    finishGraphDrag(event, cancelled);
    return;
  }
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

/** Ease the selected keys: After Effects Easy Ease, on both sides, the in side or the out side. A menu item and a key
 *  both come here (11.31). */
function easeKeys(kind: EasyEaseKind): void {
  if (scene) void runKeyEdit(planEasyEase(currentTimelineModel(scene), [...selectedKeys], kind));
}

function deleteKeys(): void {
  if (!scene) return;
  void runKeyEdit(planDelete([...selectedKeys]));
  setKeySelection([]);
}

function copyKeys(): void {
  if (!scene) return;
  keyClipboard = planCopy(currentTimelineModel(scene), [...selectedKeys]);
  log(`timeline: copied ${keyClipboard.length} key(s)`);
}

function pasteKeys(): void {
  if (scene) void runKeyEdit(planPaste(currentTimelineModel(scene), keyClipboard, currentFrame));
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
  // After Effects' Easy Ease: speed 0 with 33.33% influence on the chosen sides.
  for (const [value, label] of [["easy:both", "Easy ease (F9)"], ["easy:in", "Easy ease in (Shift+F9)"], ["easy:out", "Easy ease out (Ctrl+Shift+F9)"]]) {
    const option = document.createElement("option");
    option.value = value!;
    option.textContent = label!;
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
    log("jump to hold: nothing in this scene animates, so there is no build-in to finish", "bad");
    return;
  }
  pausePreview("jump to hold");
  setCurrentFrame(frame);
  log(`jumped to frame ${frame}, the end of the build-in`, "good");
}

/** Why the current key selection cannot be saved as a preset, if it cannot. */
function presetSaveBlocker(): string | undefined {
  if (projectSceneProject === undefined) {
    return "save this scene into a project first: presets live in the project library";
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
  if (chosen.startsWith("easy:")) {
    const kind = chosen.slice("easy:".length) as EasyEaseKind;
    void runKeyEdit(planEasyEase(currentTimelineModel(scene), [...selectedKeys], kind));
    ui.timelineEasing.value = "";
    return;
  }
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
    log(`preset save refused: ${blocker ?? "save this scene into a project first"}`, "bad");
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
  // Another scene starts at Fit: the view is the Editor's, not the scene's, and a position in one means nothing in another.
  const sceneKey = activeSession(workspace)?.key;
  if (sceneKey !== cameraScene) {
    cameraScene = sceneKey;
    camera = FIT;
    syncCamera();
  }
  const active = toolPreview ?? previewScene ?? scene;
  if (!active) {
    ui.overlay.replaceChildren();
    return;
  }
  renderViewportOverlay(
    document,
    ui.overlay,
    buildViewportOverlay(active, {
      selectedIds: selection,
      unit: overlayUnit(),
      pivots: activeTool === "pivot",
      ...(pen.points.length > 0 && penScene === activeSession(workspace)?.key ? { pen: penSketch(pen, penHover, penHover !== undefined && nearFirst(pen, penHover, penTolerance())) } : {}),
      ...pathSketchFor(active),
      ...maskSketchesFor(active),
      ...(marquee === undefined ? {} : { marquee }),
      ...(guides.length === 0 ? {} : { guides }),
      ...(guidesShown ? {} : { showGuides: false }),
    }),
  );
}

function setSelection(next: readonly string[]): void {
  selection = [...new Set(next)];
  pathSelected = [];
  pathMask = undefined;
  showRibbonStates();
  // A matte view belongs to the layer it looks at.
  if (matteView !== undefined && !selection.includes(matteView.objectId)) {
    matteView = undefined;
    scheduleEnginePreview();
    applyViewportSource();
  }
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
  scheduleEnginePreview();
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
  applyViewportSource();
}

function pausePreview(reason: string): void {
  const active = playback;
  if (!active) return;
  cancelAnimationFrame(active.requestId);
  playback = undefined;
  updatePlaybackControls();
  scheduleEnginePreview();

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

// ---------------------------------------------------------------------------
// Undo/redo and edits. Rust owns each session's history (11.36): one command
// is one entry, and a batch of edits is applied atomically, so one gesture is
// one undo however many objects or keys it touched (11.9, 11.21). A refused
// command changes nothing and adds no entry; its refusal is shown by name.
// ---------------------------------------------------------------------------

/** What the page knows that decides whether a command can run now (11.31). */
function commandContext(): CommandContext {
  const view = activeSession(workspace)?.view;
  return {
    sceneOpen: scene !== null && view !== undefined,
    projectOpen: openProject !== undefined,
    selectionCount: selection.length,
    canUndo: view !== undefined && view.undoDepth > 0,
    canRedo: view !== undefined && view.redoDepth > 0,
    busy: animationBusy,
    presetChosen: ui.timelinePreset.value !== "",
    selectedKeyCount: selectedKeys.size,
    copiedKeyCount: keyClipboard.length,
    arrangeRefusal: (command) => {
      const document_ = view?.document;
      if (document_ === undefined) return "no scene is open";
      const outcome = arrangeEdits(document_, selection, command);
      return isRefused(outcome) ? outcome.refused : undefined;
    },
  };
}

/** Run a command by its id: the one path a shortcut takes. The registry is asked first, so a key and the menu item
 *  give the same reason in the same words, and nothing runs that cannot. */
function runRegistryCommand(id: string): void {
  const reason = commandUnavailable(id, commandContext());
  if (reason !== undefined) {
    log(refusalLine(id, reason), "bad");
    return;
  }
  // Undo and redo keep their scope: a panel that has focus undoes its own module's latest change.
  if (id === "edit.undo" || id === "edit.redo") {
    void (id === "edit.undo" ? undo(focusedPanelModule()) : redo(focusedPanelModule()));
    return;
  }
  const command = commandById(id);
  if (command === undefined) return;
  switch (actionOf(command)) {
    case "invoke":
      document.getElementById(command.invoke!)?.click();
      break;
    case "native":
      runNativeAction(command.native!);
      break;
    default:
      break;
  }
}

/** Where a key press went, for the registry: into a text field, or onto a control that owns Space. */
function keyFocus(event: KeyboardEvent): KeyFocus {
  const target = event.target;
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof Element && target.closest('[contenteditable="true"]') !== null);
  return { editing, control: previewShortcutOwnsTarget(event) };
}

/** Every keyboard shortcut of the Editor, decided by the one table in `command-registry.ts`. */
function onCommandKey(event: KeyboardEvent): void {
  // Text selected anywhere on the page is copied as text, not as keys.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && (window.getSelection()?.toString() ?? "") !== "") return;
  const decision = decideKey(event, keyFocus(event), commandContext());
  if (decision.kind === "pass") return;
  if (decision.kind === "refused") {
    if (decision.quiet) return;
    // The browser gives Ctrl+S the meaning of saving the page; nothing else is taken from it.
    if (event.ctrlKey || event.metaKey) event.preventDefault();
    log(refusalLine(decision.command, decision.reason), "bad");
    return;
  }
  event.preventDefault();
  // G again, while a pen-family tool is in use, goes on to the next of the family: Pen, Add, Delete, Convert (11.116).
  if (decision.command === "edit.pen" && event.key.toLowerCase() === "g" && PEN_FAMILY.includes(activeTool)) {
    document.getElementById(PEN_FAMILY_BUTTONS[(PEN_FAMILY.indexOf(activeTool) + 1) % PEN_FAMILY.length]!)?.click();
    return;
  }
  runRegistryCommand(decision.command);
}

/** The pen family, in the order G goes through it. */
const PEN_FAMILY: readonly PageTool[] = ["pen", "vertex-add", "vertex-delete", "vertex-convert"];
const PEN_FAMILY_BUTTONS: readonly string[] = ["tool-pen", "tool-vertex-add", "tool-vertex-delete", "tool-vertex-convert"];

function updateHistoryButtons(): void {
  const view = activeSession(workspace)?.view;
  ui.undo.disabled = view === undefined || view.undoDepth === 0;
  ui.redo.disabled = view === undefined || view.redoDepth === 0;
  showRibbonStates();
  // Every edit, undo, redo and scene switch passes here, so the open list never shows a stale history.
  void refreshHistoryList();
}

// ---------------------------------------------------------------------------
// Change history (11.82). The list is the session's command log as Rust holds
// it: this page asks for it and draws it, and a click is one command
// (`goToHistoryStep`) like every other change, so the list, the Undo and Redo
// buttons and the shortcut can never disagree about what is applied.
// ---------------------------------------------------------------------------

/** Counts the reads, so a slow answer never overwrites a newer one. */
let historyRead = 0;

async function refreshHistoryList(): Promise<void> {
  if (!ui.historyDialog.open) return;
  const read = ++historyRead;
  const session = activeSession(workspace);
  if (!session) {
    ui.historyLead.textContent = "No scene is open.";
    ui.historyList.replaceChildren();
    return;
  }
  try {
    const view = await shell().invoke<HistoryView>("cmd_session_history", { session: session.key });
    if (read !== historyRead) return;
    ui.historyError.textContent = "";
    drawHistory(view);
  } catch (error) {
    if (read !== historyRead) return;
    ui.historyError.textContent = describe(error);
  }
}

function drawHistory(view: HistoryView): void {
  ui.historyLead.textContent = historySummary(view);
  let current: HTMLElement | undefined;
  const items = historyRows(view).map((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = row.applied ? "history-row" : "history-row undone";
    if (row.step !== undefined) button.dataset.step = String(row.step);
    if (row.current) {
      button.setAttribute("aria-current", "step");
      current = button;
    }
    const what = document.createElement("span");
    what.className = "history-what";
    what.textContent = row.title;
    const from = document.createElement("span");
    from.className = "history-from";
    from.textContent = row.applied ? row.from : row.from === "" ? "undone" : `${row.from}, undone`;
    button.append(what, from);
    button.title = row.current ? "The scene is here" : row.applied ? "Go back to here" : "Bring the scene forward to here";
    // The line the scene is already on does nothing: no command, and no "went to" line in Activity.
    if (!row.current) button.addEventListener("click", () => void goToHistoryStep(row.step, row.title));
    const item = document.createElement("li");
    item.append(button);
    return item;
  });
  ui.historyList.replaceChildren(...items);
  current?.scrollIntoView({ block: "nearest" });
}

/** A click on a line: the scene goes to the state just after that step, in one move. */
async function goToHistoryStep(step: number | undefined, title: string): Promise<void> {
  const session = activeSession(workspace);
  if (!session) return;
  const scope = step === undefined ? {} : { step };
  const outcome = await runCommand(
    { command: "goToHistoryStep", session: session.key, ...scope },
    { label: step === undefined ? "Went back to the scene as opened" : `Went to: ${title}`, refusal: "Change history" },
  );
  // A refusal draws nothing new (the list may have been stale), so read the history again.
  if (outcome === undefined) void refreshHistoryList();
}

function openHistory(): void {
  if (!ui.historyDialog.open) ui.historyDialog.show();
  void refreshHistoryList();
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
        command.command === "editScene" ||
        command.command === "undo" ||
        command.command === "redo" ||
        command.command === "goToHistoryStep";
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
    // The ribbon was last worked out while the edit was still going, when nothing could be created: say what can run now.
    showRibbonStates();
  }
}

/// The module a panel's gestures belong to (11.37). A gesture is tagged with
/// the panel holding focus when it is issued, and Ctrl+Z inside a panel undoes
/// that panel's latest command; outside any panel it is project-level.
const PANEL_MODULE: Readonly<Record<string, EditorModule>> = {
  viewport: "viewport",
  "object-manager": "objectManager",
  inspector: "inspector",
  pivot: "inspector",
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


/** What a tool is called in an Activity line. */
function toolWords(tool: PageTool): string {
  return tool === "move" ? "Move" : tool === "rotate" ? "Rotate" : tool === "scale" ? "Resize" : tool === "pivot" ? "Pivot" : tool === "pen" ? "Pen" : tool === "path" ? "Edit path" : tool === "vertex-add" ? "Add vertex" : tool === "vertex-delete" ? "Delete vertex" : tool === "vertex-convert" ? "Convert vertex" : tool === "hand" ? "Hand" : tool === "zoom" ? "Zoom" : "Select";
}

/** Choose the tool the pointer drags with. The buttons show which is in use. */
function setActiveTool(tool: PageTool): void {
  // A path being drawn is finished when another tool is chosen, or dropped when it is too short to be one. Hand and Zoom only
  // move the view, so the path waits for the Pen to be chosen again.
  if (activeTool === "pen" && tool !== "pen" && tool !== "hand" && tool !== "zoom") leavePen();
  if (!isPathTool(tool) && tool !== "hand" && tool !== "zoom") {
    dropPathState();
    pathMask = undefined;
  }
  activeTool = tool;
  for (const button of document.querySelectorAll<HTMLElement>("[data-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  }
  ui.overlay.dataset.tool = tool;
  showPenCreates();
  renderOverlayLayer();
}

// ---------------------------------------------------------------------------
// The view (11.105). The model is `viewport-camera.ts`; the camera is one CSS transform on the viewport surface, so every
// tool, which reads the pointer through the overlay's own box, stays true at any zoom and pan. Not saved in the scene.
// ---------------------------------------------------------------------------

let camera: Camera = FIT;
/** The scene the camera is for: another scene starts at Fit. */
let cameraScene: number | undefined;
let panning: { pointerId: number; x: number; y: number; camera: Camera } | undefined;

function viewSurface(): HTMLElement | null {
  return ui.canvas.closest<HTMLElement>(".viewport-surface");
}

/** The pane and the picture at Fit, in screen pixels as laid out (a transform does not change them). */
function viewSizes(): { pane: ViewSize; picture: ViewSize } {
  const surface = viewSurface();
  return {
    pane: { width: surface?.offsetWidth ?? 0, height: surface?.offsetHeight ?? 0 },
    picture: { width: ui.canvas.offsetWidth, height: ui.canvas.offsetHeight },
  };
}

/** Screen pixels per canvas pixel at Fit. */
function fitScale(): number {
  const active = previewScene ?? scene;
  return active !== null && active.canvas.width > 0 ? ui.canvas.offsetWidth / active.canvas.width : 0;
}

/** Canvas pixels to a screen pixel at the moment: what the overlay's handles and markers are drawn larger by. */
function overlayUnit(): number {
  const active = previewScene ?? scene;
  const box = ui.overlay.getBoundingClientRect();
  return active !== null && box.width > 0 ? active.canvas.width / box.width : 1;
}

/** Put the camera on the surface and in the readout. */
function syncCamera(): void {
  const { pane, picture } = viewSizes();
  camera = clampPan(camera, pane, picture);
  const surface = viewSurface();
  if (surface) surface.style.transform = cameraTransform(camera);
  ui.viewerZoomReadout.textContent = zoomLabel(camera, fitScale()) || "100%";
}

function setCamera(next: Camera): void {
  camera = next;
  syncCamera();
  renderOverlayLayer();
}

/** A point of the screen as an offset from the pane's middle. */
function paneOffset(clientX: number, clientY: number): ViewPoint {
  const stage = ui.canvas.closest<HTMLElement>(".viewport-stage")?.getBoundingClientRect();
  return stage === undefined ? { x: 0, y: 0 } : { x: clientX - (stage.left + stage.width / 2), y: clientY - (stage.top + stage.height / 2) };
}

function zoomView(factor: number, at: ViewPoint = { x: 0, y: 0 }): void {
  const { pane, picture } = viewSizes();
  setCamera(zoomAt(camera, factor, at, pane, picture));
}

function startPan(event: PointerEvent): void {
  event.preventDefault();
  panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera };
  ui.overlay.setPointerCapture(event.pointerId);
  ui.overlay.dataset.panning = "true";
}

function movePan(event: PointerEvent): void {
  if (panning === undefined) return;
  const { pane, picture } = viewSizes();
  setCamera(panBy(panning.camera, event.clientX - panning.x, event.clientY - panning.y, pane, picture));
}

function endPan(event: PointerEvent): void {
  if (ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);
  panning = undefined;
  delete ui.overlay.dataset.panning;
}

/** The wheel zooms at the pointer; with Shift it moves the view across. */
function onViewWheel(event: WheelEvent): void {
  if (!scene) return;
  event.preventDefault();
  // A line or a page is a larger turn than a pixel: bring them to pixels first.
  const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
  if (event.shiftKey && !event.ctrlKey) {
    const { pane, picture } = viewSizes();
    setCamera(panBy(camera, -pixels, 0, pane, picture));
    return;
  }
  zoomView(wheelFactor(pixels), paneOffset(event.clientX, event.clientY));
}

// ---------------------------------------------------------------------------
// The Pen tool (11.104). The model is `pen-tool.ts`; this feeds it the pointer and the keys and sends what it makes.
// ---------------------------------------------------------------------------

/** How close to the first point a click closes the path: ten screen pixels, in canvas pixels. */
function penTolerance(): number {
  const box = ui.overlay.getBoundingClientRect();
  const canvasWidth = (previewScene ?? scene)?.canvas.width ?? 1920;
  return box.width > 0 ? (10 * canvasWidth) / box.width : 10;
}

/** What the last snap held, so a snap is let go only at 11 screen pixels (11.110). */
let snapHold: SnapHold = {};

/** `at`, snapped to the canvas, other layers and vertices; the guides it snapped to are shown until the gesture ends. Shift (an angle
 *  step) and Ctrl turn it off; so does the setting. */
function snapAt(at: OverlayPoint, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, except: ReadonlySet<string>, own: readonly OverlayPoint[] = []): OverlayPoint {
  const active = previewScene ?? scene;
  if (!active) return at;
  const off = event.ctrlKey || event.metaKey || event.shiftKey || !editorPen.snap;
  const result = snapPoint(at, snapTargets(active, except, own), snapHold, overlayUnit(), off);
  snapHold = result.hold;
  guides = [...result.guides];
  return result.point;
}

function endSnap(): void {
  snapHold = {};
  guides = [];
}

function penPointerDown(event: PointerEvent): void {
  const at = snapAt(eventScenePoint(event), event, new Set(), pen.points.map((p) => ({ x: p.x, y: p.y })));
  event.preventDefault();
  ui.overlay.focus({ preventScroll: true });
  // The second click of a double click that has just finished a path is not the start of another.
  if (event.timeStamp - penFinishedAt < 500) return;
  // A path begun in another scene is dropped; its points mean nothing here.
  if (pen.points.length > 0 && penScene !== activeSession(workspace)?.key) cancelPen();
  // Clicking an end of the selected open shape carries that path on instead of starting another.
  if (pen.points.length === 0 && tryResume(at)) {
    ui.overlay.setPointerCapture(event.pointerId);
    penPull = event.pointerId;
    return;
  }
  if (nearFirst(pen, at, penTolerance())) {
    // Closing: a click closes the path; a drag from the first point also sets the tangents it closes with (released, it ends).
    pen = closePath(pen);
    penClosing = true;
    penPull = event.pointerId;
    penLastAt = at;
    ui.overlay.setPointerCapture(event.pointerId);
    renderOverlayLayer();
    return;
  }
  penRefused = false;
  pen = addPoint(pen, at, event.shiftKey, editorPen.angle);
  penScene = activeSession(workspace)?.key;
  penPull = event.pointerId;
  penLastAt = at;
  ui.overlay.setPointerCapture(event.pointerId);
  renderOverlayLayer();
}

/** Where a click at `at` is on an end of the selected open shape: the path is carried on from there. Only for a shape that is
 *  placed where its path says (no move, turn, scale or pivot), since the pen's points are canvas points. */
function tryResume(at: OverlayPoint): boolean {
  if (!scene || selection.length !== 1) return false;
  // A path drawn as a mask is a new one, never the end of the selected shape.
  const plan = currentPenPlan();
  if ("refused" in plan || plan.kind !== "shape") return false;
  const object = scene.objects.find((candidate) => candidate.id === selection[0]);
  if (object === undefined || object.type !== "shape" || object.locked || object.path.closed) return false;
  if (object.compoundPaths !== undefined && object.compoundPaths.length > 0) return false;
  // An animated path keeps its vertices in every key: carrying it on would add a vertex to one key only.
  if (animatesPath(scene, object.id)) return false;
  const near = (p: { x: number; y: number }) => Math.hypot(p.x - at.x, p.y - at.y) <= penTolerance();
  const first = object.path.vertices[0];
  const last = object.path.vertices[object.path.vertices.length - 1];
  const fromFirst = first !== undefined && near(first);
  if (!fromFirst && !(last !== undefined && near(last))) return false;
  const where = effectivePlacement(scene, object);
  const placed = where.x === 0 && where.y === 0 && where.rotation === 0 && where.scaleX === 1 && where.scaleY === 1 && where.anchorX === 0 && where.anchorY === 0;
  if (!placed) {
    log(`Pen: ${object.name} has been moved, turned or scaled, so its path cannot be carried on from the canvas yet. Reset its transform, or draw a new path.`, "bad");
    return false;
  }
  const state = resumeState(object.path, fromFirst);
  if (state === undefined) return false;
  pen = state;
  penResume = object.id;
  penScene = activeSession(workspace)?.key;
  renderOverlayLayer();
  return true;
}

function penPointerMove(event: PointerEvent): void {
  const raw = eventScenePoint(event);
  // A point being placed is snapped as it is put down; the handles it pulls are not.
  const at = penPull === event.pointerId ? raw : snapAt(raw, event, new Set(), pen.points.map((p) => ({ x: p.x, y: p.y })));
  if (penPull === event.pointerId) {
    const options = { alt: event.altKey, shift: event.shiftKey, degrees: editorPen.angle };
    if (penClosing) pen = closeWithPull(pen, at, options);
    else if (penSpace && penLastAt !== undefined) {
      // Space held: the new point moves with its handles, the pull stays as it was.
      pen = moveLast(pen, { x: at.x - penLastAt.x, y: at.y - penLastAt.y });
    } else {
      // The pointer is down on the point just made: it pulls that point's handles.
      pen = pullHandles(pen, at, options);
    }
    penLastAt = at;
  } else {
    const last = pen.points[pen.points.length - 1];
    penHover = event.shiftKey && last !== undefined ? constrain(last, at, editorPen.angle) : at;
  }
  renderOverlayLayer();
}

function penPointerUp(event: PointerEvent): void {
  if (penPull !== event.pointerId) return;
  penPull = undefined;
  penSpace = false;
  penLastAt = undefined;
  endSnap();
  if (ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);
  // A click or drag on the first point closed the path: it ends here.
  if (penClosing) {
    penClosing = false;
    finishPen();
    return;
  }
  renderOverlayLayer();
}

/** Enter finishes the path, Backspace takes back the last point, Escape drops it. Returns whether the key was the pen's. */
function penKey(event: KeyboardEvent): boolean {
  // With no path in progress these keys are not the pen's: Delete still deletes and Escape still clears the selection.
  if (pen.points.length === 0) return false;
  // Space while a point is being placed moves it instead of playing the preview.
  if (event.key === " " && penPull !== undefined) {
    penSpace = true;
    event.preventDefault();
    return true;
  }
  if (event.key === "Enter") finishPen();
  else if (event.key === "Backspace" || event.key === "Delete") pen = removeLast(pen);
  else if (event.key === "Escape") {
    if (penPull !== undefined) {
      // Escape in the middle of placing a point takes that point back and nothing else.
      if (ui.overlay.hasPointerCapture(penPull)) ui.overlay.releasePointerCapture(penPull);
      penPull = undefined;
      penSpace = false;
      penLastAt = undefined;
      if (penClosing) {
        penClosing = false;
        pen = { ...pen, closed: false };
      } else pen = removeLast(pen);
    } else if (penRefused) {
      // The path was refused (an open path cannot be a mask) and given back; a second Escape lets it go.
      penRefused = false;
      cancelPen();
    } else if (pen.points.length >= 2) finishPen();
    else cancelPen();
  } else return false;
  event.preventDefault();
  renderOverlayLayer();
  return true;
}

/** The path in progress was refused when it was finished and given back (11.111); Escape again drops it. */
let penRefused = false;

function cancelPen(): void {
  penRefused = false;
  endSnap();
  pen = EMPTY_PEN;
  penResume = undefined;
  penClosing = false;
  penSpace = false;
  penLastAt = undefined;
  penPull = undefined;
  penHover = undefined;
  renderOverlayLayer();
}

/** Make the path a shape: one batch, one undo step, and the new shape is selected. A path that is not enough yet says why
 *  and stays, so the next click carries on drawing it. */
function finishPen(): void {
  if (!scene || pen.points.length === 0) return;
  if (penScene !== activeSession(workspace)?.key) {
    log("Pen: the path was drawn in another scene, so nothing was made.", "bad");
    cancelPen();
    return;
  }
  // A double click makes its second point on top of the first: that is the end of the path, not another point.
  const last = pen.points[pen.points.length - 1]!;
  const before = pen.points[pen.points.length - 2];
  if (!pen.closed && before !== undefined && Math.hypot(last.x - before.x, last.y - before.y) < 1) pen = removeLast(pen);
  const shapes = scene.objects.filter((object) => object.type === "shape").length;
  const resumed = penResume;
  // 11.111: a mask on the selected layer, or a new shape, as `Pen creates` and the selection say.
  const plan = resumed === undefined ? currentPenPlan() : ({ kind: "shape" } as const);
  if ("refused" in plan) {
    log(`Pen: ${plan.refused}`, "bad");
    penRefused = true;
    renderOverlayLayer();
    return;
  }
  const outcome = plan.kind === "mask"
    ? penMaskEdit(scene, pen, plan.object)
    : resumed === undefined ? penEdits(scene, pen, `Pen path ${shapes + 1}`) : resumeEdits(resumed, pen);
  if (isRefused(outcome)) {
    log(`Pen: ${outcome.refused}`, "bad");
    penRefused = true;
    renderOverlayLayer();
    return;
  }
  const label = plan.kind === "mask" ? penMaskLabel(pen, plan.object) : penLabel(pen, resumed !== undefined);
  const kept = pen;
  cancelPen();
  penFinishedAt = performance.now();
  void runEdits(outcome.edits, {
    label,
    select: (effects) => {
      for (const effect of effects) if (effect.effect === "objectCreated") return [effect.objectId];
      return resumed === undefined ? undefined : [resumed];
    },
  }, plan.kind === "mask" ? "scene" : "viewport").then((done) => {
    // Refused, or an edit was still going: the path is given back, so the author has not lost it.
    if (done === undefined && pen.points.length === 0 && activeTool === "pen") {
      pen = kept;
      penResume = resumed;
      penScene = activeSession(workspace)?.key;
      renderOverlayLayer();
    }
  });
}

/** Leaving the Pen tool: a path of enough points is made, a shorter one is dropped. */
function leavePen(): void {
  if (pen.points.length >= 2) finishPen();
  // A path that was refused is not kept out of sight for the next time the Pen is chosen.
  if (activeTool !== "pen") cancelPen();
}

// ---------------------------------------------------------------------------
// Editing a path (11.107). The model is `path-edit.ts` (and `path-geometry.ts`, the same maths as the backend's
// `path_geometry.rs`); this feeds it the pointer and the keys and sends ONE `editPath` edit when a gesture ends.
// ---------------------------------------------------------------------------

/** The vertices that are selected, on the shape that is selected. */
let pathSelected: readonly Selected[] = [];
let pathGesture: { pointerId: number; gesture?: PathGesture; startClient: { x: number; y: number }; start: OverlayPoint; moved: boolean; additive: boolean } | undefined;
/** The subpath as it would be after the drag in progress. */
let pathPreview: { subpath: number; path: BezierPath } | undefined;
/** Shift pressed on a vertex that was already selected: a click without a move takes it out of the selection. */
let pathToggle: Selected | undefined;

/** The mask whose path the path tools edit (11.117), or `undefined` for the selected shape's own path. */
let pathMask: number | undefined;

/** Whether edits of a path set a path key at the playhead even when the path has none yet (11.112). */
let pathKeying = false;

function pathTarget(): EditTarget | { refused: string } {
  return scene ? editTarget(scene, selection, pathMask, currentFrame) : { refused: "Open a scene first." };
}

/** What the viewport draws for the path tools: the selected shape's vertices, and the handles of the selected ones. */
function pathSketchFor(active: SceneDocument): { pathEdit: ReturnType<typeof pathEditSketch> } | Record<string, never> {
  if (!isPathTool(activeTool)) return {};
  const target = editTarget(active, selection, pathMask, currentFrame);
  if (isRefused(target)) return {};
  return { pathEdit: pathEditSketch(target, pathSelected, pathPreview) };
}

/** The masks of the selected layer, for the viewport (11.117): shown with every tool, so the author sees what clips. */
function maskSketchesFor(active: SceneDocument): { masks: ReturnType<typeof maskSketches> } | Record<string, never> {
  if (selection.length !== 1) return {};
  const object = active.objects.find((candidate) => candidate.id === selection[0]);
  if (object === undefined || (object.masks?.length ?? 0) === 0) return {};
  return { masks: maskSketches(active, object, activeTool === "path" || activeTool === "vertex-add" || activeTool === "vertex-delete" || activeTool === "vertex-convert" ? pathMask : undefined) };
}

function dropPathState(): void {
  endSnap();
  pathSelected = [];
  pathGesture = undefined;
  pathPreview = undefined;
  pathToggle = undefined;
  marquee = undefined;
}

/** Ten screen pixels, in canvas pixels. */
const pathRadius = (): number => editorPen.pick * overlayUnit();

function pathPointerDown(event: PointerEvent): void {
  event.preventDefault();
  ui.overlay.focus({ preventScroll: true });
  const active = previewScene ?? scene;
  if (!active || !scene) return;
  const at = eventScenePoint(event);
  let target = pathTarget();
  const hitShape = hitTestOverlay(active, at);
  // Nothing editable selected yet, or a click on another object: select it, as the Select tool would.
  if (isRefused(target) || (hitShape !== undefined && !selection.includes(hitShape) && pickPath(target, pathSelected, at, pathRadius()) === undefined)) {
    if (hitShape !== undefined) {
      setSelection(event.shiftKey ? [hitShape] : [hitShape]);
      target = pathTarget();
    }
    if (isRefused(target)) {
      if (selection.length > 0) log(`${toolWords(activeTool)}: ${target.refused}`, "bad");
      else if (hitShape === undefined) log(`${toolWords(activeTool)}: ${target.refused}`);
      renderOverlayLayer();
      return;
    }
    if (activeTool === "path") {
      // The click that chose the shape only chose it.
      renderOverlayLayer();
      return;
    }
  }
  const hit = pickPath(target, pathSelected, at, pathRadius());
  if (activeTool !== "path") {
    const tool = activeTool === "vertex-add" ? "add" : activeTool === "vertex-delete" ? "delete" : "convert";
    // Alt with the Delete Vertex tool takes the point out and fits one curve over the two beside it (11.113).
    const planned = clickOp(tool, hit, target, tool === "delete" && event.altKey ? editorPen.fit : undefined);
    if ("refused" in planned) {
      log(`${toolWords(activeTool)}: ${planned.refused}`, "bad");
      return;
    }
    sendPathOp(target, planned.subpath, planned.op, planned.label);
    return;
  }
  // Alt-click on a vertex swaps corner and smooth, as it does in Illustrator and with the Convert tool (11.116).
  if (event.altKey && hit?.kind === "vertex") {
    const planned = clickOp("convert", hit, target);
    if ("refused" in planned) log(`Edit path: ${planned.refused}`, "bad");
    else sendPathOp(target, planned.subpath, planned.op, planned.label);
    return;
  }
  const additive = event.shiftKey;
  pathToggle = undefined;
  if (hit === undefined) {
    // Empty space: a marquee, which selects the vertices inside it.
    pathGesture = { pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, start: at, moved: false, additive };
    if (!additive) pathSelected = [];
  } else {
    if (hit.kind === "vertex" && additive && isSelected(pathSelected, hit.subpath, hit.index)) pathToggle = { subpath: hit.subpath, index: hit.index };
    const begun = beginGesture(hit, at, pathSelected, additive);
    pathSelected = begun.selected;
    pathGesture = { pointerId: event.pointerId, gesture: begun.gesture, startClient: { x: event.clientX, y: event.clientY }, start: at, moved: false, additive };
  }
  ui.overlay.setPointerCapture(event.pointerId);
  renderOverlayLayer();
}

function pathPointerMove(event: PointerEvent): void {
  if (!pathGesture || pathGesture.pointerId !== event.pointerId) return;
  const target = pathTarget();
  if (isRefused(target)) return;
  const rawAt = eventScenePoint(event);
  pathGesture.moved ||= !isClick({ clientX: pathGesture.startClient.x, clientY: pathGesture.startClient.y }, event);
  if (!pathGesture.moved) return;
  if (pathGesture.gesture === undefined) {
    marquee = boundsFromDrag(pathGesture.start, rawAt);
    renderOverlayLayer();
    return;
  }
  const at = snapGrab(target, pathGesture.gesture, rawAt, event);
  const made = gestureOp(target, pathGesture.gesture, at, { shift: event.shiftKey, alt: event.altKey, step: editorPen.angle });
  if (made === undefined) return;
  const subpath = target.paths.find((p) => p.subpath === made.subpath);
  const next = subpath === undefined ? undefined : applyOp(subpath.path, made.op);
  pathPreview = next === undefined ? undefined : { subpath: made.subpath, path: next };
  renderOverlayLayer();
}

/** The pointer position for a drag, moved so that what is grabbed (a vertex, or the end of a handle) lands on a snap, if one is
 *  near: the snap is of the grabbed point, not of the pointer. A curve is not snapped. */
function snapGrab(target: EditTarget, gesture: PathGesture, at: OverlayPoint, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): OverlayPoint {
  const hit = gesture.hit;
  if (hit.kind === "segment") return at;
  const entry = target.paths.find((p) => p.subpath === hit.subpath);
  if (entry === undefined) return at;
  const vertex = entry.path.vertices[hit.index];
  if (vertex === undefined) return at;
  const grabbed = hit.kind === "vertex"
    ? vertex
    : { x: vertex.x + (hit.side === "out" ? entry.path.outTangents : entry.path.inTangents)[hit.index]!.x, y: vertex.y + (hit.side === "out" ? entry.path.outTangents : entry.path.inTangents)[hit.index]!.y };
  const from = canvasPointOf(target, grabbed);
  // Where the grabbed point would be with the pointer at `at`: it was `from` when the pointer was at the start.
  const offset = { x: from.x - gesture.start.x, y: from.y - gesture.start.y };
  const moving = new Set(gesture.moving.map((s) => `${s.subpath}:${s.index}`));
  const own = target.paths.flatMap((p) => p.path.vertices.flatMap((v, index) => (moving.has(`${p.subpath}:${index}`) ? [] : [canvasPointOf(target, v)])));
  const landed = snapAt({ x: at.x + offset.x, y: at.y + offset.y }, event, new Set([target.object.id]), own);
  return { x: landed.x - offset.x, y: landed.y - offset.y };
}

function pathPointerUp(event: PointerEvent, cancelled: boolean): void {
  const drag = pathGesture;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (cancelled) endSnap();
  pathGesture = undefined;
  if (ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);
  const target = pathTarget();
  const at = eventScenePoint(event);
  if (isRefused(target) || cancelled) {
    pathPreview = undefined;
    marquee = undefined;
    renderOverlayLayer();
    return;
  }
  if (drag.gesture === undefined) {
    // The marquee ends: the vertices inside it, added to the selection with Shift. A click on nothing has cleared it already.
    if (drag.moved) {
      const inside = verticesInBox(target, boundsFromDrag(drag.start, at));
      pathSelected = drag.additive ? [...pathSelected, ...inside.filter((s) => !isSelected(pathSelected, s.subpath, s.index))] : inside;
    }
    marquee = undefined;
    renderOverlayLayer();
    return;
  }
  if (!drag.moved) {
    // A click: Shift on a vertex that was selected takes it out of the selection.
    if (pathToggle !== undefined) pathSelected = pathSelected.filter((s) => !(s.subpath === pathToggle!.subpath && s.index === pathToggle!.index));
    pathToggle = undefined;
    pathPreview = undefined;
    renderOverlayLayer();
    return;
  }
  const made = gestureOp(target, drag.gesture, snapGrab(target, drag.gesture, at, event), { shift: event.shiftKey, alt: event.altKey, step: editorPen.angle });
  endSnap();
  if (made === undefined) {
    pathPreview = undefined;
    renderOverlayLayer();
    return;
  }
  const words = drag.gesture.hit.kind === "vertex" ? (drag.gesture.moving.length > 1 ? `Moved ${drag.gesture.moving.length} vertices` : "Moved a vertex") : drag.gesture.hit.kind === "handle" ? "Moved a handle" : "Reshaped a curve";
  sendPathOp(target, made.subpath, made.op, words);
}

/** One `editPath` edit: one undo step. The preview stays up until Rust has answered, so the path does not jump back. */
function sendPathOp(target: EditTarget, subpath: number, op: PathOp, label: string): void {
  const id = target.object.id;
  // A new vertex count or order makes the selected indices mean something else.
  const keeps = op.op === "moveVertices" || op.op === "setHandle" || op.op === "reshapeSegment" || op.op === "convertVertex" || op.op === "setVertexKind";
  // 11.112: the frame goes with the edit when the path is animated or keys are being set, so the edit lands in a key.
  const frame = pathEditFrame(target, subpath, pathKeying);
  void runEdits([editPathEdit(id, subpath, op, target.mask, frame, pathEditRevision(target, subpath))], { label: `${label} of ${target.object.name}${frame === undefined ? "" : ` at frame ${frame}`}` }, "viewport")
    .then((done) => {
      if (done === undefined) return;
      if (!keeps) pathSelected = [];
    })
    .finally(() => {
      pathPreview = undefined;
      renderOverlayLayer();
    });
}

/** The kind of every selected vertex set in one gesture (one undo step), written out to the path and, if it is animated, to its key here. */
function setSelectedVertexKind(kind: VertexKind): void {
  const target = pathTarget();
  if (isRefused(target)) {
    log(`Vertex kind: ${target.refused}`, "bad");
    return;
  }
  const planned = kindEdits(target, pathSelected, kind, pathKeying);
  if ("refused" in planned) {
    log(`Vertex kind: ${planned.refused}`, "bad");
    return;
  }
  void runEdits(planned.edits, { label: `${planned.label} of ${target.object.name}` }, "viewport").finally(() => renderOverlayLayer());
}

/** The subpath of the selected vertices taken out of its compound shape (11.112): its animation and links go with it, the others keep their ids. */
async function removeSelectedSubpath(): Promise<void> {
  const target = pathTarget();
  if (isRefused(target)) {
    log(`Remove subpath: ${target.refused}`, "bad");
    return;
  }
  if (target.mask !== undefined) {
    log("Remove subpath: a mask is one path. Remove the mask instead.", "bad");
    return;
  }
  const subpath = pathSelected[0]?.subpath;
  if (subpath === undefined) {
    log("Remove subpath: select a vertex of the subpath to take out first.", "bad");
    return;
  }
  await runEdits([{ edit: "removeSubpath", shapeId: target.object.id, subpath } as SceneEdit], { label: `Removed a subpath of ${target.object.name}` }, "viewport");
  pathSelected = [];
}

/** The path being edited taken out of its link (11.112): it keeps what it has and is independent from then on. */
async function unlinkEditedPath(): Promise<void> {
  const target = pathTarget();
  if (isRefused(target) || !scene) {
    log(`Unlink path: ${isRefused(target) ? target.refused : "open a scene first"}`, "bad");
    return;
  }
  const subpath = pathSelected[0]?.subpath ?? target.paths[0]?.subpath ?? 0;
  const place = target.mask === undefined ? ({ kind: "shape", subpath } as const) : ({ kind: "mask", index: target.mask } as const);
  const link = pathLinkOf(scene, target.object, place);
  if (link === undefined) {
    log(`Unlink path: that path of ${target.object.name} is not linked.`, "bad");
    return;
  }
  await runEdits([unlinkPath(target.object.id, place)], { label: `Unlinked a path of ${target.object.name} from ${linkUsersWords(scene, link, linkedPathOf(target.object, place))}` }, "viewport");
}

/** The tension of the selected path's auto vertices, from the slider. */
function setPathAutoTension(tension: number): void {
  const target = pathTarget();
  if (isRefused(target)) {
    log(`Auto tension: ${target.refused}`, "bad");
    return;
  }
  const subpath = pathSelected[0]?.subpath ?? target.paths[0]?.subpath ?? 0;
  sendPathOp(target, subpath, { op: "setAutoTension", tension }, `Set auto tension to ${tension}`);
}

/** A key on every path of the selection at the playhead, as the path is there: how a path starts to animate (11.112). */
async function keyPathAtPlayhead(): Promise<void> {
  const target = pathTarget();
  if (isRefused(target)) {
    log(`Key path: ${target.refused}`, "bad");
    return;
  }
  const edits: SceneEdit[] = target.paths.map((entry) => ({
    edit: "setPathKey",
    objectId: target.object.id,
    target: target.mask === undefined ? { kind: "shape", subpath: entry.subpath } : { kind: "mask", index: target.mask },
    frame: wireFrame(currentFrame),
    path: entry.path,
    easing: "ease-in-out",
  }) as SceneEdit);
  await runEdits(edits, { label: `Keyed the path of ${target.object.name} at frame ${currentFrame}` }, "viewport");
}

/** The key of every path of the selection at the playhead, taken away. */
async function removePathKeyAtPlayhead(): Promise<void> {
  const target = pathTarget();
  if (isRefused(target)) {
    log(`Remove path key: ${target.refused}`, "bad");
    return;
  }
  const edits: SceneEdit[] = [];
  for (const entry of target.paths) {
    const at = target.mask === undefined ? ({ kind: "shape", subpath: entry.subpath } as const) : ({ kind: "mask", index: target.mask } as const);
    if (pathKeyAt(scene ? pathChannelOf(scene, target.object.id, at) : undefined, currentFrame) !== undefined) {
      edits.push({ edit: "removePathKey", objectId: target.object.id, target: at, frame: wireFrame(currentFrame) } as SceneEdit);
    }
  }
  if (edits.length === 0) {
    log(`Remove path key: ${target.object.name} has no path key at frame ${currentFrame}.`, "bad");
    return;
  }
  await runEdits(edits, { label: `Removed the path key of ${target.object.name} at frame ${currentFrame}` }, "viewport");
}

/** Delete takes the selected vertices out, Escape drops the drag or the selection. Returns whether the key was this tool's. */
function pathKey(event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    if (pathGesture !== undefined) {
      if (ui.overlay.hasPointerCapture(pathGesture.pointerId)) ui.overlay.releasePointerCapture(pathGesture.pointerId);
      pathGesture = undefined;
      pathPreview = undefined;
      marquee = undefined;
    } else if (pathSelected.length > 0) pathSelected = [];
    else return false;
    event.preventDefault();
    renderOverlayLayer();
    return true;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && pathSelected.length > 0) {
    const target = pathTarget();
    if (isRefused(target)) return false;
    const planned = deleteSelected(target, pathSelected);
    event.preventDefault();
    if ("refused" in planned) log(`Edit path: ${planned.refused}`, "bad");
    else sendPathOp(target, planned.subpath, planned.op, planned.label);
    return true;
  }
  return false;
}

/** Double click on a vertex swaps corner and smooth; on a curve it puts a vertex there (the Smart Pen's shortcuts). */
function pathDoubleClick(event: MouseEvent): void {
  const at = eventScenePoint(event as PointerEvent);
  const target = pathTarget();
  if (isRefused(target)) return;
  const hit: PathHit | undefined = pickPath(target, pathSelected, at, pathRadius());
  if (hit === undefined || hit.kind === "handle") return;
  const planned = clickOp(hit.kind === "vertex" ? "convert" : "add", hit, target);
  if ("refused" in planned) log(`Edit path: ${planned.refused}`, "bad");
  else sendPathOp(target, planned.subpath, planned.op, planned.label);
}

// ---------------------------------------------------------------------------
// The Pivot panel (11.103). The model is `anchor-point.ts`; this draws it and sends what it plans.
// ---------------------------------------------------------------------------

/** Show where the selection's pivot is and which place on the box it is on. A field being typed in is left alone. */
function renderPivotPanel(document_: SceneDocument): void {
  const view = pivotView(document_, selection);
  ui.pivotEmpty.hidden = view.kind !== "none";
  ui.pivotBody.hidden = view.kind === "none";
  ui.pivotSummary.textContent = view.summary;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pivot-place]")) {
    button.setAttribute("aria-pressed", String(button.dataset.pivotPlace === view.place));
  }
  if (document.activeElement !== ui.pivotX) ui.pivotX.value = view.x === undefined ? "" : String(view.x);
  if (document.activeElement !== ui.pivotY) ui.pivotY.value = view.y === undefined ? "" : String(view.y);
  ui.pivotX.placeholder = view.x === undefined ? "differs" : "";
  ui.pivotY.placeholder = view.y === undefined ? "differs" : "";
}

/** Send a pivot request for the selection as one batch (one undo step), or say by name why it cannot be. */
let pivotQueue: Promise<void> = Promise.resolve();
/** Requests go one after another, so a second one (a typed Y straight after a typed X) is planned from the document the
 *  first one made, not from the one before it. */
function applyPivot(request: PivotRequest): Promise<void> {
  pivotQueue = pivotQueue.then(() => sendPivot(request));
  return pivotQueue;
}

async function sendPivot(request: PivotRequest): Promise<void> {
  if (!scene) return;
  const keepInPlace = ui.pivotKeep.checked;
  // With keys on the position: add a key at the playhead (the object as drawn there), or move every existing key.
  const keyed = ui.pivotKeyedModify.checked ? "modify" : "insert";
  const plan = pivotPlan(scene, selection, request, { keepInPlace, keyed, frame: currentFrame, view: previewScene ?? scene });
  if (isRefused(plan)) {
    ui.pivotError.textContent = plan.refused;
    ui.pivotError.hidden = false;
    log(`Pivot: ${plan.refused}`, "bad");
    return;
  }
  ui.pivotError.hidden = true;
  const objects = selectionRoots(scene, selection).flatMap((id) => scene?.objects.filter((object) => object.id === id) ?? []);
  await runEdits(plan, pivotLabel(objects, request, keepInPlace), "inspector");
}

function wirePivotPanel(): void {
  const offset = (): { x: number; y: number } => ({ x: Number(ui.pivotOffsetX.value) || 0, y: Number(ui.pivotOffsetY.value) || 0 });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pivot-place]")) {
    button.addEventListener("click", () => {
      const place = button.dataset.pivotPlace ?? "";
      void applyPivot({ kind: ui.pivotScope.value === "selection" ? "selection" : "grid", place, offset: offset() });
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pivot-nudge]")) {
    button.addEventListener("click", () => {
      const [dx = 0, dy = 0] = (button.dataset.pivotNudge ?? "0,0").split(",").map(Number);
      const step = Number(ui.pivotStep.value) > 0 ? Number(ui.pivotStep.value) : 1;
      void applyPivot({ kind: "nudge", dx: dx * step, dy: dy * step });
    });
  }
  const typed = (): void => {
    const x = ui.pivotX.value.trim() === "" ? undefined : Number(ui.pivotX.value);
    const y = ui.pivotY.value.trim() === "" ? undefined : Number(ui.pivotY.value);
    if (x === undefined && y === undefined) return;
    void applyPivot({ kind: "point", ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) });
  };
  ui.pivotX.addEventListener("change", typed);
  ui.pivotY.addEventListener("change", typed);
  ui.pivotReset.addEventListener("click", () => void applyPivot({ kind: "reset" }));
}

/** Whether `id` is selected, or sits inside a group that is: grabbing a selected group by one of its children is
 *  grabbing the group. */
function isSelectedOrInsideSelected(id: string): boolean {
  if (selection.includes(id)) return true;
  if (!scene) return false;
  const parents = parentsOf(scene);
  for (let at = parents.get(id), seen = new Set<string>(); at !== undefined && !seen.has(at); at = parents.get(at)) {
    if (selection.includes(at)) return true;
    seen.add(at);
  }
  return false;
}

/** Stop showing a drag in progress and draw the real document again. */
function dropToolPreview(): void {
  if (toolPreview === null) return;
  toolPreview = null;
  if (previewScene !== null) {
    viewport?.updateDocument(previewScene);
    viewport?.render();
  }
  renderOverlayLayer();
}

/** Dim the ribbon buttons whose command cannot run now, with the reason as the tooltip: the registry's answer, the
 *  same one the menu item and the key give (11.31, 11.102). */
/** `Tool Creates` for the Pen (11.111): what the next path will be, said before the first click. */
let penCreates: PenCreates = "auto";

function currentPenPlan(): PenPlan {
  return scene ? penPlan(scene, selection, penCreates) : { kind: "shape" };
}

function showPenCreates(): void {
  const plan = currentPenPlan();
  ui.penCreatesNote.textContent = penPlanWords(plan);
  ui.penCreatesNote.classList.toggle("menu-refused", "refused" in plan);
}

function showRibbonStates(): void {
  showPenCreates();
  const context = commandContext();
  for (const button of document.querySelectorAll<HTMLButtonElement>(".creation-tools button[data-menu-item], .viewer-footer button[data-menu-item]")) {
    const command = commandById(button.dataset.menuItem ?? "");
    if (command === undefined) continue;
    button.dataset.title ??= button.title;
    const reason = commandUnavailable(command.id, context);
    button.setAttribute("aria-disabled", String(reason !== undefined));
    button.classList.toggle("menu-refused", reason !== undefined);
    button.title = reason === undefined ? (button.dataset.title ?? "") : `${button.dataset.title ?? ""}: ${reason}`;
  }
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
  // The middle button moves the view with any tool; the Hand tool does it with the main button; the Zoom tool zooms where
  // it is clicked, out with Alt.
  if (previewScene && (event.button === 1 || (event.button === 0 && activeTool === "hand"))) {
    startPan(event);
    return;
  }
  if (previewScene && event.button === 0 && activeTool === "zoom") {
    event.preventDefault();
    zoomView(event.altKey ? 1 / ZOOM_STEP : ZOOM_STEP, paneOffset(event.clientX, event.clientY));
    return;
  }
  if (!previewScene || event.button !== 0) return;
  // The next click puts a feather point on a mask's edge (11.108).
  if (featherArm !== undefined) {
    event.preventDefault();
    takeFeatherPoint(eventScenePoint(event));
    return;
  }
  // The pick whip (3.30): the next click chooses the matte source, whichever layer it is.
  if (matteWhip !== undefined) {
    event.preventDefault();
    takeMatteWhip(hitTestOverlay(previewScene, eventScenePoint(event)));
    return;
  }
  if (activeTool === "pen" && scene) {
    penPointerDown(event);
    return;
  }
  if (isPathTool(activeTool) && scene) {
    pathPointerDown(event);
    return;
  }
  const start = eventScenePoint(event);
  const additive = event.shiftKey || event.ctrlKey || event.metaKey;
  let tool: ToolDrag | undefined;
  let refusal: string | undefined;
  // Shift or Ctrl extends the selection, as with the Select tool; a tool does not start from it.
  if ((activeTool === "move" || activeTool === "rotate" || activeTool === "scale" || activeTool === "pivot") && scene && !additive) {
    // A tool acts on what is under the pointer when that is not selected yet (or a group above it is), as the pick
    // tool would select it.
    const hit = hitTestOverlay(previewScene, start);
    if (hit !== undefined && !isSelectedOrInsideSelected(hit)) setSelection([hit]);
    if (selection.length > 0) {
      const begun = beginToolDrag(activeTool, scene, selection, start, previewScene);
      if (isRefused(begun)) refusal = begun.refused;
      else tool = begun;
    }
  }
  overlayDrag = {
    pointerId: event.pointerId,
    start,
    startClient: { x: event.clientX, y: event.clientY },
    additive,
    ...(tool === undefined ? {} : { tool }),
    ...(refusal === undefined ? {} : { refusal }),
    moved: false,
  };
  // The clock would redraw the canvas under the drag on its next tick.
  if (tool !== undefined && playback !== undefined) pausePreview("moving an object");
  ui.overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onOverlayPointerMove(event: PointerEvent): void {
  if (panning !== undefined && panning.pointerId === event.pointerId) {
    movePan(event);
    return;
  }
  if (activeTool === "pen" && previewScene && scene) {
    penPointerMove(event);
    return;
  }
  if (isPathTool(activeTool) && previewScene && scene) {
    pathPointerMove(event);
    return;
  }
  if (!previewScene || !overlayDrag || overlayDrag.pointerId !== event.pointerId) return;
  const current = eventScenePoint(event);
  const cssDistance = Math.hypot(
    event.clientX - overlayDrag.startClient.x,
    event.clientY - overlayDrag.startClient.y,
  );
  overlayDrag.moved ||= cssDistance >= 3;
  if (!overlayDrag.moved) return;

  if (overlayDrag.refusal !== undefined) {
    // Dragging a refused tool says why, once, and does nothing else (not even a marquee).
    if (overlayDrag.told !== true) {
      overlayDrag.told = true;
      log(`${toolWords(activeTool)}: ${overlayDrag.refusal}`, "bad");
    }
    return;
  }
  if (overlayDrag.tool !== undefined) {
    // The object follows the pointer: the same changes the release will send, drawn on a copy of the document.
    toolPreview = previewDocument(previewScene, toolDragChanges(overlayDrag.tool, current, { shift: event.shiftKey }));
    viewport?.updateDocument(toolPreview);
    viewport?.render();
    renderOverlayLayer();
    return;
  }

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
  if (panning !== undefined && panning.pointerId === event.pointerId) {
    endPan(event);
    return;
  }
  if (activeTool === "pen") {
    penPointerUp(event);
    return;
  }
  if (isPathTool(activeTool)) {
    pathPointerUp(event, cancelled);
    return;
  }
  const active = previewScene ?? scene;
  if (!active || !overlayDrag || overlayDrag.pointerId !== event.pointerId) return;
  const drag = overlayDrag;
  overlayDrag = undefined;
  if (ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);

  if (drag.refusal !== undefined && drag.moved) {
    renderOverlayLayer();
    return;
  }
  if (drag.tool !== undefined && drag.moved) {
    // One drag is one batch of edits and one undo step; a drag that ends where it began sends nothing.
    const changes = cancelled ? [] : toolDragChanges(drag.tool, eventScenePoint(event), { shift: event.shiftKey });
    // The preview stays up until Rust has answered, so the object does not jump back for a moment; a refusal or a
    // failure puts the real document back.
    if (changes.length > 0) void runEdits(toolDragEdits(changes), toolDragLabel(drag.tool, changes), "viewport").finally(dropToolPreview);
    else dropToolPreview();
    return;
  }

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
    if (matteWhip !== undefined) {
      takeMatteWhip(id);
      return;
    }
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

// ---------------------------------------------------------------------------
// Effects & Presets and Effect Controls (11.69)
// ---------------------------------------------------------------------------

/// The one object effects are applied to and shown for: the single selection.
function effectTarget(document_: SceneDocument): { object?: SceneDocument["objects"][number]; blocker?: string } {
  if (selection.length === 0) return { blocker: "select a scene object first" };
  if (selection.length > 1) return { blocker: "select one object: effects are applied to one object at a time" };
  const object = document_.objects.find((candidate) => candidate.id === selection[0]);
  return object ? { object } : { blocker: "the selected object is not in this scene" };
}

function effectsOf(object: SceneDocument["objects"][number]): EffectStack {
  return (object as { effects?: EffectInstance[] }).effects ?? [];
}

function renderEffects(document_: SceneDocument): void {
  if (!effectSurface) {
    ui.effectsSummary.textContent = "The effect catalogue is unavailable. See Activity.";
    ui.effectsMount.replaceChildren();
    ui.effectControlsMount.replaceChildren();
    return;
  }
  const { object, blocker } = effectTarget(document_);
  const counts = availability(effectSurface);
  ui.effectsSummary.textContent = `${counts.available} of ${counts.total} effects render on the GrapiX engine · catalogue from EffectCraft`;
  ui.effectsMount.replaceChildren(
    renderNode(
      document,
      effectsBrowserPanel({
        surface: effectSurface,
        query: ui.effectsSearch.value,
        showUnported: ui.effectsShowUnported.checked,
        expanded: effectsOpen,
        ...(blocker === undefined ? {} : { targetBlocker: blocker }),
      }),
    ) as unknown as Node,
  );
  // A category header takes the keyboard: Enter or Space flips it, the arrows open and fold it.
  for (const header of ui.effectsMount.querySelectorAll<HTMLElement>('[role="group"][id^="effects-browser/"]')) header.tabIndex = 0;
  if (!object) {
    ui.effectControlsMount.replaceChildren();
    ui.effectControlsEmpty.hidden = false;
    ui.effectControlsEmpty.textContent = blocker === "select a scene object first" ? "Select a scene object to see its effects." : (blocker ?? "");
    return;
  }
  const effects = effectsOf(object);
  ui.effectControlsEmpty.hidden = effects.length > 0;
  ui.effectControlsEmpty.textContent = `No effects on ${object.name}. Apply one from Effects & Presets.`;
  const keyed = new Set(
    document_.timeline.channels.filter((channel) => channel.objectId === object.id && channel.keys.length > 0).map((channel) => channel.property),
  );
  ui.effectControlsMount.replaceChildren(
    renderNode(document, effectControlsPanel({ surface: effectSurface, objectName: object.name, effects, keyedChannels: keyed })) as unknown as Node,
  );
}

/// Send the object's next effect stack as one undoable command, or say why not.
async function commitEffects(objectId: string, next: EffectStack | { refused: string }, label: string): Promise<void> {
  if (isEffectRefused(next)) {
    log(`effects: ${next.refused}`, "bad");
    return;
  }
  await runEdits([{ edit: "setEffects", objectId, effects: [...next] }], label, "inspector");
}

function onEffectsBrowserClick(event: MouseEvent): void {
  // A click on a category's own header (the bar drawn above its list) opens or folds it.
  const header = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="group"][id^="effects-browser/"]') : null;
  if (header && event.target === header) {
    setEffectsOpen(toggleGroup(effectsOpen, header.id));
    ui.effectsMount.querySelector<HTMLElement>(`[id="${header.id}"]`)?.focus();
    return;
  }
  if (!scene || !effectSurface) return;
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action][data-for]") : null;
  if (!button || button.disabled) return;
  const { object, blocker } = effectTarget(scene);
  if (!object) {
    log(`effects: ${blocker}`, "bad");
    return;
  }
  const nodeId = button.dataset.for ?? "";
  if (button.dataset.action === "apply") {
    const listing = effectSurface.effects.find((candidate) => `effect/${candidate.id}` === nodeId);
    if (listing) void commitEffects(object.id, addEffect(effectsOf(object), listing), `Applied ${listing.name} to ${object.name}`);
  } else if (button.dataset.action === "applyPreset") {
    const preset = effectSurface.presets.find((candidate) => `preset/${candidate.id}` === nodeId);
    if (preset) void commitEffects(object.id, addPreset(effectsOf(object), preset), `Applied preset ${preset.name} to ${object.name}`);
  }
}

function onEffectsHeaderKey(event: KeyboardEvent): void {
  const header = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="group"][id^="effects-browser/"]') : null;
  if (!header || event.target !== header) return;
  const open = header.getAttribute("aria-expanded") === "true";
  const flip =
    event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open);
  if (!flip) return;
  event.preventDefault();
  setEffectsOpen(toggleGroup(effectsOpen, header.id));
  ui.effectsMount.querySelector<HTMLElement>(`[id="${header.id}"]`)?.focus();
}

/// A double-click on an effect or preset row applies it, as in After Effects.
function onEffectsBrowserDoubleClick(event: MouseEvent): void {
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>('li[role="listitem"]') : null;
  row?.querySelector<HTMLButtonElement>("button[data-action]:not([disabled])")?.click();
}

function onEffectControlsClick(event: MouseEvent): void {
  if (!scene || !effectSurface) return;
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action][data-for]") : null;
  if (!button || button.disabled) return;
  const { object } = effectTarget(scene);
  const parsed = parseControlId(button.dataset.for ?? "");
  if (!object || !parsed) return;
  const stack = effectsOf(object);
  const instance = stack.find((candidate) => candidate.effectId === parsed.effectId);
  if (!instance) return;
  const name = listingFor(effectSurface, instance)?.name ?? instance.effect;
  const action = button.dataset.action ?? "";
  if (parsed.path === undefined) {
    if (action === "toggle") void commitEffects(object.id, setEnabled(stack, instance.effectId, !instance.enabled), `${instance.enabled ? "Disabled" : "Enabled"} ${name}`);
    else if (action === "moveUp") void commitEffects(object.id, moveEffect(stack, instance.effectId, -1), `Moved ${name} up`);
    else if (action === "moveDown") void commitEffects(object.id, moveEffect(stack, instance.effectId, 1), `Moved ${name} down`);
    else if (action === "duplicate") void commitEffects(object.id, duplicateEffect(stack, instance.effectId), `Duplicated ${name}`);
    else if (action === "remove") void commitEffects(object.id, removeEffect(stack, instance.effectId), `Removed ${name}`);
    return;
  }
  const parameter = listingFor(effectSurface, instance)?.parameters.find((candidate) => candidate.path === parsed.path);
  if (!parameter) return;
  if (action.startsWith("choose:")) {
    void commitEffects(object.id, setParameter(stack, instance.effectId, parameter, Number(action.slice("choose:".length))), `Set ${name} ${parameterLabel(parameter.path)}`);
  } else if (action === "key") {
    const value = parameterValue(instance, parameter);
    // A switch or a choice holds between keys; a number eases.
    const easing = parameter.kind === "number" ? DEFAULT_EASING() : animationSurface?.easings.find((candidate) => candidate === "hold");
    if (value === undefined || !easing) {
      log("effects: this parameter cannot be keyed here", "bad");
      return;
    }
    void runGesture(
      [{ edit: "createKeyframe", objectId: object.id, property: effectChannel(instance.effectId, parameter.path), keyframe: keyframeForValue(value, currentFrame, easing) }],
      `Added ${name} ${parameterLabel(parameter.path)} key at frame ${currentFrame}`,
    );
  }
}

function onEffectControlsChange(event: Event): void {
  if (!scene || !effectSurface) return;
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const parsed = parseControlId(input?.dataset.for ?? "");
  const { object } = effectTarget(scene);
  if (!input || !object || parsed?.path === undefined) return;
  const stack = effectsOf(object);
  const instance = stack.find((candidate) => candidate.effectId === parsed.effectId);
  const parameter = instance && listingFor(effectSurface, instance)?.parameters.find((candidate) => candidate.path === parsed.path);
  if (!instance || !parameter) return;
  const name = listingFor(effectSurface, instance)?.name ?? instance.effect;
  const next = setParameter(stack, instance.effectId, parameter, input.type === "checkbox" ? input.checked : input.value);
  // A refused value leaves the field showing what the object still has.
  if (isEffectRefused(next)) renderEffects(scene);
  void commitEffects(object.id, next, `Set ${name} ${parameterLabel(parameter.path)}`);
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
      ? "held in the import cache until this scene is saved into a project"
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
    log(`${reasons.length} object(s) not drawn in the Draft view (see the Engine preview)`, "bad");
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
  // A panel on a tab that is not showing is brought forward first.
  showTab(id);
  panel.classList.remove("panel-section-collapsed");
  panel.querySelector<HTMLButtonElement>(".panel-disclosure")?.setAttribute("aria-expanded", "true");
  panel.scrollIntoView({ block: "nearest" });
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
}

/** Grey the items of an opening menu that cannot run now, with the reason as the tooltip: the registry's answer, the
 *  same one a key press or an agent gets (11.31). */
function showMenuStates(menu: HTMLElement): void {
  const context = commandContext();
  for (const button of menu.querySelectorAll<HTMLButtonElement>("button[data-menu-item]")) {
    const command = commandById(button.dataset.menuItem ?? "");
    if (command === undefined || actionOf(command) === "unbuilt") continue;
    const reason = commandUnavailable(command.id, context);
    button.setAttribute("aria-disabled", String(reason !== undefined));
    button.classList.toggle("menu-refused", reason !== undefined);
    button.title = reason ?? menuTitle(command);
  }
}

/** Workspace controls only invoke existing command and view-state paths. */
function wireWorkspaceChrome(): void {
  drawAppMenus();
  for (const button of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    button.prepend(iconImage(button.dataset.icon!));
  }
  for (const [id, icon] of [["open-scene", "folder-open"], ["save-scene", "floppy-disk"],
    ["undo", "arrow-counter-clockwise"], ["redo", "arrow-clockwise"]]) {
    document.getElementById(id!)?.prepend(iconImage(icon!));
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    // A menu item asks the registry first, as a key does (11.31): the same reason in the same words.
    const itemId = target?.closest<HTMLElement>("[data-menu-item]")?.dataset.menuItem;
    const refusal = itemId !== undefined && commandById(itemId) !== undefined ? commandUnavailable(itemId, commandContext()) : undefined;
    if (itemId !== undefined && refusal !== undefined) {
      log(refusalLine(itemId, refusal), "bad");
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => { menu.open = false; });
      return;
    }
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
    const native = target?.closest<HTMLElement>("[data-native]");
    if (native?.dataset.native) runNativeMenuAction(native);
    if (invoke || creation || panel || native) {
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => { menu.open = false; });
    } else if (!target?.closest(".app-menu")) {
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => { menu.open = false; });
    }
  });
  document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll<HTMLDetailsElement>(".app-menu").forEach((other) => {
        if (other !== menu) other.open = false;
      });
      showMenuStates(menu);
    });
  });
  document.getElementById("tool-selection")?.addEventListener("click", () => ui.overlay.focus());
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.addEventListener("click", () => {
      // The registry decides: with no scene open a tool cannot be chosen, and the document handler says why.
      const id = button.dataset.menuItem;
      if (id !== undefined && commandUnavailable(id, commandContext()) !== undefined) return;
      setActiveTool(button.dataset.tool as PageTool);
    });
  }
  showRibbonStates();
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
  const defaults = new Set(["effects", "fonts", "text-styles", "materials", "assets", "bindings", "control-contract", "take-page", "publish"]);
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
  }
}

/** The dockable panels the Display menu lists, from the page itself so the menu and the dock agree. */
function dockPanelEntries(): PanelEntry[] {
  const entries: PanelEntry[] = [];
  for (const panel of document.querySelectorAll<HTMLElement>(".panel[data-panel]")) {
    const heading = panel.querySelector<HTMLElement>(":scope > h2, :scope > .panel-title-row h2");
    if (!heading) continue;
    entries.push({ id: panel.dataset.panel!, label: heading.childNodes[0]?.textContent?.trim() || panel.dataset.panel! });
  }
  entries.push({ id: "viewport", label: "Composition" }, { id: "timeline", label: "Timeline" });
  return entries;
}

/** Draw the menu bar from the model (11.32): Ross XPression's eight menus, in its order. */
function drawAppMenus(): void {
  const bar = document.querySelector<HTMLElement>(".app-menubar");
  if (!bar) return;
  renderAppMenus(bar, APP_MENUS, {
    panels: dockPanelEntries(),
    loadRecent: async () =>
      (await shell().invoke<ListedRecent[]>("cmd_recent_projects")).map((r) => ({
        gpx: r.gpx,
        label: r.name,
        detail: r.gpx,
        missing: !r.exists,
      })),
    openRecent: (gpx) => void openRecentProject(gpx),
  });
  // The Object Toolbar is shown until the menu hides it.
  bar.querySelector('[data-native="toggle-object-toolbar"]')?.setAttribute("aria-checked", "true");
}

/** File > Open Recent: open it as File > Open does, then bring the page up to date. */
async function openRecentProject(gpx: string): Promise<void> {
  try {
    const opened = await shell().invoke<OpenedProject>("cmd_open_project", { path: gpx });
    log(`Opened project ${opened.name} (${opened.gpx})`, "good");
    if (afterSwitch(opened) === "continue") await loadProjects(opened.name);
  } catch (error) {
    log(`open project refused: ${describe(error)}`, "bad");
  }
}

/** The menu's own actions, which are not a click on an existing control. */
function runNativeMenuAction(item: HTMLElement): void {
  runNativeAction(item.dataset.native ?? "", item);
}

/** A native action by name. `item` is the menu item that asked, when one did. */
function runNativeAction(native: string, item?: HTMLElement): void {
  switch (native) {
    case "view-fit":
      setCamera(FIT);
      break;
    case "view-zoom-in":
      zoomView(ZOOM_STEP);
      break;
    case "view-zoom-out":
      zoomView(1 / ZOOM_STEP);
      break;
    case "view-zoom-100": {
      const { pane, picture } = viewSizes();
      setCamera(atPercent(camera, 100, fitScale(), pane, picture));
      break;
    }
    case "easy-ease":
      easeKeys("both");
      break;
    case "easy-ease-in":
      easeKeys("in");
      break;
    case "easy-ease-out":
      easeKeys("out");
      break;
    case "delete-keys":
      deleteKeys();
      break;
    case "copy-keys":
      copyKeys();
      break;
    case "paste-keys":
      pasteKeys();
      break;
    case "open-settings":
      void openSettings();
      break;
    case "save":
      void saveInPlace();
      break;
    case "save-next-version":
      void saveNextVersion();
      break;
    case "new-project":
      void createProject();
      break;
    case "open-project":
      void openProjectDialog();
      break;
    case "exit":
      // The shell refuses by name while a scene has unsaved work; nothing is lost by choosing Exit.
      void shell()
        .invoke("cmd_exit")
        .catch((error: unknown) => log(`exit refused: ${describe(error)}`, "bad"));
      break;
    case "toggle-object-toolbar": {
      const toolbar = document.querySelector<HTMLElement>(".creation-tools");
      if (!toolbar) break;
      toolbar.hidden = !toolbar.hidden;
      item?.setAttribute("aria-checked", String(!toolbar.hidden));
      break;
    }
    case "export-diagnostics-all":
    case "export-diagnostics-editor": {
      // Help > Export diagnostic bundle (2.14). The Editor has no live telemetry (user, 18 Nov 2026),
      // so beside Help Topics Help carries only the diagnostic export.
      const allModules = native === "export-diagnostics-all";
      void shell().invoke<void>("cmd_export_diagnostics", { allModules }).then(
        () => log(allModules ? "Exporting a diagnostic bundle for every module" : "Exporting the Editor's diagnostic bundle"),
        (error: unknown) => log(`Diagnostic export failed: ${describe(error)}`, "bad"),
      );
      break;
    }
    case "focus-activity": {
      const title = document.querySelector<HTMLElement>(".log-title");
      title?.scrollIntoView({ block: "nearest" });
      const list = document.getElementById("log");
      if (list) {
        list.tabIndex = -1;
        list.focus({ preventScroll: true });
      }
      break;
    }
    default: {
      // Edit > Line up and spread (11.83): `arrange-<command>`.
      const command = native.replace(/^arrange-/, "");
      if (isArrangeCommand(command)) void arrange(command);
    }
  }
}

/** Line up or spread the selected items: one batch of position edits, so one undo step. A refusal is shown
 *  as words in Activity and nothing is sent. */
async function arrange(command: ArrangeCommand): Promise<void> {
  const document_ = activeSession(workspace)?.view.document;
  if (document_ === undefined) {
    log(`${arrangeWords(command)}: no scene is open`, "bad");
    return;
  }
  const outcome = arrangeEdits(document_, selection, command);
  if (isRefused(outcome)) {
    log(`${arrangeWords(command)}: ${outcome.refused}`, "bad");
    return;
  }
  await runEdits(outcome, arrangeLabel(command, outcome.length), "viewport");
}

function setProjectOptions(next: readonly string[], preferred?: string): void {
  projects = [...next];
  currentProject =
    (preferred && projects.includes(preferred) ? preferred : undefined) ??
    (currentProject && projects.includes(currentProject) ? currentProject : undefined) ??
    projects[0];
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

/** File > Open project: the Start dialog's home view; the page is brought up to date when one opens. */
async function openProjectDialog(): Promise<void> {
  const opened = await showStart({ required: false, view: "home" });
  if (opened) await loadProjects(opened.name);
}

async function createProject(): Promise<void> {
  const opened = await showStart({ required: false, view: "new" });
  // With no scene open the page is not reloaded, so its project list is brought up to date here.
  if (opened) await loadProjects(opened.name);
}

// ---------------------------------------------------------------------------------------------
// Start (11.43): a project is created at a path the user chooses, or opened from its .gpx, before
// any work starts, as in XPression, Viz and After Effects. The shell decides what is allowed (a
// name, a folder that exists, unsaved work in the way) and its refusal is shown as it is.

let openProject: OpenedProject | undefined;

function applyOpenedProject(opened: OpenedProject | undefined): void {
  openProject = opened;
  ui.projectSummary.textContent = projectSummary(opened);
  ui.projectClose.disabled = opened === undefined;
  ui.projectSaveAs.disabled = opened === undefined;
}

/** After a switch the scenes of the old project are closed in the shell; start the page afresh. */
function afterSwitch(opened: OpenedProject): "reload" | "continue" {
  applyOpenedProject(opened);
  if (opened.closedSessions.length === 0) return "continue";
  window.location.reload();
  return "reload";
}

async function recentAndDefaults(): Promise<{ recent: ListedRecent[]; defaults: DefaultProject[] }> {
  const [recent, defaults] = await Promise.all([
    shell().invoke<ListedRecent[]>("cmd_recent_projects"),
    shell().invoke<DefaultProject[]>("cmd_default_location_projects").catch(() => [] as DefaultProject[]),
  ]);
  return { recent, defaults };
}

async function renderStartList(): Promise<void> {
  ui.startList.replaceChildren();
  let rows: StartRow[];
  try {
    const { recent, defaults } = await recentAndDefaults();
    rows = startRows(recent, defaults, Date.now());
  } catch (error) {
    ui.startError.textContent = describe(error);
    rows = [];
  }
  ui.startEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const item = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "start-row";
    open.disabled = row.open === undefined;
    const title = document.createElement("span");
    title.className = "start-row-title";
    const name = document.createElement("span");
    name.textContent = row.title;
    const when = document.createElement("span");
    when.className = "start-row-when";
    when.textContent = row.missing ? "missing" : row.when;
    title.append(name, when);
    const path = document.createElement("span");
    path.className = "start-row-path";
    path.textContent = row.detail;
    open.append(title, path);
    if (row.missing) {
      const note = document.createElement("span");
      note.className = "start-row-note";
      note.textContent = "Its .gpx is no longer there. Forget it, or restore the folder.";
      open.append(note);
    }
    const target = row.open;
    if (target !== undefined) {
      open.addEventListener("click", () => {
        void openFromStart(
          target.kind === "gpx"
            ? () => shell().invoke<OpenedProject>("cmd_open_project", { path: target.gpx })
            : () => shell().invoke<OpenedProject>("cmd_open_project_folder", { folder: target.folder }),
        );
      });
    }
    item.append(open);
    if (row.forgettable) {
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "start-forget";
      forget.textContent = "Forget";
      forget.title = "Take it off the list. The project itself is not touched.";
      forget.addEventListener("click", () => {
        void shell()
          .invoke("cmd_forget_recent_project", { gpx: row.detail })
          .then(renderStartList, (error) => { ui.startError.textContent = describe(error); });
      });
      item.append(forget);
    }
    ui.startList.append(item);
  }
}

function setStartView(view: "home" | "new"): void {
  ui.startHome.hidden = view !== "home";
  ui.startForm.hidden = view !== "new";
  ui.startError.textContent = "";
  ui.startNewError.textContent = "";
  if (view === "new") {
    ui.startName.focus();
    updateStartPreview();
  } else {
    void renderStartList();
  }
}

/** The form is New project, or Save project as (the same name and folder, for a copy of the open project). */
type StartMode = "new" | "save-as";
let startMode: StartMode = "new";

function applyStartMode(mode: StartMode): void {
  startMode = mode;
  ui.startFormTitle.textContent = mode === "save-as" ? "Save project as" : "New project";
  // A copy keeps the original's depth and space; they are not chosen again.
  ui.startDepthField.hidden = mode === "save-as";
  ui.startCreate.textContent = mode === "save-as" ? "Save a copy" : "Create";
  ui.startBack.textContent = mode === "save-as" ? "Cancel" : "Back";
}

function updateStartPreview(): void {
  const parent = ui.startParent.value || undefined;
  const target = previewGpx(parent, ui.startName.value);
  if (target === undefined) {
    ui.startPreview.textContent = "Choose a name and a folder.";
  } else if (startMode === "save-as" && openProject !== undefined) {
    ui.startPreview.textContent = `Will be saved as ${target} (${renderingLabel(openProject)}, as ${openProject.name}). ${openProject.name} stays as it was last saved.`;
  } else {
    ui.startPreview.textContent = `Will be saved as ${target}`;
  }
  ui.startCreate.disabled = !canCreate(parent, ui.startName.value);
}

let startSettled: ((opened: OpenedProject | undefined) => void) | undefined;

/**
 * Run an open or create call from the Start dialog; on success the dialog closes. A copy
 * (`reload`) starts the page afresh, whether or not scenes were open: the project it shows changed.
 */
async function openFromStart(
  call: () => Promise<OpenedProject>,
  options: { verb?: string; reload?: boolean } = {},
): Promise<void> {
  ui.startError.textContent = "";
  ui.startNewError.textContent = "";
  try {
    const opened = await call();
    log(`${options.verb ?? "Opened project"} ${opened.name} (${opened.gpx})`, "good");
    ui.startDialog.close();
    if (options.reload) {
      applyOpenedProject(opened);
      window.location.reload();
      return;
    }
    if (afterSwitch(opened) === "continue") startSettled?.(opened);
  } catch (error) {
    const text = describe(error);
    ui.startError.textContent = text;
    ui.startNewError.textContent = text;
    log(text, "bad");
  }
}

/**
 * Show Start. `required` is the first run: it cannot be dismissed until a project is open. Resolves
 * with the project that was opened or created, or `undefined` if the dialog was dismissed.
 */
function showStart(options: {
  required: boolean;
  view?: "home" | "new";
  mode?: StartMode;
}): Promise<OpenedProject | undefined> {
  ui.startDismiss.hidden = options.required;
  applyStartMode(options.mode ?? "new");
  if (options.mode === "save-as" && openProject !== undefined) {
    // Beside the original, with a name that is not it.
    ui.startParent.value = openProject.root;
    ui.startName.value = suggestCopyName(openProject.name);
  } else {
    ui.startParent.value = "";
    ui.startName.value = "";
  }
  setStartView(options.view ?? "home");
  return new Promise((resolve) => {
    startSettled = (opened) => {
      startSettled = undefined;
      resolve(opened);
    };
    ui.startDialog.returnValue = "";
    const onClose = (): void => {
      ui.startDialog.removeEventListener("close", onClose);
      // Closing without a project open (dismissed) settles with nothing.
      startSettled?.(undefined);
    };
    ui.startDialog.addEventListener("close", onClose);
    if (!ui.startDialog.open) ui.startDialog.showModal();
  });
}

// ---------------------------------------------------------------------------------------------
// Settings (11.81, over the settings service 2.28): one window for the user's and this computer's
// settings. Each change is sent as it is made; the shell checks it and a refusal is shown as written.

interface SettingsSnapshot {
  user: UserSettings;
  machine: MachineSettings;
  revision: number;
}

let settingsSnapshot: SettingsSnapshot | undefined;

/** The Pen and path settings in force (11.116): read from the settings service, the spec's defaults until then. */
const editorPen = { angle: 15, pick: PICK_RADIUS, doubleClickEnds: true, snap: true, fit: 1 };

function applyPenSettings(user: UserSettings | undefined): void {
  if (user === undefined) return;
  editorPen.angle = user.penAngleStep;
  editorPen.pick = user.penPickRadius;
  editorPen.doubleClickEnds = user.penDoubleClickEnds;
  editorPen.snap = user.penSnap;
  editorPen.fit = user.penFitTolerance;
}

async function readSettings(): Promise<SettingsSnapshot | undefined> {
  try {
    settingsSnapshot = await shell().invoke<SettingsSnapshot>("cmd_settings_get");
    applyPenSettings(settingsSnapshot.user);
  } catch (error) {
    log(`settings unavailable: ${describe(error)}`, "bad");
  }
  return settingsSnapshot;
}

async function setSetting(scope: SettingsScope, key: string, value: string | number | boolean): Promise<void> {
  settingsSnapshot = await shell().invoke<SettingsSnapshot>("cmd_settings_set", { scope, key, value });
  applyPenSettings(settingsSnapshot.user);
}

/** The folder the last file window was in, so the next one opens there (the `lastUsedFolder` setting). */
async function lastFolder(): Promise<string | undefined> {
  const settings = settingsSnapshot ?? (await readSettings());
  const folder = settings?.user.lastUsedFolder;
  return folder ? folder : undefined;
}

/** Remember where a file window was left; a failure to remember is not worth stopping for. */
async function rememberFolder(folder: string): Promise<void> {
  if (folder === "" || folder === settingsSnapshot?.user.lastUsedFolder) return;
  try {
    await setSetting("user", "lastUsedFolder", folder);
  } catch {
    // The setting is a convenience.
  }
}

function settingControl(scope: SettingsScope, key: string, spec: FieldSpec, current: string | number | boolean): HTMLElement {
  const id = `setting-${scope}-${key}`;
  let control: HTMLInputElement | HTMLSelectElement;
  if (spec.kind === "choice") {
    const select = document.createElement("select");
    for (const [value, words] of spec.options ?? []) select.append(new Option(words, value));
    select.value = String(current);
    control = select;
  } else {
    const input = document.createElement("input");
    if (spec.kind === "toggle") {
      input.type = "checkbox";
      input.checked = current === true;
    } else {
      input.type = "text";
      input.value = String(current);
      if (spec.kind === "number") input.inputMode = "numeric";
    }
    control = input;
  }
  control.id = id;
  control.addEventListener("change", () => void commitSetting(scope, key, spec, control));
  return control;
}

async function commitSetting(scope: SettingsScope, key: string, spec: FieldSpec, control: HTMLInputElement | HTMLSelectElement): Promise<void> {
  ui.settingsError.textContent = "";
  const raw = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value;
  const parsed = toValue(spec, raw);
  if (!parsed.ok) {
    ui.settingsError.textContent = `${spec.label}: ${parsed.why}`;
    await renderSettings();
    return;
  }
  try {
    await setSetting(scope, key, parsed.value);
    log(`Setting ${spec.label} saved`, "good");
  } catch (error) {
    ui.settingsError.textContent = `${spec.label}: ${describe(error)}`;
    log(`setting refused: ${describe(error)}`, "bad");
    await renderSettings();
  }
}

type SettingValues = Record<string, string | number | boolean>;

async function renderSettings(): Promise<void> {
  const settings = await readSettings();
  ui.settingsBody.replaceChildren();
  if (!settings) {
    ui.settingsError.textContent = "Settings could not be read. The reason is in the Activity log.";
    return;
  }
  const sections: [SettingsScope, string, string, Record<string, FieldSpec>, SettingValues][] = [
    ["user", "Yours", "Follows you to another computer.", USER_FIELDS, settings.user as unknown as SettingValues],
    ["machine", "This computer", "Stays on this computer.", MACHINE_FIELDS, settings.machine as unknown as SettingValues],
  ];
  for (const [scope, title, note, fields, values] of sections) {
    const section = document.createElement("section");
    section.className = "settings-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const sub = document.createElement("span");
    sub.className = "settings-note";
    sub.textContent = note;
    heading.append(sub);
    section.append(heading);
    for (const [key, spec] of Object.entries(fields)) {
      const row = document.createElement("div");
      row.className = "settings-row";
      const label = document.createElement("label");
      label.htmlFor = `setting-${scope}-${key}`;
      label.textContent = spec.label;
      const control = settingControl(scope, key, spec, values[key] ?? "");
      const help = document.createElement("p");
      help.className = "settings-help";
      help.textContent = `${spec.help} ${usageLine(spec)}`;
      row.append(label, control, help);
      section.append(row);
    }
    ui.settingsBody.append(section);
  }
}

async function openSettings(): Promise<void> {
  ui.settingsError.textContent = "";
  await renderSettings();
  if (!ui.settingsDialog.open) ui.settingsDialog.showModal();
}

async function resetSettings(scope: SettingsScope): Promise<void> {
  try {
    settingsSnapshot = await shell().invoke<SettingsSnapshot>("cmd_settings_reset", { scope, key: null });
    log(scope === "user" ? "Your settings were put back to their defaults" : "This computer's settings were put back to their defaults", "good");
    await renderSettings();
  } catch (error) {
    ui.settingsError.textContent = describe(error);
  }
}

/** What the Editor does at start (the `startup` setting): the last project, if it is still there. */
async function reopenLastProject(): Promise<OpenedProject | undefined> {
  const settings = await readSettings();
  if (settings?.user.startup !== "reopenLast") return undefined;
  try {
    const recent = await shell().invoke<ListedRecent[]>("cmd_recent_projects");
    const last = recent.find((r) => r.exists);
    if (!last) return undefined;
    const opened = await shell().invoke<OpenedProject>("cmd_open_project", { path: last.gpx });
    log(`Opened the last project, ${opened.name}, as your setting says`, "good");
    return opened;
  } catch (error) {
    log(`the last project could not be opened: ${describe(error)}`, "bad");
    return undefined;
  }
}

async function chooseSaveFolder(): Promise<void> {
  const defaultPath = await lastFolder();
  const picked = await openFileDialog({
    directory: true,
    multiple: false,
    title: "Choose where to save the project",
    ...(defaultPath !== undefined ? { defaultPath } : {}),
  });
  if (typeof picked === "string") {
    ui.startParent.value = picked;
    updateStartPreview();
    void rememberFolder(picked);
  }
}

async function chooseProjectFile(): Promise<void> {
  const defaultPath = await lastFolder();
  const picked = await openFileDialog({
    multiple: false,
    title: "Open project",
    ...(defaultPath !== undefined ? { defaultPath } : {}),
    filters: [{ name: "GrapiX project", extensions: ["gpx"] }],
  });
  if (typeof picked === "string") {
    await openFromStart(() => shell().invoke<OpenedProject>("cmd_open_project", { path: picked }));
  }
}

/**
 * File > Save project as: a copy of the open project under a new name and folder, carrying the
 * scenes' unsaved work; the original stays as it was last saved. The shell refuses by name (a name
 * that is taken, a folder inside the project, a scene with unsaved work stored nowhere in it).
 */
async function saveProjectAs(): Promise<void> {
  if (openProject === undefined) {
    log("save project as refused: no project is open", "bad");
    return;
  }
  await showStart({ required: false, view: "new", mode: "save-as" });
}

async function closeProject(): Promise<void> {
  try {
    await shell().invoke("cmd_close_project");
  } catch (error) {
    log(`close project refused: ${describe(error)}`, "bad");
    return;
  }
  applyOpenedProject(undefined);
  window.location.reload();
}

function wireStart(): void {
  ui.startNew.addEventListener("click", () => setStartView("new"));
  ui.startOpen.addEventListener("click", () => void chooseProjectFile());
  ui.startBack.addEventListener("click", () => {
    // New project goes back to Start; Save as has no Start to go back to, so it cancels.
    if (startMode === "save-as") ui.startDialog.close();
    else setStartView("home");
  });
  ui.startChoose.addEventListener("click", () => void chooseSaveFolder());
  ui.startName.addEventListener("input", updateStartPreview);
  ui.startDismiss.addEventListener("click", () => ui.startDialog.close());
  ui.startForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const parent = ui.startParent.value;
    const name = ui.startName.value.trim();
    if (startMode === "save-as") {
      void openFromStart(() => shell().invoke<OpenedProject>("cmd_save_project_as", { parent, name }), {
        verb: "Saved project as",
        reload: true,
      });
      return;
    }
    void openFromStart(() =>
      shell().invoke<OpenedProject>("cmd_new_project", { parent, name, colorDepth: ui.startDepth.value }),
    );
  });
  // Until a project is open, Escape does not dismiss Start: there is nothing to go back to.
  ui.startDialog.addEventListener("cancel", (event) => {
    if (openProject === undefined) event.preventDefault();
  });
  ui.projectClose.addEventListener("click", () => void closeProject());
  ui.settingsResetUser.addEventListener("click", () => void resetSettings("user"));
  ui.historyOpen.addEventListener("click", openHistory);
  ui.historyClose.addEventListener("click", () => ui.historyDialog.close());
  ui.settingsResetMachine.addEventListener("click", () => void resetSettings("machine"));
  ui.projectSaveAs.addEventListener("click", () => void saveProjectAs());
}

let managerCreateKind: "container" | "graphic" = "container";
/** The contract's rate for a new graphic (`new_scene`): 50/1. */
const DEFAULT_RATE: RationalRate = { num: 50, den: 1 };

function showManagerCreate(kind: "container" | "graphic"): void {
  managerCreateKind = kind;
  ui.managerForm.reset();
  ui.managerError.textContent = "";
  document.getElementById("manager-create-title")!.textContent = kind === "container" ? "New project" : "New scene";
  document.getElementById("manager-create-name-label")!.textContent = kind === "container" ? "Project name" : "Scene name";
  document.getElementById("manager-create-description")!.textContent = kind === "container"
    ? "Keep many scenes together. Each scene has its own layers and timeline."
    : currentProject === undefined ? "Create an independent scene. Save it into a project when ready."
      : `Add an independent scene to ${currentProject}.`;
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
      log(`Created project ${name}`, "good");
    } else {
      const id = freshGraphicId(name);
      if (currentProject === undefined) {
        const opened = await runCommand({ command: "openScene", source: { source: "new", id, name } }, `Created scene ${name}`);
        if (!opened) throw new Error("The scene could not be opened. See Activity for the refusal.");
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
        const opened = await runCommand({ command: "openScene", source: { source: "project", project, sceneId: id } }, `Created scene ${name}`);
        if (!opened) throw new Error("The scene was saved but could not be opened. See Activity for the refusal.");
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

/** File > Save and Ctrl+S (11.30): write the open scene where it already lives, and never make a version.
 *  A scene stored in a project updates that stored copy; one saved to a file rewrites the file; a scene
 *  saved nowhere is saved for the first time (into the open project, or to a file the author names). A
 *  refusal is shown by name and the unsaved mark stays. */
async function saveInPlace(): Promise<void> {
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("Save: no scene is open", "bad");
    return;
  }
  const origin = session.view.origin;
  switch (saveRoute(saveState(session.view.origin !== undefined))) {
    case "stored": {
      if (origin === undefined || !(await applyPendingIdentity())) return;
      const saved = await runCommand(
        { command: "saveScene", session: session.key, to: { to: "origin" } },
        { label: `Saved ${origin.project}/${origin.sceneId}`, refusal: "Save" },
      );
      if (saved) await refreshCatalogAfterSave();
      return;
    }
    case "project":
      await saveProjectScene();
      return;
    case "file":
    case "dialog":
      await saveScene();
      return;
  }
}

function saveState(stored: boolean): SaveState {
  return { stored, file: Boolean(scenePath), project: currentProject !== undefined };
}

/** File > Save as next version and Ctrl+Shift+S (11.30): the next numbered copy of the scene, beside the
 *  current one. The version it came from is not written to; the session continues in the new one. A scene
 *  saved nowhere has no version to number from, so this is its first save. */
async function saveNextVersion(): Promise<void> {
  const session = activeSession(workspace);
  if (!scene || !session) {
    log("Save as next version: no scene is open", "bad");
    return;
  }
  if (isFirstSave(saveState(session.view.origin !== undefined))) {
    log("This scene has not been saved yet, so this is its first save, not a new version");
    await saveInPlace();
    return;
  }
  if (!(await applyPendingIdentity())) return;
  const saved = await runCommand(
    { command: "saveScene", session: session.key, to: { to: "nextVersion" } },
    { label: versionLabel, refusal: "Save as next version" },
  );
  if (saved) await refreshCatalogAfterSave();
}

async function refreshCatalogAfterSave(): Promise<void> {
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
  const proposedId = window.prompt("Duplicate scene id", `${sceneId}-copy`);
  if (proposedId === null) return;
  const newId = proposedId.trim();
  if (!newId) {
    log("duplicate refused: scene id is empty", "bad");
    return;
  }
  const listed = projectCatalog?.project === project
    ? projectCatalog.scenes.find((candidate) => candidate.sceneId === sceneId)
    : undefined;
  const proposedName = window.prompt("Duplicate scene name", `${listed?.name ?? sceneId} Copy`);
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
    log(
      `published ${takeId} revision ${revision} hash ${plain(result.contentHash)} (${publishRoute(result)})`,
      "good",
    );
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
  if (!button) {
    // In the list view a click on a row opens that scene, as selecting a scene does in XPression.
    const row = target.closest<HTMLElement>('[role="listitem"][id^="scene/"]');
    if (row && sceneView === "list") {
      sceneDeleteArm.disarm();
      void openProjectScene(row.id.slice("scene/".length));
    }
    return;
  }
  runSceneAction(button);
}

/// The list view's keyboard (11.72): arrows walk the rows, Enter opens, Delete (twice)
/// deletes, the menu key or Shift+F10 opens the row's commands.
function onSceneListKey(event: KeyboardEvent): void {
  if (sceneView !== "list") return;
  const row = (event.target as Element | null)?.closest<HTMLElement>('[role="listitem"][id^="scene/"]');
  if (!row || event.target !== row) return;
  const next = moveRow(sceneRows().map((item) => item.id), row.id, event.key);
  if (next !== undefined) {
    event.preventDefault();
    sceneDeleteArm.disarm();
    document.getElementById(next)?.focus();
    return;
  }
  const command = rowCommand(event.key, event.shiftKey);
  if (command === undefined) {
    sceneDeleteArm.disarm();
    return;
  }
  event.preventDefault();
  const sceneId = row.id.slice("scene/".length);
  if (command === "open") {
    sceneDeleteArm.disarm();
    void openProjectScene(sceneId);
  } else if (command === "menu") {
    const box = row.getBoundingClientRect();
    openSceneMenu(row, box.left + 24, box.bottom);
  } else if (sceneDeleteArm.press(row.id, Date.now())) {
    const button = row.querySelector<HTMLElement>(':scope > button[data-action="delete"]');
    if (button) runSceneAction(button);
  } else {
    log(`press Delete again within 3 seconds to delete ${sceneId}`);
    row.classList.add("delete-armed");
  }
}

function runSceneAction(button: HTMLElement): void {
  sceneDeleteArm.disarm();
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
    ui.publishResult.textContent = `${takeId} revision ${revision} · hash ${contentHash} · ${publishRoute(result)}`;
    ui.publishResult.hidden = false;
    log(`published ${takeId} revision ${revision} hash ${contentHash} (${publishRoute(result)})`, "good");
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
  // 2.13: from here, an uncaught error, a rejection nobody handled and a
  // console.error are on record in the shell's log, each with an id.
  installShellCapture();
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
  ui.projectRefresh.addEventListener("click", () => void loadProjects(currentProject));
  ui.projectSaveScene.addEventListener("click", () => void saveProjectScene());
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
  ui.viewportView.addEventListener("change", () => {
    try {
      localStorage.setItem(VIEW_KEY, ui.viewportView.value);
    } catch {
      /* the choice then lasts until reload */
    }
    applyViewportSource();
  });
  ui.timelineRulerTicks.addEventListener("pointerdown", onRulerPointerDown);
  ui.timelinePlayhead.addEventListener("pointerdown", onRulerPointerDown);
  ui.timelineRulerTicks.addEventListener("pointermove", onRulerPointerMove);
  ui.timelineRulerTicks.addEventListener("pointerup", onRulerPointerUp);
  ui.timelineRulerTicks.addEventListener("pointercancel", onRulerPointerUp);
  ui.timelinePlayhead.addEventListener("keydown", onPlayheadKeyDown);
  document.getElementById("manager-create-cancel")!.addEventListener("click", () => ui.managerDialog.close());
  ui.sceneManagerMount.addEventListener("click", onSceneManagerClick);
  ui.sceneViewToggle.addEventListener("click", () => setSceneView(sceneView === "list" ? "thumbnails" : "list"));
  ui.sceneManagerMount.addEventListener("contextmenu", (event) => {
    const row = (event.target as Element | null)?.closest<HTMLElement>('[role="listitem"][id^="scene/"]');
    if (!row) return;
    event.preventDefault();
    openSceneMenu(row, event.clientX, event.clientY);
  });
  ui.sceneMenu.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("button[data-action]");
    if (!item) return;
    closeSceneMenu();
    runSceneAction(item);
  });
  ui.sceneManagerMount.addEventListener("keydown", onSceneListKey);
  document.addEventListener("pointerdown", (event) => {
    if (!ui.sceneMenu.hidden && !ui.sceneMenu.contains(event.target as Node)) closeSceneMenu();
  });
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
  ui.objectCopySvg.addEventListener("click", () => {
    const object = scene?.objects.find((candidate) => candidate.id === selection[0]);
    if (!object || selection.length !== 1 || object.type !== "shape") {
      log("Copy SVG: select one shape to copy its path as SVG path data.", "bad");
      return;
    }
    void copySvg(shapeSvgPath(object), `${object.name}`);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && matteWhip !== undefined) {
      endMatteWhip();
      log("Pick whip: cancelled; the matte is as it was.");
    }
    if (event.key === "Escape" && featherArm !== undefined) {
      featherArm = undefined;
      document.body.classList.remove("matte-whip");
      log("Feather point: cancelled.");
    }
  });
  ui.guideAdd.addEventListener("click", () => guideEdit("add"));
  ui.guideMove.addEventListener("click", () => guideEdit("move"));
  ui.guideRemove.addEventListener("click", () => guideEdit("remove"));
  ui.guideShow.addEventListener("change", () => {
    guidesShown = ui.guideShow.checked;
    renderOverlayLayer();
  });
  ui.pathKeying.addEventListener("change", () => {
    pathKeying = ui.pathKeying.checked;
  });
  ui.pathKeySet.addEventListener("click", () => void keyPathAtPlayhead());
  ui.pathKeyRemove.addEventListener("click", () => void removePathKeyAtPlayhead());
  ui.pathUnlink.addEventListener("click", () => void unlinkEditedPath());
  ui.subpathRemove.addEventListener("click", () => void removeSelectedSubpath());
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-vertex-kind]")) {
    button.addEventListener("click", () => setSelectedVertexKind(button.dataset.vertexKind as VertexKind));
  }
  ui.autoTension.addEventListener("change", () => setPathAutoTension(Number(ui.autoTension.value)));
  ui.objectJoin.addEventListener("click", () => {
    if (!scene) return;
    const outcome = joinEdits(scene, selection);
    if (isRefused(outcome)) {
      log(`Join: ${outcome.refused}`, "bad");
      return;
    }
    const keep = selection[0]!;
    void runEdits(outcome, { label: "Joined two paths", select: () => [keep] }, "viewport");
  });
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
  ui.effectsMount.addEventListener("click", onEffectsBrowserClick);
  ui.effectsMount.addEventListener("dblclick", onEffectsBrowserDoubleClick);
  ui.effectsMount.addEventListener("keydown", onEffectsHeaderKey);
  ui.effectsExpandAll.addEventListener("click", () => setEffectsOpen(new Set([...effectsOpen, ...effectsGroupIds()])));
  ui.effectsCollapseAll.addEventListener("click", () => setEffectsOpen(new Set()));
  ui.effectsSearch.addEventListener("input", () => scene && renderEffects(scene));
  ui.effectsShowUnported.addEventListener("change", () => scene && renderEffects(scene));
  ui.effectControlsMount.addEventListener("click", onEffectControlsClick);
  ui.effectControlsMount.addEventListener("change", onEffectControlsChange);
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
  ui.timelineGraphMode.addEventListener("click", () => {
    graphMode = graphMode === "value" ? "speed" : "value";
    contentRevision += 1;
    if (scene) paintTimeline(currentTimelineModel(scene));
    log(graphMode === "value" ? "timeline: value graph (handles editable)" : "timeline: speed graph (read only)");
  });
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
  wirePivotPanel();
  ui.canvas.closest<HTMLElement>(".viewport-stage")?.addEventListener("wheel", onViewWheel, { passive: false });
  syncCamera();
  ui.overlay.addEventListener("dblclick", (event) => {
    // The click that closed a path has already made it; the double click after it has nothing left to finish.
    if (activeTool === "pen" && editorPen.doubleClickEnds && event.timeStamp - penFinishedAt >= 500) finishPen();
    if (activeTool === "path") pathDoubleClick(event);
  });
  ui.overlay.addEventListener("keyup", (event) => {
    if (event.key === " " && penSpace) penSpace = false;
  });
  ui.undo.addEventListener("click", () => void undo());
  ui.redo.addEventListener("click", () => void redo());
  ui.previewPlay.addEventListener("click", () => togglePreview());
  document.addEventListener("keydown", onCommandKey);
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
    if (event.key === "Escape" && !ui.sceneMenu.hidden) {
      closeSceneMenu();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && !ui.keyframeMenu.hidden) {
      closeKeyframeMenu();
      event.stopPropagation();
      return;
    }
  });
  ui.overlay.addEventListener("pointerdown", onOverlayPointerDown);
  ui.overlay.addEventListener("pointermove", onOverlayPointerMove);
  ui.overlay.addEventListener("pointerup", (event) => finishOverlayPointer(event, false));
  ui.overlay.addEventListener("pointercancel", (event) => finishOverlayPointer(event, true));
  ui.penCreates.addEventListener("change", () => {
    penCreates = ui.penCreates.value as PenCreates;
    showPenCreates();
  });
  ui.overlay.addEventListener("keydown", (event) => {
    if (activeTool === "pen" && penKey(event)) return;
    if (isPathTool(activeTool) && pathKey(event)) return;
    if (event.key !== "Escape") return;
    const dropped = overlayDrag?.tool !== undefined || toolPreview !== null;
    overlayDrag = undefined;
    marquee = undefined;
    guides = [];
    dropToolPreview();
    // Escape in the middle of a drag drops the drag and keeps the selection; otherwise it clears it.
    if (!dropped) setSelection([]);
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
  try {
    effectSurface = await shell().invoke<EffectSurface>("cmd_effect_surface");
  } catch (error) {
    effectSurface = null;
    log(`effect catalogue unavailable: ${describe(error)}`, "bad");
  }
  await loadMotionLibrary();
  await loadObjectKinds();
  wireStart();
  // 11.43: no work before a project. The shell may already have one open (a reload); if not, Start
  // asks for one and cannot be dismissed.
  const current = await shell().invoke<OpenedProject | null>("cmd_current_project");
  if (current) {
    applyOpenedProject(current);
  } else {
    applyOpenedProject(undefined);
    // The `startup` setting may say to open the last project instead of showing Start.
    const reopened = await reopenLastProject();
    if (reopened) applyOpenedProject(reopened);
    const opened = reopened ?? (await showStart({ required: true }));
    if (opened === undefined) return;
  }
  await loadProjects(openProject?.name);
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
  await runCommand({ command: "openScene", source: { source: "new", id: "untitled", name: "Untitled" } }, "Opened blank scene");
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

function panelElement(panel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-panel="${panel}"]`);
}

/// The words on a panel's tab: its own heading, before the disclosure button added to it.
function panelLabel(panel: string): string {
  const heading = panelElement(panel)?.querySelector<HTMLElement>(
    ":scope > h2, :scope > .panel-title-row h2, :scope > .timeline-head h2, :scope > .pane-head h2",
  );
  return (heading?.childNodes[0]?.textContent ?? panel).trim();
}

const groupElements = new Map<string, HTMLElement>();

/// One tab group as a tab strip over its panels (11.73). The element is made once
/// and reused, so a panel inside it keeps its state across a re-render.
function renderGroup(group: TabGroup): HTMLElement {
  let element = groupElements.get(group.id);
  if (!element) {
    element = document.createElement("div");
    element.className = "dock-group";
    element.dataset.group = group.id;
    groupElements.set(group.id, element);
  }
  const tabs = document.createElement("div");
  tabs.className = "dock-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.dataset.group = group.id;
  for (const panel of group.panels) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "dock-tab";
    tab.setAttribute("role", "tab");
    tab.dataset.tab = panel;
    tab.draggable = true;
    tab.textContent = panelLabel(panel);
    tab.title = `${tab.textContent}: drag to another tab strip to move it, or out to a dock to tear it off`;
    const selected = panel === group.active;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tabs.append(tab);
  }
  const members: HTMLElement[] = [];
  for (const panel of group.panels) {
    const member = panelElement(panel);
    if (!member) continue;
    member.classList.toggle("tab-inactive", panel !== group.active);
    // A folded panel would show an empty tab: in a group the tab is the fold.
    member.classList.remove("panel-section-collapsed");
    member.setAttribute("role", "tabpanel");
    members.push(member);
  }
  element.replaceChildren(tabs, ...members);
  return element;
}

function splitterElement(region: RegionId, index: number): HTMLElement {
  const splitter = document.createElement("div");
  splitter.className = "dock-splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "horizontal");
  splitter.setAttribute("aria-label", `Resize the panels of the ${region} dock`);
  splitter.title = "Drag to resize the panels beside this bar; double-click to reset their sizes";
  splitter.tabIndex = 0;
  splitter.dataset.region = region;
  splitter.dataset.index = String(index);
  return splitter;
}

/// The stacked entries of a dock as they are on screen now, as fractions of their total
/// height: what a splitter drag starts from. None is taken below the smallest share.
function measureDock(region: RegionId): { nodes: HTMLElement[]; start: number[]; total: number } | undefined {
  const host = regionElement(region);
  if (!host) return undefined;
  const nodes = Array.from(host.querySelectorAll<HTMLElement>(":scope > [data-dock-index]"));
  const heights = nodes.map((node) => node.getBoundingClientRect().height);
  const total = heights.reduce((sum, height) => sum + height, 0);
  if (nodes.length < 2 || total <= 0) return undefined;
  // A hidden panel measures nothing: every entry is brought up to the smallest share.
  return { nodes, start: floorFractions(heights), total };
}

/// Store a dock's new sizes, or say why not, and draw the dock again.
function commitSplit(region: RegionId, fractions: readonly number[]): void {
  const next = splitRegion(layout, region, entryIds(layout.regions[region]), fractions);
  if (isLayoutRefused(next)) {
    log(next.refused, "bad");
  } else {
    layout = next;
    persistLayout(window.localStorage, layout);
    log(`resized the panels of the ${region} dock`, "good");
  }
  renderLayout();
}

let splitterDrag:
  | { region: RegionId; index: number; startY: number; total: number; start: number[]; nodes: HTMLElement[]; current: number[]; handle: HTMLElement }
  | undefined;

function wireSplitters(): void {
  document.addEventListener("pointerdown", (event) => {
    const handle = eventElement(event)?.closest<HTMLElement>(".dock-splitter");
    const region = handle?.dataset.region as RegionId | undefined;
    if (!handle || !region || event.button !== 0) return;
    const measured = measureDock(region);
    if (!measured) return;
    splitterDrag = {
      region,
      index: Number(handle.dataset.index),
      startY: event.clientY,
      total: measured.total,
      start: measured.start,
      nodes: measured.nodes,
      current: measured.start,
      handle,
    };
    handle.classList.add("resizing");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (!splitterDrag) return;
    const drag = splitterDrag;
    drag.current = dragSplitter(drag.start, drag.index, (event.clientY - drag.startY) / drag.total);
    // The entries move with the pointer; the layout is stored once, when it is let go.
    drag.nodes.forEach((node, index) => {
      node.style.flex = `${(drag.current[index] ?? 0) * 100} 1 0`;
      node.classList.add("sized");
    });
  });
  const finish = (): void => {
    if (!splitterDrag) return;
    const drag = splitterDrag;
    splitterDrag = undefined;
    drag.handle.classList.remove("resizing");
    commitSplit(drag.region, drag.current);
  };
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  document.addEventListener("keydown", (event) => {
    const handle = eventElement(event)?.closest<HTMLElement>(".dock-splitter");
    const region = handle?.dataset.region as RegionId | undefined;
    if (!handle || !region) return;
    const step = event.key === "ArrowDown" ? 0.02 : event.key === "ArrowUp" ? -0.02 : 0;
    if (step === 0) return;
    event.preventDefault();
    const measured = measureDock(region);
    if (!measured) return;
    const index = Number(handle.dataset.index);
    commitSplit(region, dragSplitter(measured.start, index, step));
    document.querySelector<HTMLElement>(`.dock-splitter[data-region="${region}"][data-index="${index}"]`)?.focus();
  });
  document.addEventListener("dblclick", (event) => {
    const handle = eventElement(event)?.closest<HTMLElement>(".dock-splitter");
    const region = handle?.dataset.region as RegionId | undefined;
    if (!handle || !region) return;
    const next = clearSplit(layout, region);
    if (isLayoutRefused(next)) return;
    layout = next;
    persistLayout(window.localStorage, layout);
    renderLayout();
    log(`the panels of the ${region} dock are sized by their content again`, "good");
  });
}

function renderLayout(): void {
  for (const region of REGIONS) {
    const host = regionElement(region);
    if (!host) continue;
    const nodes: HTMLElement[] = [];
    for (const entry of regionEntries(layout.regions[region])) {
      if (entry.kind === "group") {
        const group = renderGroup(entry.group);
        group.dataset.dockIndex = String(entry.index);
        nodes.push(group);
      } else {
        const element = panelElement(entry.panel);
        if (!element) continue;
        element.classList.remove("tab-inactive");
        element.removeAttribute("role");
        element.dataset.dockIndex = String(entry.index);
        nodes.push(element);
      }
    }
    // Stacked docks (left, right) lay their entries out by the author's sizes when they
    // have any, with a splitter between each pair (11.80); otherwise by content.
    const stacked = region === "left" || region === "right";
    const split = layout.regions[region].split;
    nodes.forEach((node, index) => {
      if (stacked && split) {
        // Scaled: flex-grow values that add up to less than one would leave part of the dock empty.
        node.style.flex = `${(split.fractions[index] ?? 0) * 100} 1 0`;
        node.classList.add("sized");
      } else {
        node.style.removeProperty("flex");
        node.classList.remove("sized");
      }
    });
    host.querySelectorAll(":scope > .dock-splitter").forEach((node) => node.remove());
    const stack: HTMLElement[] = [];
    nodes.forEach((node, index) => {
      if (stacked && index > 0) stack.push(splitterElement(region, index - 1));
      stack.push(node);
    });
    // Appended in order after anything else the region holds (the bottom dock's resizer).
    host.append(...stack);
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
  // What was reconciled is said once: the layout the author now has is stored, so the
  // next launch does not repeat a version reset or a dropped panel.
  if (restored.notes.length > 0) persistLayout(window.localStorage, layout);
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

/// Where in the region's panel list a drop at `clientY` lands: before the first
/// entry (a panel or a whole tab group) whose middle is below the pointer.
function dropIndex(host: HTMLElement, clientY: number): number {
  const region = host.dataset.region as RegionId;
  const entries = Array.from(host.querySelectorAll<HTMLElement>(":scope > [data-dock-index]")).filter(
    (entry) => entry.dataset.panel !== draggedPanel,
  );
  const before = entries.find((entry) => {
    const box = entry.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });
  let index = before ? Number(before.dataset.dockIndex) : layout.regions[region].panels.length;
  // The list the move works on has the dragged panel taken out first.
  const dragged = draggedPanel === null ? -1 : layout.regions[region].panels.indexOf(draggedPanel);
  if (dragged >= 0 && dragged < index) index -= 1;
  return index;
}

function joinGroup(panel: string, groupId: string, index?: number): void {
  const next = moveToGroup(layout, panel, groupId, index);
  if (isLayoutRefused(next)) {
    log(next.refused, "bad");
    return;
  }
  layout = next;
  persistLayout(window.localStorage, layout);
  renderLayout();
  log(`moved ${panel} to tab group ${groupId}`, "good");
}

/// Show a tab, from a click, the keyboard or the Window menu.
function showTab(panel: string, focusTab = false): void {
  const next = activateTab(layout, panel);
  if (isLayoutRefused(next)) return;
  layout = next;
  persistLayout(window.localStorage, layout);
  renderLayout();
  if (focusTab) document.querySelector<HTMLElement>(`.dock-tab[data-tab="${panel}"]`)?.focus();
}

function wireTabs(): void {
  document.addEventListener("click", (event) => {
    const tab = eventElement(event)?.closest<HTMLElement>(".dock-tab");
    if (tab?.dataset.tab) showTab(tab.dataset.tab);
  });
  document.addEventListener("keydown", (event) => {
    const tab = eventElement(event)?.closest<HTMLElement>(".dock-tab");
    if (!tab?.dataset.tab) return;
    const found = groupOf(layout, tab.dataset.tab);
    if (!found) return;
    const members = found.group.panels;
    const at = members.indexOf(tab.dataset.tab);
    const target =
      event.key === "ArrowRight" ? members[(at + 1) % members.length]
      : event.key === "ArrowLeft" ? members[(at - 1 + members.length) % members.length]
      : event.key === "Home" ? members[0]
      : event.key === "End" ? members[members.length - 1]
      : undefined;
    if (!target) return;
    event.preventDefault();
    showTab(target, true);
  });
  document.addEventListener("dragstart", (event) => {
    const tab = eventElement(event)?.closest<HTMLElement>(".dock-tab");
    if (!tab?.dataset.tab || !event.dataTransfer) return;
    draggedPanel = tab.dataset.tab;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPanel);
  });
  document.addEventListener("dragover", (event) => {
    const strip = eventElement(event)?.closest<HTMLElement>(".dock-tabs");
    document.querySelectorAll(".tab-drop-target").forEach((node) => node.classList.remove("tab-drop-target"));
    if (!draggedPanel || !strip) return;
    event.preventDefault();
    strip.classList.add("tab-drop-target");
  });
  document.addEventListener("drop", (event) => {
    const strip = eventElement(event)?.closest<HTMLElement>(".dock-tabs");
    if (!draggedPanel || !strip?.dataset.group) return;
    // A drop on a tab strip joins that group; the dock's own drop must not also run.
    event.preventDefault();
    event.stopImmediatePropagation();
    const over = eventElement(event)?.closest<HTMLElement>(".dock-tab");
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".dock-tab"));
    const index = over ? tabs.indexOf(over) : undefined;
    const panel = draggedPanel;
    clearDockGesture();
    joinGroup(panel, strip.dataset.group, index);
  }, true);
}

/// Draw where a dragged panel would land: a line above the entry it goes before, or
/// below the last one.
function showDropLine(host: HTMLElement, clientY: number): void {
  document.querySelectorAll(".drop-before, .drop-after").forEach((node) => node.classList.remove("drop-before", "drop-after"));
  const entries = Array.from(host.querySelectorAll<HTMLElement>(":scope > [data-dock-index]")).filter(
    (entry) => entry.dataset.panel !== draggedPanel,
  );
  const before = entries.find((entry) => {
    const box = entry.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });
  if (before) before.classList.add("drop-before");
  else entries[entries.length - 1]?.classList.add("drop-after");
}

function clearDockGesture(): void {
  document.querySelectorAll(".drop-before, .drop-after").forEach((node) => node.classList.remove("drop-before", "drop-after"));
  document.querySelectorAll(".tab-drop-target").forEach((node) => node.classList.remove("tab-drop-target"));
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
  wireTabs();
  wireSplitters();
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
    showDropLine(host, event.clientY);
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
