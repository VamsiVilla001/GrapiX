// The record check in the Editor (row 11.153; the engine measures, the Editor shows): the words of the Test records table, the Checks, the tally,
// the line on an element's card, and what the panel says when nothing has been measured.

import { describe, expect, it } from "vitest";

import type { FitReport, FitResult, SceneDocument } from "@grapix/contracts";

import { findNode } from "../src/agent-surface";
import { dataPanel } from "../src/data-panel";
import { elementCard } from "../src/element-card";
import { renderCard } from "../src/element-card-view";
import { MOST_NOTES } from "../src/element-card-view";
import { RECORDS_NOT_CHECKED, checkLine, checkLines, elementLines, fitTone, fitWords, needsFixing, tallyWords, testRecordsNodes } from "../src/fit-records";

const text = (id: string, name: string, hide = false) => ({ type: "text", id, name, text: "A", fontId: "f", size: 40, layout: "point", autoFit: "none", align: "left", verticalAlign: "top", textCase: "original", x: 0, y: 0, width: 100, height: 40, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0, bindings: { text: `p.${id}` }, ...(hide ? { hideWhenEmpty: true } : {}) });
const doc = (objects: unknown[]): SceneDocument =>
  ({ canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } }, objects, assets: [], fonts: [], materials: [], dataContext: { p: { name: "Soul" } }, timeline: { durationFrames: 10n, channels: [], phases: [], pathChannels: [] } }) as unknown as SceneDocument;

const fits = { result: "fits" } as const;
const over = { result: "overflows", byPx: 64, axis: "width", lines: 1 } as const;
const report = (...records: [string, FitResult[]][]): FitReport => ({ records: records.map(([id, results]) => ({ id, elements: results.map((fit, index) => ({ objectId: index === 0 ? "name" : "role", ...fit })) })) }) as FitReport;

describe("the words of the table", () => {
  it("say FITS, OVERFLOWS with the px, and EMPTY or MISSING with whether the element hides", () => {
    expect(fitWords(fits)).toBe("FITS");
    expect(fitWords(over)).toBe("OVERFLOWS 64 PX");
    expect(fitWords({ result: "overflows", byPx: 64.25, axis: "height", lines: 3 })).toBe("OVERFLOWS 64.3 PX");
    expect(fitWords({ result: "empty", hidden: false })).toBe("EMPTY");
    expect(fitWords({ result: "empty", hidden: true })).toBe("EMPTY · HIDDEN");
    expect(fitWords({ result: "missing", path: "p.role", hidden: false })).toBe("MISSING p.role");
    expect(fitWords({ result: "missing", path: "p.role", hidden: true })).toBe("MISSING p.role · HIDDEN");
  });

  it("call an empty value a fault only where nothing hides it, and tone it so", () => {
    for (const [fit, fix, tone] of [
      [fits, false, "ok"],
      [over, true, "warn"],
      [{ result: "empty", hidden: false }, true, "warn"],
      [{ result: "empty", hidden: true }, false, "neutral"],
      [{ result: "missing", path: "a", hidden: false }, true, "warn"],
      [{ result: "missing", path: "a", hidden: true }, false, "neutral"],
    ] as const) {
      expect(needsFixing(fit), JSON.stringify(fit)).toBe(fix);
      expect(fitTone(fit), JSON.stringify(fit)).toBe(tone);
    }
  });

  it("tally records, not elements, and say NEEDS for one", () => {
    expect(tallyWords(report(["1", [fits, fits]], ["17", [over, over]], ["31", [fits, { result: "empty", hidden: true }]]))).toBe("2 FIT · 1 NEEDS FIXING");
    expect(tallyWords(report(["1", [over]], ["2", [over]]))).toBe("0 FIT · 2 NEED FIXING");
    expect(tallyWords({ records: [] })).toBe("0 FIT · 0 NEED FIXING");
  });
});

