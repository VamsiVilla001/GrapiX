import { create } from "zustand";
import {
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
  normalizeColorValue,
  normalizePrimitiveMaterialBinding,
  normalizeSlabProperties,
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
  type ObjectMask,
  type PaintSceneObject,
  type PaintStroke,
  type Vec2,
  type FontDefinition,
  type GradientPreset,
  type Material,
  type MaterialFace,
  type MaterialInstance,
  type MaterialParameterValue,
  type PrimitiveMaterialBinding,
  type PropertyKeyframe,
  type MarkerSceneObject,
  type MeshSceneObject,
  type RectSceneObject,
  type ShapeSceneObject,
  type SceneDocument,
  type SceneAutomationDefinition,
  type SceneKeyframe,
  type SceneTimeline,
  type SceneViewportSettings,
  type SceneObject,
  type SceneScriptReference,
  type TextSceneObject
} from "@grapix/shared-types";
import { importMaterialAsset } from "../modules/material-manager/services/assetImporter";
import { builtInShaders } from "../modules/material-manager/services/shaderRegistry";
import { ensureDefaultStandardMaterial } from "../modules/material-manager/services/defaultMaterial";
import { assetExistsOnApi } from "../lib/apiClient";
import { clonePropertyAnimation, removePropertyKeyframe } from "./timelineAnimation";

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
  scene: SceneDocument;
}

export interface EditorState {
  scene: SceneDocument;
  hasActiveScene: boolean;
  selectedObjectId: string | null;
  selectedFaceIndices: number[];
  faceSelectionAnchor: number | null;
  dataJson: string;
  dataError: string | null;
  saveStatus: "local" | "saving" | "saved" | "error";
  saveError: string | null;
  materialActionError: string | null;
  undoStack: SceneDocument[];
  redoStack: SceneDocument[];
  historyTransaction: SceneHistoryTransaction | null;
  setSaveStatus: (status: EditorState["saveStatus"], error?: string | null) => void;
  selectObject: (objectId: string | null) => void;
  setSceneId: (id: string) => void;
  setSceneName: (name: string) => void;
  updateCanvasViewport: (patch: Partial<SceneViewportSettings>) => void;
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
  duplicateSelectedObject: () => void;
  deleteSelectedObject: () => void;
  duplicateObject: (objectId: string) => void;
  deleteObject: (objectId: string) => void;
  updateObject: (objectId: string, patch: Partial<SceneObject>) => void;
  setActiveCameraId: (cameraId: string | null) => void;
  setContainerChild: (containerId: string, childId: string, included: boolean) => boolean;
  // Pen-tool / bezier-path authoring. All commit through the scene history, so a
  // pen gesture wrapped in beginHistory/commitHistory is a single undo step.
  createPenShape: (origin: Vec2) => string;
  appendShapeVertex: (objectId: string, vertex: Vec2, inTangent?: Vec2, outTangent?: Vec2) => number;
  updateShapeVertex: (objectId: string, index: number, patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }) => void;
  addShapePoint: (objectId: string, afterIndex: number, point?: Vec2) => void;
  removeShapePoints: (objectId: string, indices: number[]) => void;
  setShapePointsSmooth: (objectId: string, indices: number[], smooth: boolean, linked?: boolean) => void;
  convertObjectToShape: (objectId: string) => string | null;
  closeShapePath: (objectId: string) => void;
  // AE-style layer masks. addMask is for pen-drawing (empty path at a local
  // origin); addRectMask drops a ready rectangular mask. All history-committed.
  addRectMask: (objectId: string) => string | null;
  addMask: (objectId: string, origin: Vec2) => string | null;
  addMaskFromPath: (objectId: string, path: BezierPath, type?: ObjectMask["type"], feather?: Vec2) => string | null;
  appendMaskVertex: (objectId: string, maskId: string, vertex: Vec2) => void;
  closeMaskPath: (objectId: string, maskId: string) => void;
  updateMask: (objectId: string, maskId: string, patch: Partial<ObjectMask>) => void;
  updateMaskVertex: (objectId: string, maskId: string, index: number, patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }) => void;
  duplicateMask: (objectId: string, maskId: string) => string | null;
  moveMask: (objectId: string, maskId: string, direction: "up" | "down") => void;
  toggleMaskKeyframe: (objectId: string, maskId: string, property: "path" | "opacity" | "feather" | "expansion", frame: number) => void;
  updateMaskKeyframeFrame: (objectId: string, maskId: string, property: "path" | "opacity" | "feather" | "expansion", keyframeId: string, frame: number) => void;
  deleteMask: (objectId: string, maskId: string) => void;
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
  renameLayer: (layerId: string, nextLayerId: string) => void;
  deleteLayer: (layerId: string) => void;
  setLayerVisibility: (layerId: string, visible: boolean) => void;
  setLayerLocked: (layerId: string, locked: boolean) => void;
  beginHistory: (label: string) => void;
  commitHistory: () => void;
  cancelHistory: () => void;
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

