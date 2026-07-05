import { create } from "zustand";
import {
  type AssetKind,
  type AssetLibraryItem,
  createObjectId,
  createSceneId,
  type BindingMap,
  type CameraSceneObject,
  type EllipseSceneObject,
  type GroupSceneObject,
  type ImageSceneObject,
  type LayerSceneObject,
  type LightSceneObject,
  type LineSceneObject,
  type Material,
  type MarkerSceneObject,
  type MeshSceneObject,
  type RectSceneObject,
  type SceneDocument,
  type SceneKeyframe,
  type SceneTimeline,
  type SceneObject,
  type TextSceneObject
} from "@grapix/shared-types";

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

interface EditorState {
  scene: SceneDocument;
  selectedObjectId: string | null;
  dataJson: string;
  dataError: string | null;
  saveStatus: "local" | "saving" | "saved" | "error";
  saveError: string | null;
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
  assignMaterialSlot: (objectId: string, slotName: string, materialId: string) => void;
  importAsset: (file: File) => Promise<void>;
  updateMaterial: (materialId: string, patch: Partial<Material>) => void;
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
    assignMaterialSlot: (objectId, slotName, materialId) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          objects: state.scene.objects.map((object) =>
            object.id === objectId
              ? ({
                  ...object,
                  materialSlots: {
                    ...object.materialSlots,
                    [slotName]: materialId
                  }
                } as SceneObject)
              : object
          )
        })
      })),
    importAsset: async (file) => {
      const asset = await fileToAsset(file);
      const material = assetToMaterial(asset);

      set((state) => ({
        scene: touchScene({
          ...state.scene,
          assets: [...state.scene.assets, asset],
          materials: material ? [...state.scene.materials, material] : state.scene.materials
        })
      }));
    },
    updateMaterial: (materialId, patch) =>
      set((state) => ({
        scene: touchScene({
          ...state.scene,
          materials: state.scene.materials.map((material) =>
            material.materialId === materialId ? { ...material, ...patch } : material
          )
        })
      })),
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
        dataError: null
      });
    },
    resetScene: () => {
      const scene = createDefaultScene();
      set({
        scene,
        selectedObjectId: scene.objects[1]?.id ?? null,
        dataJson: JSON.stringify(scene.dataContext, null, 2),
        dataError: null
      });
    }
  };

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

  return {
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
    objects: normalizeObjectStack([plate, accent, name, role, logo, score]),
    timeline: createDefaultTimeline(),
    createdAt: timestamp,
    updatedAt: timestamp
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
  return {
    ...scene,
    assets: scene.assets ?? [],
    materials: scene.materials ?? [],
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
  };
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

async function fileToAsset(file: File): Promise<AssetLibraryItem> {
  return {
    assetId: createSceneId("asset"),
    name: file.name,
    kind: assetKindFromFile(file),
    source: await readAsDataUrl(file),
    mimeType: file.type || undefined,
    sizeBytes: file.size,
    importedAt: new Date().toISOString()
  };
}

function assetToMaterial(asset: AssetLibraryItem): Material | null {
  if (!["image", "svg", "video"].includes(asset.kind)) {
    return null;
  }

  return {
    materialId: createSceneId("mat"),
    name: asset.name.replace(/\.[^.]+$/, ""),
    type: asset.kind === "svg" ? "svg-vector" : asset.kind === "video" ? "video" : "image",
    assetId: asset.assetId,
    dynamic: false,
    sampling: "linear",
    wrap: "clamp",
    opacity: 1,
    readiness: "READY"
  };
}

function assetKindFromFile(file: File): AssetKind {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (type.includes("svg") || name.endsWith(".svg")) {
    return "svg";
  }

  if (type.startsWith("image/")) {
    return "image";
  }

  if (type.startsWith("video/")) {
    return "video";
  }

  if (type.includes("font") || /\.(otf|ttf|woff|woff2)$/.test(name)) {
    return "font";
  }

  if (type.includes("json") || name.endsWith(".json")) {
    return "json";
  }

  return "unknown";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
