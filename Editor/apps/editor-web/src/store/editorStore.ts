import { create } from "zustand";
import { useProjectAssetStore } from "./projectAssetStore";
import { projectAssetLibraryItem } from "../lib/projectAssets";
import {
  normalizePropertyValue,
  type AssetLibraryItem,
  type AnimatableProperty,
  appendSceneHistory,
  bezierPathBounds,
  createMaterialDefinition,
  createObjectId,
  createSceneId,
  faceSlotKey,
  findAssetUsageDetails,
  findMaterialUsage,
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatible,
  isMaterialCompatibleWithFace,
  normalizeMaterial,
  normalizeMaterialSceneDocument,
  normalizeCameraPlanes,
  normalizeColorValue,
  normalizePrimitiveMaterialBinding,
  normalizeSlabBevels,
  normalizeSlabProperties,
  objectBounds,
  objectBoundsInScene,
  resolveSceneObjectHierarchy,
  readAnimatableProperty,
  redoSceneHistory,
  undoSceneHistory,
  type BindingMap,
  type CanvasGuide,
  type CanvasMargins,
  type ColorValue,
  type CameraSceneObject,
  type EllipseSceneObject,
  type GroupSceneObject,
  type ImageSceneObject,
  type LayerSceneObject,
  type LightSceneObject,
  type LineSceneObject,
  type BezierPath,
  type PathKeyframe,
  type ObjectMask,
  type PaintSceneObject,
  type PaintStroke,
  type Vec2,
  type FontDefinition,
  type GradientPreset,
  type Material,
  type SceneHistoryEntry,
  type MaterialFace,
  type MaterialInstance,
  type MaterialParameterValue,
  type PrimitiveMaterialBinding,
  type PropertyKeyframe,
  type MarkerSceneObject,
  type MeshSceneObject,
  type MeshPrimitiveKind,
  type RectSceneObject,
  type ShapeSceneObject,
  type SceneDocument,
  type SceneAutomationDefinition,
  type SceneKeyframe,
  type SceneTimeline,
  type SceneViewportSettings,
  type SceneObject,
  type SlabPropertiesInput,
  type SceneScriptReference,
  type TextSceneObject,
  projectAssetId,
  type MaterialAlphaMode,
  type ProjectAssetReference,
} from "@grapix/shared-types";
import {
  normaliseObjectSelection,
  reconcileObjectSelection,
  type ObjectSelection
} from "./objectSelection";
import {
  collectContainerSubtreeIds,
  containerContains,
  isAllowedContainerChild,
  isContainerObject,
  parentOfObject
} from "./objectHierarchy";
import { normalizeLayerId } from "./layerIds";
import {
  insertAnchorOnSegment,
  moveAnchorHandle,
  segmentCount,
  setAnchorKind,
  toggleAnchorKind
} from "../tools/bezierEditing";
import {
  alignMoves,
  distributeMoves,
  movableTargets,
  parentBoundsFor,
  resolveAlignFrame,
  type AlignEdge,
  type AlignReference,
  type AlignTarget,
  type DistributeMode
} from "../tools/alignment";
import {
  convertSceneDimensions,
  type CanvasConversionRequest
} from "../lib/convertSceneDimensions";
import { importMaterialAsset } from "../modules/material-manager/services/assetImporter";
import { builtInShaders } from "../modules/material-manager/services/shaderRegistry";
import { ensureDefaultStandardMaterial } from "../modules/material-manager/services/defaultMaterial";
import { assetExistsOnApi, saveSceneToApi } from "../lib/apiClient";
import { clonePropertyAnimation, removePropertyKeyframe } from "./timelineAnimation";
import { withColorStyles } from "./objectColorStyles";
import { nextUniqueObjectName } from "./objectNaming";
import { useUiStore } from "./uiStore";

export type LibraryObjectKind =
  | "text"
  | "background"
  | "model"
  | "quad"
  | "sphere"
  | "cube"
  | "cylinder"
  | "torus"
  | "slab"
  | "line"
  | "shape"
  | "directional-light"
  | "point-light"
  | "spot-light"
  | "perspective-camera"
  | "orthographic-camera"
  | "layer-object"
  | "camera-layer"
  | "event-marker"
  | "group";

interface SceneHistoryTransaction {
  label: string;
  scope?: string;
  scene: SceneDocument;
}

export interface EditorState {
  scene: SceneDocument;
  hasActiveScene: boolean;
  /**
   * The **active** member of the selection: the object the Inspector edits, the canvas gizmo
   * follows, and the alignment tools align to. Non-null exactly when `selectedObjectIds` is
   * non-empty, and always one of them. Its name and meaning are unchanged, which is why the
   * hundred-odd single-object readers needed no edit.
   */
  selectedObjectId: string | null;
  /** The whole selection, in document order. */
  selectedObjectIds: string[];
  /** Where a Shift range measures from. */
  objectSelectionAnchorId: string | null;
  selectedFaceIndices: number[];
  faceSelectionAnchor: number | null;
  dataJson: string;
  dataError: string | null;
  saveStatus: "local" | "saving" | "saved" | "error";
  saveError: string | null;
  materialActionError: string | null;
  undoStack: SceneHistoryEntry[];
  redoStack: SceneHistoryEntry[];
  historyTransaction: SceneHistoryTransaction | null;
  /**
   * The module credited with the next change.
   *
   * Set by whichever panel the author is working in, so an untransacted mutation still records who
   * made it without every one of the store's mutations having to name itself. Attribution only —
   * there is one history, and scope never selects a separate stack.
   */
  historyScope: string | null;
  setSaveStatus: (status: EditorState["saveStatus"], error?: string | null) => void;
  /**
   * Persist the open scene, coalescing concurrent callers.
   *
   * The one place that writes a scene and owns `saveStatus`. Save, publish and autosave all
   * route through here: two save paths would report two different statuses for one document,
   * and a second request issued while the first is in flight can report success for a write
   * that later failed. Resolves `false` when there is nothing to save.
   */
  saveScene: () => Promise<boolean>;
  /** Select exactly one object, or nothing. A shim over `selectObjects`. */
  selectObject: (objectId: string | null) => void;
  /**
   * Replace the whole selection.
   *
   * `active` defaults to the last id, which is what every additive gesture wants; `anchor`
   * defaults to the active id. The result is normalised, so a caller cannot install an active
   * object that is not a member.
   */
  selectObjects: (
    ids: readonly string[],
    options?: { active?: string | null; anchor?: string | null }
  ) => void;
  setSceneId: (id: string) => void;
  setSceneName: (name: string) => void;
  updateCanvasViewport: (patch: Partial<SceneViewportSettings>) => void;
  /** Resize the open scene's canvas, optionally scaling its content. One undo step. */
  convertCanvasDimensions: (request: CanvasConversionRequest) => void;
  addTextObject: () => void;
  addRectObject: () => void;
  addEllipseObject: () => void;
  addImageObject: () => void;
  addTextAt: (origin: Vec2, size: Vec2 | null, writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr") => string;
  createPaintLayer: () => string;
  addPaintStroke: (objectId: string, stroke: PaintStroke) => void;
  updatePaintStroke: (objectId: string, strokeId: string, patch: Partial<PaintStroke>) => void;
  addLibraryObject: (kind: LibraryObjectKind) => void;
  addModelObjectFromAsset: (assetId: string) => boolean;
  convertMeshKind: (objectId: string, next: MeshPrimitiveKind) => boolean;
  duplicateSelectedObject: () => void;
  deleteSelectedObject: () => void;
  duplicateObject: (objectId: string) => void;
  deleteObject: (objectId: string) => void;
  updateObject: (objectId: string, patch: Partial<SceneObject>) => void;
  /**
   * Patch many objects with the same value, as **one** undo step.
   *
   * Not a loop over `updateObject`: that would rebuild and normalise the scene once per target and
   * deposit one history entry each unless the caller remembered to wrap it. One commit writes every
   * target, carries the caller's label, and is taken back by a single Ctrl+Z — which is what an author
   * who edited twelve objects at once expects.
   *
   * Returns the number of objects written, so a caller can distinguish "nothing matched" from "done".
   */
  updateObjects: (objectIds: readonly string[], patch: Partial<SceneObject>, label: string) => number;
  setActiveCameraId: (cameraId: string | null) => void;
  setContainerChild: (containerId: string, childId: string, included: boolean) => boolean;
  // Pen-tool / bezier-path authoring. All commit through the scene history, so a
  // pen gesture wrapped in beginHistory/commitHistory is a single undo step.
  createPenShape: (origin: Vec2, paint?: { fillEnabled: boolean; strokeEnabled: boolean }) => string;
  appendShapeVertex: (objectId: string, vertex: Vec2, inTangent?: Vec2, outTangent?: Vec2) => number;
  updateShapeVertex: (objectId: string, index: number, patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }) => void;
  addShapeSubpath: (objectId: string) => number;
  updateShapeSubpath: (objectId: string, index: number, path: BezierPath) => boolean;
  removeShapeSubpath: (objectId: string, index: number) => boolean;
  moveShapeSubpath: (objectId: string, index: number, direction: -1 | 1) => boolean;
  addShapePoint: (objectId: string, afterIndex: number, point?: Vec2) => void;
  removeShapePoints: (objectId: string, indices: number[]) => void;
  /**
   * Align or distribute a selection, as one undo step.
   *
   * `keyObjectId` is the object that holds still under a `key-object` reference. Both return the
   * number of objects actually moved, so a caller can report "nothing to do" rather than leaving
   * the operator wondering whether the button worked.
   */
  alignSelection: (
    objectIds: readonly string[],
    edge: AlignEdge,
    reference: AlignReference,
    keyObjectId?: string | null
  ) => number;
  distributeSelection: (objectIds: readonly string[], mode: DistributeMode) => number;
  setShapeAnchorKind: (objectId: string, indices: number[], kind: "corner" | "smooth") => void;
  toggleShapeAnchorKind: (objectId: string, index: number) => void;
  /** Add an anchor at parameter `t` along a segment without moving the curve. Returns its index. */
  insertShapePointOnSegment: (objectId: string, segmentIndex: number, t: number) => number;
  convertObjectToShape: (objectId: string) => string | null;
  closeShapePath: (objectId: string) => void;
  // AE-style layer masks. addMask is for pen-drawing (empty path at a local
  // origin); addRectMask drops a ready rectangular mask. All history-committed.
  addRectMask: (objectId: string) => string | null;
  addMask: (objectId: string, origin: Vec2) => string | null;
  addMaskFromPath: (objectId: string, path: BezierPath, type?: ObjectMask["type"], feather?: Vec2) => string | null;
  appendMaskVertex: (objectId: string, maskId: string, vertex: Vec2) => void;
  /**
   * Place objects immediately before or after a sibling, in one step.
   *
   * "Before" means *earlier in the flat render order*, which the Object Manager draws lower down
   * because it reverses the list. The panel is responsible for that translation; this action speaks
   * render order only.
   */
  reorderObjectsInStack: (
    objectIds: readonly string[],
    targetId: string,
    placement: "before" | "after"
  ) => void;
  /**
   * Apply a resolved drop: reparent, reorder, re-layer, or any combination, as **one** undo step.
   *
   * Sequencing lives here rather than in the panel because the order matters — a cross-parent move
   * has to detach, adopt, then reorder — and a panel that got it wrong would leave a half-moved
   * subtree. Returns false when the drop was refused or changed nothing.
   */
  applyObjectDrop: (
    objectIds: readonly string[],
    drop: { kind: string; targetId?: string }
  ) => boolean;
  closeMaskPath: (objectId: string, maskId: string) => void;
  updateMask: (objectId: string, maskId: string, patch: Partial<ObjectMask>) => void;
  updateMaskVertex: (objectId: string, maskId: string, index: number, patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }) => void;
  duplicateMask: (objectId: string, maskId: string) => string | null;
  moveMask: (objectId: string, maskId: string, direction: "up" | "down") => void;
  toggleMaskKeyframe: (objectId: string, maskId: string, property: "path" | "opacity" | "feather" | "expansion", frame: number) => void;
  updateMaskKeyframeFrame: (objectId: string, maskId: string, property: "path" | "opacity" | "feather" | "expansion", keyframeId: string, frame: number) => void;
  deleteMask: (objectId: string, maskId: string) => void;
  toggleShapePathKeyframe: (objectId: string, frame: number) => void;
  setShapePathAnimationEnabled: (objectId: string, enabled: boolean, frame: number) => void;
  updateShapePathKeyframeFrame: (objectId: string, keyframeId: string, frame: number) => void;
  deleteShapePathKeyframe: (objectId: string, keyframeId: string) => void;
  toggleShapeTrimKeyframe: (objectId: string, channel: "start" | "end" | "offset", frame: number) => void;
  setShapeTrimAnimationEnabled: (objectId: string, channel: "start" | "end" | "offset", enabled: boolean, frame: number) => void;
  setShapeTrimValue: (objectId: string, channel: "start" | "end" | "offset", value: number, frame: number) => void;
  moveObjectInStack: (objectId: string, direction: "up" | "down" | "front" | "back") => void;
  updateObjectBindings: (objectId: string, bindings: BindingMap) => void;
  addObjectKeyframe: (objectId: string, frame: number) => void;
  updateObjectKeyframe: (keyframeId: string, patch: Partial<SceneKeyframe>) => void;
  deleteObjectKeyframe: (keyframeId: string) => void;
  setPropertyAnimationEnabled: (
    objectId: string,
    property: AnimatableProperty,
    enabled: boolean,
    frame: number
  ) => void;
  setAnimatedPropertyValue: (
    objectId: string,
    property: AnimatableProperty,
    value: number,
    frame: number
  ) => void;
  addPropertyKeyframe: (
    objectId: string,
    property: AnimatableProperty,
    frame: number,
    value?: number
  ) => void;
  updatePropertyKeyframe: (
    objectId: string,
    property: AnimatableProperty,
    keyframeId: string,
    patch: Partial<PropertyKeyframe>
  ) => void;
  deletePropertyKeyframe: (
    objectId: string,
    property: AnimatableProperty,
    keyframeId: string
  ) => void;
  updateTimeline: (patch: Partial<SceneTimeline>) => void;
  addFontDefinition: (font: FontDefinition, asset?: AssetLibraryItem) => void;
  addFontDefinitions: (fonts: FontDefinition[], assets?: AssetLibraryItem[]) => void;
  updateFontDefinition: (fontId: string, patch: Partial<FontDefinition>) => void;
  replaceFontDefinition: (fontId: string, font: FontDefinition, assets?: AssetLibraryItem[]) => boolean;
  removeFontDefinition: (fontId: string) => boolean;
  assignFontToSelectedText: (fontId: string) => boolean;
  updateAutomation: (automation: SceneAutomationDefinition) => void;
  attachSceneScript: (script: SceneScriptReference, asset: AssetLibraryItem) => void;
  assignMaterialSlot: (objectId: string, slotName: string, binding: string | PrimitiveMaterialBinding) => void;
  renameObject: (objectId: string, name: string) => boolean;
  assignMaterialToObjects: (objectIds: string[], materialId: string, slotName?: string) => boolean;
  assignAssetToObjects: (objectIds: string[], assetId: string, slotName?: string) => boolean;
  // Central XPression-style face-index material-binding API. One bind/unbind =
  // one undo entry; multi-face assignments commit as a single transaction. The
  // same API backs Material Manager double-click, Inspector commands, drag-drop,
  // and any future script / Visual Logic / data-driven material switching.
  selectFace: (faceIndex: number, mode: "single" | "toggle" | "range") => void;
  clearFaceSelection: () => void;
  assignMaterial: (objectId: string, faceIndex: number, materialId: string) => boolean;
  assignMaterialToFaces: (objectId: string, faceIndices: number[], binding: string | PrimitiveMaterialBinding) => boolean;
  assignAssetToFaces: (objectId: string, faceIndices: number[], assetId: string) => boolean;
  unbindMaterial: (objectId: string, faceIndex: number) => void;
  unbindMaterialFromFaces: (objectId: string, faceIndices: number[]) => void;
  getMaterial: (objectId: string, faceIndex: number) => string | undefined;
  getBindableFaces: (objectId: string) => MaterialFace[];
  getObjectsUsingMaterial: (materialId: string) => string[];
  importAsset: (file: File) => Promise<string | null>;
  /**
   * Record a file from the project's asset folders as a scene asset, and answer its id.
   *
   * The library is the folder, but the *scene* still has to say which of those files it uses:
   * publishing packages `scene.assets`, and the renderers resolve textures from it. Assignment is
   * therefore the moment a browsed reference becomes part of the document — not import, because
   * nothing is imported, and not browsing, because a scene must not gain a dependency merely by
   * someone scrolling the panel.
   *
   * Idempotent by path: assigning the same file to a second object reuses the one entry. Re-adopting
   * an entry the scene already has refreshes its metadata, so a file replaced on disk stops
   * reporting the old size.
   */
  adoptProjectAsset: (reference: ProjectAssetReference) => string;
  relinkAsset: (assetId: string, file: File) => Promise<void>;
  updateAsset: (assetId: string, patch: Partial<AssetLibraryItem>) => void;
  refreshAssetAvailability: () => Promise<void>;
  deleteAsset: (assetId: string) => boolean;
  createMaterial: (assetId?: string) => string;
  duplicateMaterial: (materialId: string) => string | null;
  deleteMaterial: (materialId: string) => boolean;
  deleteUnusedMaterials: () => number;
  updateMaterial: (materialId: string, patch: Partial<Material>) => void;
  createMaterialInstance: (baseMaterialId: string) => string | null;
  deleteMaterialInstance: (instanceId: string) => boolean;
  updateMaterialInstance: (instanceId: string, patch: Partial<MaterialInstance>) => void;
  setMaterialInstanceParameter: (instanceId: string, name: string, value: MaterialParameterValue | undefined) => void;
  moveObjectToLayer: (objectId: string, layerId: string) => void;
  saveGradientPreset: (name: string, value: GradientPreset["value"]) => string;
  updateGradientPreset: (presetId: string, patch: Partial<Pick<GradientPreset, "name" | "value">>) => void;
  duplicateGradientPreset: (presetId: string) => string | null;
  deleteGradientPreset: (presetId: string) => void;
  createLayerForObject: (objectId: string) => string | null;
  renameLayer: (layerId: string, nextLayerId: string) => boolean;
  deleteLayer: (layerId: string) => void;
  setLayerVisibility: (layerId: string, visible: boolean) => void;
  setLayerLocked: (layerId: string, locked: boolean) => void;
  /** Open a transaction. `scope` defaults to the ambient `historyScope`. */
  beginHistory: (label: string, scope?: string) => void;
  commitHistory: () => void;
  cancelHistory: () => void;
  /** Credit subsequent changes to a module. Called by a panel when the author works in it. */
  setHistoryScope: (scope: string | null) => void;
  /**
   * Take back the last change to the open scene.
   *
   * One history for the document, whichever module made the change — see `SceneHistoryEntry`. The
   * entry's label and scope say what came back, so the UI can name it instead of undoing silently.
   */
  undo: () => void;
  redo: () => void;
  setDataJson: (json: string) => void;
  applyDataJson: () => boolean;
  loadScene: (scene: SceneDocument) => void;
  applyImportedScene: (scene: SceneDocument, mode: "replace" | "merge") => void;
  resetScene: () => void;
  clearScene: () => void;
}

