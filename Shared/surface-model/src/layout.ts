/**
 * Surface layout document.
 *
 * The set of physical displays belonging to one stage, plus the colour profiles
 * they reference. Kept as its own document because an installation's physical
 * layout is surveyed and calibrated on a different schedule from the graphics
 * authored onto it.
 */

import type { StageDocument, StageSurfacePlacement } from "@grapix/stage-model";

import {
  normalizeDisplaySurface,
  surfaceCalibrationPending,
  surfaceDeviceSize,
  type DisplaySurface
} from "./surface.js";
import { findSurfaceOverlaps } from "./mapper.js";

export const SURFACE_LAYOUT_VERSION = 1 as const;

/** Reference-only colour description. Full ICC handling is a later phase. */
export interface SurfaceColorProfile {
  profileId: string;
  name: string;
  primaries: "rec709" | "rec2020" | "dci-p3" | "srgb" | "custom";
  transferFunction: "srgb" | "gamma22" | "gamma24" | "pq" | "hlg" | "linear";
  whitePointKelvin?: number;
  /** Peak luminance in nits, for HDR-capable LED products. */
  peakLuminanceNits?: number;
}

export interface SurfaceLayoutDocument {
  layoutId: string;
  name: string;
  version: typeof SURFACE_LAYOUT_VERSION;
  /** Stage this layout describes. */
  stageId: string;
  revision?: number;
  surfaces: DisplaySurface[];
  colorProfiles: SurfaceColorProfile[];
  createdAt: string;
  updatedAt: string;
}

export function createSurfaceLayout(
  stageId: string,
  overrides: Partial<SurfaceLayoutDocument> = {}
): SurfaceLayoutDocument {
  return normalizeSurfaceLayout({ ...overrides, stageId });
}

export function normalizeSurfaceLayout(
  value: Partial<SurfaceLayoutDocument> & { stageId: string }
): SurfaceLayoutDocument {
  const timestamp = new Date(0).toISOString();
  const seen = new Set<string>();
  const surfaces: DisplaySurface[] = [];

  for (const candidate of value.surfaces ?? []) {
    if (!candidate?.surfaceId || seen.has(candidate.surfaceId)) continue;
    seen.add(candidate.surfaceId);
    surfaces.push(normalizeDisplaySurface(candidate));
  }

  const profileIds = new Set<string>();
  const colorProfiles: SurfaceColorProfile[] = [];
  for (const candidate of value.colorProfiles ?? []) {
    if (!candidate?.profileId || profileIds.has(candidate.profileId)) continue;
    profileIds.add(candidate.profileId);
    colorProfiles.push(normalizeColorProfile(candidate));
  }

  const layout: SurfaceLayoutDocument = {
    layoutId: value.layoutId?.trim() || `layout_${value.stageId}`,
    name: value.name?.trim() || "Surface layout",
    version: SURFACE_LAYOUT_VERSION,
    stageId: value.stageId,
    surfaces,
    colorProfiles,
    createdAt: value.createdAt ?? timestamp,
    updatedAt: value.updatedAt ?? timestamp
  };

  if (typeof value.revision === "number" && Number.isFinite(value.revision)) {
    layout.revision = Math.max(0, Math.floor(value.revision));
  }

  return layout;
}

function normalizeColorProfile(value: Partial<SurfaceColorProfile>): SurfaceColorProfile {
  const primaries: SurfaceColorProfile["primaries"] =
    value.primaries === "rec2020"
    || value.primaries === "dci-p3"
    || value.primaries === "srgb"
    || value.primaries === "custom"
      ? value.primaries
      : "rec709";

  const transferFunction: SurfaceColorProfile["transferFunction"] =
    value.transferFunction === "gamma22"
    || value.transferFunction === "gamma24"
    || value.transferFunction === "pq"
    || value.transferFunction === "hlg"
    || value.transferFunction === "linear"
      ? value.transferFunction
      : "srgb";

  const profile: SurfaceColorProfile = {
    profileId: value.profileId ?? "profile_rec709",
    name: value.name?.trim() || "Rec.709",
    primaries,
    transferFunction
  };

  if (typeof value.whitePointKelvin === "number" && value.whitePointKelvin > 0) {
    profile.whitePointKelvin = value.whitePointKelvin;
  }
  if (typeof value.peakLuminanceNits === "number" && value.peakLuminanceNits > 0) {
    profile.peakLuminanceNits = value.peakLuminanceNits;
  }

  return profile;
}

/**
 * Project the layout's surfaces down to the placement view the stage stores.
 *
 * `DisplaySurface` extends `StageSurfacePlacement`, so this is a narrowing, not
 * a conversion — the two documents cannot drift on where a surface is.
 */
export function toStagePlacements(layout: SurfaceLayoutDocument): StageSurfacePlacement[] {
  return layout.surfaces.map((surface) => {
    const placement: StageSurfacePlacement = {
      surfaceId: surface.surfaceId,
      name: surface.name,
      position: { ...surface.position },
      size: { ...surface.size },
      rotationDegrees: surface.rotationDegrees,
      enabled: surface.enabled
    };
    if (surface.crop) placement.crop = { ...surface.crop };
    if (surface.outputId) placement.outputId = surface.outputId;
    return placement;
  });
}

export type SurfaceIssueSeverity = "error" | "warning" | "info";

export interface SurfaceIssue {
  severity: SurfaceIssueSeverity;
  code: string;
  message: string;
  subject?: string;
}

