import {
  createSceneId,
  type DesignImportIssue,
  type DesignImportIssueKind,
  type DesignImportReport,
  type DesignSourceFormat
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
    issues: []
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

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
