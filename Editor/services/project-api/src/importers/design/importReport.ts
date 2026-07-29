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
  fallback?: string
): void {
  addDesignImportIssue(report, {
    kind,
    severity: kind === "error" ? "error" : "warning",
    message,
    sourceNodeName,
    fallback
  });
}

export function completeDesignImportReport(report: DesignImportReport, importedItems: number): void {
  report.importedItems = importedItems;
  report.completedAt = new Date().toISOString();
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
