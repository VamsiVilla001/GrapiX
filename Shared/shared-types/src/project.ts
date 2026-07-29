/**
 * Project settings.
 *
 * One resolution and one colour space govern the whole project: every scene
 * canvas, every editor viewport, and the resolution the engine renders Program
 * at. That is deliberate — a project whose scenes disagree about resolution
 * cannot be cut between on air, because a lower third authored at 1080 and a
 * full-frame authored at UHD would not line up.
 *
 * **Pixels are square.** Pixel aspect ratio is fixed at 1 and is not an authoring
 * control. Anamorphic and non-square-pixel delivery is an *output* concern, handled
 * by the surface and output mapping models where it belongs, so nothing in
 * authoring has to reason about it.
 */

import type { RationalFrameRate } from "./index.js";

/**
 * Colour space for the whole project.
 *
 * Chosen by the operator rather than inferred, because the wrong guess is
 * invisible on a monitor until the material reaches a broadcast chain. Each entry
 * names its primaries and transfer function explicitly.
 */
export const PROJECT_COLOR_SPACES = [
  "srgb",
  "rec709",
  "rec2020-pq",
  "rec2020-hlg",
  "display-p3"
] as const;
export type ProjectColorSpace = (typeof PROJECT_COLOR_SPACES)[number];

export interface ProjectColorSpaceInfo {
  id: ProjectColorSpace;
  label: string;
  primaries: string;
  transferFunction: string;
  /** True for high dynamic range spaces, which need a peak luminance. */
  highDynamicRange: boolean;
  description: string;
}

export const PROJECT_COLOR_SPACE_INFO: Readonly<
  Record<ProjectColorSpace, ProjectColorSpaceInfo>
> = Object.freeze({
  srgb: {
    id: "srgb",
    label: "sRGB",
    primaries: "BT.709",
    transferFunction: "sRGB (piecewise ~2.2)",
    highDynamicRange: false,
    description:
      "Computer graphics default. Correct for web and desktop delivery; for broadcast prefer Rec.709."
  },
  rec709: {
    id: "rec709",
    label: "Rec.709",
    primaries: "BT.709",
    transferFunction: "BT.1886 (gamma 2.4)",
    highDynamicRange: false,
    description: "Standard dynamic range broadcast. The right default for HD and UHD SDR."
  },
  "rec2020-pq": {
    id: "rec2020-pq",
    label: "Rec.2020 PQ (HDR10)",
    primaries: "BT.2020",
    transferFunction: "SMPTE ST 2084 (PQ)",
    highDynamicRange: true,
    description: "HDR with absolute luminance. Needs a peak luminance to be meaningful."
  },
  "rec2020-hlg": {
    id: "rec2020-hlg",
    label: "Rec.2020 HLG",
    primaries: "BT.2020",
    transferFunction: "ARIB STD-B67 (HLG)",
    highDynamicRange: true,
    description: "HDR with relative luminance, backwards compatible with SDR displays."
  },
  "display-p3": {
    id: "display-p3",
    label: "Display P3",
    primaries: "DCI-P3",
    transferFunction: "sRGB",
    highDynamicRange: false,
    description: "Wide-gamut desktop delivery. Not a broadcast space."
  }
});

/** Named resolutions, with `custom` for anything else. */
export const RESOLUTION_PRESETS = [
  "hd-720",
  "hd-1080",
  "uhd-4k",
  "dci-4k",
  "uhd-8k",
  "custom"
] as const;
export type ResolutionPresetId = (typeof RESOLUTION_PRESETS)[number];

export interface ResolutionPreset {
  id: ResolutionPresetId;
  label: string;
  width: number;
  height: number;
}

export const RESOLUTION_PRESET_INFO: Readonly<
  Record<Exclude<ResolutionPresetId, "custom">, ResolutionPreset>
