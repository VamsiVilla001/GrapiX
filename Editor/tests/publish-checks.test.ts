import { describe, expect, it } from "vitest";

import type { FitReport, FitResult } from "@grapix/contracts";

import { checkOf, publishView, type Blocker, type PublishInput } from "../src/publish-checks";
import { renderPublishChecks } from "../src/publish-checks-view";

class Fake {
  readonly children: Fake[] = [];
  readonly dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  constructor(readonly tag: string) {}
  append(...kids: Fake[]): void {
    this.children.push(...kids);
  }
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
const fakeDocument = { createElement: (tag: string) => new Fake(tag) } as unknown as Document;

const doc = (extra: Record<string, unknown> = {}) =>
  ({
    objects: [
      { id: "plate", name: "Name plate", bindings: { text: { field: "name" } } },
      { id: "logo", name: "Logo" },
    ],
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    colorDepth: "32",
    timeline: { durationFrames: 250, channels: [{ objectId: "plate", property: "x", keys: [{ frame: 0, value: 0 }] }, { objectId: "plate", property: "y", keys: [{ frame: 0, value: 0 }] }, { objectId: "logo", property: "opacity", keys: [] }], phases: [], pathChannels: [] },
    ...extra,
  }) as never;

const blocker = (code: string, message = code): Blocker => ({ code, subject: code, message });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ name: "Final Four L3", sceneId: "s-021", document: doc(), blockers: [], fontBlockers: [], engine: "ready", ...over });

describe("which check a blocker belongs to", () => {
  it("sorts by the refusal's code: fonts, bindings, pictures, then the scene", () => {
    expect(checkOf("fontMissing")).toBe("style");
    expect(checkOf("bindingInvalid")).toBe("data");
    expect(checkOf("packageAssetNotPackaged")).toBe("assets");
    expect(checkOf("sceneIdInvalid")).toBe("scene");
    // Package refusals about a picture file carry no "asset" in the name and still belong to Assets.
    for (const code of ["packageFileHashMismatch", "packageFileLengthMismatch", "packageEntryMissing"]) expect(checkOf(code)).toBe("assets");
  });
});