function isMaterialCompatibleWithSlot(material: Material, object: SceneObject, slotName: string): boolean {
  const face = getBindableFaces(object).find((candidate) => candidate.slotKey === slotName);
  return face
    ? isMaterialCompatibleWithFace(material, object, face.index)
    : isMaterialCompatible(material, object.type);
}

/**
 * The single outstanding scene write, or `null`.
 *
 * Module scope rather than store state: it is a concurrency latch, not something the UI
 * renders — `saveStatus` is what the UI reads. Keeping it out of the store also means a
 * coalesced caller cannot observe a half-updated store mid-write.
 */
let saveInFlight: Promise<boolean> | null = null;

/**
 * Add or refresh one project asset in a scene's asset list.
 *
 * An entry the scene already has keeps what the author changed — the name they gave it, their
 * tags, an alpha mode they set — and takes the file's own facts from disk. Replacing it outright
 * would silently undo those edits every time the file was touched.
 */
function withProjectAsset(
  assets: readonly AssetLibraryItem[],
  reference: ProjectAssetReference
): AssetLibraryItem[] {
  const fresh = projectAssetLibraryItem(reference);
  const index = assets.findIndex((item) => item.assetId === fresh.assetId);
  if (index < 0) return [...assets, fresh];
  return assets.map((item, position) => position === index
    ? { ...item, ...fresh, name: item.name, tags: item.tags, alphaMode: item.alphaMode ?? fresh.alphaMode }
    : item);
}

/**
 * The alpha mode a new material should take from the image being bound to it.
 *
 * A textured material otherwise defaults to `straight`, which is the right assumption for an image
 * nobody has read: a key drawn opaque is a black rectangle on air, while an opaque photo drawn with
 * blending is merely slower. But the project library reads every image's header, so for a JPEG or a
 * lossy WebP we *know* there is no alpha channel — and drawing those as transparent surfaces costs
 * blending and invites the depth-sorting artefacts transparency brings.
 *
 * `undefined` for `unknown`, so an unread asset falls through to that safe default rather than
 * having a guess written into the document.
 */
function materialAlphaModeForAsset(asset: AssetLibraryItem): MaterialAlphaMode | undefined {
  if (asset.alphaMode === "opaque") return "opaque";
  if (asset.alphaMode === "straight" || asset.alphaMode === "premultiplied") return asset.alphaMode;
  return undefined;
}

/**
 * The asset list a scene needs in order to reference `assetId`, when `assetId` names a file in the
 * project library rather than something the scene already carries.
 *
 * Returns the list unchanged when the library has no such file — the caller then reports "could
 * not be found", which is the honest answer for an id that names nothing on disk.
 */
function adoptedProjectAssets(
  assets: readonly AssetLibraryItem[],
  assetId: string
): AssetLibraryItem[] {
  const reference = useProjectAssetStore
    .getState()
    .assets.find((candidate) => projectAssetId(candidate.path) === assetId);
  return reference ? withProjectAsset(assets, reference) : [...assets];
}