> = Object.freeze({
  "hd-720": { id: "hd-720", label: "HD 720p (1280 × 720)", width: 1280, height: 720 },
  "hd-1080": { id: "hd-1080", label: "HD 1080p (1920 × 1080)", width: 1920, height: 1080 },
  "uhd-4k": { id: "uhd-4k", label: "UHD 4K (3840 × 2160)", width: 3840, height: 2160 },
  "dci-4k": { id: "dci-4k", label: "DCI 4K (4096 × 2160)", width: 4096, height: 2160 },
  "uhd-8k": { id: "uhd-8k", label: "UHD 8K (7680 × 4320)", width: 7680, height: 4320 }
});

/**
 * Bounds for a custom resolution.
 *
 * The ceiling is the same 50,000 logical limit the stage model uses, because a
 * project resolution *is* a logical canvas size. Anything that large must be tiled,
 * and the engine's capability check enforces that separately.
 */
export const MIN_PROJECT_DIMENSION = 16;
export const MAX_PROJECT_DIMENSION = 50_000;

/** Pixel aspect ratio is fixed. Square pixels, always. */
export const PROJECT_PIXEL_ASPECT_RATIO = 1 as const;

export const PROJECT_SETTINGS_VERSION = 1 as const;

export interface ProjectResolution {
  preset: ResolutionPresetId;
  width: number;
  height: number;
  /**
   * Always 1. Present so the value is explicit on the wire and in saved files
   * rather than being an unstated assumption every consumer has to know.
   */
  pixelAspectRatio: typeof PROJECT_PIXEL_ASPECT_RATIO;
}

export interface ProjectSettings {
  version: typeof PROJECT_SETTINGS_VERSION;
  name: string;
  resolution: ProjectResolution;
  colorSpace: ProjectColorSpace;
  /** Peak luminance in nits. Only meaningful for the HDR spaces. */
  peakLuminanceNits?: number;
  frameRate: RationalFrameRate;
  /** Default safe-area insets as a fraction of each edge, for new scenes. */
  safeAreaPercent: number;
  updatedAt: string;
}

export const DEFAULT_PROJECT_SETTINGS: Readonly<ProjectSettings> = Object.freeze({
  version: PROJECT_SETTINGS_VERSION,
  name: "Untitled project",
  resolution: Object.freeze({
    preset: "hd-1080",
    width: 1920,
    height: 1080,
    pixelAspectRatio: PROJECT_PIXEL_ASPECT_RATIO
  }) as ProjectResolution,
  // Rec.709 rather than sRGB: this is a broadcast tool, and the difference in
  // transfer function is visible on a calibrated monitor.
  colorSpace: "rec709",
  frameRate: Object.freeze({ numerator: 50, denominator: 1 }) as RationalFrameRate,
  safeAreaPercent: 0.05,
  updatedAt: new Date(0).toISOString()
});

export function resolutionForPreset(preset: ResolutionPresetId): ResolutionPreset | undefined {
  if (preset === "custom") return undefined;
  return RESOLUTION_PRESET_INFO[preset];
}

/**
 * Which preset a width and height correspond to.
 *
 * Lets the UI show "UHD 4K" rather than "custom" when someone types 3840 × 2160 by
 * hand, so the two paths cannot disagree.
 */
export function presetForResolution(width: number, height: number): ResolutionPresetId {
  for (const preset of Object.values(RESOLUTION_PRESET_INFO)) {
    if (preset.width === width && preset.height === height) return preset.id;
  }
  return "custom";
}

export type ProjectSettingsIssueSeverity = "error" | "warning";

export interface ProjectSettingsIssue {
  severity: ProjectSettingsIssueSeverity;
  code: string;
  message: string;
  field?: string;
}

export interface ProjectSettingsValidation {
  valid: boolean;
  issues: ProjectSettingsIssue[];
}

/**
 * Deterministic normalisation.
 *
 * Clamps, snaps the preset to the dimensions, and forces square pixels. The same
 * input always produces the same output, so the editor, the project service and the
 * engine cannot disagree about what a project's resolution is.
 */
