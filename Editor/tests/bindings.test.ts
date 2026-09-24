// Data binding panel and resolver (11.19): text, images and transforms are
// driven from one strict data path grammar without mutating authored values.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import {
  applyBindingEdit,
  applySampleData,
  bindingPanel,
  dataFields,
  describeBindingIssue,
  formatSampleData,
  parseBindingPath,
  parseSampleData,
  resolveSceneBindings,
  sceneBindingIssues,
} from "../src/bindings";

function base(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 10,
    y: 20,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 100,
    height: 50,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
  };
}

function text(bindings: Record<string, unknown> = {}): SceneObject {
  return {
    type: "text",
    ...base("headline"),
    text: "Authored headline",
    fontId: "inter",
    size: 48,
    bindings,
  } as unknown as SceneObject;
}

function image(bindings: Record<string, unknown> = {}): SceneObject {
  return {
    type: "image",
    ...base("crest"),
    assetId: "home-crest",
    fit: "contain",
    bindings,
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "scoreboard",
    name: "Scoreboard",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {
      match: {
        headline: "Falcons lead",
        home: { crest: "away-crest" },
        position: { x: 640, y: 72 },
        visible: false,
      },
      teams: [{ name: "Falcons" }, { name: "Owls" }],
    },
    assets: [
      {
        assetId: "home-crest",
        name: "Home crest",
        kind: "image",
        path: "home.png",
        mimeType: "image/png",
      },
      {
        assetId: "away-crest",
        name: "Away crest",
        kind: "image",
        path: "away.png",
        mimeType: "image/png",
      },
    ],
    fonts: [],
    materials: [],
    objects,
  } as unknown as SceneDocument;
}

describe("binding path grammar", () => {
  it("accepts nested object paths and numeric array segments", () => {
    expect(parseBindingPath("match.home.crest")).toMatchObject({ ok: true });
    expect(parseBindingPath("teams.0.name")).toEqual({
      ok: true,
      segments: ["teams", "0", "name"],
    });
  });

  it("refuses empty, ambiguous and prototype-reaching segments", () => {
    expect(parseBindingPath("match..score")).toMatchObject({ ok: false });
    expect(parseBindingPath("match.home score")).toMatchObject({ ok: false });
    expect(parseBindingPath("match.__proto__.score")).toMatchObject({ ok: false });
  });

  it("flattens only bindable leaf values", () => {
    expect(dataFields(scene([]).dataContext).map((field) => field.path)).toEqual([
      "match.headline",
      "match.home.crest",
      "match.position.x",
      "match.position.y",
      "match.visible",
      "teams.0.name",
      "teams.1.name",
    ]);
  });
});

describe("preview resolution", () => {
  it("drives text, image asset and transforms without mutating authored values", () => {
    const authored = scene([
      text({ text: "match.headline", x: "match.position.x", y: "match.position.y" }),
      image({ assetId: "match.home.crest", visible: "match.visible" }),
    ]);
    const resolution = resolveSceneBindings(authored);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.document.objects[0]).toMatchObject({
      text: "Falcons lead",
      x: 640,
      y: 72,
    });
    expect(resolution.document.objects[1]).toMatchObject({
      assetId: "away-crest",
      visible: false,
    });
    expect(authored.objects[0]).toMatchObject({
      text: "Authored headline",
      x: 10,
      y: 20,
    });
  });

  it("refuses the whole resolution when one value has the wrong type", () => {
    const resolution = resolveSceneBindings(scene([text({ x: "match.headline" })]));
    expect(resolution).toMatchObject({
      ok: false,
      issues: [
        {
          code: "bindingTypeMismatch",
          objectId: "headline",
          property: "x",
          path: "match.headline",
        },
      ],
    });
  });

  it("names unsupported properties and non-string paths", () => {
    const resolution = resolveSceneBindings(scene([text({ madeUp: "match.headline", text: 42 })]));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.issues.map((issue) => issue.code)).toEqual([
      "bindingPropertyUnsupported",
      "bindingPathNotString",
    ]);
  });

  it("refuses an image binding to an asset the scene does not carry", () => {
    const document = scene([image({ assetId: "match.home.crest" })]);
    (document.dataContext.match as Record<string, unknown>).home = { crest: "missing" };
    expect(resolveSceneBindings(document)).toMatchObject({
      ok: false,
      issues: [{ code: "bindingAssetUnknown", property: "assetId" }],
    });
  });
});