export const useEditorStore = create<EditorState>((set, get) => {
  const initialScene = createEmptyScene();

  return {
    scene: initialScene,
    hasActiveScene: false,
    selectedObjectId: null,
    selectedObjectIds: [],
    objectSelectionAnchorId: null,
    selectedFaceIndices: [],
    faceSelectionAnchor: null,
    dataJson: JSON.stringify(initialScene.dataContext, null, 2),
    dataError: null,
    saveStatus: "local",
    saveError: null,
    materialActionError: null,
    undoStack: [],
    redoStack: [],
    historyTransaction: null,
    historyScope: null,
    setSaveStatus: (saveStatus, saveError = null) => set({ saveStatus, saveError }),
    saveScene: async () => {
      if (!get().hasActiveScene) return false;

      // Coalesce rather than queue. A second caller arriving mid-flight wants "the scene is
      // persisted", which the in-flight write already delivers; issuing a second POST would
      // race it and let a stale body win. Autosave leans on this heavily — a timer tick
      // landing during a manual save must not double-write.
      const inFlight = saveInFlight;
      if (inFlight) return inFlight;

      const attempt = (async () => {
        set({ saveStatus: "saving", saveError: null });
        try {
          /*
           * One request, and no dialog.
           *
           * Where the project lives is asked for by the UI before it calls this — `saveWithProject`
           * in the menu, `ensureProject` in the After Effects panel — because those are the paths a
           * person took. Probing for a project here would raise a file picker from autosave and
           * from every programmatic caller, and would turn a momentary service outage into "you
           * have no project".
           */
          await saveSceneToApi(get().scene);
          set({ saveStatus: "saved", saveError: null });
          return true;
        } catch (error) {
          set({
            saveStatus: "error",
            saveError: error instanceof Error ? error.message : "Save failed"
          });
          return false;
        } finally {
          saveInFlight = null;
        }
      })();

      saveInFlight = attempt;
      return attempt;
    },
    // Object selection means "the whole object" by default, so applying a
    // material to a cube/model cannot appear to fail merely because its Front
    // face is rotated away. An explicit face click in Materials narrows this
    // selection, and re-clicking the same object preserves that choice.
    selectObject: (objectId) => applySelection(objectId ? [objectId] : [], { active: objectId }),
    selectObjects: (ids, options) => applySelection(ids, options),
    setSceneId: (id) =>
      set((state) => ({
        scene: touchScene({ ...state.scene, id })
      })),
    setSceneName: (name) =>
      set((state) => ({
        scene: touchScene({ ...state.scene, name })
      })),
    updateCanvasViewport: (patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          canvas: {
            ...state.scene.canvas,
            editorViewport: normalizeViewportSettings({
              ...state.scene.canvas.editorViewport,
              ...patch,
              margins: patch.margins
                ? { ...state.scene.canvas.editorViewport?.margins, ...patch.margins }
                : state.scene.canvas.editorViewport?.margins,
              guides: patch.guides ?? state.scene.canvas.editorViewport?.guides
            }, state.scene.canvas.width, state.scene.canvas.height)
          }
        })
      })),
    // Through commitScene rather than loadScene: loading a scene clears the undo stack, and a
    // resolution change an author can't undo is the one they most want back.
    convertCanvasDimensions: (request) => {
      const converted = convertSceneDimensions(get().scene, request);
      if (converted === get().scene) return;
      commitScene(converted);
    },
    addTextObject: () => addObject(createTextObject()),
    addRectObject: () => addObject(createRectObject()),
    addEllipseObject: () => addObject(createEllipseObject()),
    addImageObject: () => addObject(createImageObject()),
    addLibraryObject: (kind) => addObject(createLibraryObject(kind, get().scene)),
    addModelObjectFromAsset: (assetId) => {
      const { scene, hasActiveScene } = get();
      const asset = scene.assets.find((item) => item.assetId === assetId);
      if (!hasActiveScene) {
        set({ materialActionError: "Create or open a scene before adding a 3D model." });
        return false;
      }
      if (!asset || asset.kind !== "model" || ["MISSING", "ERROR", "UNSUPPORTED"].includes(asset.status ?? "")) {
        set({ materialActionError: "The selected GLB/glTF model is missing or unavailable." });
        return false;
      }
      addObject(createMeshObject("model", {
        name: asset.name.replace(/\.(glb|gltf)$/i, ""),
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        width: 320,
        height: 320,
        depth: 320,
        src: asset.source,
        modelAssetId: asset.assetId,
        materialElements: asset.modelMaterialNames ?? []
      }));
      set({ materialActionError: null });
      return true;
    },
    convertMeshKind: (objectId, next) => {
      const { scene, selectedObjectId } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "mesh") return false;

      const converted = convertMeshObjectKind(object, next);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? converted : item)
      }, `Convert mesh to ${next}`);

      if (selectedObjectId === objectId) {
        const faceCount = getBindableFaces(converted).length;
        const selectedFaceIndices = get().selectedFaceIndices.filter((index) => index < faceCount);
        set({
          selectedFaceIndices: selectedFaceIndices.length ? selectedFaceIndices : [0],
          faceSelectionAnchor: selectedFaceIndices.length ? selectedFaceIndices[0] : 0
        });
      }
      return true;
    },
    duplicateSelectedObject: () => {
      const { selectedObjectId } = get();

      if (selectedObjectId) {
        duplicateObjectById(selectedObjectId);
      }
    },
    deleteSelectedObject: () => {
      const { selectedObjectId } = get();

      if (selectedObjectId) {
        deleteObjectById(selectedObjectId);
      }
    },
    duplicateObject: duplicateObjectById,
    deleteObject: deleteObjectById,
    /**
     * Patch one object, as one undo step.
     *
     * Through `commitScene`, so a visibility toggle or a lock can be undone. A continuous gesture —
     * a canvas drag, a numeric scrub — wraps itself in `beginHistory`/`commitHistory` and therefore
     * still deposits exactly one entry however many patches it emits.
     */
    updateObject: (objectId, patch) => {
      const { scene } = get();
      const target = scene.objects.find((object) => object.id === objectId);
      const safe = target ? clampPatch(target, patch) : patch;
      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.id === objectId ? ({ ...object, ...safe } as SceneObject) : object
          )
        )
      }, describeObjectPatch(patch));
    },
    updateObjects: (objectIds, patch, label) => {
      const targets = new Set(objectIds);
      if (targets.size === 0) return 0;
      const { scene } = get();
      let written = 0;
      const objects = scene.objects.map((object) => {
        if (!targets.has(object.id)) return object;
        written += 1;
        return { ...object, ...clampPatch(object, patch) } as SceneObject;
      });
      // Nothing matched: commit nothing rather than depositing an entry that undoes to itself.
      if (written === 0) return 0;
      commitScene({ ...scene, objects: normalizeObjectStack(objects) }, label);
      return written;
    },
    renameObject: (objectId, name) => {
      const nextName = name.trim();
      const { scene } = get();
      const target = scene.objects.find((object) => object.id === objectId);
      if (!target || !nextName) return false;
      if (target.name === nextName) return true;
      if (scene.objects.some((object) =>
        object.id !== objectId && object.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase()
      )) {
        return false;
      }
      commitScene({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === objectId ? ({ ...object, name: nextName } as SceneObject) : object
        )
      }, "Rename object");
      return true;
    },
    addTextAt: (origin, size, writingMode) => {
      const text = createTextObject({
        x: origin.x,
        y: origin.y,
        width: Math.max(1, size?.x ?? (writingMode === "horizontal-tb" ? 420 : 96)),
        height: Math.max(1, size?.y ?? (writingMode === "horizontal-tb" ? 72 : 420)),
        textLayout: size ? "paragraph" : "point",
        writingMode,
        verticalAlign: "top",
        direction: "ltr"
      });
      addObject(text);
      return text.id;
    },
    createPaintLayer: () => {
      const { scene } = get();
      const paint = createPaintObject({
        x: 0,
        y: 0,
        width: scene.canvas.width,
        height: scene.canvas.height
      });
      addObject(paint);
      return paint.id;
    },
    addPaintStroke: (objectId, stroke) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "paint") return;
      commitScene({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === objectId ? { ...object, strokes: [...object.strokes, stroke] } : item
        )
      });
    },
    updatePaintStroke: (objectId, strokeId, patch) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "paint") return;
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId
          ? { ...object, strokes: object.strokes.map((stroke) => stroke.id === strokeId ? { ...stroke, ...patch } : stroke) }
          : item)
      });
    },
    setActiveCameraId: (cameraId) => {
      const { scene } = get();
      if (cameraId && !scene.objects.some((object) => object.id === cameraId && object.type === "camera")) {
        return;
      }
      set({
        scene: touchScene({
          ...scene,
          activeCameraId: cameraId ?? undefined
        })
      });
    },
    setContainerChild: (containerId, childId, included) => {
      const { scene } = get();
      const container = scene.objects.find((object) => object.id === containerId);
      const child = scene.objects.find((object) => object.id === childId);
      if (!container || !child || !isContainerObject(container) || container.id === child.id) {
        return false;
      }
      if (included && !isAllowedContainerChild(container, child)) {
        return false;
      }
      if (included && isContainerObject(child) && containerContains(scene.objects, child.id, container.id)) {
        return false;
      }

      const hierarchy = resolveSceneObjectHierarchy(scene.objects);
      const effectiveChild = hierarchy.objects.find((object) => object.id === childId) ?? child;
      const effectiveContainer = hierarchy.objects.find((object) => object.id === containerId) ?? container;
      const childTransformPatch = included
        ? localizeSceneObjectTransform(effectiveChild, effectiveContainer)
        : bakeEffectiveSceneObjectTransform(effectiveChild);
      const adoptedIds = included
        ? collectContainerSubtreeIds(scene.objects, childId)
        : new Set<string>();
      const objects = scene.objects.map((object) => {
        let nextObject = object;
        if (isContainerObject(object)) {
          const withoutChild = object.childIds.filter((id) => id !== childId);
          if (object.id === containerId) {
            nextObject = {
              ...object,
              childIds: included ? [...withoutChild, childId] : withoutChild
            } as SceneObject;
          } else if (withoutChild.length !== object.childIds.length) {
            nextObject = { ...object, childIds: withoutChild } as SceneObject;
          }
        }
        if (adoptedIds.has(object.id) && nextObject.layerId !== container.layerId) {
          nextObject = { ...nextObject, layerId: container.layerId } as SceneObject;
        }
        if (object.id === childId) {
          nextObject = { ...nextObject, ...childTransformPatch } as SceneObject;
        }
        return nextObject;
      });

      set({ scene: touchScene({ ...scene, objects: normalizeObjectStack(objects) }) });
      return true;
    },
    createPenShape: (origin, paint = { fillEnabled: true, strokeEnabled: true }) => {
      const { scene } = get();
      const shape = createShapeObject({
        x: origin.x,
        y: origin.y,
        width: 1,
        height: 1,
        path: { closed: false, vertices: [{ x: 0, y: 0 }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] },
        // Fill and stroke are the pen's own options, not the "arrives unassigned" default every
        // other object is born with: a path being drawn has to be visible while it is being
        // drawn. A fill renders even while the path is still open.
        fillEnabled: paint.fillEnabled,
        fill: PEN_SHAPE_FILL,
        strokeEnabled: paint.strokeEnabled,
        strokeWidth: 2,
        stroke: PEN_SHAPE_STROKE
      });
      const layerObjects = scene.objects.filter((item) => item.layerId === shape.layerId);
      const objectWithStack = {
        ...shape,
        name: nextUniqueObjectName(scene.objects, shape.name),
        zIndex: layerObjects.reduce((highest, item) => Math.max(highest, item.zIndex), -1) + 1
      };
      commitScene({ ...scene, objects: normalizeObjectStack([...scene.objects, objectWithStack]) }, "Draw shape");
      set({ ...selectionOf(objectWithStack.id), selectedFaceIndices: [0], faceSelectionAnchor: 0 });
      return objectWithStack.id;
    },
    appendShapeVertex: (objectId, vertex, inTangent = { x: 0, y: 0 }, outTangent = { x: 0, y: 0 }) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") {
        return -1;
      }
      const path: BezierPath = {
        closed: object.path.closed,
        vertices: [...object.path.vertices, vertex],
        inTangents: [...object.path.inTangents, inTangent],
        outTangents: [...object.path.outTangents, outTangent]
      };
      const updated = fitShapeToPath(object, path);
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
      return path.vertices.length - 1;
    },
    updateShapeVertex: (objectId, index, patch) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape" || index < 0 || index >= object.path.vertices.length) {
        return;
      }
      const at = <T,>(list: T[], value: T | undefined) => value === undefined ? list : list.map((existing, i) => (i === index ? value : existing));
      const path: BezierPath = {
        closed: object.path.closed,
        vertices: at(object.path.vertices, patch.vertex),
        inTangents: at(object.path.inTangents, patch.inTangent),
        outTangents: at(object.path.outTangents, patch.outTangent)
      };
      const updated = fitShapeToPath(object, path);
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    addShapeSubpath: (objectId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return -1;
      const compoundPaths = [...(object.compoundPaths ?? []), createInsetSubpath(object.path)];
      const updated: ShapeSceneObject = { ...object, compoundPaths };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      }, "Add shape subpath");
      return compoundPaths.length - 1;
    },
    updateShapeSubpath: (objectId, index, path) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      const compoundPaths = object?.type === "shape" ? [...(object.compoundPaths ?? [])] : [];
      if (!object || object.type !== "shape" || index < 0 || index >= compoundPaths.length) return false;
      compoundPaths[index] = normalizeBezierPathArrays(path);
      const updated: ShapeSceneObject = { ...object, compoundPaths };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      }, "Edit shape subpath");
      return true;
    },
    removeShapeSubpath: (objectId, index) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      const compoundPaths = object?.type === "shape" ? [...(object.compoundPaths ?? [])] : [];
      if (!object || object.type !== "shape" || index < 0 || index >= compoundPaths.length) return false;
      compoundPaths.splice(index, 1);
      const updated: ShapeSceneObject = {
        ...object,
        compoundPaths: compoundPaths.length ? compoundPaths : undefined
      };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      }, "Remove shape subpath");
      return true;
    },
    moveShapeSubpath: (objectId, index, direction) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      const compoundPaths = object?.type === "shape" ? [...(object.compoundPaths ?? [])] : [];
      const destination = index + direction;
      if (!object || object.type !== "shape"
        || index < 0 || index >= compoundPaths.length
        || destination < 0 || destination >= compoundPaths.length) return false;
      [compoundPaths[index], compoundPaths[destination]] = [compoundPaths[destination], compoundPaths[index]];
      const updated: ShapeSceneObject = { ...object, compoundPaths };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      }, "Reorder shape subpath");
      return true;
    },
    /**
     * Add an anchor after `afterIndex`.
     *
     * Without an authored point this subdivides the segment at its midpoint, which leaves the
     * drawn curve untouched. It used to insert the midpoint of the two *vertices* with no
     * handles: on a curved segment that is a point well off the curve, so pressing "Add point"
     * silently flattened the very shape the operator was refining.
     *
     * An authored point is still placed literally — the caller has said where it wants the
     * anchor, and honouring that is the whole reason the argument exists.
     */
    addShapePoint: (objectId, afterIndex, authoredPoint) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape" || object.path.vertices.length === 0) return;
      const fromIndex = Math.min(object.path.vertices.length - 1, Math.max(0, afterIndex));

      let path: BezierPath;
      if (authoredPoint) {
        path = insertPathPoint(object.path, fromIndex + 1, authoredPoint);
      } else {
        if (fromIndex >= segmentCount(object.path)) return;
        path = insertAnchorOnSegment(object.path, fromIndex, 0.5).path;
      }

      const updated = fitShapeToPath(object, path);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      });
    },
    removeShapePoints: (objectId, indices) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const removed = new Set(indices);
      const minimum = object.path.closed ? 3 : 2;
      if (object.path.vertices.length - removed.size < minimum) return;
      const path = filterPathPoints(object.path, (_, index) => !removed.has(index));
      const updated = fitShapeToPath(object, path);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      });
    },
    // Convert anchors between a corner and a tangent point.
    //
    // Replaces `setShapePointsSmooth(id, indices, smooth, linked)`, whose `linked` argument was
    // never a real distinction: "Smooth" and "Link handles" in the tool options passed the same
    // pair of values, so one of the two buttons did nothing, and "Break handles" *rewrote* the
    // outgoing handle from the anchor's neighbours instead of breaking anything. Linkage is now
    // read from the anchor's own geometry when a handle is dragged (`moveAnchorHandle`), so it
    // needs no argument here and cannot disagree with what is on screen.
    alignSelection: (objectIds, edge, reference, keyObjectId) => {
      const { scene } = get();
      const targets = alignTargetsFor(scene, objectIds);
      if (targets.length === 0) return 0;

      const frame = resolveAlignFrame(reference, targets, {
        canvas: { x: 0, y: 0, width: scene.canvas.width, height: scene.canvas.height },
        keyObjectId,
        parentBounds: parentBoundsFor(scene, objectIds, (object) => objectBounds(object))
      });
      const moves = alignMoves(movableTargets(targets, reference, keyObjectId), edge, frame);
      return applyMoves(moves, `align ${edge}`);
    },
    distributeSelection: (objectIds, mode) => {
      const { scene } = get();
      const targets = alignTargetsFor(scene, objectIds);
      return applyMoves(distributeMoves(targets, mode), `distribute ${mode}`);
    },
    setShapeAnchorKind: (objectId, indices, kind) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const path = indices.reduce(
        (current, index) => setAnchorKind(current, index, kind),
        object.path
      );
      const updated = fitShapeToPath(object, path);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      });
    },
    toggleShapeAnchorKind: (objectId, index) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const updated = fitShapeToPath(object, toggleAnchorKind(object.path, index));
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      });
    },
    // Add an anchor where the operator clicked *on the curve*, keeping the curve identical.
    insertShapePointOnSegment: (objectId, segmentIndex, t) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return -1;
      if (segmentIndex < 0 || segmentIndex >= segmentCount(object.path)) return -1;
      const { path, index } = insertAnchorOnSegment(object.path, segmentIndex, t);
      const updated = fitShapeToPath(object, path);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? updated : item)
      });
      return index;
    },
    convertObjectToShape: (objectId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || (object.type !== "rect" && object.type !== "ellipse")) return null;
      const path = object.type === "rect"
        ? rectangleBezierPath(object.width, object.height)
        : ellipseBezierPath(object.width, object.height);
      const shape: ShapeSceneObject = {
        ...object,
        type: "shape",
        path,
        fillEnabled: true,
        strokeEnabled: object.strokeWidth > 0,
        fillRule: "nonzero"
      };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? shape : item)
      });
      return shape.id;
    },
    closeShapePath: (objectId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") {
        return;
      }
      const updated: ShapeSceneObject = { ...object, path: { ...object.path, closed: true }, fillEnabled: true };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    addRectMask: (objectId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object) return null;
      const ix = object.width * 0.2;
      const iy = object.height * 0.2;
      const zero = { x: 0, y: 0 };
      const path: BezierPath = {
        closed: true,
        vertices: [{ x: ix, y: iy }, { x: object.width - ix, y: iy }, { x: object.width - ix, y: object.height - iy }, { x: ix, y: object.height - iy }],
        inTangents: [zero, zero, zero, zero],
        outTangents: [zero, zero, zero, zero]
      };
      return addMaskToObject(objectId, path);
    },
    addMask: (objectId, origin) => {
      const path: BezierPath = { closed: false, vertices: [{ x: origin.x, y: origin.y }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] };
      return addMaskToObject(objectId, path);
    },
    addMaskFromPath: (objectId, path, type = "bezier", feather = { x: 0, y: 0 }) =>
      addMaskToObject(objectId, path, { type, feather }),
    appendMaskVertex: (objectId, maskId, vertex) => {
      mutateMask(objectId, maskId, (mask) => ({
        ...mask,
        path: {
          closed: mask.path.closed,
          vertices: [...mask.path.vertices, vertex],
          inTangents: [...mask.path.inTangents, { x: 0, y: 0 }],
          outTangents: [...mask.path.outTangents, { x: 0, y: 0 }]
        }
      }));
    },
    closeMaskPath: (objectId, maskId) => {
      mutateMask(objectId, maskId, (mask) => ({ ...mask, path: { ...mask.path, closed: true } }));
    },
    updateMask: (objectId, maskId, patch) => {
      mutateMask(objectId, maskId, (mask) => ({ ...mask, ...patch }));
    },
    updateMaskVertex: (objectId, maskId, index, patch) => {
      mutateMask(objectId, maskId, (mask) => ({
        ...mask,
        path: patchPathPoint(mask.path, index, patch)
      }));
    },
    duplicateMask: (objectId, maskId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      const mask = object?.masks?.find((item) => item.id === maskId);
      if (!object || !mask) return null;
      const duplicated: ObjectMask = {
        ...structuredClone(mask),
        id: createSceneId("mask"),
        name: `${mask.name} Copy`,
        path: {
          ...mask.path,
          vertices: mask.path.vertices.map((point) => ({ x: point.x + 12, y: point.y + 12 }))
        }
      };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId
          ? { ...item, masks: [...(item.masks ?? []), duplicated] } as SceneObject
          : item)
      });
      return duplicated.id;
    },
    moveMask: (objectId, maskId, direction) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object?.masks) return;
      const index = object.masks.findIndex((mask) => mask.id === maskId);
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= object.masks.length) return;
      const masks = object.masks.slice();
      [masks[index], masks[target]] = [masks[target], masks[index]];
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? { ...item, masks } as SceneObject : item)
      });
    },
    deleteMask: (objectId, maskId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || !object.masks) return;
      const masks = object.masks.filter((mask) => mask.id !== maskId);
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, masks } as SceneObject) : item) });
    },
    toggleMaskKeyframe: (objectId, maskId, property, frame) => {
      mutateMask(objectId, maskId, (mask) => {
        const animation = { ...(mask.animation ?? {}) };
        if (property === "path") {
          const existing = animation.path ?? [];
          animation.path = existing.some((key) => key.frame === frame)
            ? existing.filter((key) => key.frame !== frame)
            : [...existing, { id: createSceneId("maskkey"), frame, value: structuredClone(mask.path) }];
        } else if (property === "feather") {
          const existing = animation.feather ?? [];
          animation.feather = existing.some((key) => key.frame === frame)
            ? existing.filter((key) => key.frame !== frame)
            : [...existing, { id: createSceneId("maskkey"), frame, value: { ...mask.feather } }];
        } else {
          const existing = animation[property] ?? [];
          const value = property === "opacity" ? mask.opacity : mask.expansion;
          animation[property] = existing.some((key) => key.frame === frame)
            ? existing.filter((key) => key.frame !== frame)
            : [...existing, { id: createSceneId("maskkey"), frame, value }];
        }
        return { ...mask, animation };
      });
    },
    updateMaskKeyframeFrame: (objectId, maskId, property, keyframeId, frame) => {
      mutateMask(objectId, maskId, (mask) => {
        const animation = { ...(mask.animation ?? {}) };
        if (property === "path") {
          animation.path = (animation.path ?? []).map((key) => key.id === keyframeId ? { ...key, frame } : key);
        } else if (property === "feather") {
          animation.feather = (animation.feather ?? []).map((key) => key.id === keyframeId ? { ...key, frame } : key);
        } else if (property === "opacity") {
          animation.opacity = (animation.opacity ?? []).map((key) => key.id === keyframeId ? { ...key, frame } : key);
        } else {
          animation.expansion = (animation.expansion ?? []).map((key) => key.id === keyframeId ? { ...key, frame } : key);
        }
        return { ...mask, animation };
      });
    },
    toggleShapePathKeyframe: (objectId, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const existing = object.pathAnimation ?? [];
      const nextKeys = existing.some((key) => key.frame === frame)
        ? existing.filter((key) => key.frame !== frame)
        : [...existing, { id: createSceneId("pathkey"), frame, value: structuredClone(object.path) }];
      const updated: ShapeSceneObject = {
        ...object,
        pathAnimation: nextKeys.length > 0 ? nextKeys : undefined
      };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    setShapePathAnimationEnabled: (objectId, enabled, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const updated: ShapeSceneObject = {
        ...object,
        pathAnimation: enabled
          ? [{ id: createSceneId("pathkey"), frame, value: structuredClone(object.path) }]
          : undefined
      };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    updateShapePathKeyframeFrame: (objectId, keyframeId, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape" || !object.pathAnimation) return;
      const updated: ShapeSceneObject = {
        ...object,
        pathAnimation: object.pathAnimation.map((key) => key.id === keyframeId ? { ...key, frame } : key)
      };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    deleteShapePathKeyframe: (objectId, keyframeId) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape" || !object.pathAnimation) return;
      const nextKeys = object.pathAnimation.filter((key) => key.id !== keyframeId);
      const updated: ShapeSceneObject = {
        ...object,
        pathAnimation: nextKeys.length > 0 ? nextKeys : undefined
      };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    toggleShapeTrimKeyframe: (objectId, channel, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const currentValue = channel === "start" ? object.trimStart ?? 0 : channel === "end" ? object.trimEnd ?? 100 : object.trimOffset ?? 0;
      const animation = { ...(object.trimAnimation ?? {}) };
      const existing = animation[channel] ?? [];
      const nextKeys = existing.some((key) => key.frame === frame)
        ? existing.filter((key) => key.frame !== frame)
        : [...existing, { id: createSceneId("trimkey"), frame, value: currentValue }];
      animation[channel] = nextKeys;
      const anyKeys = (animation.start?.length ?? 0) + (animation.end?.length ?? 0) + (animation.offset?.length ?? 0) > 0;
      const updated: ShapeSceneObject = { ...object, trimAnimation: anyKeys ? animation : undefined };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    setShapeTrimAnimationEnabled: (objectId, channel, enabled, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const currentValue = channel === "start" ? object.trimStart ?? 0 : channel === "end" ? object.trimEnd ?? 100 : object.trimOffset ?? 0;
      const animation = { ...(object.trimAnimation ?? {}) };
      animation[channel] = enabled ? [{ id: createSceneId("trimkey"), frame, value: currentValue }] : undefined;
      const anyKeys = (animation.start?.length ?? 0) + (animation.end?.length ?? 0) + (animation.offset?.length ?? 0) > 0;
      const updated: ShapeSceneObject = { ...object, trimAnimation: anyKeys ? animation : undefined };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    setShapeTrimValue: (objectId, channel, value, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const keys = object.trimAnimation?.[channel];
      // A static channel writes the value; an animated one writes the key at the playhead,
      // adding one when there is none — the same rule the transform stopwatches follow.
      if (!keys?.length) {
        const patch = channel === "start" ? { trimStart: value } : channel === "end" ? { trimEnd: value } : { trimOffset: value };
        const updated: ShapeSceneObject = { ...object, ...patch };
        commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
        return;
      }
      const animation = { ...(object.trimAnimation ?? {}) };
      const existing = keys.findIndex((key) => key.frame === frame);
      animation[channel] = existing >= 0
        ? keys.map((key, index) => index === existing ? { ...key, value } : key)
        : [...keys, { id: createSceneId("trimkey"), frame, value }];
      const updated: ShapeSceneObject = { ...object, trimAnimation: animation };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    moveObjectInStack: (objectId, direction) => {
      const { scene } = get();
      commitScene(
        { ...scene, objects: moveObjectInStack(scene.objects, objectId, direction) },
        direction === "front" ? "Bring to front" : direction === "back" ? "Send to back" : `Move ${direction}`
      );
    },
    reorderObjectsInStack: (objectIds, targetId, placement) => {
      const { scene } = get();
      const objects = reorderObjectsInStack(scene.objects, objectIds, targetId, placement);
      if (objects === scene.objects) return;
      commitScene({ ...scene, objects }, objectIds.length > 1 ? `Reorder ${objectIds.length} objects` : "Reorder object");
    },
    applyObjectDrop: (objectIds, drop) => {
      const ids = [...objectIds];
      if (ids.length === 0 || !drop.targetId) return false;
      const { beginHistory, commitHistory } = get();

      // One transaction around the whole drop: a cross-parent move is three mutations, and three
      // undo steps for one gesture is the same defect as none.
      beginHistory(ids.length > 1 ? `Move ${ids.length} objects` : "Move object", "scene-manager");
      try {
        if (drop.kind === "into") {
          for (const id of ids) get().setContainerChild(drop.targetId, id, true);
          return true;
        }
        if (drop.kind === "into-layer") {
          for (const id of ids) get().moveObjectToLayer(id, drop.targetId);
          return true;
        }
        if (drop.kind !== "before" && drop.kind !== "after") return false;

        // A sibling placement may also be a reparent: the target's parent becomes theirs. Detach and
        // adopt first so the reorder that follows works inside the right container.
        const parent = parentOfObject(get().scene.objects, drop.targetId);
        for (const id of ids) {
          const currentParent = parentOfObject(get().scene.objects, id);
          if (currentParent?.id === parent?.id) continue;
          if (currentParent) get().setContainerChild(currentParent.id, id, false);
          if (parent) get().setContainerChild(parent.id, id, true);
          else get().moveObjectToLayer(id, get().scene.objects.find((object) => object.id === drop.targetId)?.layerId ?? "main");
        }
        get().reorderObjectsInStack(ids, drop.targetId, drop.kind);
        return true;
      } finally {
        commitHistory();
      }
    },
    updateObjectBindings: (objectId, bindings) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) =>
            object.id === objectId ? ({ ...object, bindings } as SceneObject) : object
          )
        })
      })),
    addObjectKeyframe: (objectId, frame) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);

      if (!object) {
        return;
      }

      const keyframe: SceneKeyframe = {
        id: createSceneId("kf"),
        objectId,
        frame,
        properties: createObjectSnapshot(object),
        easing: "linear"
      };

      set({
        scene: touchScene({
          ...scene,
          timeline: {
            ...scene.timeline,
            keyframes: [...scene.timeline.keyframes, keyframe].sort((a, b) => a.frame - b.frame)
          }
        })
      });
    },
    updateObjectKeyframe: (keyframeId, patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          timeline: {
            ...state.scene.timeline,
            keyframes: state.scene.timeline.keyframes.map((keyframe) =>
              keyframe.id === keyframeId ? { ...keyframe, ...patch } : keyframe
            )
          }
        })
      })),
    deleteObjectKeyframe: (keyframeId) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          timeline: {
            ...state.scene.timeline,
            keyframes: state.scene.timeline.keyframes.filter((keyframe) => keyframe.id !== keyframeId)
          }
        })
      })),
    // Enabling a stopwatch creates a key and disabling one destroys every key on the channel, so
    // both are undoable through `commitScene` rather than a bare `set`.
    setPropertyAnimationEnabled: (objectId, property, enabled, frame) => {
      const { scene } = get();
      commitScene({
        ...scene,
        objects: scene.objects.map((object) => {
          if (object.id !== objectId) return object;
          const animation = { ...(object.animation ?? {}) };

          if (enabled) {
            const key: PropertyKeyframe = {
              id: createSceneId("pkf"),
              frame: clampTimelineFrame(frame, scene.timeline.durationFrames),
              value: readAnimatableProperty(object, property),
              easing: "linear"
            };
            animation[property] = { keys: [key] };
          } else {
            delete animation[property];
          }

          return {
            ...object,
            animation: Object.keys(animation).length > 0 ? animation : undefined
          } as SceneObject;
        })
      });
    },
    // One undo step per call, and therefore one per *gesture* when the caller wraps its drag in
    // `beginHistory`/`commitHistory` — which the Object Manager's scrub and the Timeline both do.
    // Emitting this from a drag without a transaction would deposit an entry per pointer move.
    setAnimatedPropertyValue: (objectId, property, value, frame) => {
      const { scene } = get();
      commitScene({
        ...scene,
        objects: scene.objects.map((object) => {
          if (object.id !== objectId) return object;
          const nextObject = { ...object, [property]: value } as SceneObject;
          const channel = object.animation?.[property];

          if (!channel) return nextObject;

          const nextFrame = clampTimelineFrame(frame, scene.timeline.durationFrames);
          const existing = channel.keys.find((key) => key.frame === nextFrame);
          const nextKey: PropertyKeyframe = existing
            ? { ...existing, value }
            : {
                id: createSceneId("pkf"),
                frame: nextFrame,
                value,
                easing: "linear"
              };
          const keys = existing
            ? channel.keys.map((key) => key.id === existing.id ? nextKey : key)
            : [...channel.keys, nextKey];

          return {
            ...nextObject,
            animation: {
              ...object.animation,
              [property]: { keys: sortPropertyKeys(keys) }
            }
          } as SceneObject;
        })
      });
    },
    addPropertyKeyframe: (objectId, property, frame, value) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) => {
            if (object.id !== objectId) return object;
            const nextFrame = clampTimelineFrame(frame, state.scene.timeline.durationFrames);
            const channel = object.animation?.[property];
            const nextValue = value ?? readAnimatableProperty(object, property);
            const existing = channel?.keys.find((key) => key.frame === nextFrame);
            const nextKey: PropertyKeyframe = existing
              ? { ...existing, value: nextValue }
              : {
                  id: createSceneId("pkf"),
                  frame: nextFrame,
                  value: nextValue,
                  easing: "linear"
                };
            const keys = existing
              ? channel!.keys.map((key) => key.id === existing.id ? nextKey : key)
              : [...(channel?.keys ?? []), nextKey];

            return {
              ...object,
              animation: {
                ...object.animation,
                [property]: { keys: sortPropertyKeys(keys) }
              }
            } as SceneObject;
          })
        })
      })),
    updatePropertyKeyframe: (objectId, property, keyframeId, patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) => {
            if (object.id !== objectId) return object;
            const channel = object.animation?.[property];
            if (!channel) return object;
            const keys = channel.keys.map((key) =>
              key.id === keyframeId
                ? {
                    ...key,
                    ...patch,
                    frame: clampTimelineFrame(
                      patch.frame ?? key.frame,
                      state.scene.timeline.durationFrames
                    )
                  }
                : key
            );
            const updatedKey = keys.find((key) => key.id === keyframeId);
            const uniqueKeys = updatedKey
              ? keys.filter((key) => key.id === keyframeId || key.frame !== updatedKey.frame)
              : keys;

            return {
              ...object,
              animation: {
                ...object.animation,
                [property]: { keys: sortPropertyKeys(uniqueKeys) }
              }
            } as SceneObject;
          })
        })
      })),
    deletePropertyKeyframe: (objectId, property, keyframeId) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) => {
            if (object.id !== objectId) return object;
            const channel = object.animation?.[property];
            if (!channel) return object;

            return {
              ...object,
              animation: removePropertyKeyframe(object.animation, property, keyframeId)
            } as SceneObject;
          })
        })
      })),
    updateTimeline: (patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          timeline: {
            ...state.scene.timeline,
            ...patch
          }
        })
      })),
    addFontDefinition: (font, asset) => {
      get().addFontDefinitions([font], asset ? [asset] : []);
    },
    addFontDefinitions: (fonts, importedAssets = []) => {
      const { scene } = get();
      const assets = [...scene.assets];
      for (const asset of importedAssets) {
        const index = assets.findIndex((item) => item.assetId === asset.assetId);
        if (index >= 0) assets[index] = asset;
        else assets.push(asset);
      }
      const definitions = [...(scene.fonts ?? [])];
      for (const incoming of fonts) {
        const exactIndex = definitions.findIndex((font) => font.fontId === incoming.fontId);
        const familyIndex = definitions.findIndex((font) => font.family === incoming.family);
        const index = exactIndex >= 0 ? exactIndex : familyIndex;
        if (index < 0) {
          definitions.push(incoming);
          continue;
        }
        const current = definitions[index]!;
        const faces = [...current.faces];
        for (const face of incoming.faces) {
          const faceIndex = faces.findIndex((item) =>
            item.faceId === face.faceId
            || (item.weight === face.weight && item.style === face.style && item.stretch === face.stretch)
          );
          if (faceIndex >= 0) faces[faceIndex] = face;
          else faces.push(face);
        }
        definitions[index] = {
          ...current,
          ...incoming,
          fontId: current.fontId,
          displayName: current.displayName || incoming.displayName,
          fallbackFamilies: current.fallbackFamilies.length ? current.fallbackFamilies : incoming.fallbackFamilies,
          faces: faces.sort((left, right) => left.weight - right.weight || left.style.localeCompare(right.style))
        };
      }
      commitScene({
        ...scene,
        assets,
        fonts: definitions
      });
    },
    updateFontDefinition: (fontId, patch) => {
      const { scene } = get();
      commitScene({
        ...scene,
        fonts: (scene.fonts ?? []).map((font) => font.fontId === fontId
          ? { ...font, ...patch, fontId: font.fontId }
          : font)
      });
    },
    replaceFontDefinition: (fontId, replacement, importedAssets = []) => {
      const { scene } = get();
      const current = scene.fonts?.find((font) => font.fontId === fontId);
      if (!current) return false;
      const assets = [...scene.assets];
      for (const asset of importedAssets) {
        const index = assets.findIndex((item) => item.assetId === asset.assetId);
        if (index >= 0) assets[index] = asset;
        else assets.push(asset);
      }
      commitScene({
        ...scene,
        assets,
        fonts: (scene.fonts ?? []).map((font) => font.fontId === fontId
          ? {
              ...replacement,
              fontId,
              displayName: current.displayName,
              fallbackFamilies: current.fallbackFamilies,
              enabled: current.enabled ?? true
            }
          : font),
        objects: scene.objects.map((object) =>
          object.type === "text" && (object.fontId === fontId || (!object.fontId && object.fontFamily === current.family))
            ? {
                ...object,
                fontId,
                fontFamily: replacement.family,
                fallbackFamilies: current.fallbackFamilies
              }
            : object
        )
      });
      return true;
    },
    removeFontDefinition: (fontId) => {
      const { scene } = get();
      const font = scene.fonts?.find((item) => item.fontId === fontId);
      if (!font) return false;
      if (scene.objects.some((object) =>
        object.type === "text" && (object.fontId === fontId || (!object.fontId && object.fontFamily === font.family))
      )) {
        set({ materialActionError: `Font ${font.family} is still assigned to a text object.` });
        return false;
      }
      commitScene({ ...scene, fonts: (scene.fonts ?? []).filter((item) => item.fontId !== fontId) });
      return true;
    },
    assignFontToSelectedText: (fontId) => {
      const { scene, selectedObjectId } = get();
      const font = scene.fonts?.find((item) => item.fontId === fontId);
      const object = scene.objects.find((item) => item.id === selectedObjectId);
      if (!font || !object || object.type !== "text") {
        set({ materialActionError: "Select a text object before assigning a font." });
        return false;
      }
      const fileFace = font.faces.find((face) => face.source.kind === "file");
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === object.id
          ? ({
              ...item,
              fontId: font.fontId,
              fontFamily: font.family,
              fallbackFamilies: font.fallbackFamilies,
              fontWeight: nearestSupportedFontWeight(font.faces[0]?.weight ?? 400),
              fontAssetId: fileFace?.source.kind === "file" ? fileFace.source.assetId : undefined
            } as SceneObject)
          : item)
      });
      return true;
    },
    updateAutomation: (automation) => {
      const { scene } = get();
      commitScene({ ...scene, automation });
    },
    attachSceneScript: (script, asset) => {
      const { scene } = get();
      commitScene({
        ...scene,
        assets: scene.assets.some((item) => item.assetId === asset.assetId)
          ? scene.assets
          : [...scene.assets, asset],
        automation: {
          version: 1,
          transitions: scene.automation?.transitions ?? [],
          triggers: scene.automation?.triggers ?? [],
          script
        }
      });
    },
    assignMaterialSlot: (objectId, slotName, binding) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      const materialId = normalizePrimitiveMaterialBinding(binding)?.materialId;
      if (object && !materialId) {
        const materialSlots = { ...object.materialSlots };
        delete materialSlots[slotName];
        commitScene({
          ...scene,
          objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, materialSlots } as SceneObject) : item)
        });
        return;
      }
      const material = scene.materials.find((item) => item.materialId === materialId);
      if (!object || !material || !isMaterialCompatibleWithSlot(material, object, slotName)) {
        set({ materialActionError: "The selected material is not compatible with this primitive slot." });
        return;
      }
      commitScene({
        ...scene,
        objects: scene.objects.map((object) => object.id === objectId
          ? ({ ...object, materialSlots: { ...object.materialSlots, [slotName]: binding } } as SceneObject)
          : object)
      });
    },
    assignMaterialToObjects: (objectIds, materialId, slotName = "main") => {
      const { scene } = get();
      const material = scene.materials.find((item) => item.materialId === materialId);
      const selectedIds = new Set(objectIds);
      const selectedObjects = scene.objects.filter((object) => selectedIds.has(object.id));
      if (!material || !selectedObjects.length || selectedObjects.some((object) => !isMaterialCompatibleWithSlot(material, object, slotName))) {
        set({ materialActionError: "The material cannot be assigned because at least one selected primitive is incompatible." });
        return false;
      }
      commitScene({
        ...scene,
        objects: scene.objects.map((object) => selectedIds.has(object.id)
          ? ({ ...object, materialSlots: { ...object.materialSlots, [slotName]: materialId } } as SceneObject)
          : object)
      });
      return true;
    },
    assignAssetToObjects: (objectIds, assetId, slotName = "main") => {
      // XPression-style: double-clicking / dropping an imported image applies it
      // to the selected primitive. We back the asset with an image material
      // (reusing the one auto-created on import, or minting one if it was
      // deleted) so the renderer's material pipeline resolves the texture.
      // The material add + slot assignment land in a single history entry.
      const { scene } = get();
      const asset = scene.assets.find((item) => item.assetId === assetId);
      if (!asset) {
        set({ materialActionError: "The imported asset could not be found." });
        return false;
      }
      if (!["image", "svg"].includes(asset.kind)) {
        set({ materialActionError: `${asset.kind} assets can't be applied to a primitive directly yet.` });
        return false;
      }
      if (asset.status === "MISSING" || asset.status === "ERROR" || asset.status === "UNSUPPORTED") {
        set({ materialActionError: "This asset is missing or unsupported. Relink it before assigning." });
        return false;
      }
      const selectedIds = new Set(objectIds);
      const selectedObjects = scene.objects.filter((object) => selectedIds.has(object.id));
      if (!selectedObjects.length) {
        set({ materialActionError: "Select a primitive first, then double-click the image to apply it." });
        return false;
      }
      const existing = scene.materials.find((material) =>
        material.assetId === assetId || material.textureSlots?.some((slot) => slot.assetId === assetId));
      const material = existing ?? createMaterialDefinition(
        asset.name.replace(/\.[^.]+$/, ""),
        { baseTextureAssetId: assetId, alphaMode: materialAlphaModeForAsset(asset) }
      );
      if (selectedObjects.some((object) => !isMaterialCompatibleWithSlot(material, object, slotName))) {
        set({ materialActionError: "This image or texture is not compatible with the selected surface." });
        return false;
      }
      commitScene({
        ...scene,
        materials: existing ? scene.materials : [...scene.materials, material],
        objects: scene.objects.map((object) => selectedIds.has(object.id)
          ? ({ ...object, materialSlots: { ...object.materialSlots, [slotName]: material.materialId } } as SceneObject)
          : object)
      });
      set({ materialActionError: null });
      return true;
    },
    selectFace: (faceIndex, mode) => {
      const { selectedObjectId, scene, selectedFaceIndices, faceSelectionAnchor } = get();
      const object = scene.objects.find((item) => item.id === selectedObjectId);
      if (!object) return;
      const faces = getBindableFaces(object);
      if (!faces[faceIndex]) return;
      if (mode === "toggle") {
        const next = selectedFaceIndices.includes(faceIndex)
          ? selectedFaceIndices.filter((index) => index !== faceIndex)
          : [...selectedFaceIndices, faceIndex].sort((a, b) => a - b);
        set({ selectedFaceIndices: next, faceSelectionAnchor: faceIndex });
        return;
      }
      if (mode === "range") {
        const anchor = faceSelectionAnchor ?? faceIndex;
        const [lo, hi] = anchor <= faceIndex ? [anchor, faceIndex] : [faceIndex, anchor];
        const range: number[] = [];
        for (let index = lo; index <= hi; index += 1) {
          if (faces[index]) range.push(index);
        }
        set({ selectedFaceIndices: range, faceSelectionAnchor: anchor });
        return;
      }
      set({ selectedFaceIndices: [faceIndex], faceSelectionAnchor: faceIndex });
    },
    clearFaceSelection: () => set({ selectedFaceIndices: [], faceSelectionAnchor: null }),
    assignMaterial: (objectId, faceIndex, materialId) => get().assignMaterialToFaces(objectId, [faceIndex], materialId),
    assignMaterialToFaces: (objectId, faceIndices, binding) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object) {
        set({ materialActionError: "Select a compatible object or material face first." });
        return false;
      }
      const normalizedBinding = normalizePrimitiveMaterialBinding(binding);
      const materialId = normalizedBinding?.materialId;
      const material = materialId ? scene.materials.find((item) => item.materialId === materialId) : undefined;
      if (!material) {
        set({ materialActionError: "The material to bind could not be found." });
        return false;
      }
      if (normalizedBinding?.instanceId) {
        const instance = (scene.materialInstances ?? []).find(
          (item) => item.materialInstanceId === normalizedBinding.instanceId
        );
        if (!instance || instance.baseMaterialId !== material.materialId) {
          set({ materialActionError: "The material instance is missing or belongs to a different base material." });
          return false;
        }
      }
      const faces = getBindableFaces(object);
      // Default to the primary surface when no explicit face is required/selected.
      const targetIndices = faceIndices.length ? faceIndices : [0];
      const slotKeys: string[] = [];
      for (const index of targetIndices) {
        const face = faces[index];
        if (!face) {
          set({ materialActionError: "A selected face no longer exists on this object." });
          return false;
        }
        if (!isMaterialCompatibleWithFace(material, object, index)) {
          set({ materialActionError: `“${material.name}” is not compatible with the ${face.label} face.` });
          return false;
        }
        slotKeys.push(face.slotKey);
      }
      const materialSlots = { ...object.materialSlots };
      for (const key of slotKeys) materialSlots[key] = binding;
      // Single commitScene -> one undo entry, even for a multi-face assignment.
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, materialSlots } as SceneObject) : item)
      });
      set({ materialActionError: null });
      return true;
    },
    assignAssetToFaces: (objectId, faceIndices, assetId) => {
      // Face-aware counterpart of assignAssetToObjects: back the imported image
      // with an image material (reused or minted) and bind it to the selected
      // faces — the material add + all face slots land in ONE history entry.
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);

      /*
       * The asset may be a file the scene has never referenced.
       *
       * The Material Manager lists the project's asset folders, so the first thing an author does
       * with a logo they dropped in with Explorer is assign it — at which point the scene has to
       * start carrying it, because publishing packages `scene.assets` and the renderers resolve
       * textures from it.
       *
       * Adopted into the same `commitScene` below rather than through `adoptProjectAsset`, which
       * commits on its own: one gesture must be one undo. Two entries would make Ctrl+Z leave the
       * asset in the scene bound to nothing.
       */
      const assets = scene.assets.some((item) => item.assetId === assetId)
        ? scene.assets
        : adoptedProjectAssets(scene.assets, assetId);
      const asset = assets.find((item) => item.assetId === assetId);

      if (!object) {
        set({ materialActionError: "Select a compatible object or material face first." });
        return false;
      }
      if (!asset) {
        set({ materialActionError: "The imported asset could not be found." });
        return false;
      }
      if (!["image", "svg"].includes(asset.kind)) {
        set({ materialActionError: `${asset.kind} assets can't be applied to a face directly yet.` });
        return false;
      }
      if (asset.status === "MISSING" || asset.status === "ERROR" || asset.status === "UNSUPPORTED") {
        set({ materialActionError: "This asset is missing or unsupported. Relink it before assigning." });
        return false;
      }
      const existing = scene.materials.find((material) =>
        material.assetId === assetId || material.textureSlots?.some((slot) => slot.assetId === assetId));
      const material = existing ?? createMaterialDefinition(
        asset.name.replace(/\.[^.]+$/, ""),
        { baseTextureAssetId: assetId, alphaMode: materialAlphaModeForAsset(asset) }
      );
      const faces = getBindableFaces(object);
      const targetIndices = faceIndices.length ? faceIndices : [0];
      const slotKeys: string[] = [];
      for (const index of targetIndices) {
        const face = faces[index];
        if (!face) {
          set({ materialActionError: "A selected face no longer exists on this object." });
          return false;
        }
        if (!isMaterialCompatibleWithFace(material, object, index)) {
          set({ materialActionError: `This image can't be applied to the ${face.label} face.` });
          return false;
        }
        slotKeys.push(face.slotKey);
      }
      const materialSlots = { ...object.materialSlots };
      for (const key of slotKeys) materialSlots[key] = material.materialId;
      commitScene({
        ...scene,
        assets,
        materials: existing ? scene.materials : [...scene.materials, material],
        objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, materialSlots } as SceneObject) : item)
      });
      set({ materialActionError: null });
      return true;
    },
    unbindMaterial: (objectId, faceIndex) => get().unbindMaterialFromFaces(objectId, [faceIndex]),
    unbindMaterialFromFaces: (objectId, faceIndices) => {
      // Remove the object-level material binding for the given faces. This does
      // NOT delete the shared project material — it only clears the slot, so the
      // primitive returns to its default look and text returns to its font style.
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object) return;
      const faces = getBindableFaces(object);
      const materialSlots = { ...object.materialSlots };
      let changed = false;
      for (const index of (faceIndices.length ? faceIndices : [0])) {
        const key = faces[index]?.slotKey;
        if (key && key in materialSlots) {
          delete materialSlots[key];
          changed = true;
        }
      }
      if (!changed) return;
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, materialSlots } as SceneObject) : item)
      });
      set({ materialActionError: null });
    },
    getMaterial: (objectId, faceIndex) => {
      const object = get().scene.objects.find((item) => item.id === objectId);
      if (!object) return undefined;
      const key = faceSlotKey(object, faceIndex);
      return key ? getMaterialBindingId(object.materialSlots[key]) : undefined;
    },
    getBindableFaces: (objectId) => {
      const object = get().scene.objects.find((item) => item.id === objectId);
      return object ? getBindableFaces(object) : [];
    },
    getObjectsUsingMaterial: (materialId) => findMaterialUsage(get().scene, materialId).objectIds,
    importAsset: async (file) => {
      try {
        const { asset, shader } = await importMaterialAsset(file);
        const { scene } = get();
        const hasAsset = scene.assets.some((item) => item.assetId === asset.assetId);
        commitScene({
          ...scene,
          assets: hasAsset ? scene.assets.map((item) => item.assetId === asset.assetId ? asset : item) : [...scene.assets, asset],
          // XPression-style sources stay separate from reusable materials.
          // Applying an image to a face creates/reuses the one physical
          // backing material at assignment time.
          materials: scene.materials,
          shaders: shader ? [...(scene.shaders ?? []).filter((item) => item.shaderId !== shader.shaderId), shader] : scene.shaders
        });
        set({ materialActionError: null });
        return asset.assetId;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Asset import failed.";
        set({ materialActionError: message });
        return null;
      }
    },
    adoptProjectAsset: (reference) => {
      const { scene } = get();
      commitScene({ ...scene, assets: withProjectAsset(scene.assets, reference) });
      set({ materialActionError: null });
      return projectAssetId(reference.path);
    },
    relinkAsset: async (assetId, file) => {
      // Store new bytes under their content hash and keep the scene asset ID
      // stable. Undo can then restore the old metadata/source without losing
      // the previous binary.
      const { asset: importedAsset } = await importMaterialAsset(file);
      const asset = { ...importedAsset, assetId };
      const { scene } = get();
      commitScene({
        ...scene,
        assets: scene.assets.map((item) => item.assetId === assetId ? asset : item),
        objects: scene.objects.map((object) => object.type === "mesh" && object.modelAssetId === assetId
          ? {
              ...object,
              src: asset.source,
              materialElements: asset.modelMaterialNames ?? []
            }
          : object)
      });
      set({ materialActionError: null });
    },
    updateAsset: (assetId, patch) => {
      const { scene } = get();
      commitScene({
        ...scene,
        assets: scene.assets.map((asset) => asset.assetId === assetId ? { ...asset, ...patch } : asset)
      });
    },
    refreshAssetAvailability: async () => {
      const { scene } = get();
      const managedAssets = scene.assets.filter((asset) => asset.sourcePath?.startsWith("assets/"));
      const results = new Map<string, boolean>();
      await Promise.all(managedAssets.map(async (asset) => {
        results.set(asset.assetId, await assetExistsOnApi(asset.storageAssetId ?? asset.assetId));
      }));
      const current = get().scene;
      set({
        scene: {
          ...current,
          assets: current.assets.map((asset) => results.has(asset.assetId)
            ? {
                ...asset,
                status: results.get(asset.assetId) ? "READY" : "MISSING",
                error: results.get(asset.assetId) ? undefined : "The stored source could not be found. Use Relink Asset to restore it."
              }
            : asset)
        }
      });
    },
    deleteAsset: (assetId) => {
      const { scene } = get();
      const usage = findAssetUsageDetails(scene, assetId);
      if (usage.materialIds.length || usage.shaderIds.length || usage.objectIds.length) {
        set({ materialActionError: `Asset is used by ${usage.materialIds.length} material(s), ${usage.shaderIds.length} shader(s), and ${usage.objectIds.length} scene object(s). Relink it or remove those references first.` });
        return false;
      }
      commitScene({ ...scene, assets: scene.assets.filter((asset) => asset.assetId !== assetId) });
      set({ materialActionError: null });
      return true;
    },
    createMaterial: (assetId) => {
      const { scene } = get();
      const material = createMaterialDefinition(
        "New Material",
        assetId ? { baseTextureAssetId: assetId } : {}
      );
      commitScene({ ...scene, materials: [...scene.materials, material] });
      set({ materialActionError: null });
      return material.materialId;
    },
    duplicateMaterial: (materialId) => {
      const { scene } = get();
      const material = scene.materials.find((item) => item.materialId === materialId);
      if (!material) return null;
      const timestamp = new Date().toISOString();
      const duplicated = normalizeMaterial({
        ...structuredClone(material),
        materialId: createSceneId("mat"),
        name: `${material.name} Copy`,
        builtIn: false,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      commitScene({ ...scene, materials: [...scene.materials, duplicated] });
      return duplicated.materialId;
    },
    deleteMaterial: (materialId) => {
      const { scene } = get();
      const material = scene.materials.find((item) => item.materialId === materialId);
      if (material?.builtIn) {
        set({ materialActionError: "Built-in materials cannot be deleted; duplicate one to create an editable project material." });
        return false;
      }
      const usage = findMaterialUsage(scene, materialId);
      if (usage.objectIds.length || usage.instanceIds.length) {
        const details = [
          usage.objectIds.length ? `${usage.objectIds.length} primitive${usage.objectIds.length === 1 ? "" : "s"}` : "",
          usage.instanceIds.length ? `${usage.instanceIds.length} instance${usage.instanceIds.length === 1 ? "" : "s"}` : ""
        ].filter(Boolean).join(" and ");
        set({ materialActionError: `Material is still used by ${details}.` });
        return false;
      }
      commitScene({ ...scene, materials: scene.materials.filter((material) => material.materialId !== materialId) });
      set({ materialActionError: null });
      return true;
    },
    deleteUnusedMaterials: () => {
      const { scene } = get();
      const unusedIds = new Set(scene.materials
        .filter((material) => {
          if (material.builtIn) return false;
          const usage = findMaterialUsage(scene, material.materialId);
          return usage.objectIds.length === 0 && usage.instanceIds.length === 0;
        })
        .map((material) => material.materialId));
      if (!unusedIds.size) return 0;
      commitScene({
        ...scene,
        materials: scene.materials.filter((material) => !unusedIds.has(material.materialId))
      });
      set({ materialActionError: null });
      return unusedIds.size;
    },
    updateMaterial: (materialId, patch) => {
      const { scene } = get();
      commitScene({
        ...scene,
        materials: scene.materials.map((material) => material.materialId === materialId
          ? normalizeMaterial({ ...material, ...patch, updatedAt: new Date().toISOString() })
          : material)
      });
    },
    createMaterialInstance: (baseMaterialId) => {
      const { scene } = get();
      const material = scene.materials.find((item) => item.materialId === baseMaterialId);
      if (!material) return null;
      const timestamp = new Date().toISOString();
      const instance: MaterialInstance = {
        materialInstanceId: createSceneId("matinst"),
        name: `${material.name} Instance`,
        baseMaterialId,
        parameterOverrides: {},
        textureOverrides: {},
        createdAt: timestamp,
        updatedAt: timestamp
      };
      commitScene({ ...scene, materialInstances: [...(scene.materialInstances ?? []), instance] });
      return instance.materialInstanceId;
    },
    deleteMaterialInstance: (instanceId) => {
      const { scene } = get();
      const usedBy = scene.objects.filter((object) => Object.values(object.materialSlots).some((binding) => normalizePrimitiveMaterialBinding(binding)?.instanceId === instanceId));
      if (usedBy.length) {
        set({ materialActionError: `Material instance is still assigned to ${usedBy.length} primitive${usedBy.length === 1 ? "" : "s"}.` });
        return false;
      }
      commitScene({ ...scene, materialInstances: (scene.materialInstances ?? []).filter((instance) => instance.materialInstanceId !== instanceId) });
      return true;
    },
    updateMaterialInstance: (instanceId, patch) => {
      const { scene } = get();
      commitScene({
        ...scene,
        materialInstances: (scene.materialInstances ?? []).map((instance) => instance.materialInstanceId === instanceId
          ? { ...instance, ...patch, updatedAt: new Date().toISOString() }
          : instance)
      });
    },
    setMaterialInstanceParameter: (instanceId, name, value) => {
      const { scene } = get();
      commitScene({
        ...scene,
        materialInstances: (scene.materialInstances ?? []).map((instance) => {
          if (instance.materialInstanceId !== instanceId) return instance;
          const parameterOverrides = { ...instance.parameterOverrides };
          if (value === undefined) delete parameterOverrides[name];
          else parameterOverrides[name] = value;
          return { ...instance, parameterOverrides, updatedAt: new Date().toISOString() };
        })
      });
    },
    /**
     * Move an object, **and everything inside it**, to a compositing band.
     *
     * The subtree travels because all three renderers sort `layerId` before depth: leaving a group's
     * children in the old band would draw them detached from the group that positions them. This had
     * no callers when it moved one object, which is why the defect never showed.
     *
     * It also detaches from any parent. A container's children follow it *because it moved*; an
     * object dropped straight onto a band is being taken out of its group on purpose.
     */
    moveObjectToLayer: (objectId, layerId) => {
      const targetLayer = normalizeLayerId(layerId);
      const { scene } = get();
      const target = scene.objects.find((object) => object.id === objectId);

      if (!targetLayer || !target) {
        return;
      }

      const parent = parentOfObject(scene.objects, objectId);
      if (target.layerId === targetLayer && !parent) {
        return;
      }

      const travelling = collectContainerSubtreeIds(scene.objects, objectId);
      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) => {
            const next = travelling.has(object.id)
              ? ({ ...object, layerId: targetLayer } as SceneObject)
              : object;
            // Drop the moved id from whatever container claimed it.
            return isContainerObject(next) && next.childIds.includes(objectId)
              ? ({ ...next, childIds: next.childIds.filter((id) => id !== objectId) } as SceneObject)
              : next;
          })
        )
      }, `Move ${target.name} to layer`);
    },
    createLayerForObject: (objectId) => {
      const { scene } = get();
      const target = scene.objects.find((object) => object.id === objectId);

      if (!target) {
        return null;
      }

      const existing = new Set(scene.objects.map((object) => object.layerId || "main"));
      let index = existing.size + 1;
      let layerId = `layer-${index}`;

      while (existing.has(layerId)) {
        index += 1;
        layerId = `layer-${index}`;
      }

      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.id === objectId ? ({ ...object, layerId } as SceneObject) : object
          )
        )
      });

      return layerId;
    },
    renameLayer: (layerId, nextLayerId) => {
      const targetLayer = normalizeLayerId(nextLayerId);
      const { scene } = get();

      if (!targetLayer || !scene.objects.some((object) => object.layerId === layerId)) {
        return false;
      }
      if (targetLayer === layerId) return true;
      if (scene.objects.some((object) => object.layerId === targetLayer)) {
        return false;
      }

      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.layerId === layerId ? ({ ...object, layerId: targetLayer } as SceneObject) : object
          )
        )
      });
      return true;
    },
    deleteLayer: (layerId) => {
      const { scene } = get();

      // Deleting a layer keeps its objects: they move back to Main. Deleting
      // objects is a separate, explicit action.
      if (layerId === "main" || !scene.objects.some((object) => object.layerId === layerId)) {
        return;
      }

      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.layerId === layerId ? ({ ...object, layerId: "main" } as SceneObject) : object
          )
        )
      });
    },
    setLayerVisibility: (layerId, visible) => {
      const { scene } = get();

      if (!scene.objects.some((object) => object.layerId === layerId)) {
        return;
      }

      commitScene({
        ...scene,
        objects: scene.objects.map((object) =>
          object.layerId === layerId ? ({ ...object, visible } as SceneObject) : object
        )
      });
    },
    setLayerLocked: (layerId, locked) => {
      const { scene } = get();

      if (!scene.objects.some((object) => object.layerId === layerId)) {
        return;
      }

      commitScene({
        ...scene,
        objects: scene.objects.map((object) =>
          object.layerId === layerId ? ({ ...object, locked } as SceneObject) : object
        )
      });
    },
    saveGradientPreset: (name, value) => {
      const state = get();
      const presetId = createSceneId("gradient");
      commitScene({
        ...state.scene,
        gradientPresets: [
          ...(state.scene.gradientPresets ?? []),
          { presetId, name: name.trim() || "Custom gradient", value }
        ]
      });
      return presetId;
    },
    updateGradientPreset: (presetId, patch) => {
      const state = get();
      if (!(state.scene.gradientPresets ?? []).some((preset) => preset.presetId === presetId)) return;
      commitScene({
        ...state.scene,
        gradientPresets: (state.scene.gradientPresets ?? []).map((preset) =>
          preset.presetId === presetId
            ? {
                ...preset,
                ...patch,
                name: patch.name === undefined ? preset.name : patch.name.trim() || "Custom gradient"
              }
            : preset
        )
      });
    },
    duplicateGradientPreset: (presetId) => {
      const state = get();
      const source = (state.scene.gradientPresets ?? []).find((preset) => preset.presetId === presetId);
      if (!source) return null;
      const duplicateId = createSceneId("gradient");
      commitScene({
        ...state.scene,
        gradientPresets: [
          ...(state.scene.gradientPresets ?? []),
          {
            ...structuredClone(source),
            presetId: duplicateId,
            name: `${source.name} copy`
          }
        ]
      });
      return duplicateId;
    },
    deleteGradientPreset: (presetId) => {
      const state = get();
      commitScene({
        ...state.scene,
        gradientPresets: (state.scene.gradientPresets ?? []).filter((preset) => preset.presetId !== presetId)
      });
    },
    beginHistory: (label, scope) => {
      const state = get();
      if (!state.historyTransaction) {
        set({ historyTransaction: { label, scope: scope ?? state.historyScope ?? undefined, scene: state.scene } });
      }
    },
    commitHistory: () => {
      const state = get();
      const transaction = state.historyTransaction;
      if (!transaction) return;
      // A gesture that changed nothing deposits nothing: a click that never dragged must not leave
      // an empty step for the author to undo twice.
      const unchanged = state.scene === transaction.scene;
      set({
        undoStack: unchanged
          ? state.undoStack
          : appendSceneHistory(state.undoStack, {
              scene: transaction.scene,
              label: transaction.label,
              scope: transaction.scope
            }),
        redoStack: unchanged ? state.redoStack : [],
        historyTransaction: null
      });
    },
    cancelHistory: () => {
      const transaction = get().historyTransaction;
      if (!transaction) return;
      set({
        scene: transaction.scene,
        historyTransaction: null
      });
    },
    setHistoryScope: (historyScope) => {
      if (get().historyScope !== historyScope) set({ historyScope });
    },
    undo: () => {
      const state = get();
      // A transaction that is still open means a gesture is in flight — a drag, a scrub, an
      // unfinished pen path. "Undo" then means "abandon what I am doing", not "pop the stack": the
      // gesture has not been committed, so popping would take back the *previous* change and leave
      // the half-finished one standing.
      if (state.historyTransaction) {
        set({ scene: state.historyTransaction.scene, historyTransaction: null });
        return;
      }
      const snapshot = undoSceneHistory(state.scene, state.undoStack, state.redoStack);
      if (!snapshot) return;
      set({
        ...snapshot,
        // A restored scene may not contain everything that was selected — undoing an insert is
        // exactly that case — so the selection is pruned in the same update.
        ...selectionAfterRemoval(state, snapshot.scene.objects),
        historyTransaction: null,
        materialActionError: null
      });
    },
    redo: () => {
      const state = get();
      const snapshot = redoSceneHistory(state.scene, state.undoStack, state.redoStack);
      if (!snapshot) return;
      set({
        ...snapshot,
        ...selectionAfterRemoval(state, snapshot.scene.objects),
        historyTransaction: null,
        materialActionError: null
      });
    },
    setDataJson: (json) => set({ dataJson: json }),
    applyDataJson: () => {
      const dataJson = get().dataJson;

      try {
        const data = JSON.parse(dataJson) as Record<string, unknown>;
        set((state) => ({
          scene: touchScene({ ...state.scene, dataContext: data }),
          dataError: null
        }));
        return true;
      } catch (error) {
        set({
          dataError: error instanceof Error ? error.message : "Invalid JSON"
        });
        return false;
      }
    },
    loadScene: (scene) => {
      const normalized = normalizeScene(scene);
      const selectedObject = normalized.objects[0];
      set({
        scene: touchScene(normalized),
        hasActiveScene: true,
        ...selectionOf(selectedObject?.id ?? null),
        ...materialFaceSelection(selectedObject),
        dataJson: JSON.stringify(normalized.dataContext, null, 2),
        dataError: null,
        undoStack: [],
        redoStack: [],
        historyTransaction: null,
        materialActionError: null
      });
    },
    applyImportedScene: (incoming, mode) => {
      const state = get();
      const imported = normalizeScene(incoming);
      const next = mode === "merge" && state.hasActiveScene
        ? mergeImportedScene(state.scene, imported)
        : imported;
      commitScene(next);
      set({
        hasActiveScene: true,
        ...selectionOf(imported.objects[0]?.id ?? null),
        dataJson: JSON.stringify(next.dataContext, null, 2),
        dataError: null,
        historyTransaction: null,
        saveStatus: "local",
        saveError: null
      });
    },
    resetScene: () => {
      const scene = createEmptyScene();
      set({
        scene,
        hasActiveScene: true,
        ...selectionOf(null),
        selectedFaceIndices: [],
        faceSelectionAnchor: null,
        dataJson: JSON.stringify(scene.dataContext, null, 2),
        dataError: null,
        undoStack: [],
        redoStack: [],
        historyTransaction: null,
        materialActionError: null
      });
    },
    clearScene: () => {
      const scene = createEmptyScene();
      set({
        scene,
        hasActiveScene: false,
        ...selectionOf(null),
        selectedFaceIndices: [],
        faceSelectionAnchor: null,
        dataJson: JSON.stringify(scene.dataContext, null, 2),
        dataError: null,
        saveStatus: "local",
        saveError: null,
        undoStack: [],
        redoStack: [],
        historyTransaction: null,
        materialActionError: null
      });
    }
  };

  /**
   * Write the scene as one history step.
   *
   * Inside an open transaction it deposits nothing — the transaction owns the step — which is what
   * lets a drag emit a hundred of these and still be one undo. Outside one, the entry is credited to
   * the ambient `historyScope`, so a change made in a panel is attributed without every mutation in
   * this store having to name itself. `label` is optional: an unlabelled step still undoes, the UI
   * just says "Undo" rather than "Undo Delete 3 objects".
   */
  function commitScene(scene: SceneDocument, label?: string) {
    const state = get();
    set({
      scene: touchScene(scene),
      undoStack: state.historyTransaction
        ? state.undoStack
        : appendSceneHistory(state.undoStack, {
            scene: state.scene,
            label,
            scope: state.historyScope ?? undefined
          }),
      redoStack: state.historyTransaction ? state.redoStack : [],
      materialActionError: null
    });
  }

  /**
   * The selection fields for "exactly this object, or nothing".
   *
   * A spread rather than a call to `applySelection`, because every caller is a scene-lifecycle
   * `set` that also replaces the scene: reading the *old* scene to validate the id would be
   * wrong, and issuing a second `set` would paint an intermediate frame.
   */
  function selectionOf(objectId: string | null): Partial<EditorState> {
    return {
      selectedObjectIds: objectId ? [objectId] : [],
      selectedObjectId: objectId,
      objectSelectionAnchorId: objectId
    };
  }

  /**
   * The one place the selection is written.
   *
   * Ids that no longer exist are dropped before normalising, so a caller working from a stale
   * render cannot install a selection of ghosts. Order is **document order** — the order
   * `scene.objects` is in — because that is the only order the store can know: what is on screen
   * depends on a search and a collapse state that belong to the panel. Gesture callers pass their
   * own visible rows to `reduceObjectSelection`, so ranges still mean what the author sees.
   */
  function applySelection(
    ids: readonly string[],
    options?: { active?: string | null; anchor?: string | null }
  ): void {
    const state = get();
    const existing = new Set(state.scene.objects.map((object) => object.id));
    const present = ids.filter((id) => existing.has(id));
    const requestedActive = options?.active === undefined ? present.at(-1) ?? null : options.active;
    const selection = normaliseObjectSelection(
      {
        selectedObjectIds: present,
        activeObjectId: requestedActive,
        anchorId: options?.anchor ?? requestedActive ?? null
      },
      { rows: state.scene.objects.map((object) => object.id) }
    );

    set({
      selectedObjectIds: selection.selectedObjectIds,
      selectedObjectId: selection.activeObjectId,
      objectSelectionAnchorId: selection.anchorId,
      // The face choice belongs to the active object, so it survives a selection that keeps the
      // same active object — adding a sibling must not reset which face Materials is editing —
      // and resets when the active object changes.
      ...(selection.activeObjectId === state.selectedObjectId
        ? {}
        : materialFaceSelection(state.scene.objects.find((item) => item.id === selection.activeObjectId)))
    });
  }

  /**
   * The selection fields to merge into a `set` that removes objects.
   *
   * Called from inside the same update as the mutation, never from an effect: a reconciling effect
   * paints one frame in which the alignment toolbar counts deleted ids. "Above" is measured within
   * the selection itself, which is exactly "the one you had selected before this one".
   */
  function selectionAfterRemoval(state: EditorState, remaining: readonly SceneObject[]): Partial<EditorState> {
    const existing = new Set(remaining.map((object) => object.id));
    const current: ObjectSelection = {
      selectedObjectIds: state.selectedObjectIds,
      activeObjectId: state.selectedObjectId,
      anchorId: state.objectSelectionAnchorId
    };
    const next = reconcileObjectSelection(current, existing, state.selectedObjectIds);

    return {
      selectedObjectIds: next.selectedObjectIds,
      selectedObjectId: next.activeObjectId,
      objectSelectionAnchorId: next.anchorId,
      ...(next.activeObjectId === state.selectedObjectId
        ? {}
        : materialFaceSelection(remaining.find((item) => item.id === next.activeObjectId)))
    };
  }

  /**
   * Move a set of objects in one history entry.
   *
   * `x`/`y` is the anchor's world position and bounds translate rigidly with it, so a bounds
   * delta *is* a position delta — no inverse transform, and correct for a rotated or scaled
   * object. Rotation, scale, anchor, hierarchy, masks, animation channels and bindings are all
   * untouched: alignment moves an object, it does not re-author it.
   */
  function applyMoves(moves: readonly { id: string; dx: number; dy: number }[], label: string): number {
    if (moves.length === 0) return 0;
    const { scene } = get();
    const byId = new Map(moves.map((move) => [move.id, move]));

    commitScene({
      ...scene,
      objects: scene.objects.map((object) => {
        const move = byId.get(object.id);
        return move ? { ...object, x: object.x + move.dx, y: object.y + move.dy } : object;
      })
    });
    void label;
    return moves.length;
  }

  function addMaskToObject(
    objectId: string,
    path: BezierPath,
    patch: Partial<ObjectMask> = {}
  ): string | null {
    const { scene } = get();
    const object = scene.objects.find((item) => item.id === objectId);
    if (!object) return null;
    const mask: ObjectMask = {
      id: createSceneId("mask"),
      name: `Mask ${(object.masks?.length ?? 0) + 1}`,
      path,
      mode: "add",
      inverted: false,
      opacity: 1,
      expansion: 0,
      feather: { x: 0, y: 0 },
      type: "bezier",
      visible: true,
      locked: false,
      editorColor: "#f5b942",
      ...patch
    };
    const masks = [...(object.masks ?? []), mask];
    commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, masks } as SceneObject) : item) });
    return mask.id;
  }

  function mutateMask(objectId: string, maskId: string, mutate: (mask: ObjectMask) => ObjectMask): void {
    const { scene } = get();
    const object = scene.objects.find((item) => item.id === objectId);
    if (!object || !object.masks) return;
    const masks = object.masks.map((mask) => mask.id === maskId ? mutate(mask) : mask);
    commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? ({ ...item, masks } as SceneObject) : item) });
  }

  function addObject(object: SceneObject) {
    const { scene, hasActiveScene } = get();
    if (!hasActiveScene) return;
    const layerObjects = scene.objects.filter((item) => item.layerId === object.layerId);
    const objectWithStack = {
      ...object,
      name: nextUniqueObjectName(scene.objects, object.name),
      zIndex: layerObjects.reduce((highest, item) => Math.max(highest, item.zIndex), -1) + 1
    } as SceneObject;

    // `commitScene` rather than a bare `set`, so inserting an object is undoable. Inside an open
    // history transaction it deposits nothing, which is what keeps a gesture one undo step.
    commitScene({
      ...scene,
      objects: normalizeObjectStack([...scene.objects, objectWithStack]),
      activeCameraId: objectWithStack.type === "camera" && !scene.activeCameraId
        ? objectWithStack.id
        : scene.activeCameraId
    }, `Add ${objectWithStack.name}`);
    applySelection([objectWithStack.id]);
  }

  function duplicateObjectById(objectId: string) {
    const { scene } = get();
    const selected = scene.objects.find((object) => object.id === objectId);

    if (!selected) {
      return;
    }

    const duplicated = {
      ...selected,
      animation: clonePropertyAnimation(selected.animation),
      id: createObjectId(selected.type),
      name: nextUniqueObjectName(scene.objects, selected.name),
      x: selected.x + 48,
      y: selected.y + 48,
      zIndex: selected.zIndex + 1,
      locked: false,
      ...((selected.type === "layer" || selected.type === "group") ? { childIds: [] } : {})
    } as SceneObject;
    const duplicatedKeyframes = scene.timeline.keyframes
      .filter((keyframe) => keyframe.objectId === selected.id)
      .map((keyframe) => ({
        ...keyframe,
        id: createSceneId("kf"),
        objectId: duplicated.id
      }));

    commitScene({
      ...scene,
      objects: normalizeObjectStack([...scene.objects, duplicated]),
      timeline: {
        ...scene.timeline,
        keyframes: [...scene.timeline.keyframes, ...duplicatedKeyframes]
      }
    }, `Duplicate ${selected.name}`);
    applySelection([duplicated.id]);
  }

  function deleteObjectById(objectId: string) {
    const state = get();
    const { scene } = state;
    const nextActiveCameraId = scene.activeCameraId === objectId
      ? scene.objects.find((object) => object.id !== objectId && object.type === "camera" && object.visible)?.id
      : scene.activeCameraId;
    const remainingObjects = scene.objects
      .filter((object) => object.id !== objectId)
      .map((object) => isContainerObject(object) && object.childIds.includes(objectId)
        ? ({ ...object, childIds: object.childIds.filter((id) => id !== objectId) } as SceneObject)
        : object);

    // The selection is reconciled in the same update as the removal. An effect would paint one
    // frame in which the toolbar and the alignment tools count an object that is already gone.
    commitScene({
      ...scene,
      activeCameraId: nextActiveCameraId,
      objects: normalizeObjectStack(remainingObjects),
      timeline: {
        ...scene.timeline,
        keyframes: scene.timeline.keyframes.filter((keyframe) => keyframe.objectId !== objectId)
      }
    }, "Delete object");
    set(selectionAfterRemoval(state, remainingObjects));
  }
});

