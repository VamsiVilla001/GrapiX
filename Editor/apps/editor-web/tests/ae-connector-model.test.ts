import assert from "node:assert/strict";
import test from "node:test";
import {
  AE_RATIONAL_PATTERN,
  containerIdForComposition,
  controlFromProperty,
  frameRateToRational,
  rankCompositions
} from "../src/components/aeConnectorModel";

function composition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "1", name: "MAIN", width: 1920, height: 1080, frameRate: 29.97,
    durationSeconds: 10, layerCount: 5, textLayerCount: 0, assetCount: 0, missingAssetCount: 0,
    isTopLevel: true, nestedUseCount: 0, grapixMarked: false,
    ...overrides
  } as never;
}

const NO_FILTER = { query: "", onlyPublishable: false, onlyWithText: false, onlyTopLevel: false };

test("a float frame rate becomes the exact broadcast rational", () => {
  // After Effects reports 29.97003173828125; a float cannot tell 2997/100 from 30000/1001, and the
  // two are eight frames apart over an hour — a graphic that drifts off its cue.
  assert.equal(frameRateToRational(29.97003173828125), "30000/1001");
  assert.equal(frameRateToRational(59.94005966186523), "60000/1001");
  assert.equal(frameRateToRational(23.976), "24000/1001");
  // Whole-number rates keep a denominator: the container store requires both parts, and this
  // project's compositions are exactly 60 fps — a bare "60" was refused by the store.
  assert.equal(frameRateToRational(25), "25/1");
  assert.equal(frameRateToRational(50), "50/1");
  assert.equal(frameRateToRational(60), "60/1");
});

test("every rate the picker can produce is one the container store accepts", () => {
  // The store's own rule, restated. Producing a rate it refuses turns "declare a container" into an
  // error an author cannot act on, which is exactly what a real 60 fps project hit.
  for (const rate of [23.976, 24, 25, 29.97003173828125, 30, 48, 50, 59.94005966186523, 60, 0, -1, Number.NaN]) {
    assert.match(frameRateToRational(rate), AE_RATIONAL_PATTERN, `${rate} produced an invalid rational`);
  }
});

test("an unrecognised rate stays exact rather than guessing a rational", () => {
  assert.equal(frameRateToRational(48), "48/1");
  // Nonsense must not produce a broken clock string.
  assert.equal(frameRateToRational(0), "25/1");
  assert.equal(frameRateToRational(-1), "25/1");
  assert.equal(frameRateToRational(Number.NaN), "25/1");
});

test("publishable compositions rank above ones with missing footage", () => {
  const ranked = rankCompositions(
    [
      composition({ id: "1", name: "Broken", missingAssetCount: 3, textLayerCount: 9 }),
      composition({ id: "2", name: "Good", missingAssetCount: 0, textLayerCount: 1 })
    ],
    NO_FILTER
  );
  // Publishable wins even against a composition with far more text: an author cannot ship the
  // broken one at all.
  assert.deepEqual(ranked.map((entry) => entry.name), ["Good", "Broken"]);
});

test("text and frame size break the remaining ties", () => {
  const ranked = rankCompositions(
    [
      composition({ id: "1", name: "Fragment", width: 471, height: 179 }),
      composition({ id: "2", name: "Full frame", width: 1920, height: 1080 }),
      composition({ id: "3", name: "With text", width: 1920, height: 1080, textLayerCount: 4 })
    ],
    NO_FILTER
  );
  assert.deepEqual(ranked.map((entry) => entry.name), ["With text", "Full frame", "Fragment"]);
});

test("the filters narrow to what an author asked for", () => {
  const all = [
    composition({ id: "1", name: "point stands", textLayerCount: 0 }),
    composition({ id: "2", name: "points distribution", textLayerCount: 3 }),
    composition({ id: "3", name: "winner", textLayerCount: 2, missingAssetCount: 1 })
  ];

  assert.deepEqual(
    rankCompositions(all, { ...NO_FILTER, query: "point" }).map((entry) => entry.name),
    ["points distribution", "point stands"]
  );
  assert.deepEqual(
    rankCompositions(all, { ...NO_FILTER, onlyPublishable: true }).map((entry) => entry.name),
    ["points distribution", "point stands"]
  );
  assert.deepEqual(
    rankCompositions(all, { ...NO_FILTER, onlyWithText: true }).map((entry) => entry.name),
    ["points distribution", "winner"]
  );
});

test("a GX_-named composition outranks every heuristic", () => {
  const ranked = rankCompositions(
    [
      // Bigger, publishable, with text — every heuristic favours it, but it is not the one the
      // designer named for GrapiX.
      composition({ id: "1", name: "winner", textLayerCount: 9 }),
      composition({ id: "2", name: "GX_winner", textLayerCount: 0, grapixMarked: true })
    ],
    NO_FILTER
  );
  assert.deepEqual(ranked.map((entry) => entry.name), ["GX_winner", "winner"]);
});

test("top-level compositions rank above precomp fragments", () => {
  const ranked = rankCompositions(
    [
      composition({ id: "1", name: "points dist", isTopLevel: false, nestedUseCount: 12 }),
      composition({ id: "2", name: "points distribution", isTopLevel: true, nestedUseCount: 0 })
    ],
    NO_FILTER
  );
  // A fragment used twelve times as a precomp is a building block; the render candidate leads.
  assert.deepEqual(ranked.map((entry) => entry.name), ["points distribution", "points dist"]);
});

test("the top-level filter hides fragments but keeps the marked", () => {
  const all = [
    composition({ id: "1", name: "points distribution", isTopLevel: true }),
    composition({ id: "2", name: "Group 1", isTopLevel: false, nestedUseCount: 4 })
  ];
  assert.deepEqual(
    rankCompositions(all, { ...NO_FILTER, onlyTopLevel: true }).map((entry) => entry.name),
    ["points distribution"]
  );
});

test("a container id is stable, so reopening a composition finds its controls", () => {
  const first = containerIdForComposition("DYno_Format", "point stands");
  assert.equal(first, containerIdForComposition("DYno_Format", "point stands"));
  assert.equal(first, "dyno-format-point-stands");
  // Different compositions of one project must not collide onto one container.
  assert.notEqual(first, containerIdForComposition("DYno_Format", "points distribution"));
  // A name with nothing usable in it still yields an id the store will accept.
  assert.ok(containerIdForComposition("???", "***").length > 0);
});

test("a property is identified by layer index and match name, never by display name", () => {
  const comp = composition();
  const layer = {
    index: 7, name: "xxx", type: "text", enabled: true, effects: [],
    exposable: [{ label: "Source Text", kind: "text", matchName: "ADBE Text Document" }]
  } as never;
  const property = { label: "Source Text", kind: "text", matchName: "ADBE Text Document" };

  const control = controlFromProperty(comp, layer, property, []);
  assert.ok(control);
  assert.equal(control.target.layerId, 7);
  assert.equal(control.target.propertyPath[0].matchName, "ADBE Text Document");
  assert.equal(control.kind, "text");

  // Exposing the same property twice is refused...
  assert.equal(controlFromProperty(comp, layer, property, [control]), null);

  // ...but a different layer with the SAME name is a different control. This project has several
  // layers called "xxx"; keying on the name would silently merge them.
  const other = { ...layer, index: 8 } as never;
  assert.ok(controlFromProperty(comp, other, property, [control]));
});