describe("binding property panel", () => {
  it("offers kind-aware properties and exposes the scene data fields", () => {
    const panel = bindingPanel(scene([text({ text: "match.headline" })]), ["headline"]);
    expect(panel.description).toContain("headline (text)");
    const properties = panel.children?.[0]?.children ?? [];
    expect(properties.find((node) => node.id === "binding/property/text")?.value).toBe(
      'match.headline → "Falcons lead"',
    );
    expect(properties.some((node) => node.id === "binding/property/assetId")).toBe(false);
    expect(panel.children?.[1]?.children?.map((node) => node.label)).toContain("teams.0.name");
  });

  it("names why multi-selection cannot edit object-local bindings", () => {
    expect(bindingPanel(scene([text(), image()]), ["headline", "crest"]).description).toBe(
      "Select one object; 2 are selected",
    );
  });

  it("adds and removes one binding as one undoable transaction", () => {
    const document = scene([text()]);
    const added = applyBindingEdit(document, "headline", "text", "match.headline");
    expect(added).toMatchObject({
      ok: true,
      transaction: {
        label: "Bind Text binding",
        changes: [{ objectId: "headline", field: "bindings.text", to: "match.headline" }],
      },
    });
    if (!added.ok) return;
    expect(added.document.objects[0]?.bindings).toEqual({ text: "match.headline" });

    const removed = applyBindingEdit(added.document, "headline", "text", undefined);
    expect(removed).toMatchObject({ ok: true, transaction: { label: "Remove Text binding" } });
    if (removed.ok) expect(removed.document.objects[0]?.bindings).toBeUndefined();
  });

  it("refuses a path whose current value cannot drive the property", () => {
    expect(applyBindingEdit(scene([text()]), "headline", "x", "match.headline")).toEqual({
      ok: false,
      reason: "match.headline is string; X requires number",
    });
  });
});