function createEmptyScene(): SceneDocument {
  const timestamp = new Date().toISOString();

  return normalizeScene({
    id: createSceneId("empty"),
    name: "Untitled Scene",
    version: 1,
    canvas: {
      width: 1920,
      height: 1080,
      // Transparent program output reveals the editor-only checkerboard. A
      // scene background remains an authored object/property, not hidden
      // viewport chrome baked into every new template.
      background: "#77777700"
    },
    dataContext: {},
    assets: [],
    materials: [],
    materialInstances: [],
    shaders: [],
    materialFolders: [],
    objects: [],
    timeline: createDefaultTimeline(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function mergeImportedScene(current: SceneDocument, imported: SceneDocument): SceneDocument {
  const existingIds = new Set(current.objects.map((object) => object.id));
  const idMap = new Map<string, string>();
  for (const object of imported.objects) {
    idMap.set(object.id, existingIds.has(object.id) ? createSceneId("import-object") : object.id);
  }
  const objects = imported.objects.map((object) => {
    const id = idMap.get(object.id)!;
    const remapped = {
      ...structuredClone(object),
      id,
      layerId: idMap.get(object.layerId) ?? object.layerId,
      ...(object.type === "group" || object.type === "layer"
        ? { childIds: object.childIds.map((childId) => idMap.get(childId) ?? childId) }
        : {})
    } as SceneObject;
    return remapped;
  });
  const uniqueById = <T, K extends keyof T>(left: T[], right: T[], key: K): T[] => {
    const seen = new Set(left.map((item) => String(item[key])));
    return [...left, ...right.filter((item) => !seen.has(String(item[key])))];
  };
  return {
    ...current,
    assets: uniqueById(current.assets, imported.assets, "assetId"),
    materials: uniqueById(current.materials, imported.materials, "materialId"),
    materialInstances: uniqueById(current.materialInstances ?? [], imported.materialInstances ?? [], "materialInstanceId"),
    fonts: uniqueById(current.fonts ?? [], imported.fonts ?? [], "fontId"),
    gradientPresets: uniqueById(current.gradientPresets ?? [], imported.gradientPresets ?? [], "presetId"),
    objects: normalizeObjectStack(ensureUniqueObjectNames([...current.objects, ...objects])),
    dataContext: {
      ...current.dataContext,
      importedDesigns: [
        ...((current.dataContext.importedDesigns as unknown[] | undefined) ?? []),
        imported.dataContext.__designImport
      ]
    }
  };
}

function createTextObject(patch: Partial<TextSceneObject> = {}): TextSceneObject {
  return {
    ...createBaseObject("text"),
    type: "text",
    name: "Text",
    text: "Text",
    width: 420,
    height: 72,
    fill: "#f7fbff",
    fillStyle: { type: "solid", color: "#f7fbff" },
    stroke: "transparent",
    strokeStyle: { type: "solid", color: "transparent" },
    fontSize: 48,
    fontFamily: "Inter, Arial, sans-serif",
    fontWeight: "700",
    fontStyle: "normal",
    textDecoration: {},
    textLayout: "point",
    writingMode: "horizontal-tb",
    verticalAlign: "top",
    direction: "ltr",
    lineHeight: 1.2,
    letterSpacing: 0,
    wordSpacing: 0,
    paragraphSpacing: 0,
    textIndent: 0,
    overflow: "visible",
    align: "left",
    ...patch
  };
}

function createPaintObject(patch: Partial<PaintSceneObject> = {}): PaintSceneObject {
  return {
    ...createBaseObject("paint"),
    type: "paint",
    name: "Paint Layer",
    width: 1920,
    height: 1080,
    fill: "transparent",
    stroke: "transparent",
    strokes: [],
    paintBlendMode: "normal",
    ...patch
  };
}

function createRectObject(patch: Partial<RectSceneObject> = {}): RectSceneObject {
  return {
    ...createBaseObject("rect"),
    type: "rect",
    name: "Rectangle",
    radius: 10,
    ...patch
  };
}

function createShapeObject(patch: Partial<ShapeSceneObject> = {}): ShapeSceneObject {
  // Default sample = a smooth closed "rounded diamond" bezier so a new shape is
  // visibly a curve, not a polygon. The pen tool (S-2) replaces this by author.
  const defaultPath: BezierPath = {
    closed: true,
    vertices: [
      { x: 100, y: 10 },
      { x: 190, y: 90 },
      { x: 100, y: 170 },
      { x: 10, y: 90 }
    ],
    outTangents: [
      { x: 50, y: 0 },
      { x: 0, y: 50 },
      { x: -50, y: 0 },
      { x: 0, y: -50 }
    ],
    inTangents: [
      { x: -50, y: 0 },
      { x: 0, y: -50 },
      { x: 50, y: 0 },
      { x: 0, y: 50 }
    ]
  };
  const path = patch.path ?? defaultPath;
  const bounds = bezierPathBounds(path);
  // Both colour layers go through `withColorStyles`, so a colour named here or by the caller is
  // the colour that gets drawn. Without it the base object's unassigned `fillStyle` outlived every
  // fill a factory asked for, because the renderers read the rich style first.
  return {
    ...createBaseObject("shape"),
    ...withColorStyles({
      type: "shape",
      name: "Shape",
      width: bounds.width || 180,
      height: bounds.height || 160,
      stroke: "#f7fbff",
      strokeWidth: 0,
      path,
      fillEnabled: true,
      strokeEnabled: false,
      fillRule: "nonzero"
    }),
    ...withColorStyles(patch)
  } as ShapeSceneObject;
}

function fitShapeToPath(object: ShapeSceneObject, path: BezierPath): ShapeSceneObject {
  const bounds = bezierPathBounds(path);
  const offset = { x: bounds.x, y: bounds.y };
  const shiftedPath = offset.x === 0 && offset.y === 0
    ? path
    : {
        ...path,
        vertices: path.vertices.map((vertex) => ({
          x: vertex.x - offset.x,
          y: vertex.y - offset.y
        }))
      };
  const anchor = object.anchor ?? { x: 0, y: 0 };
  let pathAnimation = object.pathAnimation;
  if (pathAnimation !== undefined) {
    const currentFrame = useUiStore.getState().currentFrame;
    const existingIndex = pathAnimation.findIndex((key) => key.frame === currentFrame);
    if (existingIndex >= 0) {
      pathAnimation = pathAnimation.map((key, index) =>
        index === existingIndex ? { ...key, value: structuredClone(shiftedPath) } : key
      );
    } else {
      pathAnimation = [
        ...pathAnimation,
        { id: createSceneId("pathkey"), frame: currentFrame, value: structuredClone(shiftedPath) }
      ];
    }
  }
  return {
    ...object,
    path: shiftedPath,
    ...(pathAnimation !== undefined ? { pathAnimation } : {}),
    anchor: {
      x: anchor.x - offset.x,
      y: anchor.y - offset.y
    },
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height)
  };
}
/** Keep the three parallel path arrays structurally valid at every store boundary. */
function normalizeBezierPathArrays(path: BezierPath): BezierPath {
  const tangentAt = (tangents: readonly Vec2[], index: number): Vec2 => tangents[index] ?? { x: 0, y: 0 };
  return {
    ...path,
    vertices: path.vertices.map((vertex) => ({ ...vertex })),
    inTangents: path.vertices.map((_, index) => ({ ...tangentAt(path.inTangents, index) })),
    outTangents: path.vertices.map((_, index) => ({ ...tangentAt(path.outTangents, index) }))
  };
}

/** A visible, editable inner ring rather than an empty subpath the author cannot grab. */
function createInsetSubpath(primary: BezierPath): BezierPath {
  const bounds = bezierPathBounds(primary);
  const width = Math.max(20, bounds.width || 80);
  const height = Math.max(20, bounds.height || 80);
  const left = bounds.x + width * 0.3;
  const right = bounds.x + width * 0.7;
  const top = bounds.y + height * 0.3;
  const bottom = bounds.y + height * 0.7;
  const vertices = [
    { x: left, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: right, y: top }
  ];
  return {
    closed: true,
    vertices,
    inTangents: vertices.map(() => ({ x: 0, y: 0 })),
    outTangents: vertices.map(() => ({ x: 0, y: 0 }))
  };
}


function insertPathPoint(path: BezierPath, index: number, point: Vec2): BezierPath {
  const insert = <T,>(values: T[], value: T) => [
    ...values.slice(0, index),
    value,
    ...values.slice(index)
  ];
  return {
    ...path,
    vertices: insert(path.vertices, point),
    inTangents: insert(path.inTangents, { x: 0, y: 0 }),
    outTangents: insert(path.outTangents, { x: 0, y: 0 })
  };
}

function filterPathPoints(path: BezierPath, include: (point: Vec2, index: number) => boolean): BezierPath {
  const included = path.vertices.map(include);
  return {
    ...path,
    vertices: path.vertices.filter((_, index) => included[index]),
    inTangents: path.inTangents.filter((_, index) => included[index]),
    outTangents: path.outTangents.filter((_, index) => included[index])
  };
}

/**
 * Apply a vertex/handle edit.
 *
 * A patch naming exactly one handle is a drag of that handle, so it goes through
 * `moveAnchorHandle`, which mirrors the opposite handle when the anchor is a tangent point and
 * leaves it alone when it is a corner or deliberately broken. Direct Selection used to write the
 * handle straight in, which silently broke every smooth anchor the first time it was touched.
 *
 * A patch naming *both* handles is the pen's own create-drag, which has already decided what both
 * sides are, so it is written through unchanged rather than mirrored a second time.
 */
function patchPathPoint(
  path: BezierPath,
  index: number,
  patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }
): BezierPath {
  if (index < 0 || index >= path.vertices.length) return path;

  const onlyIn = patch.inTangent && !patch.outTangent;
  const onlyOut = patch.outTangent && !patch.inTangent;
  if (onlyIn || onlyOut) {
    const moved = moveAnchorHandle(
      path,
      index,
      onlyIn ? "in" : "out",
      (onlyIn ? patch.inTangent : patch.outTangent)!
    );
    return patch.vertex
      ? { ...moved, vertices: moved.vertices.map((v, i) => (i === index ? patch.vertex! : v)) }
      : moved;
  }

  const replace = (values: Vec2[], value: Vec2 | undefined) =>
    value ? values.map((current, currentIndex) => currentIndex === index ? value : current) : values;
  return {
    ...path,
    vertices: replace(path.vertices, patch.vertex),
    inTangents: replace(path.inTangents, patch.inTangent),
    outTangents: replace(path.outTangents, patch.outTangent)
  };
}

function smoothHandles(path: BezierPath, index: number): { inTangent: Vec2; outTangent: Vec2 } {
  const count = path.vertices.length;
  const point = path.vertices[index];
  const previous = path.vertices[index === 0 ? (path.closed ? count - 1 : 0) : index - 1];
  const next = path.vertices[index === count - 1 ? (path.closed ? 0 : count - 1) : index + 1];
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.max(0.0001, Math.hypot(dx, dy));
  const inLength = Math.hypot(point.x - previous.x, point.y - previous.y) / 3;
  const outLength = Math.hypot(next.x - point.x, next.y - point.y) / 3;
  return {
    inTangent: { x: -dx / length * inLength, y: -dy / length * inLength },
    outTangent: { x: dx / length * outLength, y: dy / length * outLength }
  };
}

function rectangleBezierPath(width: number, height: number): BezierPath {
  const zero = { x: 0, y: 0 };
  return {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    inTangents: [zero, zero, zero, zero],
    outTangents: [zero, zero, zero, zero]
  };
}

function ellipseBezierPath(width: number, height: number): BezierPath {
  const rx = width / 2;
  const ry = height / 2;
  const kx = rx * 0.5522847498307936;
  const ky = ry * 0.5522847498307936;
  return {
    closed: true,
    vertices: [{ x: rx, y: 0 }, { x: width, y: ry }, { x: rx, y: height }, { x: 0, y: ry }],
    inTangents: [{ x: -kx, y: 0 }, { x: 0, y: -ky }, { x: kx, y: 0 }, { x: 0, y: ky }],
    outTangents: [{ x: kx, y: 0 }, { x: 0, y: ky }, { x: -kx, y: 0 }, { x: 0, y: -ky }]
  };
}

function createEllipseObject(patch: Partial<EllipseSceneObject> = {}): EllipseSceneObject {
  return {
    ...createBaseObject("ellipse"),
    type: "ellipse",
    name: "Ellipse",
    width: 220,
    height: 160,
    ...patch
  };
}

function createImageObject(patch: Partial<ImageSceneObject> = {}): ImageSceneObject {
  return {
    ...createBaseObject("image"),
    type: "image",
    name: "Image",
    width: 260,
    height: 180,
    fill: "transparent",
    stroke: "#f7fbff",
    src:
      "https://images.unsplash.com/photo-1549921296-3a6b0d78cfd0?auto=format&fit=crop&w=800&q=80",
    objectFit: "cover",
    ...patch
  };
}

function createLibraryObject(kind: LibraryObjectKind, scene: SceneDocument): SceneObject {
  switch (kind) {
    case "text":
      return createTextObject({ name: "Text", x: 240, y: 220 });
    case "background":
      return createRectObject({
        name: "Background",
        x: 0,
        y: 0,
        width: scene.canvas.width,
        height: scene.canvas.height,
        fill: "#101722",
        stroke: "transparent",
        radius: 0
      });
    case "quad":
      return createRectObject({ name: "Quad", width: 360, height: 210, radius: 0 });
    case "sphere":
      return createMeshObject("sphere", {
        name: "Sphere",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        width: 220,
        height: 220,
        depth: 220
      });
    case "line":
      return createLineObject();
    case "shape":
      return createShapeObject();
    case "model":
      return createMeshObject("model", { name: "3D Model", x: scene.canvas.width / 2, y: scene.canvas.height / 2 });
    case "cube":
      return createMeshObject("cube", { name: "Cube", x: scene.canvas.width / 2, y: scene.canvas.height / 2 });
    case "cylinder":
      return createMeshObject("cylinder", { name: "Cylinder", x: scene.canvas.width / 2, y: scene.canvas.height / 2 });
    case "torus":
      return createMeshObject("torus", { name: "Torus", x: scene.canvas.width / 2, y: scene.canvas.height / 2 });
    case "slab":
      return createMeshObject("slab", {
        name: "Slab",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        width: 360,
        height: 92,
        depth: 42,
        slab: normalizeSlabProperties()
      });
    case "directional-light":
      return createLightObject("directional", {
        name: "Directional Light",
        x: scene.canvas.width / 2 - 420,
        y: scene.canvas.height / 2 - 320,
        zDepth: sceneFocalDistance(scene),
        intensity: 2.2,
        target: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 }
      });
    case "point-light":
      return createLightObject("point", {
        name: "Point Light",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2 - 260,
        zDepth: sceneFocalDistance(scene) * 0.75,
        range: sceneFocalDistance(scene) * 4,
        decay: 2,
        target: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 }
      });
    case "spot-light":
      return createLightObject("spot", {
        name: "Spot Light",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2 - 420,
        zDepth: sceneFocalDistance(scene),
        range: sceneFocalDistance(scene) * 5,
        decay: 2,
        coneAngleDeg: 42,
        penumbra: 0.25,
        target: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 }
      });
    case "perspective-camera":
      return createCameraObject("perspective", {
        name: "Persp. Camera",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        zDepth: sceneFocalDistance(scene),
        near: 1,
        far: 20_000,
        target: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 },
        up: { x: 0, y: -1, z: 0 }
      });
    case "orthographic-camera":
      return createCameraObject("orthographic", {
        name: "Ortho. Camera",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        zDepth: sceneFocalDistance(scene),
        near: 1,
        far: 20_000,
        target: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 },
        up: { x: 0, y: -1, z: 0 }
      });
    case "layer-object":
      return createLayerObject("object", {
        name: "Layer Object",
        x: 0,
        y: 0,
        width: scene.canvas.width,
        height: scene.canvas.height
      });
    case "camera-layer":
      return createLayerObject("camera", {
        name: "Camera Layer",
        x: 0,
        y: 0,
        width: scene.canvas.width,
        height: scene.canvas.height
      });
    case "event-marker":
      return createMarkerObject();
    case "group":
      return createGroupObject();
  }
}

