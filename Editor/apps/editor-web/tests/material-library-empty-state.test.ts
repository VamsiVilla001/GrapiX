/**
 * Why the asset library is empty.
 *
 * Four different situations used to wear one sentence — "No assets match the current search and
 * filter" — including the two that have nothing to do with filtering. An author whose project
 * service had restarted was told their filter was too narrow; clearing it changed nothing, because
 * the real answer was that the read had failed. An empty panel has to say which of these it is or
 * it sends people looking in the wrong place.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { emptyLibraryMessage } from "../src/modules/material-manager/components/MaterialLibrary";

test("a failed read says so, and says the list may be stale", () => {
  const message = emptyLibraryMessage("error", "Could not read the project's assets.", true);
  assert.match(message, /Could not read the project's assets/);
  assert.match(message, /out of date/, "the author needs to know what they are looking at");
  assert.doesNotMatch(message, /search and filter/, "a failed read is not a filtering problem");
});

/** A failure with no message still explains itself rather than rendering "null". */
test("a failed read with no detail still explains itself", () => {
  const message = emptyLibraryMessage("error", null, true);
  assert.match(message, /could not be read/);
  assert.doesNotMatch(message, /null|undefined/);
});

test("a session with no project is told what to do about it", () => {
  const message = emptyLibraryMessage("ready", null, false);
  assert.match(message, /Save the project to a folder/);
  assert.doesNotMatch(message, /search and filter/, "there is nothing to filter yet");
});

test("a load in flight says it is reading rather than that there is nothing", () => {
  assert.match(emptyLibraryMessage("loading", null, true), /Reading/);
});

/** The original message survives for the case it was actually written for. */
test("an open project with assets filtered out is a filtering problem", () => {
  assert.equal(
    emptyLibraryMessage("ready", null, true),
    "No assets match the current search and filter."
  );
});
