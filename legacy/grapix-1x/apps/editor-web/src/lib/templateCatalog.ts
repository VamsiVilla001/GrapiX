import type { SceneDocument, TemplateScene, VideoProfile } from "@grapix/shared-types";

export interface TemplateCatalog {
  templates: TemplateScene[];
}

const defaultProfile: VideoProfile = {
  id: "1080p50",
  label: "1080p50",
  width: 1920,
  height: 1080,
  frameRate: 50,
  scanMode: "p",
  timebase: "50/1"
};

export function createSeedTemplateCatalog(): TemplateCatalog {
  return {
    templates: []
  };
}

export function createEmptyTemplateScene(index: number): SceneDocument {
  const timestamp = new Date().toISOString();
  const sceneId = formatNumericSceneId(index);

  return {
    id: sceneId,
    name: `Untitled Template ${index}`,
    version: 1,
    canvas: {
      width: defaultProfile.width,
      height: defaultProfile.height,
      background: "#070b12"
    },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: {
      fps: defaultProfile.frameRate,
      durationFrames: defaultProfile.frameRate * 2,
      keyframes: []
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function sceneToTemplateScene(scene: SceneDocument, index: number): TemplateScene {
  const videoProfile = profileFromScene(scene);
  const now = new Date().toISOString();
  const sceneId = formatNumericSceneId(index + 1);

  return {
    templateId: `template_custom_${Date.now()}`,
    sceneId,
    name: scene.name || `Untitled Template ${index + 1}`,
    shortLabel: sceneId,
    videoProfile,
    favorite: false,
    thumbnailVariant: "blue",
    scene: {
      ...scene,
      id: sceneId
    },
    createdAt: now,
    updatedAt: now
  };
}

export function profileFromScene(scene: SceneDocument): VideoProfile {
  const fps = scene.timeline?.fps ?? defaultProfile.frameRate;
  const scanMode = "p";
  const labelPrefix = scene.canvas.width >= 3840 ? "UHD" : `${scene.canvas.height}`;

  return {
    id: `${labelPrefix}${scanMode}${fps}`,
    label: `${labelPrefix}${scanMode}${fps}`,
    width: scene.canvas.width,
    height: scene.canvas.height,
    frameRate: fps,
    scanMode,
    timebase: `${fps}/1`
  };
}

export function formatNumericSceneId(value: number): string {
  return String(Math.max(1, Math.round(value))).padStart(3, "0");
}
