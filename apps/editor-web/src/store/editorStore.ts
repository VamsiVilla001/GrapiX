import { create } from "zustand";
import {
  type AssetLibraryItem,
  appendSceneHistory,
  createMaterialDefinition,
  createObjectId,
  createSceneId,
  findAssetUsageDetails,
  findMaterialUsage,
  isMaterialCompatible,
  normalizeMaterial,
  normalizeMaterialSceneDocument,
  normalizePrimitiveMaterialBinding,
  redoSceneHistory,
  undoSceneHistory,
  type BindingMap,
  type CameraSceneObject,
  type EllipseSceneObject,
  type GroupSceneObject,
  type ImageSceneObject,
  type LayerSceneObject,
  type LightSceneObject,
  type LineSceneObject,
  type Material,
  type MaterialInstance,
  type MaterialParameterValue,
  type PrimitiveMaterialBinding,
  type MarkerSceneObject,
  type MeshSceneObject,
  type RectSceneObject,
  type SceneDocument,
  type SceneKeyframe,
  type SceneTimeline,
  type SceneObject,
  type TextSceneObject
} from "@grapix/shared-types";
import { importMaterialAsset } from "../modules/material-manager/services/assetImporter";
import { builtInShaders } from "../modules/material-manager/services/shaderRegistry";
import { assetExistsOnApi } from "../lib/apiClient";

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
  selectedObjectId: string | null;
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
  addTextObject: () => void;
  addRectObject: () => void;
  addEllipseObject: () => void;
  addImageObject: () => void;
  addLibraryObject: (kind: LibraryObjectKind) => void;
  duplicateSelectedObject: () => void;
  deleteSelectedObject: () => void;
  duplicateObject: (objectId: string) => void;
  deleteObject: (objectId: string) => void;
  updateObject: (objectId: string, patch: Partial<SceneObject>) => void;
  moveObjectInStack: (objectId: string, direction: "up" | "down" | "front" | "back") => void;
  updateObjectBindings: (objectId: string, bindings: BindingMap) => void;
  addObjectKeyframe: (objectId: string, frame: number) => void;
  updateObjectKeyframe: (keyframeId: string, patch: Partial<SceneKeyframe>) => void;
  deleteObjectKeyframe: (keyframeId: string) => void;
  updateTimeline: (patch: Partial<SceneTimeline>) => void;
  assignMaterialSlot: (objectId: string, slotName: string, binding: string | PrimitiveMaterialBinding) => void;
  assignMaterialToObjects: (objectIds: string[], materialId: string, slotName?: string) => boolean;
  importAsset: (file: File) => Promise<void>;
  relinkAsset: (assetId: string, file: File) => Promise<void>;
  updateAsset: (assetId: string, patch: Partial<AssetLibraryItem>) => void;
  refreshAssetAvailability: () => Promise<void>;
  deleteAsset: (assetId: string) => boolean;
  createMaterial: (type: "solid-color" | "image" | "unlit-texture", assetId?: string) => string;
  duplicateMaterial: (materialId: string) => string | null;
  deleteMaterial: (materialId: string) => boolean;
  updateMaterial: (materialId: string, patch: Partial<Material>) => void;
  createMaterialInstance: (baseMaterialId: string) => string | null;
  deleteMaterialInstance: (instanceId: string) => boolean;
  updateMaterialInstance: (instanceId: string, patch: Partial<MaterialInstance>) => void;
  setMaterialInstanceParameter: (instanceId: string, name: string, value: MaterialParameterValue | undefined) => void;
  beginHistory: (label: string) => void;
  commitHistory: () => void;
  undo: () => void;
  redo: () => void;
  setDataJson: (json: string) => void;
  applyDataJson: () => boolean;
  loadScene: (scene: SceneDocument) => void;
  resetScene: () => void;
}

const defaultDataContext = {
  player: {
    name: "Maya Chen",
    role: "Lead Anchor",
    headshot:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=600&q=80"
  },
  team: {
    primaryColor: "#23c7d9",
    secondaryColor: "#f5b942"
  },
  teams: {
    home: {
      name: "Team Soul",
      logo: "asset_team_soul_logo",
      primaryColor: "#ffcc00"
    }
  },
  score: {
    home: 15,
    away: 12
  }
};

