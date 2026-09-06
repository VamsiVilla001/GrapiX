import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATABLE_PROPERTIES,
  claimedProperties,
  isPropertyAnimatable,
  CONTAINER_OBJECT_TYPES,
  PROGRAM_OBJECT_TYPES,
  propertyRendererSupport,
  type SceneObject,
  type SceneObjectType
} from "@grapix/shared-types";
import {
  CONTROL_MANIFEST,
  importedDisclosures,
  inspectorControl
} from "../src/modules/object-inspector/services/inspectorControls";

/**
 * The audit that stops the panel lying again.
 *
 * Written to derive from the contract rather than to restate it: there is **no list of parity facts in
 * this file**. That is deliberate, and it is the difference between a test that holds and a test that
 * rots — a literal here would have to be edited every time a renderer gained a feature, and nobody
 * would, so the panel would keep a disabled field long after the capability arrived.
 *
 * Two rules, over every object type and every control the panel offers.
 */

function baseFields() {
  return {
    x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main", width: 10, height: 10, rotation: 0,
    opacity: 1, visible: true, locked: false, fill: "#fff", stroke: "#000", strokeWidth: 0,
    bindings: {}, materialSlots: {}
  };
}

function textObject(extra: Record<string, unknown>): SceneObject {
  return {
    id: "t1", name: "T", type: "text", ...baseFields(),
    text: "mvp", fontSize: 48, fontFamily: "Arial", fontWeight: "400", align: "left", ...extra
  } as SceneObject;
}

function rectObject(): SceneObject {
  return { id: "r1", name: "R", type: "rect", ...baseFields(), radius: 0 } as SceneObject;
}
const ALL_TYPES: SceneObjectType[] = [
  "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh", "light", "camera",
  "layer", "marker", "group"
];

test("the manifest covers every object type, so no type can escape the audit", () => {
  for (const type of ALL_TYPES) {
    assert.ok(CONTROL_MANIFEST[type], `${type} has no control manifest`);
  }
  assert.deepEqual(Object.keys(CONTROL_MANIFEST).sort(), [...ALL_TYPES].sort());
});

test("no control is offered for a property neither renderer consumes", () => {
  const offences: string[] = [];
  for (const type of ALL_TYPES) {
    for (const property of CONTROL_MANIFEST[type]) {
      const claim = propertyRendererSupport(type, property);
      if (claim?.support !== "neither") continue;
      if (inspectorControl(type, property).enabled) {
        offences.push(`${type}.${property}`);
      }
    }
  }
  // The eleven dishonest controls of 2026-08-08 are why this exists. Any new one lands here.
  assert.deepEqual(offences, [], `enabled controls for properties nothing renders: ${offences.join(", ")}`);
});

test("a property the renderers disagree about carries its explanation", () => {
  const silent: string[] = [];
  for (const type of ALL_TYPES) {
    for (const property of CONTROL_MANIFEST[type]) {
      const control = inspectorControl(type, property);
      if (!control.support || control.support === "both" || control.support === "editor") continue;
      if (!control.note) silent.push(`${type}.${property} (${control.support})`);
    }
  }
  assert.deepEqual(silent, [], `parity gaps with no note: ${silent.join(", ")}`);
});

test("a property nothing renders is never silently disabled either", () => {
  // Disabling without saying why is the same defect wearing a different hat: the author sees a dead
  // control and no reason for it.
  for (const type of ALL_TYPES) {
    for (const property of CONTROL_MANIFEST[type]) {
      const control = inspectorControl(type, property);
      if (control.enabled) continue;
      assert.ok(control.note, `${type}.${property} is disabled with no explanation`);
    }
  }
});

test("editor-only state stays editable and is not mistaken for a parity gap", () => {
  // Without the `editor` verdict, `locked` and `name` would read as properties no renderer consumes
  // and the audit would demand disabling them.
  for (const type of ALL_TYPES) {
    for (const property of ["name", "locked"]) {
      const control = inspectorControl(type, property);
      assert.equal(control.support, "editor", `${type}.${property} should be editor state`);
      assert.equal(control.enabled, true, `${type}.${property} must stay editable`);
    }
  }
});

