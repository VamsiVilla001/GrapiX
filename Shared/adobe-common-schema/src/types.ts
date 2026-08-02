export type CompatibilityStatus = "Native" | "Converted" | "Rasterised" | "Unsupported";

export interface TransformData {
  x: number;
  y: number;
  z?: number;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  scaleX: number;
  scaleY: number;
  scaleZ?: number;
  opacity: number;
  anchorX?: number;
  anchorY?: number;
  anchorZ?: number;
}

export interface MaskData {
  id: string;
  name?: string;
  mode: "add" | "subtract" | "intersect" | "difference" | "alpha" | "none";
  pathData?: string;
  alphaAssetId?: string;
  inverted?: boolean;
  opacity?: number;
  feather?: number;
  expansion?: number;
}

export interface EffectData {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
  status: CompatibilityStatus;
}

export interface KeyframeData {
  time: number;
  frame?: number;
  value: unknown;
  easing?: string;
  inHandle?: { x: number; y: number };
  outHandle?: { x: number; y: number };
}

export interface PropertyChannelData {
  property: string;
  keyframes: KeyframeData[];
}

export interface AnimationData {
  duration: number;
  frameRate: number;
  channels: PropertyChannelData[];
}

export interface TextData {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontStyle?: string;
  color: string;
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: number;
  letterSpacing?: number;
}

export interface ShapeData {
  pathData?: string;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  cornerRadius?: number;
}

export interface AdobeLayer {
  id: string;
  name: string;
  type:
    | "text"
    | "shape"
    | "pixel"
    | "smart-object"
    | "group"
    | "adjustment"
    | "composition"
    | "precomp"
    | "solid"
    | "image"
    | "video"
    | "null"
    | "camera"
    | "light"
    | string;
  parentId?: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: TransformData;
  masks?: MaskData[];
  effects?: EffectData[];
  animation?: AnimationData;
  children?: AdobeLayer[];
  textData?: TextData;
  shapeData?: ShapeData;
  assetId?: string;
  blendMode?: string;
  status?: CompatibilityStatus;
}

export interface AdobeAsset {
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "font" | "data" | "source";
  mimeType?: string;
  dataBase64?: string;
  checksum?: string;
  url?: string;
}

export interface ImportWarning {
  code: string;
  message: string;
  layerId?: string;
  layerName?: string;
  status: CompatibilityStatus;
}

export interface AdobeImportDocument {
  source: "photoshop" | "after-effects";
  documentId: string;
  name: string;
  width: number;
  height: number;
  frameRate?: number;
  duration?: number;
  layers: AdobeLayer[];
  assets: AdobeAsset[];
  warnings: ImportWarning[];
}

export interface AdobeExportRequest {
  target: "photoshop" | "after-effects";
  sceneId: string;
  sceneName: string;
  width: number;
  height: number;
  frameRate?: number;
  duration?: number;
  layers: AdobeLayer[];
  assets: AdobeAsset[];
}

export interface AdobeApplicationStatus {
  app: "photoshop" | "after-effects";
  installed: boolean;
  /** A local plugin bridge holds a socket right now. */
  connected: boolean;
  version?: string;
  bridgeVersion?: string;
  activeDocument?: string;
  permissionsStatus?: "granted" | "denied" | "pending";
  lastConnectedAt?: number;
  /**
   * Adobe's Photoshop API is configured and usable without a local Photoshop.
   * Always false for After Effects, which has no cloud API.
   */
  cloudAvailable: boolean;
  /** Why the cloud transport is unusable, when it is not. */
  cloudDetail?: string;
}

export interface AdobeGatewayStatus {
  gatewayVersion: string;
  port: number;
  protocol: string;
  applications: Record<"photoshop" | "after-effects", AdobeApplicationStatus>;
  connectedClients: number;
}
