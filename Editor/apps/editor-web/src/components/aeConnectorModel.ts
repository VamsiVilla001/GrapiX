/**
 * The connector panel's decisions, separated from its markup so they can be tested.
 *
 * Four things here can be wrong in a way a screenshot would not show: how a float frame rate
 * becomes an exact broadcast clock, how 280 compositions are ranked so the useful ones are
 * reachable, what a container is called, and whether a property is already exposed. Each of them
 * changes what an operator ends up driving on air.
 */
import type { AeDynamicControl } from "@grapix/ae-runtime-contract";
import type { AeCompositionSummary, AeLayerSummary } from "../lib/apiClient";

export interface CompositionFilter {
  query: string;
  onlyPublishable: boolean;
  onlyWithText: boolean;
  onlyTopLevel: boolean;
}

/**
 * The broadcast rationals, and the float each one arrives as.
 *
 * After Effects reports a composition's rate as a float — `29.97003173828125` — and a float cannot
 * distinguish `2997/100` from `30000/1001`. The two are eight frames apart over an hour, which is
 * a graphic that drifts off its cue. So the float is *matched* against the rationals broadcast
 * actually uses rather than converted, and anything unrecognised falls back to a whole number,
 * which is at least exact.
 */
const BROADCAST_RATES: { rational: string; value: number }[] = [
  { rational: "24000/1001", value: 24000 / 1001 },
  { rational: "24/1", value: 24 },
  { rational: "25/1", value: 25 },
  { rational: "30000/1001", value: 30000 / 1001 },
  { rational: "30/1", value: 30 },
  { rational: "50/1", value: 50 },
  { rational: "60000/1001", value: 60000 / 1001 },
  { rational: "60/1", value: 60 }
];

/**
 * The shape the container store accepts.
 *
 * Restated here because producing a rate the store refuses turns "declare a container" into an
 * error an author cannot act on — which is what a real 60 fps project hit, since a bare "60"
 * has no denominator.
 */
export const AE_RATIONAL_PATTERN = /^\d+\/\d+$/;

export function frameRateToRational(frameRate: number): string {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return "25/1";
  for (const candidate of BROADCAST_RATES) {
    // A thousandth is far tighter than the gap between any two rates in the table, and far looser
    // than the float error After Effects introduces.
    if (Math.abs(candidate.value - frameRate) < 0.001) return candidate.rational;
  }
  return `${Math.round(frameRate)}/1`;
}

/**
 * Order and filter the compositions a picker shows.
 *
 * A production project holds hundreds, most of them precomps of precomps that no one publishes. The
 * ranking puts what an author is looking for first: compositions a designer named `GX_…` as
 * intended for GrapiX, then render candidates nothing nests, then ones that can actually be
 * published, then ones with text an operator could drive, then larger ones — a full-frame graphic
 * outranks a 471×179 fragment. Alphabetical order would bury every useful composition among its
 * own parts.
 */
export function rankCompositions(
  compositions: readonly AeCompositionSummary[],
  filter: CompositionFilter
): AeCompositionSummary[] {
  const query = filter.query.trim().toLowerCase();

  return compositions
    .filter((composition) => {
      if (query && !composition.name.toLowerCase().includes(query)) return false;
      if (filter.onlyPublishable && composition.missingAssetCount > 0) return false;
      if (filter.onlyWithText && composition.textLayerCount === 0) return false;
      if (filter.onlyTopLevel && !composition.isTopLevel) return false;
      return true;
    })
    .sort((left, right) => {
      // Explicit intent outranks every heuristic: a `GX_` name is a designer telling GrapiX.
      const marked = Number(left.grapixMarked) - Number(right.grapixMarked);
      if (marked !== 0) return -marked;
      const topLevel = Number(left.isTopLevel) - Number(right.isTopLevel);
      if (topLevel !== 0) return -topLevel;
      const publishable = Number(left.missingAssetCount === 0) - Number(right.missingAssetCount === 0);
      if (publishable !== 0) return -publishable;
      const text = left.textLayerCount - right.textLayerCount;
      if (text !== 0) return -text;
      const area = left.width * left.height - right.width * right.height;
      if (area !== 0) return -area;
      return left.name.localeCompare(right.name);
    });
}

/**
 * A stable container id for one composition of one project.
 *
 * Derived rather than random so re-opening the same composition finds the container an author
 * already declared controls on, instead of silently starting a second one beside it.
 */
export function containerIdForComposition(projectName: string, compositionName: string): string {
  const slug = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const id = `${slug(projectName)}-${slug(compositionName)}`.replace(/^-+|-+$/g, "");
  return id || "ae-graphic";
}

/**
 * Turn a chosen property into a declared control, or `null` when it is already exposed.
 *
 * Identity is the composition, the layer and the property's match name together — not the display
 * name. Two layers can be called `xxx` in one composition, and this project has several, so a name
 * would collide the moment an author exposed the second of them.
 */
export function controlFromProperty(
  composition: AeCompositionSummary,
  layer: AeLayerSummary,
  property: AeLayerSummary["exposable"][number],
  existing: readonly AeDynamicControl[]
): AeDynamicControl | null {
  const already = existing.some(
    (control) =>
      control.target.layerId === layer.index &&
      control.target.compositionItemId === Number(composition.id) &&
      control.target.propertyPath[0]?.matchName === property.matchName
  );
  if (already) return null;

  return {
    controlId: crypto.randomUUID(),
    displayName: `${layer.name} · ${property.label}`,
    kind: property.kind as AeDynamicControl["kind"],
    writable: true,
    updatePolicy: "immediate",
    target: {
      compositionItemId: Number(composition.id),
      layerId: layer.index,
      sourceItemId: null,
      propertyPath: [{ matchName: property.matchName, ordinal: 0 }]
    },
    validation: {
      status: "valid",
      reason: null,
      validatedProjectDigest: null,
      structuralFingerprint: null,
      validatedAt: new Date().toISOString()
    }
  };
}
