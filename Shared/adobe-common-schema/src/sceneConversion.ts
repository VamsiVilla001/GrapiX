import {
  ANIMATABLE_PROPERTIES,
  IMPLEMENTED_OBJECT_EFFECTS,
  OBJECT_EFFECT_TYPES,
  normalizeObjectEffects,
  type AnimatableProperty,
  type ObjectEffectType,
  type PropertyKeyframe,
  type PropertyChannelMap,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";
import { PS_LAYER_TYPE_FIDELITY, PS_LAYER_TYPE_TO_GRAPIX, resolvePhotoshopBlendMode } from "./photoshop.js";
import type { AdobeImportDocument, AdobeLayer, ImportWarning, KeyframeData } from "./types.js";

export interface AdobeSceneConversion {
  scene: SceneDocument;
  report: AdobeSceneReport;
}

export interface AdobeSceneReport {
  converted: number;
  warnings: ImportWarning[];
}

export function adobeDocumentToScene(
  document: AdobeImportDocument,
  options?: { sceneId?: string; sceneName?: string; keepTextEditable?: boolean }
): AdobeSceneConversion {
  const timestamp = new Date().toISOString();
  const warnings = [...document.warnings];
  const objects: SceneObject[] = [];
  const objectIdCounts: Record<string, number> = {};
  const keepTextEditable = options?.keepTextEditable ?? true;
  let zIndex = 0;

  /*
   * Nesting is expressed by `childIds` alone. `layerId` is a compositing layer,
   * not a hierarchy reference: both renderers sort it before `zIndex`, so every
   * imported object remains on main and document walk order decides what is on top.
   */
  const convertLayers = (layers: AdobeLayer[]): string[] => layers.map((layer) => {
    const object = convertLayer(layer, document, nextObjectId(layer.id), zIndex++, keepTextEditable, warnings);
    objects.push(object);
    if (object.type === "group") {
      object.childIds = convertLayers(layer.children ?? []);
    } else if (layer.children?.length) {
      warnings.push({
        code: "photoshop.hierarchy.nonGroupParent",
        message: `"${layer.name}" has child layers but is not a Photoshop group; its children were imported at the scene root.`,
        layerId: layer.id,
        layerName: layer.name,
        status: "Converted"
      });
      convertLayers(layer.children);
    }
    return object.id;
  });

  convertLayers(document.layers);

  const scene: SceneDocument = {
    id: options?.sceneId ?? sceneIdFromDocument(document.documentId),
    name: options?.sceneName ?? document.name,
    version: 1,
    canvas: {
      width: Math.max(1, Math.round(document.width)),
      height: Math.max(1, Math.round(document.height)),
      background: "#00000000"
    },
    dataContext: {
      __adobeImport: {
        source: document.source,
        sourceFormat: document.source === "photoshop" ? "psd" : document.source,
        sourceName: document.name,
        sourceDocumentId: document.documentId,
        importedAt: timestamp
      }
    },
    assets: [],
    materials: [],
    materialInstances: [],
    shaders: [],
    materialFolders: [],
    gradientPresets: [],
    objects,
    timeline: { fps: 50, durationFrames: 300, keyframes: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };

  return { scene, report: { converted: objects.length, warnings } };

  function nextObjectId(layerId: string): string {
    const base = `adobe-${safeId(layerId)}`;
    const count = objectIdCounts[base] ?? 0;
    objectIdCounts[base] = count + 1;
    return count === 0 ? base : `${base}-${count + 1}`;
  }
}

function convertLayer(
  layer: AdobeLayer,
  document: AdobeImportDocument,
  id: string,
  zIndex: number,
  keepTextEditable: boolean,
  warnings: ImportWarning[]
): SceneObject {
  const mappedType = PS_LAYER_TYPE_TO_GRAPIX[layer.type] ?? layer.type;
  const fidelity = PS_LAYER_TYPE_FIDELITY[layer.type] ?? layer.status;
  const blend = resolvePhotoshopBlendMode(layer.blendMode);
  const effects = normalizeObjectEffects((layer.effects ?? []).map((effect) => ({
    ...effect.parameters,
    id: effect.id,
    type: effect.type,
    enabled: effect.enabled,
    sourceData: { ...effect.parameters, name: effect.name, status: effect.status }
  })));
  const animation = convertAnimation(layer, warnings);
  const common = {
    id,
    name: layer.name,
    x: layer.transform.x,
    y: layer.transform.y,
    zDepth: layer.transform.z ?? 0,
    zIndex,
    layerId: "main",
    // The cloud manifest exposes the transform but not per-layer bounds. A canvas-sized
    // transparent surface preserves that transform until a PSD rendition supplies pixels.
    width: Math.max(0.01, document.width),
    height: Math.max(0.01, document.height),
    rotation: layer.transform.rotationZ ?? 0,
    rotationX: layer.transform.rotationX,
    rotationY: layer.transform.rotationY,
    scaleX: layer.transform.scaleX,
    scaleY: layer.transform.scaleY,
    scaleZ: layer.transform.scaleZ,
    anchor: layer.transform.anchorX === undefined && layer.transform.anchorY === undefined
      ? undefined
      : { x: layer.transform.anchorX ?? 0, y: layer.transform.anchorY ?? 0 },
    opacity: layer.opacity,
    visible: layer.visible,
    locked: layer.locked,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    animation,
    effects: effects.length ? effects : undefined,
    ...(document.source === "photoshop"
      ? {
          importedDesign: {
            sourceFormat: "psd" as const,
            sourceName: document.name,
            sourceNodeId: layer.id,
            sourceNodeType: layer.type,
            effects: (layer.effects ?? []).map((effect) => ({
              id: effect.id,
              name: effect.name,
              type: effect.type,
              enabled: effect.enabled,
              parameters: effect.parameters,
              status: effect.status
            })),
            raw: {
              sourceFidelity: fidelity,
              sourceBlendMode: layer.blendMode,
              resolvedBlendMode: blend.mode
            }
          }
        }
      : {})
  };

  reportLayerFidelity(layer, mappedType, fidelity, warnings);
  reportBlendWithoutMaterial(layer, blend.mode, blend.warning, warnings);
  reportEffects(layer, effects.length, warnings);

  if (mappedType === "group") return { ...common, type: "group", childIds: [] };

  if (mappedType === "text" && layer.textData && keepTextEditable) {
    const align = layer.textData.align === "justify" ? "left" : layer.textData.align ?? "left";
    if (layer.textData.align === "justify") {
      warnings.push({
        code: "photoshop.text.justify",
        message: `"${layer.name}" uses justified text, which GrapiX text objects cannot represent exactly.`,
        layerId: layer.id,
        layerName: layer.name,
        status: "Converted"
      });
    }
    if (layer.textData.fontStyle && !isTextFontStyle(layer.textData.fontStyle)) {
      warnings.push({
        code: "photoshop.text.fontStyle",
        message: `"${layer.name}" uses font style "${layer.textData.fontStyle}", which GrapiX cannot represent exactly.`,
        layerId: layer.id,
        layerName: layer.name,
        status: "Converted"
      });
    }
    return {
      ...common,
      type: "text",
      text: layer.textData.text,
      textLayout: "point",
      fontSize: layer.textData.fontSize,
      fontFamily: layer.textData.fontFamily,
      fontWeight: "normal",
      ...(layer.textData.fontStyle && isTextFontStyle(layer.textData.fontStyle) ? { fontStyle: layer.textData.fontStyle } : {}),
      textDecoration: {},
      lineHeight: layer.textData.lineHeight,
      letterSpacing: layer.textData.letterSpacing,
      wordSpacing: 0,
      paragraphSpacing: 0,
      textIndent: 0,
      overflow: "visible",
      align,
      fill: layer.textData.color
    };
  }

  warnings.push({
    code: "photoshop.rendition.required",
    message: `"${layer.name}" geometry imported, but the Photoshop cloud manifest contains no layer pixels. A PSD rendition is needed to reproduce this layer.`,
    layerId: layer.id,
    layerName: layer.name,
    status: "Converted"
  });
  return { ...common, type: "rect", radius: layer.shapeData?.cornerRadius ?? 0 };
}

function convertAnimation(layer: AdobeLayer, warnings: ImportWarning[]): PropertyChannelMap | undefined {
  if (!layer.animation?.channels.length) return undefined;

  const animation: PropertyChannelMap = {};
  for (const channel of layer.animation.channels) {
    if (!isAnimatableProperty(channel.property)) {
      reportAnimationWarning(layer, channel.property, "is not a GrapiX animatable property", warnings);
      continue;
    }
    const keys: PropertyKeyframe[] = [];
    let unmappable = false;
    for (let index = 0; index < channel.keyframes.length; index += 1) {
      const key = convertKeyframe(channel.keyframes[index]!, layer.animation.frameRate, layer.id, channel.property, index);
      if (!key) {
        unmappable = true;
        break;
      }
      keys.push(key);
    }
    if (unmappable) {
      reportAnimationWarning(layer, channel.property, "has a key whose time, value, or easing cannot be represented exactly", warnings);
      continue;
    }
    keys.sort((left, right) => left.frame - right.frame);
    if (keys.some((key, index) => index > 0 && key.frame === keys[index - 1]?.frame)) {
      reportAnimationWarning(layer, channel.property, "has multiple keys at one frame", warnings);
      continue;
    }
    animation[channel.property] = { keys };
  }

  return Object.keys(animation).length ? animation : undefined;
}

function convertKeyframe(
  keyframe: KeyframeData,
  sourceFrameRate: number,
  layerId: string,
  property: string,
  index: number
): { id: string; frame: number; value: number; easing: "linear" | "ease-in" | "ease-out" | "ease-in-out" } | undefined {
  if (typeof keyframe.value !== "number" || !Number.isFinite(keyframe.value)) return undefined;
  const frame = keyframe.frame !== undefined && sourceFrameRate === 50
    ? keyframe.frame
    : Number.isFinite(keyframe.time) ? keyframe.time * 50 : undefined;
  if (frame === undefined || !Number.isInteger(frame) || frame < 0 || !isSceneEasing(keyframe.easing)) return undefined;
  return {
    id: `adobe-key-${safeId(layerId)}-${safeId(property)}-${index}`,
    frame,
    value: keyframe.value,
    easing: keyframe.easing ?? "linear"
  };
}

function reportAnimationWarning(layer: AdobeLayer, property: string, reason: string, warnings: ImportWarning[]): void {
  warnings.push({
    code: "photoshop.animation.unmapped",
    message: `"${layer.name}" animation channel "${property}" ${reason}; it was not imported.`,
    layerId: layer.id,
    layerName: layer.name,
    status: "Converted"
  });
}

function reportLayerFidelity(
  layer: AdobeLayer,
  mappedType: string,
  fidelity: ImportWarning["status"] | undefined,
  warnings: ImportWarning[]
): void {
  if (fidelity !== "Unsupported" && fidelity !== "Rasterised") return;
  warnings.push({
    code: "photoshop.layer.fidelity",
    message: `"${layer.name}" is a ${layer.type} layer (${mappedType}), which GrapiX cannot convert without a rendition.`,
    layerId: layer.id,
    layerName: layer.name,
    status: fidelity
  });
}

function reportBlendWithoutMaterial(
  layer: AdobeLayer,
  resolvedMode: string,
  blendWarning: string | undefined,
  warnings: ImportWarning[]
): void {
  if (!layer.blendMode || layer.blendMode === "normal") return;
  warnings.push({
    code: "photoshop.blendMode",
    message: blendWarning
      ? `"${layer.name}": ${blendWarning}`
      : `"${layer.name}" uses blend mode "${layer.blendMode}" (resolved as "${resolvedMode}"). This import has no material to apply it.`,
    layerId: layer.id,
    layerName: layer.name,
    status: "Converted"
  });
}

function reportEffects(layer: AdobeLayer, convertedEffects: number, warnings: ImportWarning[]): void {
  for (const effect of layer.effects ?? []) {
    if (convertedEffects === 0 || !isKnownEffectType(effect.type)) {
      warnings.push({
        code: "photoshop.effect.unmapped",
        message: `"${layer.name}" effect "${effect.name}" cannot be represented as a GrapiX layer style.`,
        layerId: layer.id,
        layerName: layer.name,
        status: "Converted"
      });
    } else if (effect.enabled && !IMPLEMENTED_OBJECT_EFFECTS.includes(effect.type)) {
      warnings.push({
        code: "photoshop.effect.unrendered",
        message: `"${layer.name}" effect "${effect.name}" was retained but no GrapiX renderer draws layer styles yet.`,
        layerId: layer.id,
        layerName: layer.name,
        status: "Converted"
      });
    }
  }
}

function isKnownEffectType(value: string): value is ObjectEffectType {
  return OBJECT_EFFECT_TYPES.includes(value as ObjectEffectType);
}

function isAnimatableProperty(value: string): value is AnimatableProperty {
  return ANIMATABLE_PROPERTIES.includes(value as AnimatableProperty);
}

function isSceneEasing(value: string | undefined): value is "linear" | "ease-in" | "ease-out" | "ease-in-out" {
  return value === undefined || value === "linear" || value === "ease-in" || value === "ease-out" || value === "ease-in-out";
}

function isTextFontStyle(value: string): value is "normal" | "italic" | "oblique" {
  return value === "normal" || value === "italic" || value === "oblique";
}

function sceneIdFromDocument(documentId: string): string {
  return `adobe-scene-${safeId(documentId)}`;
}

function safeId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || "layer";
}
