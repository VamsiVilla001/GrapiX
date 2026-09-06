import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  objectInspectorTabIndex,
  objectInspectorTabsFor,
  objectInspectorTitle
} from "../src/modules/object-inspector/services/objectInspectorTabs";
import { isMaterialSurface } from "../src/modules/object-inspector/services/inspectorControls";

function objectOfType(type: SceneObject["type"]): SceneObject {
  return { id: "object-1", name: "Object 1", type } as SceneObject;
}

const ALL_TYPES = [
  "text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh", "light", "camera",
  "layer", "marker", "group"
] as const;

test("no object means no tab strip", () => {
  assert.equal(objectInspectorTabsFor(null), null);
});

test("the leading tab is the object's own kind", () => {
  assert.equal(objectInspectorTabsFor(objectOfType("rect"))!.tabs[0], "Quad");
  assert.equal(objectInspectorTabsFor(objectOfType("mesh"))!.tabs[0], "Mesh");
  assert.equal(objectInspectorTitle("Lower third", objectOfType("rect")),
    "Object Inspector - Lower third - Quad Object");
});

test("tab names are unique, so every tab in the strip can be selected", () => {
  for (const type of [
    "text", "rect", "ellipse", "image", "line", "shape", "paint",
    "mesh", "light", "camera", "layer", "marker", "group"
  ] as const) {
    const tabs = objectInspectorTabsFor(objectOfType(type))!.tabs;
    assert.deepEqual(
      [...new Set(tabs)],
      tabs,
      `${type} offers a repeated tab name, which cannot be selected`
    );
  }
});

test("a text object keeps dedicated Transform, Materials and Data Binding tabs", () => {
  assert.deepEqual(objectInspectorTabsFor(objectOfType("text"))!.tabs, [
    "Text",
    "Transform",
    "Materials",
    "Data Binding"
  ]);
});

test("scene furniture gets only the controls it can use", () => {
  assert.deepEqual(objectInspectorTabsFor(objectOfType("camera"))!.tabs, ["Camera", "Transform"]);
  assert.deepEqual(objectInspectorTabsFor(objectOfType("light"))!.tabs, ["Light", "Transform"]);
  assert.deepEqual(objectInspectorTabsFor(objectOfType("marker"))!.tabs, ["Marker"]);
  assert.equal(objectInspectorTabsFor(objectOfType("line"))!.tabs.includes("Materials"), false);
});

test("a brush layer is not a material surface, for the same reason a line is not", () => {
  // A paint layer draws every stroke from its own colour, opacity and flow, and `sceneMaterial`
  // excludes paint from face resolution — so a Materials tab here offered a binding that changed
  // nothing on screen. `line` was already excluded on the same grounds.
  const paintTabs = objectInspectorTabsFor(objectOfType("paint"))!.tabs;
  assert.equal(paintTabs.includes("Materials"), false);
  assert.deepEqual(paintTabs, ["Paint", "Transform", "Data Binding"]);
});

test("the types whose pixels a material reaches still have the tab", () => {
  for (const type of ["text", "rect", "ellipse", "image", "shape", "mesh"] as const) {
    assert.ok(
      objectInspectorTabsFor(objectOfType(type))!.tabs.includes("Materials"),
      `${type} should keep its Materials tab`
    );
  }
});

test("the material-surface predicate and the tab descriptors cannot disagree", () => {
  // One definition. The Inspector's quick-field filter used to keep its own set, and both admitted
  // paint; this asserts the descriptors now follow the shared predicate exactly.
  for (const type of ALL_TYPES) {
    const hasTab = objectInspectorTabsFor(objectOfType(type))!.tabs.includes("Materials");
    assert.equal(hasTab, isMaterialSurface(type), `${type}: tab ${hasTab} vs predicate ${isMaterialSurface(type)}`);
  }
});

test("the tab strip owns only arrow, Home and End navigation", () => {
  assert.equal(objectInspectorTabIndex(0, 4, "ArrowRight"), 1);
  assert.equal(objectInspectorTabIndex(3, 4, "ArrowRight"), 0);
  assert.equal(objectInspectorTabIndex(0, 4, "ArrowLeft"), 3);
  assert.equal(objectInspectorTabIndex(2, 4, "ArrowUp"), 1);
  assert.equal(objectInspectorTabIndex(2, 4, "ArrowDown"), 3);
  assert.equal(objectInspectorTabIndex(2, 4, "Home"), 0);
  assert.equal(objectInspectorTabIndex(1, 4, "End"), 3);
  assert.equal(objectInspectorTabIndex(1, 4, "Tab"), null);
  assert.equal(objectInspectorTabIndex(1, 4, "Enter"), null);
  assert.equal(objectInspectorTabIndex(1, 4, "Escape"), null);
});

test("tab navigation refuses an empty strip or an invalid active index", () => {
  assert.equal(objectInspectorTabIndex(0, 0, "ArrowRight"), null);
  assert.equal(objectInspectorTabIndex(-1, 4, "ArrowRight"), null);
  assert.equal(objectInspectorTabIndex(4, 4, "ArrowLeft"), null);
});
