import { create } from "zustand";
import type { BrushBlendMode, ColorValue, Vec2 } from "@grapix/shared-types";

type PropertiesTab = "Properties" | "Materials" | "Text" | "Data Binding";
export type EditorTool =
  | "select"
  | "move"
  | "rotate"
  | "scale"
  | "pivot"
  | "pen"
  | "path-selection"
  | "direct-selection"
  | "horizontal-type"
  | "vertical-type"
  | "brush"
  | "eyedropper"
  | "rectangular-marquee"
  | "elliptical-marquee";
export type PenTarget = "shape" | "mask";
export type ToolGroup = "selection" | "type" | "marquee";
export type MarqueeOperation = "new" | "add" | "subtract" | "intersect";
export type MarqueeMode = "objects" | "region" | "mask";

export interface MarqueeSelection {
  kind: "rectangle" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
  operation: MarqueeOperation;
}

export interface BrushOptions {
  mode: "paint" | "mask-paint" | "mask-erase" | "mask-reveal";
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  smoothing: number;
  roundness: number;
  angle: number;
  blendMode: BrushBlendMode;
}
export interface TypeOptions {
  fontId: string | null;
  fontSize: number;
  fontWeight: string;
  fontStyle: "normal" | "italic" | "oblique";
}


/**
 * What the pen paints with.
 *
 * A path can be a filled region, an outline, or both, and which one you want is decided before
 * you draw rather than repaired in the Inspector afterwards — so the options bar carries it, the
 * way the brush carries its size and the type tool its font.
 */
export interface PenOptions {
  fillEnabled: boolean;
  strokeEnabled: boolean;
}

export interface MarqueeOptions {
  mode: MarqueeMode;
  operation: MarqueeOperation;
  constraint: "free" | "fixed-ratio" | "fixed-size";
  ratio: number;
  fixedWidth: number;
  fixedHeight: number;
  fromCenter: boolean;
  feather: number;
  objectContainment: "touching" | "enclosed";
}

export interface EyedropperOptions {
  sampleSize: 1 | 3 | 5 | 11;
  source: "composited" | "active-layer";
  copyGradient: boolean;
  applyToSelection: boolean;
}

