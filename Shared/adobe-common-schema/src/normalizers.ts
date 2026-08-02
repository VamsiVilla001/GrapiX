import type {
  AdobeImportDocument,
  AdobeLayer,
  CompatibilityStatus,
  ImportWarning,
  TransformData
} from "./types.js";

export function defaultTransform(): TransformData {
  return {
    x: 0,
    y: 0,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    anchorZ: 0
  };
}

export function normalizeTransform(raw?: Partial<TransformData>): TransformData {
  const base = defaultTransform();
  if (!raw) return base;
  return {
    x: typeof raw.x === "number" && Number.isFinite(raw.x) ? raw.x : base.x,
    y: typeof raw.y === "number" && Number.isFinite(raw.y) ? raw.y : base.y,
    z: typeof raw.z === "number" && Number.isFinite(raw.z) ? raw.z : base.z,
    rotationX: typeof raw.rotationX === "number" && Number.isFinite(raw.rotationX) ? raw.rotationX : base.rotationX,
    rotationY: typeof raw.rotationY === "number" && Number.isFinite(raw.rotationY) ? raw.rotationY : base.rotationY,
    rotationZ: typeof raw.rotationZ === "number" && Number.isFinite(raw.rotationZ) ? raw.rotationZ : base.rotationZ,
    scaleX: typeof raw.scaleX === "number" && Number.isFinite(raw.scaleX) ? raw.scaleX : base.scaleX,
    scaleY: typeof raw.scaleY === "number" && Number.isFinite(raw.scaleY) ? raw.scaleY : base.scaleY,
    scaleZ: typeof raw.scaleZ === "number" && Number.isFinite(raw.scaleZ) ? raw.scaleZ : base.scaleZ,
    opacity: typeof raw.opacity === "number" && Number.isFinite(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : base.opacity,
    anchorX: typeof raw.anchorX === "number" && Number.isFinite(raw.anchorX) ? raw.anchorX : base.anchorX,
    anchorY: typeof raw.anchorY === "number" && Number.isFinite(raw.anchorY) ? raw.anchorY : base.anchorY,
    anchorZ: typeof raw.anchorZ === "number" && Number.isFinite(raw.anchorZ) ? raw.anchorZ : base.anchorZ
  };
}

export function classifyCompatibility(type: string, hasUnsupportedEffects = false): CompatibilityStatus {
  if (hasUnsupportedEffects) return "Converted";
  switch (type.toLowerCase()) {
    case "text":
    case "shape":
    case "pixel":
    case "solid":
    case "composition":
      return "Native";
    case "smart-object":
    case "precomp":
    case "adjustment":
      return "Converted";
    case "third-party-plugin":
    case "unknown":
      return "Unsupported";
    default:
      return "Native";
  }
}

export function validateAdobeImportDocument(doc: unknown): { valid: boolean; errors: string[]; normalized?: AdobeImportDocument } {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") {
    return { valid: false, errors: ["Document must be a non-null object"] };
  }
  const d = doc as Partial<AdobeImportDocument>;
  if (d.source !== "photoshop" && d.source !== "after-effects") {
    errors.push("Document source must be 'photoshop' or 'after-effects'");
  }
  if (typeof d.documentId !== "string" || !d.documentId.trim()) {
    errors.push("Document requires a valid documentId string");
  }
  if (typeof d.name !== "string" || !d.name.trim()) {
    errors.push("Document requires a valid name string");
  }
  if (typeof d.width !== "number" || !Number.isFinite(d.width) || d.width <= 0) {
    errors.push("Document width must be a finite positive number");
  }
  if (typeof d.height !== "number" || !Number.isFinite(d.height) || d.height <= 0) {
    errors.push("Document height must be a finite positive number");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const layers: AdobeLayer[] = Array.isArray(d.layers) ? d.layers.map(normalizeAdobeLayer) : [];
  const warnings: ImportWarning[] = Array.isArray(d.warnings) ? d.warnings : [];

  const normalized: AdobeImportDocument = {
    source: d.source!,
    documentId: d.documentId!,
    name: d.name!,
    width: d.width!,
    height: d.height!,
    frameRate: typeof d.frameRate === "number" && Number.isFinite(d.frameRate) && d.frameRate > 0
      ? d.frameRate
      : 30,
    duration: typeof d.duration === "number" && Number.isFinite(d.duration) && d.duration >= 0
      ? d.duration
      : 10,
    layers,
    assets: Array.isArray(d.assets) ? d.assets : [],
    warnings
  };

  return { valid: true, errors: [], normalized };
}

function normalizeAdobeLayer(layer: Partial<AdobeLayer>): AdobeLayer {
  return {
    id: typeof layer.id === "string" ? layer.id : `layer-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof layer.name === "string" ? layer.name : "Untitled Layer",
    type: typeof layer.type === "string" ? layer.type : "pixel",
    parentId: layer.parentId,
    visible: typeof layer.visible === "boolean" ? layer.visible : true,
    locked: typeof layer.locked === "boolean" ? layer.locked : false,
    opacity: typeof layer.opacity === "number" && Number.isFinite(layer.opacity)
      ? Math.min(1, Math.max(0, layer.opacity))
      : 1,
    transform: normalizeTransform(layer.transform),
    masks: Array.isArray(layer.masks) ? layer.masks : [],
    effects: Array.isArray(layer.effects) ? layer.effects : [],
    animation: layer.animation,
    children: Array.isArray(layer.children) ? layer.children.map(normalizeAdobeLayer) : [],
    textData: layer.textData,
    shapeData: layer.shapeData,
    assetId: layer.assetId,
    blendMode: layer.blendMode || "normal",
    status: layer.status || classifyCompatibility(layer.type || "pixel", (layer.effects || []).some((e) => e.status === "Unsupported"))
  };
}