describe("the Checks", () => {
  const document = doc([text("name", "Name plate"), text("role", "Role")]);

  it("say which record, which element, by how much and in which direction, and nothing for what fits", () => {
    expect(checkLine(document, "17", { objectId: "name", ...over } as never)).toBe("Record 17 overflows Name plate by 64 px, in width (1 line)");
    expect(checkLine(document, "9", { objectId: "name", result: "overflows", byPx: 12.5, axis: "height", lines: 4 } as never)).toBe("Record 9 overflows Name plate by 12.5 px, in height (4 lines)");
    expect(checkLine(document, "32", { objectId: "role", result: "empty", hidden: false } as never)).toBe("Record 32 leaves Role empty, and it does not hide when empty");
    expect(checkLine(document, "33", { objectId: "role", result: "missing", path: "p.role", hidden: false } as never)).toBe("Record 33 has no p.role for Role, and it does not hide when empty");
    expect(checkLine(document, "1", { objectId: "name", ...fits } as never)).toBeUndefined();
    expect(checkLine(document, "31", { objectId: "role", result: "empty", hidden: true } as never)).toBeUndefined();
    expect(checkLine(document, "5", { objectId: "gone", ...over } as never)).toContain("overflows gone by");
  });

  it("list every line in record order, and the lines of one element for its card", () => {
    const found = report(["1", [fits, fits]], ["17", [over, { result: "empty", hidden: false }]], ["18", [over, fits]]);
    expect(checkLines(document, found)).toEqual([
      "Record 17 overflows Name plate by 64 px, in width (1 line)",
      "Record 17 leaves Role empty, and it does not hide when empty",
      "Record 18 overflows Name plate by 64 px, in width (1 line)",
    ]);
    expect(elementLines(document, found, "name")).toEqual(["Record 17 overflows Name plate by 64 px, in width (1 line)", "Record 18 overflows Name plate by 64 px, in width (1 line)"]);
    expect(elementLines(document, found, "role")).toEqual(["Record 17 leaves Role empty, and it does not hide when empty"]);
    expect(elementLines(document, undefined, "name")).toEqual([]);
  });
});

