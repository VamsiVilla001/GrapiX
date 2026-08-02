/**
 * `@grapix/output-contracts` — output adapters behind a stable interface.
 *
 * Requirement 5 and requirement 13: keep output methods out of the renderer core,
 * and do not hard-code NDI, SDI, or display resolutions.
 *
 * Nothing here knows what NDI is. An adapter is an id, a declared set of
 * capabilities, and a frame sink. That is deliberately all: it means DeckLink,
 * AJA, a display window, and a file writer can be added later without touching
 * the renderer, the protocol, or the stage model.
 *
 * The honesty rule: an adapter that is compiled in but unusable — no SDK, no
 * hardware, no licence — reports `available: false` with a reason. It never
 * accepts frames and quietly discards them.
 */

import type { RationalFrameRate } from "@grapix/shared-types";

/** Pixel layouts an adapter may accept. Named, not assumed. */
export const OUTPUT_COLOR_FORMATS = [
  "bgra8",
  "rgba8",
  "bgra8-srgb",
  "rgba16f",
  "uyvy422",
  "v210",
  "p010"
] as const;
export type OutputColorFormat = (typeof OUTPUT_COLOR_FORMATS)[number];

export const OUTPUT_ALPHA_MODES = ["premultiplied", "straight", "opaque"] as const;
export type OutputAlphaMode = (typeof OUTPUT_ALPHA_MODES)[number];

export const OUTPUT_SCAN_MODES = ["progressive", "interlaced-upper", "interlaced-lower"] as const;
export type OutputScanMode = (typeof OUTPUT_SCAN_MODES)[number];

export const OUTPUT_COLOR_SPACES = ["srgb", "rec709", "rec2020-pq", "rec2020-hlg"] as const;
export type OutputColorSpace = (typeof OUTPUT_COLOR_SPACES)[number];

/**
 * Categories of output, for grouping in the UI only.
 *
 * The renderer never switches on this — it exists so an operator sees "SDI" and
 * "network" as different things.
 */
export const OUTPUT_ADAPTER_KINDS = [
  "null",
  "recording",
  "file",
  "network",
  "sdi",
  "display",
  "shared-memory",
  "encoder"
] as const;
export type OutputAdapterKind = (typeof OUTPUT_ADAPTER_KINDS)[number];

/** What one frame handed to an adapter looks like. */
export interface OutputFrameFormat {
  width: number;
  height: number;
  frameRate: RationalFrameRate;
  colorFormat: OutputColorFormat;
  alphaMode: OutputAlphaMode;
  scanMode: OutputScanMode;
  colorSpace: OutputColorSpace;
  pixelAspectRatio: number;
}

/**
 * What an adapter can do.
 *
 * `fixedFormats` empty means "any format the engine can render". A non-empty list
 * means the hardware only accepts those, which is normal for SDI.
 */
export interface OutputAdapterDescriptor {
  adapterId: string;
  name: string;
  kind: OutputAdapterKind;
  /** False when the adapter exists but cannot run here. */
  available: boolean;
  /** Required whenever `available` is false. Shown to the operator verbatim. */
  unavailableReason?: string;
  colorFormats: readonly OutputColorFormat[];
  alphaModes: readonly OutputAlphaMode[];
  scanModes: readonly OutputScanMode[];
  colorSpaces: readonly OutputColorSpace[];
  /** Empty means unconstrained. */
  fixedFormats: readonly { width: number; height: number; frameRate: RationalFrameRate }[];
  supportsAlpha: boolean;
  supportsGenlock: boolean;
  supportsHardwareEncoding: boolean;
  /** Maximum simultaneous instances, e.g. physical SDI ports. */
  maxInstances: number;
  /** Adapter-specific option keys, so a UI can present them without guessing. */
  optionKeys: readonly string[];
  /**
   * Whether this adapter has been certified against real hardware.
   *
   * False for everything that has not actually been run on a device. Never set
   * this true from a compile-time feature flag.
   */
  hardwareCertified: boolean;
}

export const OUTPUT_STATES = ["idle", "configured", "running", "error"] as const;
export type OutputState = (typeof OUTPUT_STATES)[number];

