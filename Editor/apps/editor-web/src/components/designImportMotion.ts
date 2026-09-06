/**
 * The import dialog's motion decisions, separated from its markup so they can be tested.
 *
 * Three things here can be wrong in a way a screenshot would not show: which mode is actually
 * sent, whether a file is a manifest at all, and the order the report groups appear in. All three
 * change what an author believes happened to their design, so all three are tested.
 */
import type {
  FigmaMotionCompatibility,
  FigmaMotionImportMode,
  FigmaMotionImportReport,
  FigmaMotionManifest
} from "@grapix/shared-types";

/** Which import tab the dialog is on. A manifest can only be delivered by one of them. */
export type DesignSourceMode = "file" | "figma";

/**
 * A bridge manifest can only travel with a Figma link.
 *
 * The design-file request sends the design's raw bytes as its body, so there is nowhere for a
 * second file to ride. Rather than send a mode the service will only warn about, the file tab
 * falls back to prototype motion — which an exported Figma document genuinely carries — and the
 * dialog says so beside the control.
 */
export function motionManifestDeliverable(sourceMode: DesignSourceMode): boolean {
  return sourceMode === "figma";
}

/** The mode actually sent, which is not always the one selected. */
export function resolveMotionMode(
  selected: FigmaMotionImportMode,
  sourceMode: DesignSourceMode
): FigmaMotionImportMode {
  if (selected === "full-motion-manifest" && !motionManifestDeliverable(sourceMode)) {
    return "design-and-prototype-motion";
  }
  return selected;
}

/**
 * Whether the dialog may start an import.
 *
 * Requesting a manifest without supplying one would import silently without the motion the author
 * came for, so the button waits for the file rather than the report explaining its absence.
 */
export function canStartMotionImport(
  effectiveMode: FigmaMotionImportMode,
  hasManifest: boolean
): boolean {
  return effectiveMode !== "full-motion-manifest" || hasManifest;
}

/**
 * A chosen file's text → a manifest.
 *
 * Parsed and checked when the file is chosen, so a wrong file is reported while the author is
 * still looking at the field that caused it instead of surfacing as a failed import a minute
 * later. The check is deliberately shallow — `version` and `timelines` — because the importer
 * classifies and reports everything inside, and a strict client-side schema would reject a
 * manifest from a newer bridge that the service could still read.
 */
export function parseMotionManifest(text: string): FigmaMotionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  const manifest = parsed as FigmaMotionManifest | null;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("That file is not a GrapiX motion manifest.");
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.timelines)) {
    throw new Error("This is not a GrapiX motion manifest (expected version 1 with a timelines array).");
  }
  return manifest;
}

/** Plain-English labels for the compatibility taxonomy. */
export const MOTION_COMPATIBILITY_LABELS: Record<FigmaMotionCompatibility, string> = {
  "native-editable": "Native editable keyframes",
  "smart-animate-converted": "Converted from Smart Animate",
  "prototype-transition": "From a prototype transition",
  sampled: "Sampled — an approximation",
  unsupported: "No GrapiX channel — nothing authored"
};

/**
 * Report entries grouped by outcome, worst first.
 *
 * The question an author has is "what did I lose", and a hundred rows in source order does not
 * answer it. `unsupported` leads because it is the group that needs a decision; `sampled` follows
 * because it is the one that is editable but approximate. Empty groups are dropped rather than
 * rendered as headings with nothing under them.
 */
export const MOTION_GROUP_ORDER: readonly FigmaMotionCompatibility[] = [
  "unsupported",
  "sampled",
  "native-editable",
  "smart-animate-converted",
  "prototype-transition"
];

export function motionReportGroups(
  report: FigmaMotionImportReport
): { compatibility: FigmaMotionCompatibility; entries: FigmaMotionImportReport["entries"] }[] {
  return MOTION_GROUP_ORDER
    .map((compatibility) => ({
      compatibility,
      entries: report.entries.filter((entry) => entry.compatibility === compatibility)
    }))
    .filter((group) => group.entries.length > 0);
}

/**
 * The missing-node sentence.
 *
 * Names the layers rather than counting them: the remedy is to import the frame holding them, and
 * that needs identifying. Truncated because a manifest can refer to hundreds, and a paragraph the
 * author will not read is not a report.
 */
export function missingNodeSummary(missingNodes: readonly string[], limit = 8): string {
  const shown = missingNodes.slice(0, limit).join(", ");
  const rest = missingNodes.length - limit;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