export const useEditorStore = create<EditorState>((set, get) => {
  const initialScene = createEmptyScene();

  return {
    scene: initialScene,
    hasActiveScene: false,
    selectedObjectId: null,
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
    setSaveStatus: (saveStatus, saveError = null) => set({ saveStatus, saveError }),
    // Object selection means "the whole object" by default, so applying a
    // material to a cube/model cannot appear to fail merely because its Front
    // face is rotated away. An explicit face click in Materials narrows this
    // selection, and re-clicking the same object preserves that choice.
    selectObject: (objectId) => set((state) => {
      if (state.selectedObjectId === objectId) {
        return { selectedObjectId: objectId };
      }
      const object = state.scene.objects.find((item) => item.id === objectId);
      return {
        selectedObjectId: objectId,
        ...materialFaceSelection(object)
      };
    }),
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
  updateObject: (objectId, patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: normalizeObjectStack(
            state.scene.objects.map((object) =>
              object.id === objectId ? ({ ...object, ...patch } as SceneObject) : object
            )
          )
        })
      })),
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
    createPenShape: (origin) => {
      const { scene } = get();
      const shape = createShapeObject({
        x: origin.x,
        y: origin.y,
        width: 1,
        height: 1,
        path: { closed: false, vertices: [{ x: 0, y: 0 }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] },
        // Draw with both a fill and stroke (like AE's pen), so a new path is
        // immediately a coloured, editable shape — a fill renders even while open.
        fillEnabled: true,
        fill: "#7c5cff",
        strokeEnabled: true,
        strokeWidth: 2,
        stroke: "#ffffff"
      });
      const layerObjects = scene.objects.filter((item) => item.layerId === shape.layerId);
      const objectWithStack = { ...shape, zIndex: layerObjects.reduce((highest, item) => Math.max(highest, item.zIndex), -1) + 1 };
      commitScene({ ...scene, objects: normalizeObjectStack([...scene.objects, objectWithStack]) });
      set({ selectedObjectId: objectWithStack.id, selectedFaceIndices: [0], faceSelectionAnchor: 0 });
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
      const bounds = bezierPathBounds(path);
      const updated: ShapeSceneObject = { ...object, path, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
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
      const bounds = bezierPathBounds(path);
      const updated: ShapeSceneObject = { ...object, path, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
      commitScene({ ...scene, objects: scene.objects.map((item) => item.id === objectId ? updated : item) });
    },
    addShapePoint: (objectId, afterIndex, authoredPoint) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape" || object.path.vertices.length === 0) return;
      const fromIndex = Math.min(object.path.vertices.length - 1, Math.max(0, afterIndex));
      const toIndex = object.path.closed
        ? (fromIndex + 1) % object.path.vertices.length
        : Math.min(object.path.vertices.length - 1, fromIndex + 1);
      const from = object.path.vertices[fromIndex];
      const to = object.path.vertices[toIndex];
      const point = authoredPoint ?? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const insertAt = fromIndex + 1;
      const path = insertPathPoint(object.path, insertAt, point);
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? { ...object, path } : item)
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
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? { ...object, path } : item)
      });
    },
    setShapePointsSmooth: (objectId, indices, smooth, linked = true) => {
      const { scene } = get();
      const object = scene.objects.find((item) => item.id === objectId);
      if (!object || object.type !== "shape") return;
      const selected = new Set(indices);
      const path: BezierPath = {
        ...object.path,
        inTangents: object.path.inTangents.map((handle, index) => {
          if (!selected.has(index)) return handle;
          if (!smooth) return { x: 0, y: 0 };
          const derived = smoothHandles(object.path, index);
          return linked ? derived.inTangent : handle;
        }),
        outTangents: object.path.outTangents.map((handle, index) => {
          if (!selected.has(index)) return handle;
          if (!smooth) return { x: 0, y: 0 };
          const derived = smoothHandles(object.path, index);
          return derived.outTangent;
        })
      };
      commitScene({
        ...scene,
        objects: scene.objects.map((item) => item.id === objectId ? { ...object, path } : item)
      });
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
    moveObjectInStack: (objectId, direction) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: moveObjectInStack(state.scene.objects, objectId, direction)
        })
      })),
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
    setPropertyAnimationEnabled: (objectId, property, enabled, frame) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) => {
            if (object.id !== objectId) return object;
            const animation = { ...(object.animation ?? {}) };

            if (enabled) {
              const key: PropertyKeyframe = {
                id: createSceneId("pkf"),
                frame: clampTimelineFrame(frame, state.scene.timeline.durationFrames),
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
        })
      })),
    setAnimatedPropertyValue: (objectId, property, value, frame) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) => {
            if (object.id !== objectId) return object;
            const nextObject = { ...object, [property]: value } as SceneObject;
            const channel = object.animation?.[property];

            if (!channel) return nextObject;

            const nextFrame = clampTimelineFrame(frame, state.scene.timeline.durationFrames);
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
        })
      })),
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
        { baseTextureAssetId: assetId }
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
      const materialId = normalizePrimitiveMaterialBinding(binding)?.materialId;
      const material = materialId ? scene.materials.find((item) => item.materialId === materialId) : undefined;
      if (!material) {
        set({ materialActionError: "The material to bind could not be found." });
        return false;
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
      const asset = scene.assets.find((item) => item.assetId === assetId);
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
        { baseTextureAssetId: assetId }
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
    moveObjectToLayer: (objectId, layerId) => {
      const targetLayer = normalizeLayerId(layerId);
      const { scene } = get();
      const target = scene.objects.find((object) => object.id === objectId);

      if (!targetLayer || !target || target.layerId === targetLayer) {
        return;
      }

      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.id === objectId ? ({ ...object, layerId: targetLayer } as SceneObject) : object
          )
        )
      });
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

      if (!targetLayer || targetLayer === layerId || !scene.objects.some((object) => object.layerId === layerId)) {
        return;
      }

      commitScene({
        ...scene,
        objects: normalizeObjectStack(
          scene.objects.map((object) =>
            object.layerId === layerId ? ({ ...object, layerId: targetLayer } as SceneObject) : object
          )
        )
      });
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
    beginHistory: (label) => {
      const state = get();
      if (!state.historyTransaction) set({ historyTransaction: { label, scene: state.scene } });
    },
    commitHistory: () => {
      const state = get();
      if (!state.historyTransaction) return;
      set({
        undoStack: state.scene === state.historyTransaction.scene
          ? state.undoStack
          : appendSceneHistory(state.undoStack, state.historyTransaction.scene),
        redoStack: state.scene === state.historyTransaction.scene ? state.redoStack : [],
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
    undo: () => {
      const state = get();
      const snapshot = undoSceneHistory(state.scene, state.undoStack, state.redoStack);
      if (!snapshot) return;
      set({
        ...snapshot,
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
        selectedObjectId: selectedObject?.id ?? null,
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
        selectedObjectId: imported.objects[0]?.id ?? null,
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
        selectedObjectId: null,
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
        selectedObjectId: null,
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

  function commitScene(scene: SceneDocument) {
    const state = get();
    set({
      scene: touchScene(scene),
      undoStack: state.historyTransaction ? state.undoStack : appendSceneHistory(state.undoStack, state.scene),
      redoStack: state.historyTransaction ? state.redoStack : [],
      materialActionError: null
    });
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
      zIndex: layerObjects.reduce((highest, item) => Math.max(highest, item.zIndex), -1) + 1
    } as SceneObject;

    set({
      scene: touchScene({
        ...scene,
        objects: normalizeObjectStack([...scene.objects, objectWithStack]),
        activeCameraId: objectWithStack.type === "camera" && !scene.activeCameraId
          ? objectWithStack.id
          : scene.activeCameraId
      }),
      selectedObjectId: objectWithStack.id,
      ...materialFaceSelection(objectWithStack)
    });
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
      name: `${selected.name} Copy`,
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

    set({
      scene: touchScene({
        ...scene,
        objects: normalizeObjectStack([...scene.objects, duplicated]),
        timeline: {
          ...scene.timeline,
          keyframes: [...scene.timeline.keyframes, ...duplicatedKeyframes]
        }
      }),
      selectedObjectId: duplicated.id,
      ...materialFaceSelection(duplicated)
    });
  }

  function deleteObjectById(objectId: string) {
    const { scene, selectedObjectId } = get();
    const nextActiveCameraId = scene.activeCameraId === objectId
      ? scene.objects.find((object) => object.id !== objectId && object.type === "camera" && object.visible)?.id
      : scene.activeCameraId;
    const remainingObjects = scene.objects
      .filter((object) => object.id !== objectId)
      .map((object) => isContainerObject(object) && object.childIds.includes(objectId)
        ? ({ ...object, childIds: object.childIds.filter((id) => id !== objectId) } as SceneObject)
        : object);

    set({
      scene: touchScene({
        ...scene,
        activeCameraId: nextActiveCameraId,
        objects: normalizeObjectStack(remainingObjects),
        timeline: {
          ...scene.timeline,
          keyframes: scene.timeline.keyframes.filter((keyframe) => keyframe.objectId !== objectId)
        }
      }),
      selectedObjectId: selectedObjectId === objectId ? null : selectedObjectId,
      ...(selectedObjectId === objectId ? { selectedFaceIndices: [], faceSelectionAnchor: null } : {})
    });
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
    objects: normalizeObjectStack([...current.objects, ...objects]),
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
    stroke: "transparent",
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
    fill: "#263348",
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
  return {
    ...createBaseObject("shape"),
    type: "shape",
    name: "Shape",
    width: bounds.width || 180,
    height: bounds.height || 160,
    fill: "#7c5cff",
    stroke: "#f7fbff",
    strokeWidth: 0,
    path,
    fillEnabled: true,
    strokeEnabled: false,
    fillRule: "nonzero",
    ...patch
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

function patchPathPoint(
  path: BezierPath,
  index: number,
  patch: { vertex?: Vec2; inTangent?: Vec2; outTangent?: Vec2 }
): BezierPath {
  if (index < 0 || index >= path.vertices.length) return path;
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
    fill: "#23c7d9",
    stroke: "#f7fbff",
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
      return createRectObject({ name: "Quad", width: 360, height: 210, fill: "#263348", radius: 0 });
    case "sphere":
      return createMeshObject("sphere", {
        name: "Sphere",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        width: 220,
        height: 220,
        depth: 220,
        fill: "#9fc7ff"
      });
    case "line":
      return createLineObject();
    case "shape":
      return createShapeObject();
    case "model":
      return createMeshObject("model", { name: "3D Model", x: scene.canvas.width / 2, y: scene.canvas.height / 2, fill: "#6be7ff" });
    case "cube":
      return createMeshObject("cube", { name: "Cube", x: scene.canvas.width / 2, y: scene.canvas.height / 2, fill: "#84a7ff" });
    case "cylinder":
      return createMeshObject("cylinder", { name: "Cylinder", x: scene.canvas.width / 2, y: scene.canvas.height / 2, fill: "#66d9a8" });
    case "torus":
      return createMeshObject("torus", { name: "Torus", x: scene.canvas.width / 2, y: scene.canvas.height / 2, fill: "#b889ff" });
    case "slab":
      return createMeshObject("slab", {
        name: "Slab",
        x: scene.canvas.width / 2,
        y: scene.canvas.height / 2,
        fill: "#8bd1c7",
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
    fill: "#6be7ff",
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
    fill: "#23c7d9",
    stroke: "#f7fbff",
    fillStyle: { type: "solid", color: "#23c7d9" } as ColorValue,
    strokeStyle: { type: "solid", color: "#f7fbff" } as ColorValue,
    strokeWidth: 0,
    bindings: {},
    materialSlots: {}
  };
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
    scene.objects.map((object, index) => ({
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
      fillStyle: normalizeColorValue(object.fillStyle ?? object.fill, object.fill),
      strokeStyle: normalizeColorValue(object.strokeStyle ?? object.stroke, object.stroke),
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
            lineHeight: object.lineHeight ?? object.fontSize * 1.2,
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
    } as SceneObject))
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

function isContainerObject(object: SceneObject): object is LayerSceneObject | GroupSceneObject {
  return object.type === "layer" || object.type === "group";
}

function isAllowedContainerChild(container: LayerSceneObject | GroupSceneObject, child: SceneObject): boolean {
  if (container.type === "group") {
    return true;
  }
  return container.layerKind === "camera" ? child.type === "camera" : child.type !== "camera";
}

function containerContains(objects: SceneObject[], containerId: string, soughtId: string): boolean {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === soughtId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const object = byId.get(id);
    if (!object || !isContainerObject(object)) return false;
    return object.childIds.some(visit);
  };
  return visit(containerId);
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

function collectContainerSubtreeIds(objects: SceneObject[], rootId: string): Set<string> {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const collected = new Set<string>();
  const visit = (id: string): void => {
    if (collected.has(id)) return;
    collected.add(id);
    const object = byId.get(id);
    if (!object || !isContainerObject(object)) return;
    object.childIds.forEach(visit);
  };
  visit(rootId);
  return collected;
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

function touchScene(scene: SceneDocument): SceneDocument {
  return {
    ...scene,
    updatedAt: new Date().toISOString()
  };
}

function clampTimelineFrame(frame: number, durationFrames: number): number {
  return Math.max(0, Math.min(durationFrames, Math.round(frame)));
}

function sortPropertyKeys(keys: PropertyKeyframe[]): PropertyKeyframe[] {
  return [...keys].sort((left, right) =>
    left.frame === right.frame
      ? left.id.localeCompare(right.id)
      : left.frame - right.frame
  );
}

/** Layers are identified by kebab-case slugs on objects ("main", "layer-2"). */
function normalizeLayerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
