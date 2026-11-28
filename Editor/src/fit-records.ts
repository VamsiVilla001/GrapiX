// The record check in the Editor (plan row 11.153, Figma B2v2 and B4): the Test records table, the Checks, and the line on an element's card.
//
// **The engine measures, the Editor only shows** (docs/design/data-block-2026-11-26.md; Jev A on all three): the report comes from
// `cmd_fit_report`, which asks the engine to shape each record's text in its box with the shaping it draws with. Nothing here decides a fit.
// While there is no report (no check made yet, the engine not reachable, the engine declining), the panel says so in words and draws no
// FITS: a state, not a result.
//
// Words (Figma B4): FITS, OVERFLOWS 64 PX, EMPTY and EMPTY · HIDDEN, MISSING p.name; the tally "46 FIT · 2 NEED FIXING". An empty or missing
// value is a fault only for an element that does not hide when empty (a blank plate on air); for one that does, it is the intended outcome.

import type { ElementFit, FitReport, FitResult, SceneDocument } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/** The result in the words of the Test records table. */
export function fitWords(fit: FitResult): string {
  switch (fit.result) {
    case "fits":
      return "FITS";
    case "overflows":
      return `OVERFLOWS ${trimNumber(fit.byPx)} PX`;
    case "empty":
      return fit.hidden ? "EMPTY · HIDDEN" : "EMPTY";
    case "missing":
      return fit.hidden ? `MISSING ${fit.path} · HIDDEN` : `MISSING ${fit.path}`;
  }
}

/** 64 not 64.0, 64.3 as it is. */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Whether the designer needs to act on this result: it overflows, or it is empty or missing and the element does not hide. */
export function needsFixing(fit: FitResult): boolean {
  switch (fit.result) {
    case "fits":
      return false;
    case "overflows":
      return true;
    case "empty":
    case "missing":
      return !fit.hidden;
  }
}

/** How the tone of the result reads: ok, warn (needs fixing), neutral (an intended empty). */
export function fitTone(fit: FitResult): "ok" | "warn" | "neutral" {
  if (fit.result === "fits") return "ok";
  return needsFixing(fit) ? "warn" : "neutral";
}

/** "46 FIT · 2 NEED FIXING": records, not elements; a record needs fixing when any of its texts does. */
export function tallyWords(report: FitReport): string {
  const toFix = report.records.filter((record) => record.elements.some((element) => needsFixing(element))).length;
  const fit = report.records.length - toFix;
  return `${fit} FIT · ${toFix} NEED${toFix === 1 ? "S" : ""} FIXING`;
}

const nameOf = (document: SceneDocument, objectId: string): string => document.objects.find((object) => object.id === objectId)?.name ?? objectId;

/** One sentence for a result that needs fixing, in the words of Figma B4: "Record 17 overflows Name by 64 px". Undefined for one that does not. */
export function checkLine(document: SceneDocument, recordId: string, element: ElementFit): string | undefined {
  if (!needsFixing(element)) return undefined;
  const name = nameOf(document, element.objectId);
  switch (element.result) {
    case "overflows":
      return `Record ${recordId} overflows ${name} by ${trimNumber(element.byPx)} px, ${element.axis === "height" ? "in height" : "in width"} (${element.lines} ${element.lines === 1 ? "line" : "lines"})`;
    case "empty":
      return `Record ${recordId} leaves ${name} empty, and it does not hide when empty`;
    case "missing":
      return `Record ${recordId} has no ${element.path} for ${name}, and it does not hide when empty`;
    case "fits":
      return undefined;
  }
}

/** Every line that needs fixing across the report, in record order, for the Checks list. */
export function checkLines(document: SceneDocument, report: FitReport): string[] {
  return report.records.flatMap((record) => record.elements.flatMap((element) => checkLine(document, record.id, element) ?? []));
}

/** The lines of one element: what each record that needs fixing says about it, for the line on its card. */
export function elementLines(document: SceneDocument, report: FitReport | undefined, objectId: string): string[] {
  if (report === undefined) return [];
  return report.records.flatMap((record) => record.elements.filter((element) => element.objectId === objectId).flatMap((element) => checkLine(document, record.id, element) ?? []));
}

/** What the table says when there is no report. */
export const RECORDS_NOT_CHECKED = "Not checked yet. Check records asks the engine to shape each record's text in its box; nothing here says a record fits that was not measured.";

export interface RecordsState {
  /** The last report the engine gave. */
  readonly report?: FitReport;
  /** Why there is none: the engine could not be asked, or declined, in words. */
  readonly problem?: string;
  /** A check is running now. */
  readonly checking?: boolean;
  /** The graphic has changed since the report was made, so it may no longer be true. */
  readonly stale?: boolean;
}

/** How many rows of the table the panel draws before it says how many more; the report itself is whole. */
export const MOST_ROWS_SHOWN = 100;

/** The Test records block as nodes: a person and an agent read the same table (invariant 27). */
export function testRecordsNodes(document: SceneDocument, state: RecordsState): UiNode[] {
  const nodes: UiNode[] = [];
  const bound = document.objects.some((object) => object.type === "text" && typeof object.bindings?.text === "string");
  const check: UiNode["actions"] = [
    {
      name: "checkRecords",
      label: state.checking === true ? "Checking…" : "Check records",
      ...(state.checking === true
        ? { unavailable: "A check is running" }
        : bound
          ? {}
          : { unavailable: "No text is bound to data: bind a text to a field first" }),
    },
  ];
  if (state.report === undefined) {
    nodes.push({
      id: "data/records",
      role: "region",
      label: "Test records",
      value: state.problem ?? RECORDS_NOT_CHECKED,
      ...(state.problem === undefined ? {} : { tone: "warn" as const }),
      actions: check,
    });
    return nodes;
  }
  const report = state.report;
  const lines = checkLines(document, report);
  nodes.push({
    id: "data/records",
    role: "region",
    label: "Test records",
    value: (report.records.length === 0 ? "No records" : tallyWords(report)) + (state.stale === true ? " · OUT OF DATE: check again" : ""),
    tone: lines.length === 0 ? "ok" : "warn",
    actions: check,
    children: [
      ...(lines.length === 0
        ? []
        : [
            {
              id: "data/checks",
              role: "list" as const,
              label: "Checks",
              children: lines.map((line, index): UiNode => ({ id: `data/check/${index}`, role: "listitem", label: line, tone: "warn" })),
            } satisfies UiNode,
          ]),
      {
        id: "data/record-rows",
        role: "list" as const,
        label: "Records",
        children: [
          ...report.records.slice(0, MOST_ROWS_SHOWN).map((record): UiNode => ({
            id: `data/record/${record.id}`,
            role: "listitem",
            label: record.id,
            children: record.elements.map((element): UiNode => ({
              id: `data/record/${record.id}/${element.objectId}`,
              role: "gridcell",
              label: nameOf(document, element.objectId),
              value: fitWords(element),
              tone: fitTone(element),
            })),
          })),
          ...(report.records.length > MOST_ROWS_SHOWN
            ? [{ id: "data/record-more", role: "status" as const, label: "More records", value: `${report.records.length - MOST_ROWS_SHOWN} more records are in the report and not drawn here` } satisfies UiNode]
            : []),
        ],
      },
    ],
  });
  return nodes;
}