test("every property of a type Program cannot render is at best Preview-only", () => {
  // The middle resolution step, which is where most of the contract's value comes from: Program
  // prepares six object types, so nothing authored on the others reaches a published frame.
  for (const type of ALL_TYPES) {
    if (PROGRAM_OBJECT_TYPES.includes(type) || CONTAINER_OBJECT_TYPES.includes(type)) continue;
    const control = inspectorControl(type, "x");
    assert.ok(
      control.support === "preview" || control.support === "neither",
      `${type}.x claims ${control.support} while Program does not render ${type}`
    );
    assert.ok(control.note?.includes(type), `${type}.x should name its own type in the note`);
  }
});

test("the corrected fill-rule claim says Program, not both", () => {
  // The note this contract exists for. It used to say both renderers fill non-zero; Program branches
  // on even-odd and Preview never reads the field.
  const control = inspectorControl("shape", "fillRule");
  assert.equal(control.support, "program");
  assert.equal(control.enabled, true);
  assert.match(control.note ?? "", /Preview ignores the rule/);
  assert.doesNotMatch(control.note ?? "", /both renderers fill/i);
});

test("dimensions are refused on the three types whose geometry ignores them", () => {
  for (const type of ["line", "shape", "paint"] as const) {
    for (const property of ["width", "height"]) {
      const control = inspectorControl(type, property);
      assert.equal(control.enabled, false, `${type}.${property} must not be authorable`);
      assert.ok(control.note, `${type}.${property} needs a reason`);
      assert.ok(
        !CONTROL_MANIFEST[type].includes(property),
        `${type} should not list ${property} at all — the control is deleted, not disabled`
      );
    }
  }
});

test("dimensions remain authorable where the renderers do read them", () => {
  for (const type of ["rect", "ellipse", "image", "text", "mesh"] as const) {
    assert.equal(inspectorControl(type, "width").enabled, true, `${type}.width should be editable`);
  }
});

test("layer styles are refused on every object type", () => {
  for (const type of ALL_TYPES) {
    const control = inspectorControl(type, "effects");
    assert.equal(control.enabled, false, `${type}.effects must not be authorable`);
    assert.match(control.note ?? "", /layer styles/);
  }
});

test("a marker event name is not offered at all", () => {
  assert.equal(inspectorControl("marker", "eventName").enabled, false);
  assert.ok(!CONTROL_MANIFEST.marker.includes("eventName"));
});

test("an unclaimed property behaves as before rather than being disabled", () => {
  // The contract is an exception table. A property it says nothing about must not become dead.
  const control = inspectorControl("rect", "radius");
  assert.equal(control.enabled, true);
  assert.equal(control.support, undefined);
  assert.equal(control.note, undefined);
});

test("the contract can list what it claims, so the audit cannot be quietly narrowed", () => {
  const claims = claimedProperties("text");
  for (const property of ["textCase", "paragraphSpacing", "overflow", "effects"]) {
    assert.ok(claims.includes(property), `text claims should include ${property}`);
  }
});

test("an imported letter case is reported, and can never be set", () => {
  // The gate's exact requirement: shown read-only, not settable. "Not settable" is provable here
  // because the manifest is the panel's own account of what it offers a control for.
  assert.ok(!CONTROL_MANIFEST.text.includes("textCase"), "textCase must never be a control");

  const imported = textObject({ textCase: "upper" });
  const disclosures = importedDisclosures(imported);
  assert.equal(disclosures.length, 1);
  assert.equal(disclosures[0].property, "textCase");
  assert.equal(disclosures[0].value, "upper");
  // The wording comes from the contract, not from the panel.
  assert.equal(disclosures[0].note, propertyRendererSupport("text", "textCase")?.note);
  assert.match(disclosures[0].note ?? "", /no text-case step/);
});

test("a default or absent letter case is not reported, so the panel stays quiet", () => {
  assert.deepEqual(importedDisclosures(textObject({ textCase: "original" })), []);
  assert.deepEqual(importedDisclosures(textObject({})), []);
});

test("only text discloses a letter case", () => {
  assert.deepEqual(importedDisclosures(rectObject()), []);
});