function createLineObject(patch: Partial<LineSceneObject> = {}): LineSceneObject {
  return {
    ...createBaseObject("line"),
    type: "line",
    name: "Lines",
    width: 320,
    height: 120,
    fill: "transparent",
    stroke: "#23c7d9",
    strokeWidth: 8,
    points: [
      { x: 0, y: 90 },
      { x: 110, y: 24 },
      { x: 210, y: 72 },
      { x: 320, y: 18 }
    ],
    ...patch
  };
}

function createMeshObject(meshKind: MeshSceneObject["meshKind"], patch: Partial<MeshSceneObject> = {}): MeshSceneObject {
  const mesh: MeshSceneObject = {
    ...createBaseObject("mesh"),
    type: "mesh",
    name: "Mesh",
    width: 240,
    height: 180,
    depth: 120,
    stroke: "#ffffff",
    strokeWidth: 2,
    meshKind,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scaleZ: 1,
    ...patch
  };
  return {
    ...mesh,
    anchor3d: mesh.anchor3d ?? {
      x: mesh.width / 2,
      y: mesh.height / 2,
      z: mesh.depth / 2
    }
  };
}
/**
 * Change the geometry contract without carrying fields or face bindings that the next kind cannot use.
 *
 * `main` survives every conversion because it is face zero for every mesh. Other bindings survive only
 * when the new kind names the same face key. Imported-model and slab data are kind-local: retaining
 * either on an unrelated primitive makes a later conversion resurrect stale geometry.
 */
