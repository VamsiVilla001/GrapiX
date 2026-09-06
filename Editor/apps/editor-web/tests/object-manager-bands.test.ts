import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import { bandAggregate } from "../src/modules/object-manager/services/objectManagerBands";
import { expandSearchMatches } from "../src/modules/object-manager/services/objectSearch";

/**
 * What a band's header says about the band.
 *
 * The regression this pins: the panel reduced these over its *search-filtered* rows, while the eye
 * and the lock write every object in the layer. Under an active search the header therefore reported
 * one thing and did another — the class of defect where the control is not lying about itself but
 * about its subject.
 */

function object(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: id,
    type: "rect",
    layerId: "main",
    visible: true,
    locked: false,
    bindings: {},
    materialSlots: {},
    ...overrides
  } as unknown as SceneObject;
}

test("a band counts its own objects and no others", () => {
  const objects = [object("a"), object("b"), object("c", { layerId: "lower" })];
  assert.equal(bandAggregate(objects, "main").count, 2);
  assert.equal(bandAggregate(objects, "lower").count, 1);
});

test("an object with no layerId belongs to main", () => {
  const objects = [object("a", { layerId: "" } as Partial<SceneObject>)];
  assert.equal(bandAggregate(objects, "main").count, 1);
});

test("a band is visible when anything in it is", () => {
  const objects = [object("a", { visible: false }), object("b", { visible: true })];
  assert.equal(bandAggregate(objects, "main").visible, true);
  assert.equal(bandAggregate([object("a", { visible: false })], "main").visible, false);
});

test("a band is locked only when everything in it is", () => {
  assert.equal(bandAggregate([object("a", { locked: true }), object("b", { locked: false })], "main").locked, false);
  assert.equal(bandAggregate([object("a", { locked: true }), object("b", { locked: true })], "main").locked, true);
});

test("an empty band is not locked", () => {
  // `every` on an empty list is true, which would show a lock on a band holding nothing.
  assert.equal(bandAggregate([], "main").locked, false);
  assert.equal(bandAggregate([object("a", { layerId: "other" })], "main").locked, false);
});

test("the aggregate ignores the search, which is the whole point", () => {
  const objects = [
    object("plate", { name: "Plate", locked: true }),
    object("strap", { name: "Strap", locked: false })
  ];
  // A search that shows only the locked object.
  const visible = expandSearchMatches(objects, "plate");
  assert.deepEqual([...visible], ["plate"]);

  // Aggregating over the *filtered* rows would report the band as fully locked and then unlock every
  // object in it — the header describing one set and acting on another.
  const filtered = objects.filter((object) => visible.has(object.id));
  assert.equal(bandAggregate(filtered, "main").locked, true, "what the old code saw");
  assert.equal(bandAggregate(objects, "main").locked, false, "what the action actually affects");
});
