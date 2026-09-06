import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBindings,
  resolveSceneObjectHierarchy,
  BINDABLE_SCENE_PROPERTIES,
  describePropertySource,
  isBindingAssignable,
  resolvePropertySource
} from "../dist/index.js";

/**
 * Which value is in force, decided the way the renderer decides it.
 *
 * The order Preview prepares a scene in is channels, then hierarchy, then bindings
 * (`sceneMaterial.ts:35-38`), so a binding **overwrites** a sampled keyframe. The Inspector's field
 * sampled only the channel, so a bound-and-keyframed property showed a number nothing drew.
 *
 * The second fact these tests pin is the one nothing had written down: the native renderer resolves no
 * bindings — `SceneDocumentDto` has no `dataContext` field at all — while it does sample channels. So
 * `program` is the pre-binding value for every bound property, and `agrees` is false whenever the
 * binding actually changes something. A test that asserted `preview === program` would have looked
 * reasonable and hidden the whole parity gap.
 */

function rect(overrides = {}) {
  return {
    id: "r1",
    name: "Rect",
    type: "rect",
    x: 100,
    y: 50,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ff0000",
    stroke: "#ffffff",
    strokeWidth: 1,
    bindings: {},
    materialSlots: {},
    ...overrides
  };
}

const channel = (...values) => ({
  keys: values.map(([frame, value], index) => ({ id: `k${index}`, frame, value, easing: "linear" }))
});

test("a property with no channel and no binding is static, and both renderers agree", () => {
  const source = resolvePropertySource(rect(), "x", {}, 0);
  assert.equal(source.kind, "static");
  assert.equal(source.preview, 100);
  assert.equal(source.program, 100);
  assert.equal(source.agrees, true);
});

test("a channel with keys is keyframed, sampled at the frame, and honoured on air", () => {
  const object = rect({ animation: { x: channel([0, 0], [10, 100]) } });
  const source = resolvePropertySource(object, "x", {}, 5);
  assert.equal(source.kind, "keyframed");
  assert.equal(source.preview, 50);
  // `animation.rs` samples x, so Program draws the same number.
  assert.equal(source.program, 50);
  assert.equal(source.agrees, true);
  assert.equal(source.keyCount, 2);
});

test("an empty channel is static, not keyframed with nothing in it", () => {
  const object = rect({ animation: { x: { keys: [] } } });
  assert.equal(resolvePropertySource(object, "x", {}, 0).kind, "static");
});

test("a valid binding over a sampled channel reports bound with the resolved value", () => {
  // The gate's central case: both a channel and a binding, and the binding is what Preview draws.
  const object = rect({
    animation: { x: channel([0, 0], [10, 100]) },
    bindings: { x: "layout.x" }
  });
  const source = resolvePropertySource(object, "x", { layout: { x: 777 } }, 5);
  assert.equal(source.kind, "bound");
  assert.equal(source.preview, 777, "the binding wins over the keyframe, as applyBindings does");
  assert.equal(source.program, 50, "Program resolves no bindings, so it draws the sampled key");
  assert.equal(source.agrees, false);
  assert.equal(source.path, "layout.x");
});

test("a binding that agrees with the value beneath it still reports the disagreement honestly", () => {
  // Same number by coincidence is not the same mechanism, but the author only cares that air matches.
  const object = rect({ x: 42, bindings: { x: "layout.x" } });
  const source = resolvePropertySource(object, "x", { layout: { x: 42 } }, 0);
  assert.equal(source.kind, "bound");
  assert.equal(source.agrees, true, "nothing visibly differs when the bound value equals the authored one");
});

test("a missing path reports binding-missing with the value actually drawn", () => {
  const object = rect({ animation: { x: channel([0, 0], [10, 100]) }, bindings: { x: "nope.missing" } });
  const source = resolvePropertySource(object, "x", { layout: { x: 1 } }, 5);
  assert.equal(source.kind, "binding-missing");
  // `applyBindings` skips an undefined resolution, so the sampled key survives — not the authored 100.
  assert.equal(source.preview, 50, "the fallback is the sampled channel, not the authored field");
  assert.equal(source.program, 50);
  assert.equal(source.agrees, true, "an unresolved binding cannot make the renderers disagree");
});