describe("the checks", () => {
  it("are all OK and Publish is allowed when the shell found nothing", () => {
    const view = publishView(input());
    expect(view.rows.map((r) => [r.id, r.state])).toEqual([["style", "ok"], ["data", "ok"], ["assets", "ok"], ["scene", "ok"]]);
    expect(view.canPublish).toBe(true);
    expect(view.fixCount).toBe(0);
    expect(view.title).toBe("Publish Final Four L3 to Playout");
    expect(view.chips.map((c) => c.text)).toEqual(["NEW GRAPHIC", "READY TO PUBLISH", "ENGINE READY"]);
  });

  it("let a graphic with no bindings publish as it is: nothing requires a binding (owner, 25 Nov 2026)", () => {
    const plain = doc({ objects: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    const view = publishView(input({ document: plain }));
    expect(view.canPublish).toBe(true);
    expect(view.rows.find((r) => r.id === "data")).toMatchObject({ state: "ok", text: "no data fields; this graphic publishes as it is" });
    expect(view.chips.map((c) => c.text)).toContain("READY TO PUBLISH");
    // A bound one says the ordinary thing.
    expect(publishView(input()).rows.find((r) => r.id === "data")!.text).toBe("every bound field has a source");
  });

  it("say CHECKING and keep Publish off until the shell has answered", () => {
    const view = publishView(input({ blockers: undefined }));
    expect(view.rows.every((r) => r.state === "wait")).toBe(true);
    expect(view.canPublish).toBe(false);
    expect(view.chips[1]!.text).toBe("CHECKING");
  });

  it("name what to fix, count it per row, and keep Publish off", () => {
    const view = publishView(input({ blockers: [blocker("fontMissing", 'font "Inter" is missing'), blocker("fontMissing", 'font "Mono" is missing'), blocker("bindingInvalid", "plate.text has no field")], publishedRevision: 4 }));
    const style = view.rows.find((r) => r.id === "style")!;
    expect(style).toMatchObject({ state: "fix", text: "2 fonts cannot be used" });
    expect(style.details).toEqual(['font "Inter" is missing', 'font "Mono" is missing']);
    expect(view.rows.find((r) => r.id === "data")).toMatchObject({ state: "fix", text: "1 field cannot be filled" });
    expect(view.rows.find((r) => r.id === "assets")!.state).toBe("ok");
    expect(view.canPublish).toBe(false);
    expect(view.fixCount).toBe(2);
    expect(view.chips.map((c) => c.text)).toEqual(["NEW PACKAGE r5", "2 THINGS TO FIX FIRST", "ENGINE READY"]);
  });

  it("count a font the font manager cannot resolve even before the shell has answered, and never twice", () => {
    const early = publishView(input({ blockers: undefined, fontBlockers: ["Inter"] }));
    expect(early.rows[0]).toMatchObject({ state: "fix", details: ['font "Inter" is not available'] });
    expect(early.canPublish).toBe(false);
    const both = publishView(input({ blockers: [blocker("fontMissing", 'font "Inter" is not available')], fontBlockers: ["Inter"] }));
    expect(both.rows[0]!.details).toEqual(['font "Inter" is not available']);
  });

  it("say the engine is not ready without blocking Publish (publishing reaches the asset plane, not the engine)", () => {
    const view = publishView(input({ engine: "not-ready" }));
    expect(view.chips[2]).toMatchObject({ text: "ENGINE NOT READY", tone: "warn" });
    expect(view.canPublish).toBe(true);
  });
});

// The Test row (row 11.153, Figma B6; Jev and Laya: docs/evidence/11.153/jev-laya-publish-test-row.json).
describe("the Test row", () => {
  const bound = doc({ objects: [{ type: "text", id: "plate", name: "Name plate", bindings: { text: "p.name" } }, { id: "logo", name: "Logo" }] });
  const report = (...records: [string, FitResult][]): FitReport => ({ records: records.map(([id, fit]) => ({ id, elements: [{ objectId: "plate", ...fit }] })) }) as FitReport;
  const testOf = (over: Partial<PublishInput>) => publishView(input({ document: bound, ...over })).rows.find((row) => row.id === "test");

  it("is not drawn when no text is bound to data: there is nothing to test", () => {
    expect(publishView(input()).rows.map((row) => row.id)).toEqual(["style", "data", "assets", "scene"]);
    expect(testOf({})).toBeDefined();
  });

  it("sits after Data and says not checked, never OK, before a check; and does not block Publish", () => {
    const view = publishView(input({ document: bound }));
    expect(view.rows.map((row) => row.id)).toEqual(["style", "data", "test", "assets", "scene"]);
    expect(testOf({})).toMatchObject({ state: "idle", text: "not checked yet: Check records measures each record's text in its box" });
    expect(view.canPublish).toBe(true);
    expect(testOf({ records: { problem: "The engine could not check the records: unreachable" } })).toMatchObject({ state: "idle", text: "The engine could not check the records: unreachable" });
  });

  it("says checking while a check runs", () => {
    expect(testOf({ records: { checking: true } })).toMatchObject({ state: "wait", text: "checking the records…" });
  });

  it("is OK when every record fits, in words that say how many", () => {
    expect(testOf({ records: { report: report(["1", { result: "fits" }, ], ["2", { result: "fits" }]) } })).toMatchObject({ state: "ok", text: "all 2 records fit" });
    expect(testOf({ records: { report: report(["sample", { result: "fits" }]) } })).toMatchObject({ state: "ok", text: "the record fits" });
  });

  it("says FIX with the tally and one line per problem, and keeps Publish off (it blocks like the other rows)", () => {
    const records = { report: report(["1", { result: "fits" }], ["2", { result: "overflows", byPx: 64, axis: "width", lines: 1 }], ["3", { result: "empty", hidden: false }]) };
    const row = testOf({ records })!;
    expect(row).toMatchObject({ state: "fix", text: "1 FIT · 2 NEED FIXING" });
    expect(row.details).toEqual(["Record 2 overflows Name plate by 64 px, in width (1 line)", "Record 3 leaves Name plate empty, and it does not hide when empty"]);
    const view = publishView(input({ document: bound, records }));
    expect(view.canPublish).toBe(false);
    expect(view.fixCount).toBe(1);
    expect(view.chips.map((chip) => chip.text)).toContain("1 THING TO FIX FIRST");
  });

  it("reads an intended empty (Hide when empty) as fine", () => {
    expect(testOf({ records: { report: report(["1", { result: "empty", hidden: true }]) } })).toMatchObject({ state: "ok" });
  });

  it("says out of date, never OK and never blocking, when the graphic changed since the check", () => {
    const stale = { report: report(["1", { result: "overflows", byPx: 9, axis: "height", lines: 3 }]), stale: true };
    const view = publishView(input({ document: bound, records: stale }));
    expect(view.rows.find((row) => row.id === "test")).toMatchObject({ state: "idle" });
    expect(view.rows.find((row) => row.id === "test")!.text).toContain("out of date");
    expect(view.canPublish).toBe(true);
  });

  it("is not drawn for a bound element that is not text, and blocks on a single problem as on many", () => {
    const rect = doc({ objects: [{ type: "rect", id: "r", name: "R", bindings: { text: "p.name" } }] });
    expect(publishView(input({ document: rect })).rows.map((row) => row.id)).not.toContain("test");
    const one = { report: report(["1", { result: "overflows", byPx: 5, axis: "width", lines: 2 }]) };
    expect(testOf({ records: one })).toMatchObject({ state: "fix", text: "0 FIT · 1 NEEDS FIXING", details: ["Record 1 overflows Name plate by 5 px, in width (2 lines)"] });
  });

  it("names what an out-of-date check had said, an empty one included", () => {
    expect(testOf({ records: { report: { records: [] } as unknown as FitReport, stale: true } })!.text).toBe("out of date, the graphic changed since the check (it said no records): check again");
    expect(testOf({ records: { report: report(["1", { result: "fits" }]), stale: true } })!.text).toBe("out of date, the graphic changed since the check (it said 1 FIT · 0 NEED FIXING): check again");
  });

  it("says no records to test for an empty report, and does not block", () => {
    expect(testOf({ records: { report: { records: [] } as unknown as FitReport } })).toMatchObject({ state: "idle", text: "no records to test" });
  });

  it("is drawn with a Check records button that the Data screen's button shares, except while checking", () => {
    const draw = (records: PublishInput["records"]) => renderPublishChecks(fakeDocument, publishView(input({ document: bound, ...(records === undefined ? {} : { records }) }))) as unknown as Fake;
    const buttons = (root: Fake) => root.all().filter((n) => n.tag === "button");
    const idle = draw(undefined);
    expect(buttons(idle).map((b) => [b.textContent, b.dataset.action, b.dataset.for])).toEqual([["Check records", "checkRecords", "data/records"]]);
    expect(idle.all().find((n) => n.dataset.check === "test")!.children[0]!.textContent).toBe("—");
    expect(buttons(draw({ checking: true }))).toEqual([]);
    expect(buttons(renderPublishChecks(fakeDocument, publishView(input())) as unknown as Fake)).toEqual([]);
  });
});

describe("the package card", () => {
  it("lists the scene, the bound fields, the motion, the format and the fingerprint", () => {
    const card = Object.fromEntries(publishView(input({ lastPublish: { revision: 2, contentHash: "7c1e" + "0".repeat(56) + "a90b" } })).contents.map((c) => [c.label, c.value]));
    expect(card).toEqual({
      "Scene ID": "s-021 · same in Playout",
      Fields: "Name plate.text",
      Motion: "keyframes on 1 element",
      Format: "1920×1080 · 50 fps · 32 bit",
      Fingerprint: "sha-256 7c1e…a90b",
    });
  });

  it("says plainly when there is nothing bound, animated or published yet", () => {
    const empty = doc({ objects: [{ id: "a", name: "A" }], timeline: { durationFrames: 10, channels: [], phases: [], pathChannels: [] }, canvas: { width: 1280, height: 720, frameRate: { num: 30000, den: 1001 } }, colorDepth: "8" });
    const card = Object.fromEntries(publishView(input({ document: empty })).contents.map((c) => [c.label, c.value]));
    expect(card).toMatchObject({ Fields: "none", Motion: "no keyframes", Format: "1280×720 · 29.97 fps · 8 bit", Fingerprint: "made when published" });
  });
});

describe("the drawn panel", () => {
  it("shows each check with its state word, a FIX row's details, the note and who can do what", () => {
    const root = renderPublishChecks(fakeDocument, publishView(input({ blockers: [blocker("bindingInvalid", "plate.text has no field")] }))) as unknown as Fake;
    const rows = root.all().filter((n) => n.className === "publish-check");
    expect(rows.map((r) => [r.dataset.check, r.dataset.state])).toEqual([["style", "ok"], ["data", "fix"], ["assets", "ok"], ["scene", "ok"]]);
    expect(rows[1]!.children[0]!.textContent).toBe("FIX");
    expect(rows[0]!.children[0]!.textContent).toBe("OK");
    expect(root.all().filter((n) => n.className === "publish-check-detail").map((n) => n.textContent)).toEqual(["plate.text has no field"]);
    const text = root.all().map((n) => n.textContent).join("|");
    expect(text).toContain("It never puts anything on air.");
    expect(text).toContain("read and propose; never cue");
    // The owner's decision: no journey chips and no "Fix next issue".
    expect(text).not.toContain("Fix next issue");
  });
});