const defaultLogoAsset: AssetLibraryItem = {
  assetId: "asset_default_logo",
  name: "Default Team Logo",
  kind: "svg",
  source: svgDataUri("#263348", "#23c7d9", "GX"),
  mimeType: "image/svg+xml",
  importedAt: new Date(0).toISOString()
};

const teamSoulLogoAsset: AssetLibraryItem = {
  assetId: "asset_team_soul_logo",
  name: "Team Soul Logo",
  kind: "svg",
  source: svgDataUri("#141414", "#ffcc00", "SOUL"),
  mimeType: "image/svg+xml",
  importedAt: new Date(0).toISOString()
};

export const useEditorStore = create<EditorState>((set, get) => {
  const initialScene = createDefaultScene();

  return {
    scene: initialScene,
    selectedObjectId: initialScene.objects[1]?.id ?? null,
    dataJson: JSON.stringify(initialScene.dataContext, null, 2),
    dataError: null,
    saveStatus: "local",
    saveError: null,
    materialActionError: null,
    undoStack: [],
    redoStack: [],
    historyTransaction: null,
    setSaveStatus: (saveStatus, saveError = null) => set({ saveStatus, saveError }),
    selectObject: (objectId) => set({ selectedObjectId: objectId }),
    setSceneId: (id) =>
      set((state) => ({
        scene: touchScene({ ...state.scene, id })
      })),
    setSceneName: (name) =>
      set((state) => ({
        scene: touchScene({ ...state.scene, name })
      })),
    addTextObject: () => addObject(createTextObject()),
    addRectObject: () => addObject(createRectObject()),
    addEllipseObject: () => addObject(createEllipseObject()),
    addImageObject: () => addObject(createImageObject()),
    addLibraryObject: (kind) => addObject(createLibraryObject(kind, get().scene)),
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
      if (!object || !material || !isMaterialCompatible(material, object.type)) {
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
      if (!material || !selectedObjects.length || selectedObjects.some((object) => !isMaterialCompatible(material, object.type))) {
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
    importAsset: async (file) => {
      try {
        const { asset, shader } = await importMaterialAsset(file);
        const { scene } = get();
        const hasAsset = scene.assets.some((item) => item.assetId === asset.assetId);
        const material = asset.kind === "image" || asset.kind === "svg"
          ? createMaterialDefinition(asset.name.replace(/\.[^.]+$/, ""), "image", asset.assetId)
          : null;
        commitScene({
          ...scene,
          assets: hasAsset ? scene.assets.map((item) => item.assetId === asset.assetId ? asset : item) : [...scene.assets, asset],
          materials: material && !hasAsset ? [...scene.materials, material] : scene.materials,
          shaders: shader ? [...(scene.shaders ?? []).filter((item) => item.shaderId !== shader.shaderId), shader] : scene.shaders
        });
        set({ materialActionError: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Asset import failed.";
        set({ materialActionError: message });
        throw error;
      }
    },
    relinkAsset: async (assetId, file) => {
      // Store new bytes under their content hash and keep the scene asset ID
      // stable. Undo can then restore the old metadata/source without losing
      // the previous binary.
      const { asset: importedAsset } = await importMaterialAsset(file);
      const asset = { ...importedAsset, assetId };
      const { scene } = get();
      commitScene({ ...scene, assets: scene.assets.map((item) => item.assetId === assetId ? asset : item) });
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
      if (usage.materialIds.length || usage.shaderIds.length) {
        set({ materialActionError: `Asset is used by ${usage.materialIds.length} material(s) and ${usage.shaderIds.length} shader(s). Relink it or remove those references first.` });
        return false;
      }
      commitScene({ ...scene, assets: scene.assets.filter((asset) => asset.assetId !== assetId) });
      set({ materialActionError: null });
      return true;
    },
    createMaterial: (type, assetId) => {
      const { scene } = get();
      const material = createMaterialDefinition(
        type === "solid-color" ? "Solid Colour" : type === "unlit-texture" ? "Unlit Texture" : "Image Material",
        type,
        assetId
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
      set({
        scene: touchScene(normalized),
        selectedObjectId: normalized.objects[0]?.id ?? null,
        dataJson: JSON.stringify(normalized.dataContext, null, 2),
        dataError: null,
        undoStack: [],
        redoStack: [],
        historyTransaction: null,
        materialActionError: null
      });
    },
    resetScene: () => {
      const scene = createDefaultScene();
      set({
        scene,
        selectedObjectId: scene.objects[1]?.id ?? null,
        dataJson: JSON.stringify(scene.dataContext, null, 2),
        dataError: null,
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

  function addObject(object: SceneObject) {
    const { scene } = get();
    const layerObjects = scene.objects.filter((item) => item.layerId === object.layerId);
    const objectWithStack = {
      ...object,
      zIndex: layerObjects.reduce((highest, item) => Math.max(highest, item.zIndex), -1) + 1
    } as SceneObject;

    set({
      scene: touchScene({ ...scene, objects: normalizeObjectStack([...scene.objects, objectWithStack]) }),
      selectedObjectId: objectWithStack.id
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
      id: createObjectId(selected.type),
      name: `${selected.name} Copy`,
      x: selected.x + 48,
      y: selected.y + 48,
      zIndex: selected.zIndex + 1,
      locked: false
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
      selectedObjectId: duplicated.id
    });
  }

  function deleteObjectById(objectId: string) {
    const { scene, selectedObjectId } = get();

    set({
      scene: touchScene({
        ...scene,
        objects: normalizeObjectStack(scene.objects.filter((object) => object.id !== objectId)),
        timeline: {
          ...scene.timeline,
          keyframes: scene.timeline.keyframes.filter((keyframe) => keyframe.objectId !== objectId)
        }
      }),
      selectedObjectId: selectedObjectId === objectId ? null : selectedObjectId
    });
  }
});

function createDefaultScene(): SceneDocument {
  const timestamp = new Date().toISOString();
  const plate = createRectObject({
    name: "Lower Third Plate",
    x: 140,
    y: 760,
    width: 1120,
    height: 176,
    fill: "#121826",
    stroke: "#23c7d9",
    opacity: 0.92,
    radius: 24,
    materialSlots: {
      main: "mat_lowerthird_bg"
    }
  });
  const accent = createRectObject({
    name: "Accent Bar",
    x: 140,
    y: 742,
    width: 420,
    height: 18,
    fill: "#f5b942",
    stroke: "transparent",
    radius: 12,
    materialSlots: {
      main: "mat_accent_team_color"
    }
  });
  const name = createTextObject({
    name: "Player Name",
    x: 200,
    y: 790,
    width: 700,
    height: 72,
    text: "Maya Chen",
    fontSize: 58,
    fill: "#f7fbff",
    bindings: {
      text: "player.name",
      fill: "team.primaryColor"
    }
  });
  const role = createTextObject({
    name: "Player Role",
    x: 204,
    y: 864,
    width: 620,
    height: 42,
    text: "Lead Anchor",
    fontSize: 30,
    fontWeight: "500",
    fill: "#d6dde8",
    bindings: {
      text: "player.role"
    }
  });
  const score = createTextObject({
    name: "Home Score",
    x: 1000,
    y: 792,
    width: 170,
    height: 86,
    text: "15",
    fontSize: 76,
    fontWeight: "800",
    fill: "#ffffff",
    align: "center",
    bindings: {
      text: "score.home"
    }
  });
  const logo = createImageObject({
    name: "Home Team Logo",
    x: 820,
    y: 788,
    width: 128,
    height: 128,
    stroke: "transparent",
    src: defaultLogoAsset.source,
    materialSlots: {
      main: "mat_home_team_logo"
    }
  });

  return normalizeMaterialSceneDocument({
    id: createSceneId("lower_third"),
    name: "Lower Third Starter",
    version: 1,
    canvas: {
      width: 1920,
      height: 1080,
      background: "#070b12"
    },
    dataContext: defaultDataContext,
    assets: [defaultLogoAsset, teamSoulLogoAsset],
    materials: [
      {
        materialId: "mat_lowerthird_bg",
        name: "Lower Third Background",
        type: "solid-color",
        color: "#121826",
        dynamic: false,
        opacity: 1,
        readiness: "READY"
      },
      {
        materialId: "mat_accent_team_color",
        name: "Team Accent Color",
        type: "solid-color",
        color: "#f5b942",
        dynamic: true,
        binding: {
          path: "teams.home.primaryColor",
          type: "color",
          fallbackColor: "#f5b942"
        },
        opacity: 1,
        readiness: "READY"
      },
      {
        materialId: "mat_home_team_logo",
        name: "Home Team Logo",
        type: "image",
        assetId: "asset_default_logo",
        dynamic: true,
        binding: {
          path: "teams.home.logo",
          type: "assetId",
          fallbackAssetId: "asset_default_logo"
        },
        sampling: "linear",
        wrap: "clamp",
        opacity: 1,
        readiness: "READY"
      }
    ],
    materialInstances: [],
    shaders: builtInShaders.map((shader) => shader.definition),
    materialFolders: [
      { folderId: "folder_materials", name: "Materials", kind: "material" },
      { folderId: "folder_images", name: "Images", kind: "asset" },
      { folderId: "folder_shaders", name: "Shaders", kind: "shader" }
    ],
    objects: normalizeObjectStack([plate, accent, name, role, logo, score]),
    timeline: createDefaultTimeline(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
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
    align: "left",
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
      return createEllipseObject({ name: "Sphere", width: 220, height: 220, fill: "#9fc7ff" });
    case "line":
      return createLineObject();
    case "model":
      return createMeshObject("model", { name: "3D Model", fill: "#6be7ff" });
    case "cube":
      return createMeshObject("cube", { name: "Cube", fill: "#84a7ff" });
    case "cylinder":
      return createMeshObject("cylinder", { name: "Cylinder", fill: "#66d9a8" });
    case "torus":
      return createMeshObject("torus", { name: "Torus", fill: "#b889ff" });
    case "slab":
      return createMeshObject("slab", { name: "Slab", fill: "#8bd1c7", width: 360, height: 92, depth: 42 });
    case "directional-light":
      return createLightObject("directional", { name: "Directional Light" });
    case "point-light":
      return createLightObject("point", { name: "Point Light" });
    case "spot-light":
      return createLightObject("spot", { name: "Spot Light" });
    case "perspective-camera":
      return createCameraObject("perspective", { name: "Persp. Camera" });
    case "orthographic-camera":
      return createCameraObject("orthographic", { name: "Ortho. Camera" });
    case "layer-object":
      return createLayerObject("object", { name: "Layer Object" });
    case "camera-layer":
      return createLayerObject("camera", { name: "Camera Layer" });
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
  return {
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
    ...patch
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
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#23c7d9",
    stroke: "#f7fbff",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {}
  };
}

function normalizeScene(scene: SceneDocument): SceneDocument {
  const builtInShaderDefinitions = builtInShaders.map((shader) => shader.definition);
  const existingShaderIds = new Set((scene.shaders ?? []).map((shader) => shader.shaderId));
  return normalizeMaterialSceneDocument({
    ...scene,
    assets: scene.assets ?? [],
    materials: scene.materials ?? [],
    materialInstances: scene.materialInstances ?? [],
    shaders: [...(scene.shaders ?? []), ...builtInShaderDefinitions.filter((shader) => !existingShaderIds.has(shader.shaderId))],
    materialFolders: scene.materialFolders ?? [],
    timeline: normalizeTimeline(scene.timeline),
    objects: normalizeObjectStack(
      scene.objects.map((object, index) => ({
        ...object,
        zDepth: object.zDepth ?? 0,
        zIndex: object.zIndex ?? index,
        layerId: object.layerId ?? "main",
        locked: object.locked ?? false,
        materialSlots: object.materialSlots ?? {}
      }))
    )
  });
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

function createObjectSnapshot(object: SceneObject): SceneKeyframe["properties"] {
  const snapshot: SceneKeyframe["properties"] = {
    x: object.x,
    y: object.y,
    zDepth: object.zDepth,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
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

  return snapshot;
}

function svgDataUri(background: string, foreground: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="${background}"/><circle cx="128" cy="128" r="82" fill="${foreground}"/><text x="128" y="144" text-anchor="middle" font-family="Arial,sans-serif" font-size="44" font-weight="800" fill="${background}">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function touchScene(scene: SceneDocument): SceneDocument {
  return {
    ...scene,
    updatedAt: new Date().toISOString()
  };
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