function convertMeshObjectKind(object: MeshSceneObject, next: MeshPrimitiveKind): MeshSceneObject {
  const {
    src,
    modelAssetId,
    materialElements,
    clipName,
    clipIndex,
    timeScale,
    frameOffset,
    animationLoop,
    slab,
    ...base
  } = object;
  const modelMetadata = next === "model" && object.meshKind === "model"
    ? { src, modelAssetId, materialElements, clipName, clipIndex, timeScale, frameOffset, animationLoop }
    : {};
  const candidate: MeshSceneObject = {
    ...base,
    type: "mesh",
    meshKind: next,
    materialSlots: {},
    ...(next === "slab"
      ? { slab: normalizeSlabProperties(object.meshKind === "slab" ? slab : undefined) }
      : {}),
    ...modelMetadata
  };
  const validSlots = new Set(getBindableFaces(candidate).map((face) => face.slotKey));
  const materialSlots = Object.fromEntries(
    Object.entries(object.materialSlots).filter(([slotKey]) => validSlots.has(slotKey))
  );
  return { ...candidate, materialSlots };
}


function createLightObject(lightKind: LightSceneObject["lightKind"], patch: Partial<LightSceneObject> = {}): LightSceneObject {
  return {
    ...createBaseObject("light"),
    type: "light",
    name: "Light",
    width: 120,
    height: 120,
    fill: "#fff56b",
    stroke: "#ffffff",
    strokeWidth: 2,
    lightKind,
    intensity: 1,
    color: "#fff56b",
    range: 0,
    decay: 2,
    coneAngleDeg: 42,
    penumbra: 0.25,
    target: { x: 960, y: 540, z: 0 },
    castShadow: false,
    ...patch
  };
}