describe("the Test records block", () => {
  const document = doc([text("name", "Name plate"), text("role", "Role", true)]);

  it("says it is not checked, and draws no result, until the engine has measured", () => {
    const [block] = testRecordsNodes(document, {});
    expect(block!.value).toBe(RECORDS_NOT_CHECKED);
    expect(block!.children).toBeUndefined();
    expect(block!.actions![0]).toEqual({ name: "checkRecords", label: "Check records" });
  });

  it("says why the engine could not be asked, in a warning tone, and still draws no result", () => {
    const [block] = testRecordsNodes(document, { problem: "The engine could not check the records: asset plane unreachable" });
    expect(block).toMatchObject({ value: "The engine could not check the records: asset plane unreachable", tone: "warn" });
    expect(block!.children).toBeUndefined();
  });

  it("dims the button while a check runs, and when no text is bound to data", () => {
    expect(testRecordsNodes(document, { checking: true })[0]!.actions![0]).toEqual({ name: "checkRecords", label: "Checking…", unavailable: "A check is running" });
    const unbound = doc([{ ...text("a", "A"), bindings: undefined }]);
    expect(testRecordsNodes(unbound, {})[0]!.actions![0]!.unavailable).toBe("No text is bound to data: bind a text to a field first");
  });

  it("is the tally, the Checks and a row per record with the words per element", () => {
    const found = report(["1", [fits, fits]], ["17", [over, { result: "empty", hidden: true }]]);
    const [block] = testRecordsNodes(document, { report: found });
    expect(block).toMatchObject({ value: "1 FIT · 1 NEEDS FIXING", tone: "warn" });
    expect(block!.children!.map((child) => child.id)).toEqual(["data/checks", "data/record-rows"]);
    const rows = findNode(block!, "data/record-rows")!;
    expect(rows.children!.map((row) => row.label)).toEqual(["1", "17"]);
    expect(rows.children![1]!.children!.map((cell) => [cell.label, cell.value, cell.tone])).toEqual([["Name plate", "OVERFLOWS 64 PX", "warn"], ["Role", "EMPTY · HIDDEN", "neutral"]]);
  });

  it("has no Checks and an ok tone when everything fits, and says when there are no records", () => {
    const [clean] = testRecordsNodes(document, { report: report(["1", [fits, fits]]) });
    expect(clean).toMatchObject({ value: "1 FIT · 0 NEED FIXING", tone: "ok" });
    expect(clean!.children!.map((child) => child.id)).toEqual(["data/record-rows"]);
    expect(testRecordsNodes(document, { report: { records: [] } })[0]!.value).toBe("No records");
  });

  it("says when the graphic changed since the check, and draws only the first rows of a long report", () => {
    expect(testRecordsNodes(document, { report: report(["1", [fits]]), stale: true })[0]!.value).toBe("1 FIT · 0 NEED FIXING · OUT OF DATE: check again");
    const long = report(...Array.from({ length: 130 }, (_, n): [string, FitResult[]] => [String(n + 1), [fits]]));
    const rows = findNode(testRecordsNodes(document, { report: long })[0]!, "data/record-rows")!;
    expect(rows.children!.length).toBe(101);
    expect(rows.children![100]).toMatchObject({ id: "data/record-more", value: "30 more records are in the report and not drawn here" });
  });

  it("is part of the Data panel, so an agent reads the same table", () => {
    const panel = dataPanel(document, { report: report(["17", [over]]) });
    expect(findNode(panel, "data/records")!.value).toBe("0 FIT · 1 NEEDS FIXING");
    expect(findNode(panel, "data/record/17/name")!.value).toBe("OVERFLOWS 64 PX");
  });
});

describe("the line on an element's card", () => {
  const document = doc([text("name", "Name plate")]);
  const card = (notes: string[]) => elementCard(document, document.objects[0]!, undefined, notes).sections.find((section) => section.id === "data")!;

  it("is in the Data block, and only when the check found something for this element", () => {
    expect(card([]).notes).toBeUndefined();
    expect(card(["Record 17 overflows Name plate by 64 px, in width (1 line)"]).notes).toEqual(["Record 17 overflows Name plate by 64 px, in width (1 line)"]);
  });

  it("draws at most three and points at the Data screen for the rest", () => {
    // A document with just what the card's view touches: an element is its class, its text and its children.
    interface Fake { tag: string; className: string; textContent: string; children: Fake[]; type?: string; disabled?: boolean; title?: string; append(...nodes: Fake[]): void; setAttribute(name: string, value: string): void; addEventListener(): void }
    const make = (tag: string): Fake => ({
      tag, className: "", textContent: "", children: [],
      append(...nodes: Fake[]) { this.children.push(...nodes); },
      setAttribute() {}, addEventListener() {},
    });
    const fake = { createElement: make } as never;
    const warnings = (lines: string[]): string[] => {
      const root = renderCard(fake, elementCard(document, document.objects[0]!, undefined, lines), { openTimeline() {}, openData() {}, setAction() {} }) as unknown as Fake;
      const found: string[] = [];
      const walk = (node: Fake): void => {
        if (node.className === "card-warning") found.push(node.textContent);
        node.children.forEach(walk);
      };
      walk(root);
      return found;
    };
    expect(MOST_NOTES).toBe(3);
    const lines = Array.from({ length: 5 }, (_, n) => `Record ${n + 1} overflows Name plate by 64 px, in width (1 line)`);
    expect(warnings(lines)).toEqual([...lines.slice(0, 3), "2 more in the Data screen"]);
    expect(warnings(lines.slice(0, 3))).toEqual(lines.slice(0, 3));
    expect(warnings([])).toEqual([]);
  });
});
