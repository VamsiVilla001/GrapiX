// 11.105 and 11.102: the stylesheet rules the viewport's view and the tool ribbon rely on. Vitest does not load CSS, so the
// text is read here. A rule that went missing would not fail a type check: the picture would just spill out of the pane,
// or the hand would not look like a hand.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../../Editor/web/style.css", import.meta.url)), "utf8");

test("the view is clipped to the pasteboard and moves about the middle of the surface", () => {
  assert.match(css, /\.viewport-stage \{ overflow: hidden; \}/);
  assert.match(css, /\.viewport-surface \{ transform-origin: 50% 50%;/);
});

test("each tool shows its own pointer, and the hand closes while it pans", () => {
  for (const [tool, cursor] of [["hand", "grab"], ["zoom", "zoom-in"], ["pen", "crosshair"], ["pivot", "crosshair"], ["move", "move"], ["rotate", "crosshair"], ["scale", "nwse-resize"]]) {
    assert.ok(css.includes(`#viewport-overlay[data-tool="${tool}"] { cursor: ${cursor}; }`), `${tool} has ${cursor}`);
  }
  assert.match(css, /#viewport-overlay\[data-panning="true"\] \{ cursor: grabbing; \}/);
});

test("the ribbon shows which tool is in use and dims what cannot run", () => {
  assert.match(css, /\.creation-tools button\[aria-pressed="true"\] \{/);
  assert.match(css, /\.creation-tools button\.menu-refused \{ opacity: 0\.45; \}/);
  assert.match(css, /\.viewer-footer button\.menu-refused \{ opacity: 0\.45; \}/);
});

test("the Pivot panel's grid has nine cells and a lit one", () => {
  assert.match(css, /\.pivot-grid \{ display: grid; grid-template-columns: repeat\(3, \d+px\);/);
  assert.match(css, /\.pivot-grid button\[aria-pressed="true"\] \{/);
});