function createCameraObject(cameraKind: CameraSceneObject["cameraKind"], patch: Partial<CameraSceneObject> = {}): CameraSceneObject {
  return {
    ...createBaseObject("camera"),
    type: "camera",
    name: "Camera",
    width: 180,
    height: 120,
    fill: "#d95f5f",
    stroke: "#ffffff",
    strokeWidth: 2,
    cameraKind,
    fov: cameraKind === "perspective" ? 45 : 0,
    zoom: 1,
    near: 1,
    far: 20_000,
    target: { x: 960, y: 540, z: 0 },
    up: { x: 0, y: -1, z: 0 },
    ...patch
  };
}

function createLayerObject(layerKind: LayerSceneObject["layerKind"], patch: Partial<LayerSceneObject> = {}): LayerSceneObject {
  return {
    ...createBaseObject("layer"),
    type: "layer",
    name: "Layer",
    width: 260,
    height: 160,
    fill: "#253647",
    stroke: "#23c7d9",
    strokeWidth: 3,
    layerKind,
    childIds: [],
    ...patch
  };
}

function createMarkerObject(patch: Partial<MarkerSceneObject> = {}): MarkerSceneObject {
  return {
    ...createBaseObject("marker"),
    type: "marker",
    name: "Event Marker",
    width: 96,
    height: 96,
    fill: "#ff4f5f",
    stroke: "#fff27a",
    strokeWidth: 4,
    markerKind: "event",
    eventName: "Event Marker",
    ...patch
  };
}

function createGroupObject(patch: Partial<GroupSceneObject> = {}): GroupSceneObject {
  return {
    ...createBaseObject("group"),
    type: "group",
    name: "Group",
    width: 260,
    height: 170,
    fill: "rgba(35, 199, 217, 0.12)",
    stroke: "#23c7d9",
    strokeWidth: 3,
    childIds: [],
    ...patch
  };
}

/**
 * How an object with nothing assigned to it looks.
 *
 * Fully transparent rather than a neutral grey, because a grey fill is still a fill: it would
 * composite over whatever is behind and would key as opaque on air. The outline is a mid tone
 * chosen to stay legible against both a dark canvas and a light one, since the canvas background
 * is the designer's choice.
 */
const UNASSIGNED_FILL = "#00000000";
const UNASSIGNED_OUTLINE = "#8fa6b6";
/** What the pen draws with. Exported-in-spirit constants so the tool options bar can show them. */
export const PEN_SHAPE_FILL = "#7c5cff";
export const PEN_SHAPE_STROKE = "#ffffff";

function createBaseObject(type: SceneObject["type"]) {
  return {
    id: createObjectId(type),
    name: "Object",
    x: 220,
    y: 220,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 300,
    height: 140,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    // An object arrives with nothing assigned, and it must look like it.
    //
    // Every type used to be born with an arbitrary fill — quads slate blue, cubes lavender,
    // toruses purple — while `materialSlots` stayed empty. A solid coloured shape is exactly
    // what an *assigned* material looks like, so the viewport told the designer the object was
    // finished when nothing had been bound to it. Transparent fill plus a hairline outline reads
    // as an empty container: it shows extent and orientation, and it cannot be mistaken for a
    // surface. Assigning a material or an explicit fill is what makes it solid.
    fill: UNASSIGNED_FILL,
    stroke: UNASSIGNED_OUTLINE,
    fillStyle: { type: "solid", color: UNASSIGNED_FILL } as ColorValue,
    strokeStyle: { type: "solid", color: UNASSIGNED_OUTLINE } as ColorValue,
    strokeWidth: 1,
    bindings: {},
    materialSlots: {}
  };
}

function normalizedObjectFillStyle(object: SceneObject): ColorValue {
  const normalized = normalizeColorValue(object.fillStyle ?? object.fill, object.fill);
  // Text objects created by older builds inherited the base object's transparent
  // fillStyle even though their text fill was white. That stale base value must
  // not override the visible text colour forever.
  if (
    object.type === "text"
    && normalized.type === "solid"
    && normalized.color.toLowerCase() === UNASSIGNED_FILL
    && object.fill.toLowerCase() !== UNASSIGNED_FILL
  ) {
    return normalizeColorValue(object.fill, "#f7fbff");
  }
  return normalized;
}

function normalizedTextLineHeight(object: Extract<SceneObject, { type: "text" }>): number {
  const value = object.lineHeight ?? object.fontSize * 1.2;
  // Early scenes stored CSS-style multipliers (the old default was 1.2), while
  // both renderers and the Inspector use pixels. Migrate those scenes on load.
  return value > 0 && value <= 4 ? object.fontSize * value : value;
}

function normalizedObjectStrokeStyle(object: SceneObject): ColorValue {
  const normalized = normalizeColorValue(object.strokeStyle ?? object.stroke, object.stroke);
  // The same legacy base-style mismatch affected text outlines: old text objects
  // declared a transparent stroke but retained the base object's grey strokeStyle.
  if (
    object.type === "text"
    && normalized.type === "solid"
    && normalized.color.toLowerCase() === UNASSIGNED_OUTLINE
    && object.stroke.toLowerCase() === "transparent"
  ) {
    return normalizeColorValue(object.stroke, "transparent");
  }
  return normalized;
}

/**
 * Bring every numeric field of a patch inside what the renderers accept, before it reaches the scene.
 *
 * At the mutation boundary rather than in each control, because a control's `min`/`max` is a browser
 * hint: it blocks the spinner, not a paste, a data binding or a scrub, and the store never consulted it.
 * Typing 500 into a spot light's cone used to save 500, show 500 and draw 179 — three numbers for one
 * property. Clamping here means the saved value is the drawn value for every path that writes.
 *
 * Per-property ranges come from the shared table. Two rules cannot be expressed there: a camera's
 * clipping planes and a slab's bevels constrain *each other*, so they need the object's current values
 * and not just the patch — which is why this takes the object. The version that took only the type
 * carried a comment claiming the planes were enforced, guarding a branch that returned the same value
 * either way; the bevels were never clamped at all, so a 500-unit bevel on a 100-deep slab saved 500
 * and drew 50.
 */