interface UiState {
  zoom: number;
  snapping: boolean;
  propertiesTab: PropertiesTab;
  activeTool: EditorTool;
  penTarget: PenTarget;
  lastGroupTool: Record<ToolGroup, EditorTool>;
  selectedPathObjectIds: string[];
  selectedAnchorIndices: number[];
  selectedMaskId: string | null;
  marqueeSelection: MarqueeSelection | null;
  foregroundColor: ColorValue;
  typeOptions: TypeOptions;
  penOptions: PenOptions;
  brushOptions: BrushOptions;
  marqueeOptions: MarqueeOptions;
  eyedropperOptions: EyedropperOptions;
  timelinePlaying: boolean;
  currentFrame: number;
  setZoom: (zoom: number) => void;
  toggleSnapping: () => void;
  setActiveTool: (tool: EditorTool) => void;
  setSelectedPaths: (objectIds: string[]) => void;
  setSelectedAnchors: (indices: number[]) => void;
  setSelectedMaskId: (maskId: string | null) => void;
  setMarqueeSelection: (selection: MarqueeSelection | null) => void;
  setForegroundColor: (color: ColorValue) => void;
  updateTypeOptions: (patch: Partial<TypeOptions>) => void;
  updatePenOptions: (patch: Partial<PenOptions>) => void;
  updateBrushOptions: (patch: Partial<BrushOptions>) => void;
  updateMarqueeOptions: (patch: Partial<MarqueeOptions>) => void;
  updateEyedropperOptions: (patch: Partial<EyedropperOptions>) => void;
  setPenTarget: (target: PenTarget) => void;
  setPropertiesTab: (tab: PropertiesTab) => void;
  setCurrentFrame: (frame: number, durationFrames?: number) => void;
  toggleTimelinePlayback: () => void;
  goToStart: () => void;
  stepTimeline: (durationFrames: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  zoom: 100,
  snapping: true,
  propertiesTab: "Properties",
  activeTool: "select",
  penTarget: "shape",
  lastGroupTool: {
    selection: "path-selection",
    type: "horizontal-type",
    marquee: "rectangular-marquee"
  },
  selectedPathObjectIds: [],
  selectedAnchorIndices: [],
  selectedMaskId: null,
  marqueeSelection: null,
  typeOptions: {
    fontId: null,
    fontSize: 48,
    fontWeight: "700",
    fontStyle: "normal"
  },
  foregroundColor: { type: "solid", color: "#ffffff" },
  // Fill and stroke both on, matching the pen in the design tools this panel is modelled on: a
  // new path reads as a shape straight away rather than as an invisible outline.
  penOptions: {
    fillEnabled: true,
    strokeEnabled: true
  },
  brushOptions: {
    mode: "paint",
    size: 36,
    hardness: 0.8,
    opacity: 1,
    flow: 1,
    spacing: 0.15,
    smoothing: 0.55,
    roundness: 1,
    angle: 0,
    blendMode: "normal"
  },
  marqueeOptions: {
    mode: "objects",
    operation: "new",
    constraint: "free",
    ratio: 1,
    fixedWidth: 320,
    fixedHeight: 180,
    fromCenter: false,
    feather: 0,
    objectContainment: "touching"
  },
  eyedropperOptions: {
    sampleSize: 1,
    source: "composited",
    copyGradient: false,
    applyToSelection: false
  },
  timelinePlaying: false,
  currentFrame: 0,
  setZoom: (zoom) => set({ zoom }),
  toggleSnapping: () => set((state) => ({ snapping: !state.snapping })),
  setActiveTool: (activeTool) => set((state) => ({
    activeTool,
    lastGroupTool: {
      ...state.lastGroupTool,
      ...(activeTool === "path-selection" || activeTool === "direct-selection"
        ? { selection: activeTool }
        : {}),
      ...(activeTool === "horizontal-type" || activeTool === "vertical-type"
        ? { type: activeTool }
        : {}),
      ...(activeTool === "rectangular-marquee" || activeTool === "elliptical-marquee"
        ? { marquee: activeTool }
        : {})
    }
  })),
  setSelectedPaths: (selectedPathObjectIds) => set({ selectedPathObjectIds }),
  setSelectedAnchors: (selectedAnchorIndices) => set({ selectedAnchorIndices }),
  setSelectedMaskId: (selectedMaskId) => set({ selectedMaskId }),
  setMarqueeSelection: (marqueeSelection) => set({ marqueeSelection }),
  setForegroundColor: (foregroundColor) => set({ foregroundColor }),
  updateTypeOptions: (patch) => set((state) => ({ typeOptions: { ...state.typeOptions, ...patch } })),
  updatePenOptions: (patch) => set((state) => ({ penOptions: { ...state.penOptions, ...patch } })),
  updateBrushOptions: (patch) => set((state) => ({ brushOptions: { ...state.brushOptions, ...patch } })),
  updateMarqueeOptions: (patch) => set((state) => ({ marqueeOptions: { ...state.marqueeOptions, ...patch } })),
  updateEyedropperOptions: (patch) => set((state) => ({ eyedropperOptions: { ...state.eyedropperOptions, ...patch } })),
  setPenTarget: (penTarget) => set({ penTarget }),
  setPropertiesTab: (propertiesTab) => set({ propertiesTab }),
  setCurrentFrame: (currentFrame, durationFrames) =>
    set({
      currentFrame: clampCurrentFrame(currentFrame, durationFrames)
    }),
  toggleTimelinePlayback: () => set((state) => ({ timelinePlaying: !state.timelinePlaying })),
  goToStart: () => set({ currentFrame: 0, timelinePlaying: false }),
  stepTimeline: (durationFrames) =>
    set((state) => {
      const nextFrame = Math.min(state.currentFrame + 1, durationFrames);

      return {
        currentFrame: nextFrame,
        timelinePlaying: nextFrame < durationFrames
      };
    })
}));

function clampCurrentFrame(frame: number, durationFrames?: number): number {
  const roundedFrame = Number.isFinite(frame) ? Math.round(frame) : 0;
  const maximum = Number.isFinite(durationFrames)
    ? Math.max(0, Math.round(durationFrames!))
    : Number.POSITIVE_INFINITY;

  return Math.min(maximum, Math.max(0, roundedFrame));
}
