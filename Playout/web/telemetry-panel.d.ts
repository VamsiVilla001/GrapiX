// GENERATED from Shared/web-panels/telemetry-panel.d.ts by tools/sync-shared-web.mjs. Do not edit: edit the source and run `npm run sync:web`.
// Types for telemetry-panel.js (build plan 2.27). The reply shapes are the generated
// contract types (`Shared/generated-ts`: PerformanceSummary and what it carries); they
// are restated structurally here so this file has no import and can be copied into
// either app's web folder as it is.

export interface TelemetryRate {
  num: number;
  den: number;
}

export interface TelemetrySeries {
  name: string;
  unit: string;
  values: number[];
  limit?: number | null;
}

export type TelemetryState = "ok" | "degraded" | "failed" | "notMeasured";

export interface TelemetryComponent {
  id: string;
  kind: string;
  label: string;
  state: TelemetryState;
  detail?: string | null;
  series: TelemetrySeries[];
}

export type TelemetrySeverity = "Nominal" | "Warning" | "Critical";

export interface TelemetryFinding {
  id: string;
  component: string;
  severity: TelemetrySeverity;
  what: string;
  check: string;
  record?: string | null;
}

/** The engine's `performance` reply, as the panel reads it. */
export interface TelemetryReading {
  rate: TelemetryRate;
  totalRendered: number;
  totalLate: number;
  totalDropped: number;
  totalMissed: number;
  meanBudgetRatio?: number | null;
  components?: TelemetryComponent[];
  findings?: TelemetryFinding[];
}

export interface TelemetryHeadline {
  word: string;
  tone: "ok" | "warning" | "critical" | "idle";
  note: string;
}

export function worstSeverity(findings: readonly { severity: string }[] | undefined): TelemetrySeverity;
export function headline(summary: TelemetryReading | undefined): TelemetryHeadline;
export function sparklinePoints(
  values: readonly number[],
  limit?: number | null,
  width?: number,
  height?: number,
): { points: [number, number][]; limitY: number | null };
export function renderSummary(doc: Document, summary: TelemetryReading): Node[];

export interface TelemetryPanel {
  open(): void;
  close(): void;
  refresh(): Promise<void>;
  isOpen(): boolean;
}

export function createTelemetryPanel(options: {
  load: () => Promise<TelemetryReading>;
  intervalMs?: number;
  doc?: Document;
  now?: () => number;
}): TelemetryPanel;
