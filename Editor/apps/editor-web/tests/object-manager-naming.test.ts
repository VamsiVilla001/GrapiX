import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import { normalizeLayerId } from "../src/store/layerIds";
import {
  layerRenameError,
  objectRenameError
} from "../src/modules/object-manager/services/objectManagerNaming";

/**
 * Predicting a rename collision, so it can be shown inline instead of raised as a modal.
 *
 * The old path lied twice and then blocked the app: the input was seeded with the raw slug while the
 * band displayed Title Case, and the `window.alert` quoted the raw draft while the store decided the
 * collision on the **normalised** id. So "Lower Third" collided with "lower third" and the message
 * named neither culprit.
 */

function object(id: string, name: string, layerId = "main"): SceneObject {
  return { id, name, layerId, type: "rect", bindings: {}, materialSlots: {} } as unknown as SceneObject;
}

const scene = () => [
  object("a", "Plate", "main"),
  object("b", "Strap", "lower-third"),
  object("c", "Logo", "background")
];

test("a band id is the store's slug: lower case, hyphenated, trimmed", () => {
  assert.equal(normalizeLayerId("  Lower Third  "), "lower-third");
  assert.equal(normalizeLayerId("Layer #2!"), "layer-2");
  assert.equal(normalizeLayerId("---odd---"), "odd");
});

test("names differing only in case or punctuation are the same band", () => {
  // The case the alert could not explain.
  const error = layerRenameError(scene(), "background", "Lower Third");
  assert.ok(error);
  assert.match(error, /lower-third/, "the slug is named, because that is what collided");

  assert.ok(layerRenameError(scene(), "background", "lower third"));
  assert.ok(layerRenameError(scene(), "background", "LOWER-THIRD"));
});

test("renaming a band to its own current id is not a collision", () => {
  assert.equal(layerRenameError(scene(), "lower-third", "Lower Third"), null);
});

test("a free name is accepted", () => {
  assert.equal(layerRenameError(scene(), "background", "Sponsor Bar"), null);
});

test("an empty draft is a cancel, not an error", () => {
  assert.equal(layerRenameError(scene(), "background", "   "), null);
});

test("a draft with no letters or numbers is refused with a reason", () => {
  const error = layerRenameError(scene(), "background", "---");
  assert.ok(error);
  assert.match(error, /at least one letter or number/);
});

test("an object rename collides case-insensitively, matching the store", () => {
  const error = objectRenameError(scene(), "a", "logo");
  assert.ok(error);
  assert.match(error, /Logo/, "the existing name is quoted as the author wrote it");
});

test("renaming an object to its own name is not a collision", () => {
  assert.equal(objectRenameError(scene(), "a", "Plate"), null);
  assert.equal(objectRenameError(scene(), "a", "  Plate  "), null, "surrounding space is not a difference");
});

test("a free object name is accepted, and an empty draft is a cancel", () => {
  assert.equal(objectRenameError(scene(), "a", "Score"), null);
  assert.equal(objectRenameError(scene(), "a", ""), null);
});
