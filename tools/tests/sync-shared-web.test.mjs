// The shared web files are one source copied into both apps (build plan 2.27):
// a copy that was edited, or never made, is named so the build fails on it.

import assert from "node:assert/strict";
import test from "node:test";

import { drift, generated, plan } from "../sync-shared-web.mjs";

const SOURCES = [{ name: "panel.js", source: "export const a = 1;\r\n" }];

test("each source is planned for Playout (the Editor has no live telemetry) under a generated header, with LF endings", () => {
  const copies = plan(SOURCES);
  assert.deepEqual(copies.map(([path]) => path), ["Playout/web/panel.js"]);
  assert.ok(copies[0][1].startsWith("// GENERATED from Shared/web-panels/panel.js"));
  assert.ok(copies[0][1].endsWith("export const a = 1;\n"));
});

test("a copy that matches is no drift, whatever its line endings", () => {
  const expected = plan(SOURCES);
  const files = new Map(expected.map(([path, text]) => [path, text.replace(/\n/g, "\r\n")]));
  assert.deepEqual(drift(expected, (path) => files.get(path)), []);
});

test("a missing copy and an edited copy are each named", () => {
  const expected = plan(SOURCES);
  assert.deepEqual(drift(expected, () => undefined), [["Playout/web/panel.js", "missing"]]);
  const files = new Map([["Playout/web/panel.js", generated("panel.js", "export const a = 2;\n")]]);
  assert.deepEqual(drift(expected, (path) => files.get(path)), [["Playout/web/panel.js", "edited"]]);
});