export function normalizeProjectSettings(
  value: Partial<ProjectSettings> | undefined
): ProjectSettings {
  const requested = value?.resolution;

  // A named preset is authoritative over any dimensions stored beside it, so a
  // hand-edited file cannot end up claiming "HD 1080" at 1280 × 720.
  const fromPreset = requested?.preset ? resolutionForPreset(requested.preset) : undefined;

  const width = clampDimension(
    fromPreset?.width ?? requested?.width,
    DEFAULT_PROJECT_SETTINGS.resolution.width
  );
  const height = clampDimension(
    fromPreset?.height ?? requested?.height,
    DEFAULT_PROJECT_SETTINGS.resolution.height
  );

  const colorSpace: ProjectColorSpace = PROJECT_COLOR_SPACES.includes(
    value?.colorSpace as ProjectColorSpace
  )
    ? (value?.colorSpace as ProjectColorSpace)
    : DEFAULT_PROJECT_SETTINGS.colorSpace;

  const settings: ProjectSettings = {
    version: PROJECT_SETTINGS_VERSION,
    name: value?.name?.trim() || DEFAULT_PROJECT_SETTINGS.name,
    resolution: {
      // Derive the preset from the final dimensions rather than trusting the input.
      preset: presetForResolution(width, height),
      width,
      height,
      pixelAspectRatio: PROJECT_PIXEL_ASPECT_RATIO
    },
    colorSpace,
    frameRate: normalizeRationalRate(value?.frameRate),
    safeAreaPercent: clampFraction(value?.safeAreaPercent, DEFAULT_PROJECT_SETTINGS.safeAreaPercent),
    updatedAt: value?.updatedAt ?? DEFAULT_PROJECT_SETTINGS.updatedAt
  };

  // Peak luminance is only meaningful for HDR, so it is dropped for SDR rather
  // than carried as a misleading value.
  if (PROJECT_COLOR_SPACE_INFO[colorSpace].highDynamicRange) {
    const peak = value?.peakLuminanceNits;
    settings.peakLuminanceNits =
      typeof peak === "number" && Number.isFinite(peak) && peak > 0
        ? Math.min(10_000, Math.round(peak))
        : 1_000;
  }

  return settings;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  // Even dimensions: odd widths break 4:2:0 chroma subsampling in every broadcast
  // codec, so the constraint belongs here rather than surfacing at encode time.
  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded + 1;
  return Math.min(MAX_PROJECT_DIMENSION, Math.max(MIN_PROJECT_DIMENSION, even));
}

function clampFraction(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(0.25, value);
}

function normalizeRationalRate(value: Partial<RationalFrameRate> | undefined): RationalFrameRate {
  const numerator = value?.numerator;
  const denominator = value?.denominator;
  if (
    typeof numerator === "number"
    && Number.isFinite(numerator)
    && numerator > 0
    && typeof denominator === "number"
    && Number.isFinite(denominator)
    && denominator > 0
  ) {
    return { numerator: Math.round(numerator), denominator: Math.round(denominator) };
  }
  return { ...DEFAULT_PROJECT_SETTINGS.frameRate };
}

/**
 * Validate settings, reporting anything an operator should know before authoring.
 *
 * Errors mean the settings cannot be used; warnings mean they will work but carry a
 * consequence worth stating.
 */
