/**
 * Turn one After Effects composition into a GrapiX scene an author can edit.
 *
 * This is the design-time counterpart to the runtime container path. The connector reads a project
 * into an `AeManifest` (no After Effects needed — `aepParser`), the author picks one composition,
 * and this materializes it as a new `SceneDocument`: every layer becomes a scene object in the
 * Object Manager, and every keyframed transform property becomes a timeline channel on that object.
 * It is a one-shot import — the scene is native GrapiX afterward and the `.aep` is never read again
 * for it.
 *
 * ## What maps, and what does not
 *
 * GrapiX animates scalar properties only (`ANIMATABLE_PROPERTIES`), so AE's multi-component
 * streams expand: `position` → `x`/`y`, `scale` → `scaleX`/`scaleY`, a 3D `rotation` triplet →
 * `rotationX`/`rotationY`/`rotation`. Anything with no scalar equivalent (a camera, a light, an
 * effect parameter, an audio level, a mask path) is reported in the conversion warnings, never
 * silently dropped. Unsupported layer kinds (audio, camera, light, adjustment) become a
 * transparent `rect` placeholder named after the source so the author sees the layer existed and
 * can replace it, rather than a hole in the stacking order.
 *
 * ## Frame rate and time
 *
 * AE reports a composition's rate as a float and stores keyframe times in seconds. The scene
 * timeline is frame-addressed, so the float is matched to the exact broadcast rational
 * (`frameRateToRational`) and each keyframe time is multiplied by that rational and rounded to a
 * frame. A rate that matches nothing broadcast falls back to a whole number, which the report
 * names. Keyframe times are layer-relative in AE; the scene is composition-referenced, so each is
 * shifted by the layer's `startTime` before conversion.
 */

