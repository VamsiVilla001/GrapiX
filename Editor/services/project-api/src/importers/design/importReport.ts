import {
  createSceneId,
  type DesignImportIssue,
  type DesignImportIssueKind,
  type DesignImportReport,
  type DesignSourceFormat,
  type NormalizedDesignDocument,
  type NormalizedDesignNode
} from "@grapix/shared-types";

export function createDesignImportReport(
  sourceFormat: DesignSourceFormat,
  sourceName: string
): DesignImportReport {
  const startedAt = new Date().toISOString();
  return {
    sourceFormat,
    sourceName,
    startedAt,
    completedAt: startedAt,
    importedItems: 0,
    convertedProperties: 0,
    missingFonts: [],
    missingLinkedAssets: [],
    unsupportedEffects: [],
    rasterizedObjects: [],
    visualDifferences: [],
    errors: [],
    warnings: [],
    issues: [],
    counts: {
      nodes: 0,
      native: 0,
      genericContainers: 0,
      flattened: 0,
      clippedContainers: 0,
      syntheticLayers: 0,
      masks: 0,
      assetsDownloaded: 0,
      assetsFailed: 0,
      missingNodes: []
    }
  };
}

export function addDesignImportIssue(
  report: DesignImportReport,
  issue: Omit<DesignImportIssue, "id">
): void {
  const next = { ...issue, id: createSceneId("import-issue") };
  report.issues.push(next);
  if (issue.kind === "converted") report.convertedProperties += 1;
  if (issue.kind === "missing-font") pushUnique(report.missingFonts, issue.sourceNodeName ?? issue.message);
  if (issue.kind === "missing-asset") pushUnique(report.missingLinkedAssets, issue.sourceNodeName ?? issue.message);
  if (issue.kind === "unsupported-effect") pushUnique(report.unsupportedEffects, issue.sourceNodeName ?? issue.message);
  if (issue.kind === "rasterized") pushUnique(report.rasterizedObjects, issue.sourceNodeName ?? issue.message);
  if (issue.kind === "visual-difference") pushUnique(report.visualDifferences, issue.message);
  if (issue.severity === "error") pushUnique(report.errors, issue.message);
  else if (issue.severity === "warning") pushUnique(report.warnings, issue.message);
}

export function reportImportWarning(
  report: DesignImportReport,
  message: string,
  kind: DesignImportIssueKind = "warning",
  sourceNodeName?: string,
  fallback?: string,
  sourceNodeId?: string
): void {
  addDesignImportIssue(report, {
    kind,
    severity: kind === "error" ? "error" : "warning",
    message,
    sourceNodeId,
    sourceNodeName,
    fallback
  });
}

/**
 * Drop the issues raised for layers that the import then discarded, and rebuild
 * every derived list from what survives.
 *
 * Format adapters walk the whole source document, so they report on layers that
 * `normalizeDesignDocument` removes afterwards - a hidden Photoshop group is the
 * common case. Reporting an unrenderable effect or mask for a layer that is not in
 * the scene tells an author to go fix something that does not exist. An issue with
 * no `sourceNodeId` is document-level and always kept.
 */
export function pruneDesignImportIssues(
  report: DesignImportReport,
  importedNodeIds: ReadonlySet<string>
): void {
  const kept = report.issues.filter(
    (issue) => !issue.sourceNodeId || importedNodeIds.has(issue.sourceNodeId)
  );
  if (kept.length === report.issues.length) return;

  report.issues = [];
  report.convertedProperties = 0;
  report.missingFonts = [];
  report.missingLinkedAssets = [];
  report.unsupportedEffects = [];
  report.rasterizedObjects = [];
  report.visualDifferences = [];
  report.errors = [];
  report.warnings = [];
  for (const issue of kept) {
    const { id, ...rest } = issue;
    addDesignImportIssue(report, rest);
    report.issues[report.issues.length - 1].id = id;
  }
}

export function completeDesignImportReport(report: DesignImportReport, importedItems: number): void {
  report.importedItems = importedItems;
  report.completedAt = new Date().toISOString();
}

/**
 * Rebuild the mutually exclusive node-outcome counters from the document that will
 * be converted. Adapters may annotate a node before normalization, but filtering,
 * masking, and hierarchy policy decide which nodes actually arrive; this is the one
 * point all import sources share.
 */
export function populateDesignImportCounts(
  document: NormalizedDesignDocument,
  report: DesignImportReport
): void {
  const prior = report.counts;
  report.counts = {
    nodes: 0,
    native: 0,
    genericContainers: 0,
    flattened: 0,
    clippedContainers: prior.clippedContainers,
    syntheticLayers: prior.syntheticLayers,
    masks: prior.masks,
    assetsDownloaded: prior.assetsDownloaded,
    assetsFailed: prior.assetsFailed,
    missingNodes: prior.missingNodes
  };

  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      report.counts.nodes += 1;
      // `flattened` is a marker — the node was also raster-rendered by the source tool —
      // not a third outcome. Every node partitions into native or generic container,
      // and a flattened node still belongs to one of the two.
      if (node.flattenedFromFigma) report.counts.flattened += 1;
      if (node.genericContainer) report.counts.genericContainers += 1;
      else report.counts.native += 1;
      walk(node.children);
    }
  };
  document.pages.forEach((page) => walk(page.nodes));
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