test("a missing path on an unkeyframed property falls back to the authored field", () => {
  const source = resolvePropertySource(rect({ bindings: { x: "nope" } }), "x", {}, 0);
  assert.equal(source.kind, "binding-missing");
  assert.equal(source.preview, 100);
});

test("an empty path is not a binding at all", () => {
  assert.equal(resolvePropertySource(rect({ bindings: { x: "  " } }), "x", {}, 0).kind, "static");
});

test("a string bound to numeric x reports binding-type-mismatch with both types named", () => {
  const source = resolvePropertySource(rect({ bindings: { x: "label" } }), "x", { label: "left" }, 0);
  assert.equal(source.kind, "binding-type-mismatch");
  assert.equal(source.found, "string");
  assert.equal(source.expected, "number");
  // `assignBoundValue`'s `if (typeof value === "number")` has no else, so the write never happens.
  assert.equal(source.preview, 100);
});

test("null and an array are named as themselves rather than as objects", () => {
  const asNull = resolvePropertySource(rect({ bindings: { x: "v" } }), "x", { v: null }, 0);
  // `resolveDataPath` returns null, which is not undefined, so this is a mismatch and not a miss.
  assert.equal(asNull.kind, "binding-type-mismatch");
  assert.equal(asNull.found, "null");
  const asArray = resolvePropertySource(rect({ bindings: { x: "v" } }), "x", { v: [1, 2] }, 0);
  assert.equal(asArray.found, "array");
});

test("a number bound to a colour is a mismatch, because the applier requires a string", () => {
  const source = resolvePropertySource(rect({ bindings: { fill: "v" } }), "fill", { v: 16711680 }, 0);
  assert.equal(source.kind, "binding-type-mismatch");
  assert.equal(source.expected, "string");
});

test("text and visible accept any type, because the applier coerces them", () => {
  const textObject = rect({ type: "text", text: "old", bindings: { text: "v" } });
  const asNumber = resolvePropertySource(textObject, "text", { v: 42 }, 0);
  assert.equal(asNumber.kind, "bound");
  assert.equal(asNumber.preview, "42", "String(value) is what assignBoundValue stores");
  const visible = resolvePropertySource(rect({ bindings: { visible: "v" } }), "visible", { v: 0 }, 0);
  assert.equal(visible.kind, "bound");
  assert.equal(visible.preview, false, "Boolean(value) is what assignBoundValue stores");
});

test("scaleZ bound on a non-mesh is unsupported, not bound", () => {
  // The state the plan did not name, and the one F13 is made of: the path resolves, the type is right,
  // and `assignBoundValue` drops it because the guard is `object.type === "mesh"`.
  const source = resolvePropertySource(rect({ bindings: { scaleZ: "v" } }), "scaleZ", { v: 2 }, 0);
  assert.equal(source.kind, "binding-unsupported");
  assert.ok(source.reason?.includes("meshes only"), `reason should say why: ${source.reason}`);
  assert.equal(source.agrees, true, "an inert binding cannot make the renderers disagree");
});

test("scaleZ bound on a mesh is honoured", () => {
  const mesh = rect({ type: "mesh", meshKind: "cube", depth: 100, scaleZ: 1, bindings: { scaleZ: "v" } });
  const source = resolvePropertySource(mesh, "scaleZ", { v: 2 }, 0);
  assert.equal(source.kind, "bound");
  assert.equal(source.preview, 2);
});

test("text bound on a non-text object is unsupported", () => {
  const source = resolvePropertySource(rect({ bindings: { text: "v" } }), "text", { v: "hello" }, 0);
  assert.equal(source.kind, "binding-unsupported");
});

