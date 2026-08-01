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
  for (const type of ["text", "rect", "mesh", "camera", "light", "layer", "group"] as const) {
    const tabs = objectInspectorTabsFor(objectOfType(type))!.tabs;
    assert.deepEqual(
      [...new Set(tabs)],
      tabs,
      `${type} offers a repeated tab name, which cannot be selected`
    );
  }
});

test("a text object keeps Materials and Data Binding beside its type tab", () => {
  assert.deepEqual(objectInspectorTabsFor(objectOfType("text"))!.tabs, [
    "Text",
    "Materials",
    "Data Binding"
  ]);
});

test("scene furniture is not offered surfaces it does not have", () => {
  assert.deepEqual(objectInspectorTabsFor(objectOfType("camera"))!.tabs, ["Camera"]);
  assert.deepEqual(objectInspectorTabsFor(objectOfType("light"))!.tabs, ["Light"]);
  assert.equal(objectInspectorTabsFor(objectOfType("line"))!.tabs.includes("Materials"), false);
});