import {
  type AeComposition,
  type AeLayer,
  type AeManifest,
  type AnimatableProperty,
  type AssetLibraryItem,
  type PropertyChannelMap,
  type PropertyKeyframe,
  type RationalFrameRate,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";
import path from "node:path";

export interface AeSceneImportWarning {
  code: string;
  message: string;
  layerName?: string;
}

/**
 * Where one piece of After Effects footage resolves to, how big it is, and what it is.
 *
 * The size is not decoration. An AE layer stores `position` as the world position of its anchor
 * and `anchorPoint` in the footage's own coordinates, so a layer placed at (960, 540) with an
 * anchor of (73, 61) only lands correctly if the object is 146x123 — the footage's real size.
 * Substituting the composition frame puts every anchor in the wrong place and stretches the image
 * across the canvas.
 *
 * The MIME is not decoration either. Collected assets are served from `/api/assets/<id>/content`,
 * which carries no file extension, so the renderer selects its texture parser from this value. An
 * asset published without one loads as `null` and draws the missing-texture placeholder.
 */
export interface AeResolvedFootage {
  src: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

export interface AeSceneImportResult {
  scene: SceneDocument;
  warnings: AeSceneImportWarning[];
  /** How many of the composition's layers became objects (the rest are placeholder-free). */
  convertedLayers: number;
}

/** The frame rates broadcast actually uses, so a float becomes the exact rational it came from. */
const BROADCAST_RATES: { value: number; rational: RationalFrameRate }[] = [
  { value: 24000 / 1001, rational: { numerator: 24000, denominator: 1001 } },
  { value: 24, rational: { numerator: 24, denominator: 1 } },
  { value: 25, rational: { numerator: 25, denominator: 1 } },
  { value: 30000 / 1001, rational: { numerator: 30000, denominator: 1001 } },
  { value: 30, rational: { numerator: 30, denominator: 1 } },
  { value: 50, rational: { numerator: 50, denominator: 1 } },
  { value: 60000 / 1001, rational: { numerator: 60000, denominator: 1001 } },
  { value: 60, rational: { numerator: 60, denominator: 1 } }
];

/**
 * Match a composition's float frame rate to the exact broadcast rational.
 *
 * A thousandth of a frame per second is far tighter than the gap between any two rates above and
 * far looser than the float error AE introduces, so it separates them reliably. Anything
 * unrecognised falls back to a whole number and is named in the warnings.
 */
export function aeFrameRateToRational(frameRate: number): { rational: RationalFrameRate; exact: boolean } {
  for (const candidate of BROADCAST_RATES) {
    if (Math.abs(candidate.value - frameRate) < 0.001) return { rational: candidate.rational, exact: true };
  }
  return { rational: { numerator: Math.max(1, Math.round(frameRate)), denominator: 1 }, exact: false };
}

/**
 * Every AE layer kind, mapped to what GrapiX draws for it.
 *
 * Exhaustive on purpose \u2014 a `Partial` here meant a kind nobody had thought about silently became a
 * rectangle. `camera` and `light` have no GrapiX equivalent that draws anything, so they map to a
 * hidden `group`: the layer keeps its place in the tree and its transform (a parented layer still
 * resolves against it) without pretending to render. `adjustment` is the same story \u2014 GrapiX has no
 * adjustment-layer compositing, and drawing an opaque rectangle instead would be worse than drawing
 * nothing.
 */
const LAYER_KIND_TO_OBJECT: Record<AeLayer["type"], SceneObject["type"]> = {
  text: "text",
  solid: "rect",
  shape: "rect",
  image: "image",
  video: "image",
  "image-sequence": "image",
  precomp: "group",
  null: "group",
  audio: "group",
  camera: "group",
  light: "group",
  adjustment: "group"
};

/** Kinds that map to a group because GrapiX cannot draw them, not because they contain children. */
const NON_DRAWING_KINDS: Record<string, string> = {
  audio: "audio is not drawn; the layer is kept as an empty group so timing and parenting survive",
  camera: "GrapiX cameras are scene-level, not layer-level; kept as an empty group",
  light: "GrapiX lights are scene-level, not layer-level; kept as an empty group",
  adjustment: "adjustment-layer compositing is not implemented; kept as an empty group so nothing is tinted"
};

interface ScalarExpansion {
  property: AnimatableProperty;
  value: number;
}

/** Read one numeric component, or `undefined` when it is not a finite number. */
function numericComponent(components: unknown[], index: number): number | undefined {
  const value = components[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Stream name → the scalar properties it expands to, in component order. */
function expandStream(streamProperty: string, keyframeValue: number | number[] | string | boolean): ScalarExpansion[] {
  const components = Array.isArray(keyframeValue) ? keyframeValue : [keyframeValue];
  const out: ScalarExpansion[] = [];
  const push = (property: AnimatableProperty, value: number | undefined, scale = 1) => {
    if (value !== undefined) out.push({ property, value: value * scale });
  };

  const propLower = streamProperty.toLowerCase().replace(/_/g, " ").trim();

  if (propLower.includes("opacity")) {
    push("opacity", numericComponent(components, 0), 1 / 100);
  } else if (propLower === "position" || propLower === "adbe position") {
    push("x", numericComponent(components, 0));
    push("y", numericComponent(components, 1));
    push("zDepth", numericComponent(components, 2));
  } else if (propLower === "positionx" || propLower === "position 0" || propLower === "x position" || propLower === "x") {
    push("x", numericComponent(components, 0));
  } else if (propLower === "positiony" || propLower === "position 1" || propLower === "y position" || propLower === "y") {
    push("y", numericComponent(components, 0));
  } else if (propLower === "positionz" || propLower === "position 2" || propLower === "z position" || propLower === "z") {
    push("zDepth", numericComponent(components, 0));
  } else if (propLower.includes("scale")) {
    push("scaleX", numericComponent(components, 0), 1 / 100);
    push("scaleY", numericComponent(components, 1), 1 / 100);
    push("scaleZ", numericComponent(components, 2), 1 / 100);
  } else if (propLower === "rotation" || propLower === "rotatez" || propLower === "rotation z" || propLower === "z rotation" || propLower === "adbe rotate z") {
    push("rotation", numericComponent(components, 0));
  } else if (propLower === "rotatex" || propLower === "rotation x" || propLower === "x rotation" || propLower === "adbe rotate x") {
    push("rotationX", numericComponent(components, 0));
  } else if (propLower === "rotatey" || propLower === "rotation y" || propLower === "y rotation" || propLower === "adbe rotate y") {
    push("rotationY", numericComponent(components, 0));
  } else if (propLower.includes("orientation")) {
    push("rotationX", numericComponent(components, 0));
    push("rotationY", numericComponent(components, 1));
    push("rotation", numericComponent(components, 2));
  } else if (propLower.includes("anchor")) {
    push("x", numericComponent(components, 0));
    push("y", numericComponent(components, 1));
  }

  return out;
}

/**
 * Convert one layer's animated streams into a scene `PropertyChannelMap`.
 *
 * Each stream's keyframes expand to one scalar channel per component, timed in frames against the
 * composition's rational rate and shifted by the layer's `startTime`. A stream that produces no
 * animatable scalar (an effect, a mask path, an audio level) is reported, not imported.
 */
function convertLayerAnimation(
  layer: AeLayer,
  rational: RationalFrameRate,
  warnings: AeSceneImportWarning[]
): PropertyChannelMap | undefined {
  const framesPerSecond = rational.numerator / rational.denominator;
  const channels: PropertyChannelMap = {};

  for (const stream of layer.streams) {
    if (stream.expression) {
      warnings.push({
        code: "ae.animation.expression",
        layerName: layer.name,
        message: `"${layer.name}" property "${stream.property}" is expression-driven; its baked keyframes were imported but the expression itself cannot be.`
      });
    }
    // Accumulate keys per scalar property across the stream's keyframes.
    const perProperty = new Map<AnimatableProperty, PropertyKeyframe[]>();
    for (let index = 0; index < stream.keyframes.length; index += 1) {
      const keyframe = stream.keyframes[index]!;
      for (const expanded of expandStream(stream.property, keyframe.value)) {
        // Layer-relative seconds → composition-referenced frame.
        const frame = Math.round((keyframe.time + layer.startTime) * framesPerSecond);
        if (!Number.isFinite(frame) || frame < 0) continue;
        const keys = perProperty.get(expanded.property) ?? [];
        keys.push({
          id: `ae-${layer.index}-${expanded.property}-${index}`,
          frame,
          value: expanded.value,
          // AE's "bezier" is a temporal ease with tangents the scene channel does not carry; map it
          // to the nearest named curve rather than drop the key. "hold" steps exactly as AE does.
          easing: keyframe.interpolation === "hold" ? "hold" : keyframe.interpolation === "bezier" ? "ease-in-out" : "linear"
        });
        perProperty.set(expanded.property, keys);
      }
    }
    if (perProperty.size === 0) {
      warnings.push({
        code: "ae.animation.unmapped",
        layerName: layer.name,
        message: `"${layer.name}" property "${stream.property}" has no GrapiX animatable equivalent and was not imported.`
      });
      continue;
    }
    for (const [property, keys] of perProperty) {
      keys.sort((left, right) => left.frame - right.frame);
      channels[property] = { keys };
    }
  }

  return Object.keys(channels).length ? channels : undefined;
}

/** The layer's static (un-keyframed) transform, mapped to scene-object fields. */
function layerStaticTransform(layer: AeLayer): Pick<SceneObject, "x" | "y" | "rotation" | "rotationX" | "rotationY" | "scaleX" | "scaleY" | "opacity" | "anchor"> {
  const position = layer.position;
  const scale = layer.scale;
  const rotation = layer.rotation;
  return {
    x: position[0] ?? 0,
    y: position[1] ?? 0,
    // 3D rotation is [x, y, z]; 2D is a lone Z value.
    rotation: rotation.length >= 3 ? rotation[2] ?? 0 : rotation[0] ?? 0,
    rotationX: rotation.length >= 3 ? rotation[0] ?? 0 : undefined,
    rotationY: rotation.length >= 3 ? rotation[1] ?? 0 : undefined,
    scaleX: (scale[0] ?? 100) / 100,
    scaleY: (scale[1] ?? 100) / 100,
    opacity: (layer.opacity ?? 100) / 100,
    anchor: layer.anchorPoint.length >= 2 ? { x: layer.anchorPoint[0] ?? 0, y: layer.anchorPoint[1] ?? 0 } : undefined
  };
}

function convertLayerToObject(
  layer: AeLayer,
  zIndex: number,
  composition: AeComposition,
  rational: RationalFrameRate,
  pathByAssetId: Map<string, AeResolvedFootage> | undefined,
  warnings: AeSceneImportWarning[],
  idPrefix = ""
): SceneObject {
  const mappedType = LAYER_KIND_TO_OBJECT[layer.type] ?? "rect";
  const nonDrawingReason = NON_DRAWING_KINDS[layer.type];
  if (nonDrawingReason) {
    warnings.push({
      code: "ae.layer.nonDrawing",
      layerName: layer.name,
      message: `"${layer.name}" (${layer.type}): ${nonDrawingReason}.`
    });
  }
  const animation = convertLayerAnimation(layer, rational, warnings);
  const transform = layerStaticTransform(layer);

  // Resolve the footage first: its intrinsic size is what the object's bounds must be, and the
  // composition frame is only a fallback for a layer whose real size is unknowable here.
  //
  // Name before id, deliberately. After Effects names a PSD-derived footage item `Footage 7192`,
  // which identifies nothing, but it names the composition layer after the Photoshop layer the
  // pixels came from. The id key only carries the ordinal guess, so consulting it first would let
  // that guess win over the exact match.
  const assetId = layer.sourceItemId !== undefined ? String(layer.sourceItemId) : undefined;
  const resolved = pathByAssetId?.get(layer.name.toLowerCase().trim())
    ?? (assetId ? pathByAssetId?.get(assetId) : undefined);

  const common = {
    id: `${idPrefix}ae-layer-${layer.index}`,
    name: layer.name,
    x: transform.x,
    y: transform.y,
    zDepth: 0,
    zIndex,
    layerId: "main",
    width: Math.max(1, Math.round(resolved?.width ?? composition.width)),
    height: Math.max(1, Math.round(resolved?.height ?? composition.height)),
    rotation: transform.rotation,
    rotationX: transform.rotationX,
    rotationY: transform.rotationY,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    anchor: transform.anchor,
    opacity: transform.opacity,
    visible: layer.visible,
    locked: layer.locked,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    animation,
    importedDesign: {
      sourceFormat: "aep" as const,
      sourceName: layer.name,
      sourceNodeType: layer.type,
      raw: { sourceItemId: layer.sourceItemId, blendingMode: layer.blendingMode }
    }
  };

  if (mappedType === "text" && layer.text) {
    return {
      ...common,
      type: "text",
      text: layer.text.content,
      textLayout: "point",
      fontSize: layer.text.fontSize,
      fontFamily: layer.text.fontFamily,
      fontWeight: "normal",
      align: layer.text.align === "justify" ? "left" : layer.text.align,
      fill: layer.text.fillColor
    };
  }
  if (mappedType === "rect") {
    return { ...common, type: "rect", radius: 0, fill: layer.solidColor ?? "transparent" };
  }
  if (mappedType === "group") {
    return { ...common, type: "group", childIds: [] };
  }
  if (mappedType === "image") {
    if (!resolved) {
      warnings.push({
        code: "ae.footage.unresolved",
        layerName: layer.name,
        message: `"${layer.name}" draws footage (${assetId ?? "unknown"}); no collected asset was resolved for it.`
      });
    }
    // `fill` rather than `contain`: the object is already the footage's own size, so the image
    // must map onto it one-to-one. `contain` would letterbox a correctly sized surface.
    return { ...common, type: "image", src: resolved?.src ?? "", objectFit: "stretch" };
  }
  return { ...common, type: "rect", radius: 0 };
}
export function aeCompositionToScene(
  composition: AeComposition,
  options?: {
    sceneId?: string;
    sceneName?: string;
    importId?: string;
    pathByAssetId?: Map<string, AeResolvedFootage>;
    manifest?: AeManifest;
  }
): AeSceneImportResult {
  const warnings: AeSceneImportWarning[] = [];
  const { rational, exact } = aeFrameRateToRational(composition.frameRate);
  if (!exact) {
    warnings.push({
      code: "ae.framerate.approximate",
      message: `Composition frame rate ${composition.frameRate} matches no broadcast rate; imported as ${rational.numerator}/${rational.denominator}.`
    });
  }
  const fps = rational.numerator / rational.denominator;
  const timestamp = new Date().toISOString();
  const importId = options?.importId ?? `import_${composition.id}_${Date.now().toString(36)}`;
  const rootGroupId = `ae-import-${importId}`;
  const manifest = options?.manifest;

  // Every distinct resolved source becomes a library asset, so the renderer can find the MIME and
  // fetch it through the authenticated content route instead of guessing at a bare path.
  const sceneAssets: AssetLibraryItem[] = [];
  if (options?.pathByAssetId) {
    const seenSources = new Set<string>();
    for (const [key, footage] of options.pathByAssetId) {
      if (seenSources.has(footage.src)) continue;
      seenSources.add(footage.src);
      // The MIME decides, not the path: a collected asset is served from an extension-less content
      // URL, so testing the source string would file every movie as an image.
      const isVideo = footage.mimeType?.startsWith("video/")
        ?? /\.(mp4|mov|webm|mkv)$/i.test(footage.src);
      sceneAssets.push({
        assetId: `ae_asset_${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        name: path.basename(footage.src),
        kind: isVideo ? "video" : "image",
        source: footage.src,
        // The renderer matches this entry by `source` and reads the MIME off it to choose a
        // texture parser, because the content URL has no extension to infer one from.
        mimeType: footage.mimeType ?? (isVideo ? "video/mp4" : "image/png"),
        importedAt: timestamp
      });
    }
  }

  // Recursive composition conversion helper
  const convertComp = (
    comp: AeComposition,
    parentTimeOffset = 0,
    depth = 0
  ): { objects: SceneObject[]; topLevelIds: string[] } => {
    const objects: SceneObject[] = [];
    const topLevelIds: string[] = [];
    const objectByLayerIndex = new Map<number, SceneObject>();

    for (let order = 0; order < comp.layers.length; order += 1) {
      const layer = comp.layers[order]!;
      const zIndex = comp.layers.length - 1 - order;
      const idPrefix = depth > 0 ? `comp-${comp.id}-d${depth}-` : "";
      const isPrecomp = layer.type === "precomp" && layer.sourceItemId !== undefined;
      const subComp = isPrecomp && manifest
        ? manifest.compositions.find((c: AeComposition) => String(c.id) === String(layer.sourceItemId))
        : null;

      const obj = convertLayerToObject(layer, zIndex, comp, rational, options?.pathByAssetId, warnings, idPrefix);
      objectByLayerIndex.set(layer.index, obj);

      if (subComp && depth < 8) {
        obj.type = "group";
        const subResult = convertComp(subComp, parentTimeOffset + layer.startTime, depth + 1);
        objects.push(...subResult.objects);
        if ("childIds" in obj && Array.isArray(obj.childIds)) {
          obj.childIds.push(...subResult.topLevelIds);
        }
      }
      objects.push(obj);
      topLevelIds.push(obj.id);
    }

    // Replicate parentIndex links into group childIds
    for (const layer of comp.layers) {
      if (layer.parentIndex !== undefined && layer.parentIndex !== null) {
        const parentObj = objectByLayerIndex.get(layer.parentIndex);
        const childObj = objectByLayerIndex.get(layer.index);
        if (parentObj && childObj) {
          parentObj.type = "group";
          if (!("childIds" in parentObj) || !Array.isArray(parentObj.childIds)) {
            (parentObj as unknown as { childIds: string[] }).childIds = [];
          }
          const pGroup = parentObj as unknown as { childIds: string[] };
          if (!pGroup.childIds.includes(childObj.id)) pGroup.childIds.push(childObj.id);
          const idx = topLevelIds.indexOf(childObj.id);
          if (idx !== -1) topLevelIds.splice(idx, 1);
        }
      }
    }

    return { objects, topLevelIds };
  };

  const compResult = convertComp(composition, 0, 0);

  // Wrap the imported composition's top-level objects into a single root group
  const rootGroup: SceneObject = {
    id: rootGroupId,
    name: composition.name,
    type: "group",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: Math.max(1, Math.round(composition.width)),
    height: Math.max(1, Math.round(composition.height)),
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    childIds: compResult.topLevelIds,
    importedDesign: {
      sourceFormat: "aep",
      sourceName: composition.name,
      sourceNodeType: "composition",
      raw: {
        importId,
        compositionId: composition.id
      }
    }
  };

  const objects: SceneObject[] = [rootGroup, ...compResult.objects];

  const scene: SceneDocument = {
    id: options?.sceneId ?? `ae-scene-${composition.id}`,
    name: options?.sceneName ?? composition.name,
    version: 1,
    canvas: {
      width: Math.max(1, Math.round(composition.width)),
      height: Math.max(1, Math.round(composition.height)),
      background: composition.backgroundColor || "#00000000"
    },
    dataContext: {
      __aeImport: {
        source: "after-effects",
        sourceFormat: "aep",
        sourceName: composition.name,
        sourceCompositionId: composition.id,
        importId,
        rootGroupId,
        importedAt: timestamp
      }
    },
    assets: sceneAssets,
    materials: [],
    materialInstances: [],
    shaders: [],
    materialFolders: [],
    gradientPresets: [],
    objects,
    timeline: {
      fps,
      frameRate: rational,
      durationFrames: Math.max(1, Math.round(composition.duration * fps)),
      keyframes: []
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };

  return { scene, warnings, convertedLayers: compResult.objects.length };
}