test("an unsupported binding is decided before the path is read", () => {
  // Otherwise a valid path would report `bound` for a value nothing assigns — the exact shape of the
  // lie this phase exists to remove.
  const source = resolvePropertySource(rect({ bindings: { rotationX: "v" } }), "rotationX", { v: 90 }, 0);
  assert.equal(source.kind, "binding-unsupported");
});

test("the assignability predicate matches the applier's guards", () => {
  const plain = rect();
  const mesh = rect({ type: "mesh" });
  const text = rect({ type: "text" });
  const image = rect({ type: "image" });
  for (const property of ["rotationX", "rotationY", "rotationZ", "scaleZ"]) {
    assert.equal(isBindingAssignable(mesh, property), true, `${property} on a mesh`);
    assert.equal(isBindingAssignable(plain, property), false, `${property} on a rect`);
  }
  assert.equal(isBindingAssignable(text, "text"), true);
  assert.equal(isBindingAssignable(plain, "text"), false);
  assert.equal(isBindingAssignable(image, "src"), true);
  assert.equal(isBindingAssignable(plain, "src"), false);
  for (const property of ["x", "y", "width", "height", "opacity", "fill", "visible"]) {
    assert.equal(isBindingAssignable(plain, property), true, `${property} applies to any type`);
  }
  assert.equal(isBindingAssignable(plain, "notAProperty"), false);
});

test("a channel the object's kind cannot animate is not read as one", () => {
  // `zDepth` is animatable for mesh-path types only, and the evaluator ignores the rest, so a stale
  // channel on a rect must not be reported as the value in force.
  const object = rect({ animation: { zDepth: channel([0, 0], [10, 500]) } });
  const source = resolvePropertySource(object, "zDepth", {}, 5);
  assert.equal(source.kind, "static");
  assert.equal(source.preview, 0);
});

test("width is bindable but has no channel, so a binding on it is simply bound", () => {
  const source = resolvePropertySource(rect({ bindings: { width: "w" } }), "width", { w: 640 }, 0);
  assert.equal(source.kind, "bound");
  assert.equal(source.preview, 640);
  assert.equal(source.program, 200);
});

test("every kind produces a sentence, and a static value produces none", () => {
  assert.equal(describePropertySource({ kind: "static", preview: 1, program: 1, agrees: true }), "");
  const cases = [
    resolvePropertySource(rect({ animation: { x: channel([0, 1]) } }), "x", {}, 0),
    resolvePropertySource(rect({ bindings: { x: "a" } }), "x", { a: 5 }, 0),
    resolvePropertySource(rect({ bindings: { x: "a" } }), "x", {}, 0),
    resolvePropertySource(rect({ bindings: { x: "a" } }), "x", { a: "no" }, 0),
    resolvePropertySource(rect({ bindings: { scaleZ: "a" } }), "scaleZ", { a: 2 }, 0)
  ];
  for (const source of cases) {
    const sentence = describePropertySource(source);
    assert.ok(sentence.length > 0, `${source.kind} should say something`);
    assert.ok(!sentence.includes("undefined"), `${source.kind} sentence leaked undefined: ${sentence}`);
  }
});

test("the bound sentence names Program, because that is the part an author cannot see", () => {
  const object = rect({ bindings: { x: "layout.x" } });
  const sentence = describePropertySource(resolvePropertySource(object, "x", { layout: { x: 777 } }, 0));
  assert.ok(sentence.includes("layout.x"), sentence);
  assert.ok(sentence.includes("Program draws 100"), sentence);
});

test("resolving does not mutate the object or the data context", () => {
  const object = rect({ animation: { x: channel([0, 0], [10, 100]) }, bindings: { x: "layout.x" } });
  const before = JSON.stringify(object);
  const data = { layout: { x: 777 } };
  const dataBefore = JSON.stringify(data);
  resolvePropertySource(object, "x", data, 5);
  assert.equal(JSON.stringify(object), before, "the object must be untouched");
  assert.equal(JSON.stringify(data), dataBefore, "the data context must be untouched");
});