export function validateProjectSettings(
  settings: ProjectSettings
): ProjectSettingsValidation {
  const issues: ProjectSettingsIssue[] = [];
  const { width, height } = settings.resolution;

  if (width < MIN_PROJECT_DIMENSION || width > MAX_PROJECT_DIMENSION) {
    issues.push({
      severity: "error",
      code: "WIDTH_OUT_OF_RANGE",
      field: "resolution.width",
      message: `width must be between ${MIN_PROJECT_DIMENSION} and ${MAX_PROJECT_DIMENSION}`
    });
  }
  if (height < MIN_PROJECT_DIMENSION || height > MAX_PROJECT_DIMENSION) {
    issues.push({
      severity: "error",
      code: "HEIGHT_OUT_OF_RANGE",
      field: "resolution.height",
      message: `height must be between ${MIN_PROJECT_DIMENSION} and ${MAX_PROJECT_DIMENSION}`
    });
  }

  if (width % 2 !== 0 || height % 2 !== 0) {
    issues.push({
      severity: "error",
      code: "ODD_DIMENSION",
      field: "resolution",
      message: "width and height must be even; odd dimensions break 4:2:0 chroma subsampling"
    });
  }

  if (settings.resolution.pixelAspectRatio !== PROJECT_PIXEL_ASPECT_RATIO) {
    issues.push({
      severity: "error",
      code: "NON_SQUARE_PIXELS",
      field: "resolution.pixelAspectRatio",
      message:
        "project pixels are square; non-square delivery is configured on the output, not in authoring"
    });
  }

  // A project this large cannot be one GPU texture. It is legal, but the operator
  // needs to know tiling is mandatory rather than optional.
  if (width > 16_384 || height > 16_384) {
    issues.push({
      severity: "warning",
      code: "REQUIRES_TILING",
      field: "resolution",
      message: `${width} × ${height} exceeds the texture limit of typical hardware, so the render engine must tile it`
    });
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > 100) {
    issues.push({
      severity: "warning",
      code: "VERY_LARGE_PROJECT",
      field: "resolution",
      message: `${megapixels.toFixed(1)} megapixels per frame; expect reduced frame rates without a region-based output setup`
    });
  }

  const info = PROJECT_COLOR_SPACE_INFO[settings.colorSpace];
  if (info.highDynamicRange && settings.peakLuminanceNits === undefined) {
    issues.push({
      severity: "warning",
      code: "HDR_WITHOUT_PEAK_LUMINANCE",
      field: "peakLuminanceNits",
      message: `${info.label} is an HDR space; set a peak luminance or tone mapping is undefined`
    });
  }
  if (!info.highDynamicRange && settings.peakLuminanceNits !== undefined) {
    issues.push({
      severity: "warning",
      code: "PEAK_LUMINANCE_IGNORED",
      field: "peakLuminanceNits",
      message: `${info.label} is a standard dynamic range space, so peak luminance is ignored`
    });
  }
  if (settings.colorSpace === "srgb" || settings.colorSpace === "display-p3") {
    issues.push({
      severity: "warning",
      code: "NON_BROADCAST_COLOR_SPACE",
      field: "colorSpace",
      message: `${info.label} is not a broadcast colour space; Rec.709 is the standard choice for SDR delivery`
    });
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

/** The canvas every scene in this project uses. */
export function projectCanvasSize(settings: ProjectSettings): {
  width: number;
  height: number;
} {
  return { width: settings.resolution.width, height: settings.resolution.height };
}

/** Default safe-area insets in pixels, derived from the project percentage. */
export function projectSafeAreaInsets(settings: ProjectSettings): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const { width, height } = settings.resolution;
  return {
    top: Math.round(height * settings.safeAreaPercent),
    right: Math.round(width * settings.safeAreaPercent),
    bottom: Math.round(height * settings.safeAreaPercent),
    left: Math.round(width * settings.safeAreaPercent)
  };
}

export interface SceneResolutionMismatch {
  sceneId: string;
  sceneName: string;
  sceneWidth: number;
  sceneHeight: number;
}

/**
 * Scenes whose canvas does not match the project.
 *
 * The whole reason project resolution is a single setting: two scenes at different
 * resolutions cannot be cut between on air. This finds the ones that would need
 * conforming after a resolution change.
 */
export function findResolutionMismatches(
  settings: ProjectSettings,
  scenes: readonly { id: string; name: string; canvas: { width: number; height: number } }[]
): SceneResolutionMismatch[] {
  const { width, height } = settings.resolution;
  return scenes
    .filter((scene) => scene.canvas.width !== width || scene.canvas.height !== height)
    .map((scene) => ({
      sceneId: scene.id,
      sceneName: scene.name,
      sceneWidth: scene.canvas.width,
      sceneHeight: scene.canvas.height
    }));
}

/** Colour space as the engine and output adapters name it. */
export function colorSpaceWireName(colorSpace: ProjectColorSpace): string {
  return colorSpace;
}
