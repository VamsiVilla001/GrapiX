// The scene import report (build plan 11.17, over the 7.2 pipeline).
//
// An import is shown with the full account of what it cost: every source
// element, the tier it landed on, the object it became (or that it was
// dropped), and each substitution with what replaced it and why. The panel
// is a `UiNode` tree, so the dialog a person reads and the surface an agent
// reads are the same thing (invariant 27).

import type { ImportEntry, ImportReport, ImportTier, RefusalSeverity } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/** The ladder, most faithful first, as a person reads it. */
const TIER_ORDER: readonly ImportTier[] = ["native", "container", "flattened", "rasterized"];

const TIER_LABEL: Readonly<Record<ImportTier, string>> = {
  native: "Native",
  container: "Container",
  flattened: "Flattened",
  rasterized: "Rasterized",
};

const SEVERITY_ORDER: readonly RefusalSeverity[] = ["info", "warning", "error"];

/** The least faithful tier any entry reached; `native` for an empty report. */
export function worstTier(report: ImportReport): ImportTier {
  let worst = 0;
  for (const entry of report.entries) worst = Math.max(worst, TIER_ORDER.indexOf(entry.tier));
  return TIER_ORDER[worst]!;
}

/** The most serious substitution, or undefined when nothing was substituted. */
export function worstSeverity(report: ImportReport): RefusalSeverity | undefined {
  let worst = -1;
  for (const entry of report.entries) {
    for (const substitution of entry.substitutions) {
      worst = Math.max(worst, SEVERITY_ORDER.indexOf(substitution.severity));
    }
  }
  return worst < 0 ? undefined : SEVERITY_ORDER[worst];
}

/** How many entries landed on each tier, in ladder order, zero counts left out. */
export function tierCounts(report: ImportReport): string {
  return TIER_ORDER.map((tier) => [tier, report.entries.filter((entry) => entry.tier === tier).length] as const)
    .filter(([, count]) => count > 0)
    .map(([tier, count]) => `${count} ${TIER_LABEL[tier].toLowerCase()}`)
    .join(" · ");
}

function entryNode(entry: ImportEntry, index: number): UiNode {
  const landed = entry.objectId === undefined ? "dropped, no object" : `became ${entry.objectId}`;
  return {
    // The index keeps the id unique when a source repeats an id.
    id: `scene-import/entry/${index}/${entry.sourceId}`,
    role: "listitem",
    label: entry.sourceName === entry.sourceId ? entry.sourceId : `${entry.sourceName} (${entry.sourceId})`,
    description: landed,
    value: TIER_LABEL[entry.tier],
    children: entry.substitutions.map((substitution, at) => ({
      id: `scene-import/entry/${index}/${entry.sourceId}/substitution/${at}`,
      role: substitution.severity === "error" ? "alert" : "status",
      label: `${substitution.sourceFeature} → ${substitution.replacedWith}`,
      description: substitution.reason,
      value: substitution.severity,
    })),
  };
}

/** The report as a panel: a summary, then one item per source element. */
export function sceneImportPanel(report: ImportReport): UiNode {
  const substitutions = report.entries.reduce((sum, entry) => sum + entry.substitutions.length, 0);
  const severity = worstSeverity(report);
  const tier = worstTier(report);
  const summary =
    substitutions === 0
      ? "Everything imported natively; nothing was substituted."
      : `${substitutions} substitution(s); the least faithful element is ${TIER_LABEL[tier].toLowerCase()}.`;
  return {
    id: "scene-import",
    role: "region",
    label: `Imported ${report.sourceName}`,
    description: `${report.entries.length} element(s) · ${tierCounts(report) || "none"}`,
    children: [
      {
        // An alert when anything was lost at error severity: the author must
        // see it before working on a graphic that is missing parts.
        id: "scene-import/summary",
        role: severity === "error" ? "alert" : "status",
        label: "Summary",
        value: summary,
        ...(report.sourceHash === undefined ? {} : { description: `source kept as ${report.sourceHash.slice(0, 16)}…` }),
      },
      {
        id: "scene-import/entries",
        role: "list",
        label: "Elements",
        children: report.entries.map(entryNode),
      },
    ],
  };
}