describe("author-supplied sample data", () => {
  const emptyScene = (objects: SceneObject[] = [text()]): SceneDocument => ({
    ...scene(objects),
    dataContext: {},
  });

  it("makes a new, empty scene bindable: one transaction, fields discovered at once", () => {
    const document = emptyScene();
    expect(applyBindingEdit(document, "headline", "text", "live.title")).toMatchObject({ ok: false });

    const outcome = applySampleData(document, '{ "live": { "title": "BREAKING", "score": 3 } }');
    expect(outcome).toMatchObject({
      ok: true,
      transaction: {
        label: "Replace sample data (2 fields)",
        changes: [{ objectId: "scoreboard", field: "dataContext", from: {} }],
      },
      invalidBindings: [],
      newlyInvalid: [],
    });
    if (!outcome.ok) return;
    expect(outcome.transaction.changes).toHaveLength(1);
    expect(outcome.document.dataContext).toEqual({ live: { title: "BREAKING", score: 3 } });
    expect(dataFields(outcome.document.dataContext).map((field) => field.path)).toEqual([
      "live.title",
      "live.score",
    ]);
    // Objects are carried over untouched; only the data context changed.
    expect(outcome.document.objects).toBe(document.objects);

    const bound = applyBindingEdit(outcome.document, "headline", "text", "live.title");
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const preview = resolveSceneBindings(bound.document);
    expect(preview.ok && preview.document.objects[0]).toMatchObject({ text: "BREAKING" });
    // The panel lists the new fields for the author to pick from.
    const panel = bindingPanel(bound.document, ["headline"]);
    expect(panel.children?.[1]?.children?.map((node) => node.label)).toEqual(["live.title", "live.score"]);
  });

  it("refuses invalid JSON with its position and leaves the document identical", () => {
    const document = scene([text({ text: "match.headline" })]);
    const snapshot = structuredClone(document);
    const outcome = applySampleData(document, '{\n  "live": { "title": "A" },\n  "score": 3,\n}');
    expect(outcome).toEqual({
      ok: false,
      code: "sampleDataInvalidJson",
      reason: `line 4, column 1: expected a double-quoted property name, found "}"`,
      position: { offset: 44, line: 4, column: 1 },
    });
    expect(document).toEqual(snapshot);
  });

  it("names every other malformed input by code and position", () => {
    const refusal = (input: string) => {
      const parsed = parseSampleData(input);
      return parsed.ok ? "accepted" : `${parsed.code} @${parsed.position?.line}:${parsed.position?.column}`;
    };
    expect(refusal("")).toBe("sampleDataInvalidJson @1:1");
    expect(refusal('{"a": 1} x')).toBe("sampleDataInvalidJson @1:10");
    expect(refusal("{'a': 1}")).toBe("sampleDataInvalidJson @1:2");
    expect(refusal('{"a": "unterminated}')).toBe("sampleDataInvalidJson @1:21");
    expect(refusal('{"a": 01}')).toBe("sampleDataInvalidJson @1:8");
    expect(refusal('{"a": NaN}')).toBe("sampleDataInvalidJson @1:7");
    // Accepted by JSON.parse, but each would silently change the data.
    expect(refusal('{"a": 1, "a": 2}')).toBe("sampleDataDuplicateKey @1:10");
    expect(refusal('{"id": 12345678901234567890}')).toBe("sampleDataNumberUnrepresentable @1:8");
    expect(refusal('{"big": 1e999}')).toBe("sampleDataNumberUnrepresentable @1:9");
    expect(refusal(`{"deep": ${"[".repeat(300)}${"]".repeat(300)}}`)).toMatch(/^sampleDataTooDeep/);
    // The root must be an object: that is the generated dataContext shape.
    expect(refusal("  [1, 2]")).toBe("sampleDataNotObject @1:3");
    expect(refusal("null")).toBe("sampleDataNotObject @1:1");
    expect(refusal('"text"')).toBe("sampleDataNotObject @1:1");
    // Valid edge cases stay valid.
    expect(parseSampleData('{"s": "a\\u00e9\\n", "n": -1.5e3, "z": [], "o": {}, "t": true, "x": null}')).toEqual({
      ok: true,
      data: { s: "aé\n", n: -1500, z: [], o: {}, t: true, x: null },
    });
  });

  it("reports a binding the new data invalidates, by path and reason, and keeps it", () => {
    const document = scene([text({ text: "match.headline", x: "match.position.x" })]);
    expect(sceneBindingIssues(document)).toEqual([]);

    const outcome = applySampleData(document, '{ "match": { "position": { "x": "wide" } } }');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.invalidBindings.map(describeBindingIssue)).toEqual([
      "headline.text → match.headline: match.headline is absent from the scene data context",
      "headline.x → match.position.x: match.position.x is string; X requires number",
    ]);
    expect(outcome.newlyInvalid).toEqual(outcome.invalidBindings);
    // Not dropped, not rewritten.
    expect(outcome.document.objects[0]?.bindings).toEqual({ text: "match.headline", x: "match.position.x" });
    // The panel shows each as invalid rather than as unbound.
    const properties = bindingPanel(outcome.document, ["headline"]).children?.[0]?.children ?? [];
    expect(properties.find((node) => node.id === "binding/property/text")?.value).toBe(
      "match.headline — match.headline is absent from the scene data context",
    );
    // And the preview refuses the whole resolution by name.
    expect(resolveSceneBindings(outcome.document)).toMatchObject({
      ok: false,
      issues: [{ code: "bindingPathInvalid" }, { code: "bindingTypeMismatch" }],
    });
  });

  it("separates bindings already invalid from those this change broke", () => {
    const document = scene([text({ text: "match.headline", y: "match.gone" })]);
    const outcome = applySampleData(document, '{ "other": 1 }');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.invalidBindings.map((issue) => issue.property)).toEqual(["text", "y"]);
    expect(outcome.newlyInvalid.map((issue) => issue.property)).toEqual(["text"]);
  });

  it("undo restores the previous data through whole-document history", () => {
    // The Editor's history (main.ts `commitScene`/`undo`) snapshots the
    // pre-gesture document. The replace must leave that snapshot intact.
    const before = scene([text({ text: "match.headline" })]);
    const snapshot = structuredClone(before);
    const undoStack: SceneDocument[] = [];
    let current = before;

    const outcome = applySampleData(current, formatSampleData({ match: { headline: "Owls level" } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    undoStack.push(current);
    current = outcome.document;
    expect(undoStack).toHaveLength(1);

    const restored = undoStack.pop();
    expect(restored).toBeDefined();
    if (!restored) return;
    current = restored;
    expect(current.dataContext).toEqual(snapshot.dataContext);
    expect(current).toEqual(snapshot);
    const preview = resolveSceneBindings(current);
    expect(preview.ok && preview.document.objects[0]).toMatchObject({ text: "Falcons lead" });
  });

  it("refuses an unchanged replace so it adds no empty undo entry", () => {
    const document = scene([]);
    expect(applySampleData(document, formatSampleData(document.dataContext))).toEqual({
      ok: false,
      code: "sampleDataUnchanged",
      reason: "the sample data is unchanged",
    });
  });
});