export interface OutputRuntimeStatus {
  adapterId: string;
  instanceId: string;
  state: OutputState;
  format?: OutputFrameFormat;
  framesAccepted: number;
  framesSent: number;
  /**
   * Frames dropped because the sink could not keep up.
   *
   * Dropping is correct: an output that blocks would stall the render clock and
   * take every other output down with it.
   */
  framesDropped: number;
  lastSendMs: number;
  lastError?: string;
  genlocked: boolean;
}

export type OutputConfigureResult =
  | { ok: true; format: OutputFrameFormat; warnings: string[] }
  | { ok: false; code: OutputConfigureErrorCode; message: string };

export const OUTPUT_CONFIGURE_ERROR_CODES = [
  "ADAPTER_UNAVAILABLE",
  "FORMAT_UNSUPPORTED",
  "RESOLUTION_UNSUPPORTED",
  "FRAME_RATE_UNSUPPORTED",
  "ALPHA_UNSUPPORTED",
  "INTERLACED_UNSUPPORTED",
  "TOO_MANY_INSTANCES",
  "DEVICE_BUSY",
  "INVALID_OPTION"
] as const;
export type OutputConfigureErrorCode = (typeof OUTPUT_CONFIGURE_ERROR_CODES)[number];

/**
 * The frame sink contract.
 *
 * Implemented natively in the engine; mirrored here so the Editor and Playout can
 * reason about outputs without importing anything from the engine.
 *
 * `send` must never block for longer than one frame. An adapter that cannot keep
 * up drops and counts, because the render clock is not allowed to wait for a
 * network stack.
 */
export interface OutputAdapter {
  readonly descriptor: OutputAdapterDescriptor;
  readonly instanceId: string;
  configure(format: OutputFrameFormat, options?: Record<string, unknown>): OutputConfigureResult;
  start(): void;
  stop(): void;
  /** Hand over one frame. Returns false when the frame was dropped. */
  send(frame: OutputFrame): boolean;
  status(): OutputRuntimeStatus;
  dispose(): void;
}

export interface OutputFrame {
  frameNumber: number;
  /** Presentation deadline in nanoseconds, from the engine's frame clock. */
  deadlineNanos: number;
  width: number;
  height: number;
  colorFormat: OutputColorFormat;
  /** Bytes per row, which may exceed `width * bytesPerPixel` for alignment. */
  stride: number;
  /** The engine owns this buffer; an adapter must not retain it past `send`. */
  pixels: Uint8Array;
}

/**
 * Validate a requested format against an adapter.
 *
 * Called before configuring, so an unsupported request is a clear message rather
 * than a driver error at air time.
 */