function clampPatch(object: SceneObject, patch: Partial<SceneObject>): Partial<SceneObject> {
  const objectType = object.type;
  const clamped: Record<string, unknown> = { ...patch };
  let changed = false;
  for (const [property, value] of Object.entries(clamped)) {
    if (typeof value !== "number") continue;
    const next = normalizePropertyValue(objectType, property, value);
    if (next !== undefined && next !== value) {
      clamped[property] = next;
      changed = true;
    }
  }
  const current = object as unknown as Record<string, unknown>;
  const numberOf = (property: string, fallback: number) => {
    const value = property in clamped ? clamped[property] : current[property];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  if (objectType === "camera" && ("near" in clamped || "far" in clamped)) {
    const planes = normalizeCameraPlanes(numberOf("near", 1), numberOf("far", 20000));
    if (planes.near !== numberOf("near", 1) || planes.far !== numberOf("far", 20000)) {
      clamped.near = planes.near;
      clamped.far = planes.far;
      changed = true;
    }
  }
  if (objectType === "mesh" && object.meshKind === "slab"
    && ("slab" in clamped || "depth" in clamped || "width" in clamped || "height" in clamped)) {
    const slab = normalizeSlabProperties(
      ("slab" in clamped ? clamped.slab : object.slab) as SlabPropertiesInput | undefined
    );
    const bevels = normalizeSlabBevels(
      { width: numberOf("width", 0), height: numberOf("height", 0), depth: numberOf("depth", 0.01) },
      slab.frontBevel,
      slab.backBevel
    );
    if (bevels.front.size !== slab.frontBevel.size || bevels.front.depth !== slab.frontBevel.depth
      || bevels.back.size !== slab.backBevel.size || bevels.back.depth !== slab.backBevel.depth) {
      clamped.slab = { ...slab, frontBevel: bevels.front, backBevel: bevels.back };
      changed = true;
    }
  }
  return changed ? (clamped as Partial<SceneObject>) : patch;
}
function normalizeScene(scene: SceneDocument): SceneDocument {
  const builtInShaderDefinitions = builtInShaders.map((shader) => shader.definition);
  const builtInShaderIds = new Set(builtInShaderDefinitions.map((shader) => shader.shaderId));
  // Built-in shader definitions are app-owned, not user data: always refresh them
  // from the current manifest so scenes saved by older builds pick up renames and
  // new flags (userFacing / compatibilityAliasFor) instead of keeping stale copies.
  // Scene-authored shaders (imported WGSL) are preserved untouched.
  const authoredShaders = (scene.shaders ?? []).filter((shader) => !builtInShaderIds.has(shader.shaderId));
  const objects = normalizeObjectStack(
    ensureUniqueObjectNames(scene.objects.map((object, index) => ({
      ...object,
      zDepth: object.type === "camera" && object.zDepth === 0 && !object.target
        ? sceneFocalDistance(scene)
        : object.zDepth ?? 0,
      zIndex: object.zIndex ?? index,
      layerId: object.layerId ?? "main",
      locked: object.locked ?? false,
      scaleX: object.scaleX ?? 1,
      scaleY: object.scaleY ?? 1,
      scaleZ: object.scaleZ ?? 1,
      anchor: object.anchor ?? { x: 0, y: 0 },
      fillStyle: normalizedObjectFillStyle(object),
      strokeStyle: normalizedObjectStrokeStyle(object),
      masks: (object.masks ?? []).map((mask, maskIndex) => ({
        ...mask,
        name: mask.name || `Mask ${maskIndex + 1}`,
        type: mask.type ?? "bezier",
        visible: mask.visible ?? true,
        locked: mask.locked ?? false,
        editorColor: mask.editorColor ?? "#f5b942",
        opacity: mask.opacity ?? 1,
        expansion: mask.expansion ?? 0,
        feather: mask.feather ?? { x: 0, y: 0 }
        ,
        paintStrokes: (mask.paintStrokes ?? []).map((stroke) => ({
          ...stroke,
          color: normalizeColorValue(stroke.color, "#ffffff")
        }))
      })),
      materialSlots: object.materialSlots ?? {},
      ...(object.type === "mesh" && object.meshKind === "slab"
        ? { slab: normalizeSlabProperties(object.slab) }
        : {}),
      ...((object.type === "layer" || object.type === "group")
        ? { childIds: Array.isArray(object.childIds) ? object.childIds : [] }
        : {}),
      ...(object.type === "light"
        ? {
            intensity: object.intensity ?? 1,
            color: object.color ?? object.fill ?? "#fff56b",
            range: object.range ?? 0,
            decay: object.decay ?? 2,
            coneAngleDeg: object.coneAngleDeg ?? 42,
            penumbra: object.penumbra ?? 0.25,
            target: object.target ?? { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 },
            castShadow: object.castShadow ?? false
          }
        : {}),
      ...(object.type === "camera"
        ? {
            fov: object.cameraKind === "perspective" ? object.fov ?? 45 : 0,
            zoom: object.zoom ?? 1,
            near: object.near ?? 1,
            far: object.far ?? 20_000,
            target: object.target ?? { x: scene.canvas.width / 2, y: scene.canvas.height / 2, z: 0 },
            up: object.up ?? { x: 0, y: -1, z: 0 }
          }
        : {}),
      ...(object.type === "mesh"
        ? {
            rotationX: object.rotationX ?? 0,
            rotationY: object.rotationY ?? 0,
            rotationZ: object.rotationZ ?? object.rotation ?? 0,
            scaleZ: object.scaleZ ?? 1,
            anchor3d: object.anchor3d ?? {
              x: object.anchor?.x ?? 0,
              y: object.anchor?.y ?? 0,
              z: object.depth / 2
            }
          }
        : {})
      ,
      ...(object.type === "text"
        ? {
            textLayout: object.textLayout ?? "point",
            autoFit: object.autoFit ?? "none",
            writingMode: object.writingMode ?? "horizontal-tb",
            verticalAlign: object.verticalAlign ?? "top",
            direction: object.direction ?? "auto",
            fontStyle: object.fontStyle ?? "normal",
            textDecoration: object.textDecoration ?? {},
            lineHeight: normalizedTextLineHeight(object),
            letterSpacing: object.letterSpacing ?? 0,
            wordSpacing: object.wordSpacing ?? 0,
            paragraphSpacing: object.paragraphSpacing ?? 0,
            textIndent: object.textIndent ?? 0,
            overflow: object.overflow ?? "visible"
          }
        : {}),
      ...(object.type === "paint"
        ? {
            strokes: Array.isArray(object.strokes) ? object.strokes.map((stroke) => ({
              ...stroke,
              color: normalizeColorValue(stroke.color, "#ffffff")
            })) : [],
            paintBlendMode: object.paintBlendMode ?? "normal"
          }
        : {})
    } as SceneObject)))
  );
  const requestedCamera = objects.find((object) => object.id === scene.activeCameraId && object.type === "camera");
  const activeCameraId = requestedCamera?.id
    ?? objects.find((object) => object.type === "camera" && object.visible)?.id;

  return normalizeMaterialSceneDocument({
    ...scene,
    canvas: {
      ...scene.canvas,
      backgroundStyle: normalizeColorValue(scene.canvas.backgroundStyle ?? scene.canvas.background, scene.canvas.background),
      editorViewport: normalizeViewportSettings(
        scene.canvas.editorViewport,
        scene.canvas.width,
        scene.canvas.height
      )
    },
    activeCameraId,
    assets: scene.assets ?? [],
    materials: ensureDefaultStandardMaterial(scene.materials ?? []),
    materialInstances: scene.materialInstances ?? [],
    shaders: [...authoredShaders, ...builtInShaderDefinitions],
    materialFolders: scene.materialFolders ?? [],
    fonts: (scene.fonts ?? []).map((font) => ({
      ...font,
      enabled: font.enabled ?? true,
      fallbackFamilies: font.fallbackFamilies?.length ? font.fallbackFamilies : ["Arial", "sans-serif"],
      faces: font.faces.map((face) => ({
        ...face,
        status: face.status ?? font.status
      }))
    })),
    gradientPresets: scene.gradientPresets ?? [],
    timeline: normalizeTimeline(scene.timeline),
    objects
  });
}

function normalizeViewportSettings(
  viewport: Partial<SceneViewportSettings> | undefined,
  canvasWidth: number,
  canvasHeight: number
): SceneViewportSettings {
  const margins = viewport?.margins as Partial<CanvasMargins> | undefined;
  const guides = Array.isArray(viewport?.guides) ? viewport.guides : [];
  return {
    showRulers: viewport?.showRulers ?? true,
    margins: {
      top: clampViewportDistance(margins?.top, canvasHeight),
      right: clampViewportDistance(margins?.right, canvasWidth),
      bottom: clampViewportDistance(margins?.bottom, canvasHeight),
      left: clampViewportDistance(margins?.left, canvasWidth)
    },
    guides: guides
      .filter((guide): guide is CanvasGuide =>
        Boolean(guide?.guideId)
        && (guide.orientation === "horizontal" || guide.orientation === "vertical")
        && Number.isFinite(guide.position)
      )
      .map((guide) => ({
        ...guide,
        position: clampViewportDistance(
          guide.position,
          guide.orientation === "horizontal" ? canvasHeight : canvasWidth
        )
      }))
  };
}

function clampViewportDistance(value: number | undefined, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, maximum), Math.max(0, Math.round(value!)));
}

function sceneFocalDistance(scene: Pick<SceneDocument, "canvas">): number {
  return (scene.canvas.height / 2) / Math.tan((45 * Math.PI / 180) / 2);
}

function materialFaceSelection(object: SceneObject | undefined): Pick<
  EditorState,
  "selectedFaceIndices" | "faceSelectionAnchor"
> {
  const selectedFaceIndices = object
    ? getBindableFaces(object).map((face) => face.index)
    : [];
  return {
    selectedFaceIndices,
    faceSelectionAnchor: selectedFaceIndices[0] ?? null
  };
}

/**
 * The alignable members of a selection.
 *
 * Hidden objects are dropped because aligning something the operator cannot see is a change they
 * cannot check. Locked ones are kept but flagged: a locked graphic is exactly the thing you want
 * others to line up *to*, so it belongs in the bounding box while staying still.
 */
function alignTargetsFor(scene: SceneDocument, objectIds: readonly string[]): AlignTarget[] {
  const wanted = new Set(objectIds);
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  return scene.objects
    .filter((object) => wanted.has(object.id) && object.visible)
    .map((object) => ({
      id: object.id,
      bounds: objectBoundsInScene(object, byId),
      locked: object.locked
    }));
}


function localizeSceneObjectTransform(
  worldObject: SceneObject,
  worldContainer: SceneObject
): Partial<SceneObject> {
  const anchor = worldContainer.anchor ?? { x: 0, y: 0 };
  const deltaX = worldObject.x - worldContainer.x;
  const deltaY = worldObject.y - worldContainer.y;
  const radians = -worldContainer.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const unrotatedX = deltaX * cosine - deltaY * sine;
  const unrotatedY = deltaX * sine + deltaY * cosine;
  const scaleX = safeHierarchyScale(worldContainer.scaleX ?? 1);
  const scaleY = safeHierarchyScale(worldContainer.scaleY ?? 1);
  const scaleZ = safeHierarchyScale(worldContainer.scaleZ ?? 1);
  const patch: Record<string, unknown> = {
    x: anchor.x + unrotatedX / scaleX,
    y: anchor.y + unrotatedY / scaleY,
    zDepth: worldObject.zDepth - worldContainer.zDepth,
    rotation: worldObject.rotation - worldContainer.rotation,
    scaleX: (worldObject.scaleX ?? 1) / scaleX,
    scaleY: (worldObject.scaleY ?? 1) / scaleY,
    scaleZ: (worldObject.scaleZ ?? 1) / scaleZ
  };
  if (worldObject.type === "mesh") {
    patch.rotationX = (worldObject.rotationX ?? 0) - (worldContainer.rotationX ?? 0);
    patch.rotationY = (worldObject.rotationY ?? 0) - (worldContainer.rotationY ?? 0);
    patch.rotationZ = (worldObject.rotationZ ?? worldObject.rotation) - worldContainer.rotation;
  }
  return patch as Partial<SceneObject>;
}

function bakeEffectiveSceneObjectTransform(worldObject: SceneObject): Partial<SceneObject> {
  const patch: Record<string, unknown> = {
    x: worldObject.x,
    y: worldObject.y,
    zDepth: worldObject.zDepth,
    rotation: worldObject.rotation,
    scaleX: worldObject.scaleX ?? 1,
    scaleY: worldObject.scaleY ?? 1,
    scaleZ: worldObject.scaleZ ?? 1,
    opacity: worldObject.opacity,
    visible: worldObject.visible,
    locked: worldObject.locked
  };
  if (worldObject.type === "mesh") {
    patch.rotationX = worldObject.rotationX ?? 0;
    patch.rotationY = worldObject.rotationY ?? 0;
    patch.rotationZ = worldObject.rotationZ ?? worldObject.rotation;
  }
  return patch as Partial<SceneObject>;
}

function safeHierarchyScale(value: number): number {
  if (Math.abs(value) >= 0.0001) return value;
  return value < 0 ? -0.0001 : 0.0001;
}


function createDefaultTimeline(): SceneTimeline {
  return {
    fps: 60,
    durationFrames: 120,
    keyframes: []
  };
}

function normalizeTimeline(timeline: SceneTimeline | undefined): SceneTimeline {
  return {
    ...createDefaultTimeline(),
    ...timeline,
    keyframes: timeline?.keyframes ?? []
  };
}

function nearestSupportedFontWeight(weight: number): TextSceneObject["fontWeight"] {
  const weights: Array<TextSceneObject["fontWeight"]> = ["400", "500", "600", "700", "800"];
  return weights.reduce((nearest, candidate) =>
    Math.abs(Number(candidate) - weight) < Math.abs(Number(nearest) - weight) ? candidate : nearest
  );
}

function createObjectSnapshot(object: SceneObject): SceneKeyframe["properties"] {
  const snapshot: SceneKeyframe["properties"] = {
    x: object.x,
    y: object.y,
    zDepth: object.zDepth,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    scaleX: object.scaleX ?? 1,
    scaleY: object.scaleY ?? 1,
    anchor: structuredClone(object.anchor ?? { x: 0, y: 0 }),
    opacity: object.opacity,
    fill: object.fill,
    stroke: object.stroke,
    visible: object.visible
  };

  if (object.type === "text") {
    snapshot.text = object.text;
  }

  if (object.type === "image") {
    snapshot.src = object.src;
  }

  if (object.type === "shape") {
    // Deep-copy so later path edits don't mutate the captured keyframe.
    snapshot.path = structuredClone(object.path);
  }

  if (object.type === "mesh") {
    snapshot.rotationX = object.rotationX ?? 0;
    snapshot.rotationY = object.rotationY ?? 0;
    snapshot.rotationZ = object.rotationZ ?? object.rotation ?? 0;
    snapshot.scaleZ = object.scaleZ ?? 1;
  }

  return snapshot;
}

/**
 * Name a patch for the history, so "Undo" can say what it takes back.
 *
 * Only patches an author would recognise as a distinct action are named; anything else falls back to
 * a generic label rather than reciting field names, because "Undo x, y, width, height" is noise. An
 * unnamed step still undoes — the UI just says "Undo".
 */
function describeObjectPatch(patch: Partial<SceneObject>): string {
  const keys = Object.keys(patch);
  if (keys.length === 1) {
    if (keys[0] === "visible") return "visible" in patch && patch.visible ? "Show object" : "Hide object";
    if (keys[0] === "locked") return "locked" in patch && patch.locked ? "Lock object" : "Unlock object";
    if (keys[0] === "name") return "Rename object";
    if (keys[0] === "layerId") return "Move object to layer";
  }
  if (keys.length > 0 && keys.every((key) => key === "x" || key === "y")) return "Move object";
  if (keys.length > 0 && keys.every((key) => key.startsWith("scale"))) return "Scale object";
  if (keys.length > 0 && keys.every((key) => key.startsWith("rotation"))) return "Rotate object";
  return "Edit object";
}

function touchScene(scene: SceneDocument): SceneDocument {
  return {
    ...scene,
    updatedAt: new Date().toISOString()
  };
}

function clampTimelineFrame(frame: number, durationFrames: number): number {
  return Math.max(0, Math.min(durationFrames, Math.round(frame)));
}


function ensureUniqueObjectNames(objects: readonly SceneObject[]): SceneObject[] {
  const accepted: SceneObject[] = [];
  for (const object of objects) {
    const name = object.name.trim() || "Object";
    const duplicate = accepted.some((candidate) =>
      candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    accepted.push(duplicate
      ? ({ ...object, name: nextUniqueObjectName(accepted, name) } as SceneObject)
      : object.name === name
        ? object
        : ({ ...object, name } as SceneObject));
  }
  return accepted;
}

function sortPropertyKeys(keys: PropertyKeyframe[]): PropertyKeyframe[] {
  return [...keys].sort((left, right) =>
    left.frame === right.frame
      ? left.id.localeCompare(right.id)
      : left.frame - right.frame
  );
}

function moveObjectInStack(
  objects: SceneObject[],
  objectId: string,
  direction: "up" | "down" | "front" | "back"
): SceneObject[] {
  const target = objects.find((object) => object.id === objectId);

  if (!target) {
    return objects;
  }

  const layerObjects = sortObjectsForRender(objects.filter((object) => object.layerId === target.layerId));
  const targetIndex = layerObjects.findIndex((object) => object.id === objectId);

  if (targetIndex === -1) {
    return objects;
  }

  const nextLayerObjects = [...layerObjects];

  if (direction === "front") {
    nextLayerObjects.splice(targetIndex, 1);
    nextLayerObjects.push(target);
  } else if (direction === "back") {
    nextLayerObjects.splice(targetIndex, 1);
    nextLayerObjects.unshift(target);
  } else {
    const swapIndex = direction === "up" ? targetIndex + 1 : targetIndex - 1;

    if (swapIndex < 0 || swapIndex >= nextLayerObjects.length) {
      return objects;
    }

    [nextLayerObjects[targetIndex], nextLayerObjects[swapIndex]] = [nextLayerObjects[swapIndex], nextLayerObjects[targetIndex]];
  }

  const renumberedLayerObjects = nextLayerObjects.map((object, index) => ({
    ...object,
    zIndex: index
  }) as SceneObject);
  const layerObjectMap = new Map(renumberedLayerObjects.map((object) => [object.id, object]));

  return normalizeObjectStack(objects.map((object) => layerObjectMap.get(object.id) ?? object));
}

/**
 * Splice objects to sit immediately before or after a sibling, within their compositing band.
 *
 * Works on the flat render order of the band — the same list `moveObjectInStack` walks — and finishes
 * through `normalizeObjectStack`, so `zIndex` comes out contiguous and every renderer sorts it the
 * same way. The moved objects keep their relative order rather than the order they were clicked in:
 * a multi-object drag should look like the run you picked up, not a reshuffle of it.
 *
 * `before`/`after` are in **render order**, so `before` is the *lower* `zIndex`. The Object Manager
 * draws that list reversed, so what an author sees as "above" arrives here as `after`. The panel owns
 * that translation; doing it in both places is how it ends up applied twice.
 */
function reorderObjectsInStack(
  objects: SceneObject[],
  objectIds: readonly string[],
  targetId: string,
  placement: "before" | "after"
): SceneObject[] {
  const target = objects.find((object) => object.id === targetId);
  const moving = new Set(objectIds);
  if (!target || moving.has(targetId)) return objects;

  const band = sortObjectsForRender(objects.filter((object) => object.layerId === target.layerId));
  const held = band.filter((object) => moving.has(object.id));
  if (held.length === 0) return objects;

  const remaining = band.filter((object) => !moving.has(object.id));
  const targetIndex = remaining.findIndex((object) => object.id === targetId);
  if (targetIndex === -1) return objects;

  const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
  const next = [...remaining.slice(0, insertAt), ...held, ...remaining.slice(insertAt)];
  const renumbered = new Map(next.map((object, index) => [object.id, { ...object, zIndex: index } as SceneObject]));

  return normalizeObjectStack(objects.map((object) => renumbered.get(object.id) ?? object));
}

function normalizeObjectStack(objects: SceneObject[]): SceneObject[] {
  const groupedObjects = new Map<string, SceneObject[]>();

  for (const object of objects) {
    const layerId = object.layerId || "main";
    groupedObjects.set(layerId, [...(groupedObjects.get(layerId) ?? []), { ...object, layerId } as SceneObject]);
  }

  const renumbered = new Map<string, SceneObject>();

  for (const layerObjects of groupedObjects.values()) {
    sortObjectsForRender(layerObjects).forEach((object, index) => {
      renumbered.set(object.id, { ...object, zIndex: index } as SceneObject);
    });
  }

  return objects.map((object) => renumbered.get(object.id) ?? object);
}

function sortObjectsForRender(objects: SceneObject[]): SceneObject[] {
  return [...objects].sort((left, right) => {
    if (left.zDepth !== right.zDepth) {
      return left.zDepth - right.zDepth;
    }

    return left.zIndex - right.zIndex;
  });
}
