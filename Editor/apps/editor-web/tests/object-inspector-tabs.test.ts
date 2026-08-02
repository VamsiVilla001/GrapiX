import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  objectInspectorTabsFor,
  objectInspectorTitle
} from "../src/modules/object-inspector/services/objectInspectorTabs";

function objectOfType(type: SceneObject["type"]): SceneObject {
  return { id: "object-1", name: "Object 1", type } as SceneObject;
}

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