/*
 * The mirror, asserted behaviourally.
 *
 * `BINDING_VALUE_TYPE` and the mesh-only set inside the resolver restate what `assignBoundValue`
 * does. A restated list rots — that is rule 210, learned when a hand-maintained Rust copy of an object
 * type table drifted from the code it claimed to describe. So instead of comparing the resolver to a
 * second list, this runs the real applier and checks the resolver predicted what it did.
 */

const EVERY_TYPE_FIXTURE = {
  rect: () => rect(),
  text: () => rect({ type: "text", text: "t", fontSize: 48, fontFamily: "Inter", align: "left" }),
  image: () => rect({ type: "image", src: "" }),
  mesh: () => rect({ type: "mesh", meshKind: "cube", depth: 100, scaleZ: 1, rotationX: 0, rotationY: 0, rotationZ: 0 }),
  ellipse: () => rect({ type: "ellipse" }),
  layer: () => rect({ type: "layer", layerKind: "main", childIds: [] }),
  group: () => rect({ type: "group", childIds: [] })
};

/** A value of the right shape for each property, so only assignability decides the outcome. */
const SAMPLE_FOR = {
  text: "bound text",
  src: "bound.png",
  fill: "#00ff00",
  stroke: "#0000ff",
  visible: false,
  x: 11,
  y: 12,
  zDepth: 13,
  width: 14,
  height: 15,
  rotation: 16,
  rotationX: 17,
  rotationY: 18,
  rotationZ: 19,
  scaleX: 2,
  scaleY: 3,
  scaleZ: 4,
  opacity: 0.5
};

test("the resolver reports bound exactly when the applier writes the value", () => {
  const checked = [];
  for (const [typeName, build] of Object.entries(EVERY_TYPE_FIXTURE)) {
    for (const property of BINDABLE_SCENE_PROPERTIES) {
      const value = SAMPLE_FOR[property];
      const object = build();
      object.bindings = { [property]: "d.v" };
      const before = object[property];
      const source = resolvePropertySource(object, property, { d: { v: value } }, 0);
      const applied = applyBindings(object, { d: { v: value } });
      const wrote = applied[property] !== before;
      assert.equal(
        source.kind === "bound",
        wrote,
        `${typeName}.${property}: resolver said ${source.kind} but the applier ${wrote ? "wrote" : "did not write"}`
      );
      if (wrote) {
        assert.deepEqual(source.preview, applied[property], `${typeName}.${property} value`);
      }
      checked.push(`${typeName}.${property}`);
    }
  }
  // A silent zero-length sweep would pass this test while checking nothing.
  assert.equal(checked.length, Object.keys(EVERY_TYPE_FIXTURE).length * BINDABLE_SCENE_PROPERTIES.length);
  assert.ok(checked.length >= 100, `expected a real sweep, checked ${checked.length}`);
});

test("the applier leaves the property alone for every kind the resolver calls unsupported", () => {
  for (const [typeName, build] of Object.entries(EVERY_TYPE_FIXTURE)) {
    for (const property of BINDABLE_SCENE_PROPERTIES) {
      const object = build();
      object.bindings = { [property]: "d.v" };
      const source = resolvePropertySource(object, property, { d: { v: SAMPLE_FOR[property] } }, 0);
      if (source.kind !== "binding-unsupported") continue;
      const applied = applyBindings(object, { d: { v: SAMPLE_FOR[property] } });
      assert.deepEqual(
        applied[property],
        object[property],
        `${typeName}.${property} was called unsupported but the applier changed it`
      );
      assert.equal(isBindingAssignable(object, property), false);
    }
  }
});