export function validateOutputFormat(
  descriptor: OutputAdapterDescriptor,
  format: OutputFrameFormat
): OutputConfigureResult {
  if (!descriptor.available) {
    return {
      ok: false,
      code: "ADAPTER_UNAVAILABLE",
      message: descriptor.unavailableReason
        ? `${descriptor.name} is unavailable: ${descriptor.unavailableReason}`
        : `${descriptor.name} is unavailable`
    };
  }

  if (!Number.isSafeInteger(format.width) || format.width <= 0
    || !Number.isSafeInteger(format.height) || format.height <= 0) {
    return {
      ok: false,
      code: "INVALID_OPTION",
      message: `${descriptor.name} requires positive whole-pixel dimensions`
    };
  }

  if (!Number.isSafeInteger(format.frameRate.numerator) || format.frameRate.numerator <= 0
    || !Number.isSafeInteger(format.frameRate.denominator) || format.frameRate.denominator <= 0) {
    return {
      ok: false,
      code: "FRAME_RATE_UNSUPPORTED",
      message: `${descriptor.name} requires a finite positive rational frame rate`
    };
  }

  if (!descriptor.colorFormats.includes(format.colorFormat)) {
    return {
      ok: false,
      code: "FORMAT_UNSUPPORTED",
      message: `${descriptor.name} does not accept ${format.colorFormat}; it supports ${descriptor.colorFormats.join(", ")}`
    };
  }

  if (!descriptor.alphaModes.includes(format.alphaMode)) {
    return {
      ok: false,
      code: "ALPHA_UNSUPPORTED",
      message: `${descriptor.name} does not accept ${format.alphaMode} alpha`
    };
  }

  if (format.scanMode !== "progressive" && !descriptor.scanModes.includes(format.scanMode)) {
    return {
      ok: false,
      code: "INTERLACED_UNSUPPORTED",
      message: `${descriptor.name} does not support ${format.scanMode}`
    };
  }

  if (descriptor.fixedFormats.length > 0) {
    const match = descriptor.fixedFormats.find(
      (candidate) =>
        candidate.width === format.width
        && candidate.height === format.height
        && candidate.frameRate.numerator * format.frameRate.denominator
          === format.frameRate.numerator * candidate.frameRate.denominator
    );
    if (!match) {
      return {
        ok: false,
        code: "RESOLUTION_UNSUPPORTED",
        message: `${descriptor.name} accepts only fixed formats; ${format.width}x${format.height} at ${format.frameRate.numerator}/${format.frameRate.denominator} is not one of them`
      };
    }
  }

  const warnings: string[] = [];
  if (format.alphaMode !== "opaque" && !descriptor.supportsAlpha) {
    warnings.push(`${descriptor.name} discards alpha; the key channel will be lost`);
  }
  if (!descriptor.hardwareCertified && descriptor.kind !== "null" && descriptor.kind !== "recording") {
    warnings.push(
      `${descriptor.name} has not been certified against real hardware; do not rely on it for a live show`
    );
  }

  return { ok: true, format, warnings };
}

/** The always-available development sink. */
export const NULL_OUTPUT_DESCRIPTOR: OutputAdapterDescriptor = Object.freeze<OutputAdapterDescriptor>({
  adapterId: "null",
  name: "Null output",
  kind: "null",
  available: true,
  colorFormats: ["bgra8", "rgba8"],
  alphaModes: ["premultiplied", "straight", "opaque"],
  scanModes: ["progressive"],
  colorSpaces: ["srgb"],
  fixedFormats: [],
  supportsAlpha: true,
  supportsGenlock: false,
  supportsHardwareEncoding: false,
  maxInstances: 8,
  optionKeys: [],
  hardwareCertified: true
});

/** Deterministic frame capture, for tests and visual comparison. */
export const RECORDING_OUTPUT_DESCRIPTOR: OutputAdapterDescriptor = Object.freeze<OutputAdapterDescriptor>({
  adapterId: "recording",
  name: "Deterministic recording",
  kind: "recording",
  available: true,
  colorFormats: ["bgra8"],
  alphaModes: ["premultiplied", "straight"],
  scanModes: ["progressive"],
  colorSpaces: ["srgb"],
  fixedFormats: [],
  supportsAlpha: true,
  supportsGenlock: false,
  supportsHardwareEncoding: false,
  maxInstances: 4,
  optionKeys: ["recordingName", "directory"],
  hardwareCertified: true
});

/**
 * Descriptors for adapters that need a vendor SDK.
 *
 * Declared so the protocol, the UI, and the capability check all know these
 * exist, and declared unavailable so nobody mistakes a declaration for an
 * implementation. Each becomes available only when its SDK is present *and* it
 * has been run against a device.
 */
