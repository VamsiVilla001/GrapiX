import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PREFERENCES,
  NAME_WIDTH_MAX,
  NAME_WIDTH_MIN,
  clampNameWidth,
  parsePreferences,
  serialisePreferences
} from "../src/modules/object-manager/services/objectManagerPreferences";

/**
 * Reading a stored payload written by a previous build.
 *
 * Every field is validated on its own, because a payload can be partly stale — a column this build
 * dropped, a width from a since-changed clamp — and one bad value must not throw the others away.
 * Nothing in this panel persisted at all before: the comment claimed columns were "remembered", but
 * `uiStore` has no persistence, so they survived a re-dock and died on refresh.
 */

test("an absent or unusable payload falls back to the defaults", () => {
  for (const raw of [null, undefined, 0, "", "not json", [], true]) {
    assert.deepEqual(parsePreferences(raw), DEFAULT_PREFERENCES, JSON.stringify(raw));
  }
});

test("a stored set is kept and re-sorted into catalogue order", () => {
  const parsed = parsePreferences({ columns: ["y", "opacity", "scaleX"], columnMode: "custom", nameWidth: 240 });
  assert.deepEqual(parsed.columns, ["opacity", "y", "scaleX"], "catalogue order, not stored order");
  assert.equal(parsed.nameWidth, 240);
});

test("a column this build no longer has is dropped, not rendered", () => {
  // Rendering it would leave a permanent blank stripe down the grid.
  const parsed = parsePreferences({ columns: ["opacity", "skewX", "y"] });
  assert.deepEqual(parsed.columns, ["opacity", "y"]);
});

test("a non-string in the column list is ignored rather than poisoning the set", () => {
  const parsed = parsePreferences({ columns: ["opacity", 7, null, "x"] });
  assert.deepEqual(parsed.columns, ["opacity", "x"]);
});

test("an unknown column mode falls back rather than rendering an undefined rule", () => {
  assert.equal(parsePreferences({ columnMode: "sideways" }).columnMode, "custom");
  for (const mode of ["all", "keyframed", "custom"]) {
    assert.equal(parsePreferences({ columnMode: mode }).columnMode, mode);
  }
});

test("the name width is clamped on read, so an out-of-range stored value cannot break the layout", () => {
  assert.equal(parsePreferences({ nameWidth: 4000 }).nameWidth, NAME_WIDTH_MAX);
  assert.equal(parsePreferences({ nameWidth: 10 }).nameWidth, NAME_WIDTH_MIN);
  assert.equal(parsePreferences({ nameWidth: "240" }).nameWidth, DEFAULT_PREFERENCES.nameWidth, "wrong type");
});

test("clamping refuses a value that is not a finite number", () => {
  assert.equal(clampNameWidth(Number.NaN), DEFAULT_PREFERENCES.nameWidth);
  assert.equal(clampNameWidth(Number.POSITIVE_INFINITY), DEFAULT_PREFERENCES.nameWidth);
  assert.equal(clampNameWidth(200.6), 201, "rounded to whole pixels");
});

test("a round trip keeps exactly the three preference fields", () => {
  const written = serialisePreferences({ columns: ["x"], columnMode: "keyframed", nameWidth: 300 });
  assert.deepEqual(Object.keys(JSON.parse(written)).sort(), ["columnMode", "columns", "nameWidth"]);
  assert.deepEqual(parsePreferences(JSON.parse(written)), { columns: ["x"], columnMode: "keyframed", nameWidth: 300 });
});

test("collapse is deliberately not part of the payload", () => {
  // Session-scoped: it survives a re-dock, not a reload. Persisting it would mean keeping a map of
  // scene ids to node ids and pruning stale entries on every projection.
  const written = JSON.parse(serialisePreferences({ columns: [], columnMode: "all", nameWidth: 180 }));
  assert.equal("collapsedIds" in written, false);
});