export interface SurfaceLayoutValidation {
  valid: boolean;
  issues: SurfaceIssue[];
}

/**
 * Validate a layout, optionally against the stage it belongs to.
 *
 * Declared-but-unimplemented warp, edge blend, and bezel compensation are
 * reported as `info` every time. That is deliberate: an operator must never
 * believe a projector is calibrated because the data exists.
 */
export function validateSurfaceLayout(
  layout: SurfaceLayoutDocument,
  stage?: StageDocument
): SurfaceLayoutValidation {
  const issues: SurfaceIssue[] = [];
  const profileIds = new Set(layout.colorProfiles.map((profile) => profile.profileId));
  const outputIds = stage ? new Set(stage.outputs.map((output) => output.outputId)) : undefined;

  if (stage && stage.stageId !== layout.stageId) {
    issues.push({
      severity: "error",
      code: "LAYOUT_STAGE_MISMATCH",
      message: `layout targets stage ${layout.stageId} but was validated against ${stage.stageId}`
    });
  }

  for (const surface of layout.surfaces) {
    if (!(surface.size.width > 0) || !(surface.size.height > 0)) {
      issues.push({
        severity: "warning",
        code: "SURFACE_EMPTY",
        message: `surface "${surface.name}" has no logical area`,
        subject: surface.surfaceId
      });
    }

    if (surface.colorProfileRef && !profileIds.has(surface.colorProfileRef)) {
      issues.push({
        severity: "error",
        code: "SURFACE_PROFILE_MISSING",
        message: `surface "${surface.name}" references unknown colour profile ${surface.colorProfileRef}`,
        subject: surface.surfaceId
      });
    }

    if (outputIds && surface.outputId && !outputIds.has(surface.outputId)) {
      issues.push({
        severity: "error",
        code: "SURFACE_OUTPUT_MISSING",
        message: `surface "${surface.name}" references unknown output ${surface.outputId}`,
        subject: surface.surfaceId
      });
    }

    if (surface.enabled && !surface.outputId) {
      issues.push({
        severity: "warning",
        code: "SURFACE_UNASSIGNED",
        message: `surface "${surface.name}" is enabled but has no output assignment`,
        subject: surface.surfaceId
      });
    }

    const warp = surface.warp;
    if (warp && warp.mode !== "none") {
      const expected = warp.columns * warp.rows;
      if (warp.controlPoints.length > 0 && warp.controlPoints.length !== expected) {
        issues.push({
          severity: "error",
          code: "WARP_GRID_MISMATCH",
          message: `surface "${surface.name}" declares a ${warp.columns}x${warp.rows} warp grid but supplies ${warp.controlPoints.length} control points`,
          subject: surface.surfaceId
        });
      }
    }

    if (surfaceCalibrationPending(surface)) {
      issues.push({
        severity: "info",
        code: "CALIBRATION_NOT_IMPLEMENTED",
        message: `surface "${surface.name}" declares warp, edge blend, or bezel compensation; the renderer carries the data but does not yet apply it`,
        subject: surface.surfaceId
      });
    }

    const device = surfaceDeviceSize(surface);
    if (device.width > 65_536 || device.height > 65_536) {
      issues.push({
        severity: "warning",
        code: "SURFACE_DEVICE_LARGE",
        message: `surface "${surface.name}" declares a ${device.width}x${device.height} device resolution; verify it is driven by more than one output`,
        subject: surface.surfaceId
      });
    }
  }

  // Overlaps are expected for blended projectors and a mistake for LED walls.
  for (const overlap of findSurfaceOverlaps(layout.surfaces)) {
    const a = layout.surfaces.find((surface) => surface.surfaceId === overlap.a);
    const b = layout.surfaces.find((surface) => surface.surfaceId === overlap.b);
    const blended = a?.edgeBlend?.enabled === true || b?.edgeBlend?.enabled === true;
    issues.push({
      severity: blended ? "info" : "warning",
      code: blended ? "SURFACE_BLEND_OVERLAP" : "SURFACE_OVERLAP",
      message: blended
        ? `surfaces "${a?.name}" and "${b?.name}" overlap and declare edge blending`
        : `surfaces "${a?.name}" and "${b?.name}" overlap without edge blending`,
      subject: overlap.a
    });
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

export interface SurfaceLayoutSummary {
  layoutId: string;
  stageId: string;
  surfaceCount: number;
  enabledSurfaceCount: number;
  totalDevicePixels: number;
  kinds: Record<string, number>;
  calibrationPendingCount: number;
}

export function summarizeSurfaceLayout(layout: SurfaceLayoutDocument): SurfaceLayoutSummary {
  const kinds: Record<string, number> = {};
  let totalDevicePixels = 0;
  let enabledSurfaceCount = 0;
  let calibrationPendingCount = 0;

  for (const surface of layout.surfaces) {
    kinds[surface.kind] = (kinds[surface.kind] ?? 0) + 1;
    if (surface.enabled) {
      enabledSurfaceCount += 1;
      const device = surfaceDeviceSize(surface);
      totalDevicePixels += device.width * device.height;
    }
    if (surfaceCalibrationPending(surface)) {
      calibrationPendingCount += 1;
    }
  }

  return {
    layoutId: layout.layoutId,
    stageId: layout.stageId,
    surfaceCount: layout.surfaces.length,
    enabledSurfaceCount,
    totalDevicePixels,
    kinds,
    calibrationPendingCount
  };
}