/*
 * The animatable set against the editable surface.
 *
 * The plan's rule: a property that is animatable and applicable gets a stopwatch; one that is not gets
 * neither. Before this, the two questions had two homes — `isPropertyAnimatable` returned true for
 * everything but `zDepth`, and the Inspector hid a group of controls behind a
 * `supportsDetailedTransform` flag reading "not a camera and not a light". They disagreed in both
 * directions at once: the Timeline offered a camera's `scaleY`, which nothing reads, and the panel hid
 * a light's `opacity`, which *both* renderers read as a dimmer.
 */

/**
 * `zDepth` on a light or a camera: a control with no channel, and a finding of its own.
 *
 * The gate rule is an allowlist of the *mesh path*, written because depth on a rect is paint order. It
 * incidentally also excludes a light and a camera, for which `zDepth` is a real 3D coordinate that both
 * renderers read and that Preview animates correctly. So you can dolly a camera by hand and not key it.
 *
 * That is not F27 — F27 is `rotation`, `scaleX`, `scaleY` and `opacity` — and fixing it means deciding
 * whether the allowlist should be a denylist of the 2D types it was written for, which touches the
 * engine's own match arms. Named here so the sweep below stays broad enough to catch the next
 * disagreement, without this one masquerading as a pass.
 */
const KNOWN_CONTROL_WITHOUT_CHANNEL = new Set(["light.zDepth", "camera.zDepth"]);

test("a property with a control is animatable, and one without has no channel either", () => {
  const disagreements: string[] = [];
  for (const [objectType, controls] of Object.entries(CONTROL_MANIFEST)) {
    for (const property of ANIMATABLE_PROPERTIES) {
      const offered = controls.includes(property);
      const animatable = isPropertyAnimatable(objectType as SceneObjectType, property);
      // A control the panel offers must be animatable. The converse does not hold: `width` and
      // `height` have controls and no channel by design, and `rotationZ` is a mesh's Z angle under a
      // second name, so the manifest lists whichever one the panel draws.
      if (offered && !animatable && !KNOWN_CONTROL_WITHOUT_CHANNEL.has(`${objectType}.${property}`)) {
        disagreements.push(`${objectType}.${property}: control offered, not animatable`);
      }
    }
  }
  assert.deepEqual(disagreements, []);
});

test("the known control-without-channel cases are still exactly those two", () => {
  // An exclusion list that silently grows is how a finding becomes permanent. This fails if one of them
  // is fixed, so the list shrinks when the engine does.
  for (const entry of KNOWN_CONTROL_WITHOUT_CHANNEL) {
    const [objectType, property] = entry.split(".");
    assert.ok(
      CONTROL_MANIFEST[objectType as SceneObjectType].includes(property),
      `${entry}: no longer has a control, so drop it from the exclusion list`
    );
    assert.equal(
      isPropertyAnimatable(objectType as SceneObjectType, property as never),
      false,
      `${entry}: is animatable now, so drop it from the exclusion list`
    );
  }
});

test("a light offers the opacity its renderers honour", () => {
  assert.ok(CONTROL_MANIFEST.light.includes("opacity"), "a light's dimmer needs a control");
  assert.equal(isPropertyAnimatable("light", "opacity"), true);
  assert.equal(inspectorControl("light", "opacity").enabled, true);
});

test("a light offers no orientation control, because neither renderer turns one", () => {
  for (const property of ["rotation", "scaleX", "scaleY"]) {
    assert.equal(CONTROL_MANIFEST.light.includes(property), false, `light.${property}`);
    assert.equal(inspectorControl("light", property).enabled, false, `light.${property} control`);
    assert.ok(inspectorControl("light", property).note, `light.${property} needs a reason`);
  }
});

test("a camera offers neither orientation nor opacity", () => {
  for (const property of ["rotation", "scaleX", "scaleY", "opacity"]) {
    assert.equal(CONTROL_MANIFEST.camera.includes(property), false, `camera.${property}`);
    assert.equal(isPropertyAnimatable("camera", property), false, `camera.${property} animatable`);
  }
  // Its position still animates: a camera move is ordinary authoring.
  assert.ok(CONTROL_MANIFEST.camera.includes("x"));
  assert.equal(isPropertyAnimatable("camera", "x"), true);
});