test("the bindable list and the type table describe the same set of properties", () => {
  /*
   * The list is declared in authoring order and the types in a lookup, so they are two tables. They
   * were one for a moment — the list derived from `Object.keys` of the type map — and that put
   * `visible` third in the panel because of where it sat in a type table, which is the wrong reason
   * for a UI order. Two tables with a test beating them together is better than one table serving two
   * purposes badly.
   */
  for (const property of BINDABLE_SCENE_PROPERTIES) {
    const source = resolvePropertySource(
      { ...rect(), type: "mesh", meshKind: "cube", depth: 1, text: "t", src: "s", bindings: { [property]: "d" } },
      property,
      { d: 1 },
      0
    );
    assert.notEqual(
      source.kind,
      "static",
      `${property} is listed as bindable but the resolver does not recognise it as bound`
    );
  }
  // And the order is the authoring order, not an accident of the type lookup.
  assert.deepEqual(BINDABLE_SCENE_PROPERTIES.slice(0, 5), ["text", "src", "fill", "stroke", "visible"]);
  assert.equal(BINDABLE_SCENE_PROPERTIES.length, 18);
  assert.equal(new Set(BINDABLE_SCENE_PROPERTIES).size, 18, "no property listed twice");
});

/*
 * The container question, decided by measurement rather than by reading.
 *
 * The plan offered two outcomes for a bound container transform — make it reach the children, or stop
 * advertising it — and asked for a paired test to choose. These are the Preview half; the Program half
 * is `services/render-daemon/tests/data_bindings_are_not_resolved.rs`, which shows there is nothing to
 * pair with: the native renderer resolves no bindings at all.
 */

const container = (overrides = {}) => ({
  ...rect(),
  id: "layer_1",
  type: "layer",
  layerKind: "main",
  childIds: ["mesh_1"],
  scaleZ: 1,
  ...overrides
});

const meshChild = () => ({
  ...rect(),
  id: "mesh_1",
  type: "mesh",
  meshKind: "cube",
  depth: 100,
  scaleZ: 1,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0
});

const childScaleZ = (objects) => objects.find((object) => object.id === "mesh_1").scaleZ;

test("a container's scaleZ set directly does reach its mesh child", () => {
  // The control. Without it, the next two tests could pass because inheritance is broken outright,
  // and the wrong thing would get blamed.
  const resolved = resolveSceneObjectHierarchy([container({ scaleZ: 5 }), meshChild()]).objects;
  assert.equal(childScaleZ(resolved), 5);
});

test("a container's scaleZ binding does not reach its mesh child", () => {
  // Preview's order: hierarchy, then bindings per object (`sceneMaterial.ts:35-38`).
  const objects = resolveSceneObjectHierarchy([
    container({ bindings: { scaleZ: "rig.depth" } }),
    meshChild()
  ]).objects.map((object) => applyBindings(object, { rig: { depth: 5 } }));
  assert.equal(childScaleZ(objects), 1);
});

test("applying bindings before hierarchy would not have fixed it either", () => {
  /*
   * This is the finding that decided the outcome. The plan's preferred fix was to reorder the
   * pipeline, and reordering changes nothing: `assignBoundValue` guards `scaleZ` behind
   * `object.type === "mesh"`, so the container's own `scaleZ` is never written whichever order runs.
   * Both halves would have to change, and the native renderer has no binding resolution to change.
   */
  const bound = [container({ bindings: { scaleZ: "rig.depth" } }), meshChild()]
    .map((object) => applyBindings(object, { rig: { depth: 5 } }));
  assert.equal(bound[0].scaleZ, 1, "the container's own scaleZ is never written");
  const objects = resolveSceneObjectHierarchy(bound).objects;
  assert.equal(childScaleZ(objects), 1, "so the child cannot inherit it in either order");
});

test("the resolver says so rather than reporting the binding as live", () => {
  const source = resolvePropertySource(
    container({ bindings: { scaleZ: "rig.depth" } }),
    "scaleZ",
    { rig: { depth: 5 } },
    0
  );
  assert.equal(source.kind, "binding-unsupported");
});