export const PENDING_ADAPTER_DESCRIPTORS: readonly OutputAdapterDescriptor[] = Object.freeze([
  Object.freeze({
    adapterId: "ndi",
    name: "NDI",
    kind: "network" as OutputAdapterKind,
    available: false,
    unavailableReason: "requires NDI SDK 6.x at build time and network certification",
    colorFormats: ["bgra8"] as OutputColorFormat[],
    alphaModes: ["premultiplied", "straight"] as OutputAlphaMode[],
    scanModes: ["progressive"] as OutputScanMode[],
    colorSpaces: ["srgb"] as OutputColorSpace[],
    fixedFormats: [],
    supportsAlpha: true,
    supportsGenlock: false,
    supportsHardwareEncoding: false,
    maxInstances: 4,
    optionKeys: ["sourceName", "groups"],
    hardwareCertified: false
  }),
  Object.freeze({
    adapterId: "decklink",
    name: "Blackmagic DeckLink",
    kind: "sdi" as OutputAdapterKind,
    available: false,
    unavailableReason: "requires the DeckLink SDK and a certified device",
    colorFormats: ["bgra8", "uyvy422", "v210"] as OutputColorFormat[],
    alphaModes: ["premultiplied", "opaque"] as OutputAlphaMode[],
    scanModes: [
      "progressive",
      "interlaced-upper",
      "interlaced-lower"
    ] as OutputScanMode[],
    colorSpaces: ["rec709", "rec2020-pq"] as OutputColorSpace[],
    fixedFormats: [],
    supportsAlpha: true,
    supportsGenlock: true,
    supportsHardwareEncoding: false,
    maxInstances: 8,
    optionKeys: ["deviceIndex", "keyAndFill"],
    hardwareCertified: false
  }),
  Object.freeze({
    adapterId: "aja",
    name: "AJA",
    kind: "sdi" as OutputAdapterKind,
    available: false,
    unavailableReason: "requires the AJA NTV2 SDK and a certified device",
    colorFormats: ["bgra8", "uyvy422", "v210"] as OutputColorFormat[],
    alphaModes: ["premultiplied", "opaque"] as OutputAlphaMode[],
    scanModes: [
      "progressive",
      "interlaced-upper",
      "interlaced-lower"
    ] as OutputScanMode[],
    colorSpaces: ["rec709", "rec2020-pq"] as OutputColorSpace[],
    fixedFormats: [],
    supportsAlpha: true,
    supportsGenlock: true,
    supportsHardwareEncoding: false,
    maxInstances: 8,
    optionKeys: ["deviceIndex", "channel"],
    hardwareCertified: false
  })
]);

/** Registry contract. The engine owns the instances; this is the lookup. */
export interface OutputAdapterRegistry {
  descriptors(): readonly OutputAdapterDescriptor[];
  get(adapterId: string): OutputAdapterDescriptor | undefined;
  available(): readonly OutputAdapterDescriptor[];
}

export function createDescriptorRegistry(
  descriptors: readonly OutputAdapterDescriptor[]
): OutputAdapterRegistry {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.adapterId, descriptor]));
  return {
    descriptors: () => descriptors,
    get: (adapterId) => byId.get(adapterId),
    available: () => descriptors.filter((descriptor) => descriptor.available)
  };
}

/** Every adapter GrapiX knows about, available or not. */
export const ALL_ADAPTER_DESCRIPTORS: readonly OutputAdapterDescriptor[] = Object.freeze([
  NULL_OUTPUT_DESCRIPTOR,
  RECORDING_OUTPUT_DESCRIPTOR,
  ...PENDING_ADAPTER_DESCRIPTORS
]);

export function bytesPerPixel(format: OutputColorFormat): number {
  switch (format) {
    case "bgra8":
    case "rgba8":
    case "bgra8-srgb":
      return 4;
    case "rgba16f":
      return 8;
    case "uyvy422":
      return 2;
    case "v210":
      // 128 bits per 6 pixels; not a whole number per pixel.
      return 8 / 3;
    case "p010":
      return 3;
    default:
      return 4;
  }
}

/** Bytes one frame occupies, given a row alignment. */
export function frameByteSize(format: OutputFrameFormat, rowAlignment = 1): number {
  if (!Number.isSafeInteger(format.width) || format.width <= 0
    || !Number.isSafeInteger(format.height) || format.height <= 0
    || !Number.isSafeInteger(rowAlignment) || rowAlignment <= 0) {
    throw new RangeError("frame dimensions and row alignment must be positive whole numbers");
  }
  const rowBytes = Math.ceil(format.width * bytesPerPixel(format.colorFormat));
  const stride = Math.ceil(rowBytes / rowAlignment) * rowAlignment;
  const totalBytes = stride * format.height;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new RangeError("frame byte size exceeds JavaScript's safe integer range");
  }
  return totalBytes;
}
