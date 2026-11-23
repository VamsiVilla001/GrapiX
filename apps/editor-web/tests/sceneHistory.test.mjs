import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import ts from "typescript";

// Compile this pure TypeScript module for Node without importing the editor UI.
// Its shared-types import is type-only, so the emitted JavaScript is standalone.
const source = readFileSync(new URL("../src/store/sceneHistory.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { SceneHistory } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

function scene() {
  return {
    id: "scene-1",
    name: "Test",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: { score: 0 },
    assets: [],
    materials: [],
    objects: [{ id: "object-a", x: 0, y: 0, visible: true }],
    timeline: { fps: 60, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function moved(before, x) {
  return { ...before, objects: before.objects.map((o) => ({ ...o, x })) };
}

test("Undo and Redo recover exact scene content and selected object", () => {
  const a = scene(), b = moved(a, 200), c = moved(b, 300);
  const h = new SceneHistory(a, null);
  h.record(a, b, null, "object-a");
  h.record(b, c, "object-a", "object-a");
  assert.equal(h.info().currentIndex, 2);
  assert.deepEqual(h.undo().scene, b);
  assert.equal(h.undo().selectedObjectId, null);
  assert.deepEqual(h.redo().scene, b);
  assert.deepEqual(h.redo().scene, c);
  assert.equal(h.redo(), null);
});

test("Multiple drag updates become a single gesture step", () => {
  const a = scene();
  const h = new SceneHistory(a, "object-a");
  h.begin(a, "object-a", "Move Object");
  let last = a;
  for (const x of [10, 20, 30, 40]) {
    const next = moved(last, x);
    h.record(last, next, "object-a", "object-a");
    last = next;
  }
  assert.equal(h.info().totalStates, 1);
  h.end(last, "object-a");
  assert.equal(h.info().totalStates, 2);
  assert.equal(h.info().undoLabel, "Move Object");
  assert.deepEqual(h.undo().scene, a);
});

test("No-op changes and updatedAt-only changes add no history", () => {
  const a = scene();
  const h = new SceneHistory(a, null);
  assert.equal(h.record(a, { ...a, updatedAt: "later" }, null, null), false);
  assert.equal(h.record(a, structuredClone(a), null, null), false);
  assert.equal(h.info().totalStates, 1);
});

test("New edit after Undo clears Redo, but not the current document state", () => {
  const a = scene(), b = moved(a, 20), c = moved(b, 40), d = moved(b, 90);
  const h = new SceneHistory(a, null);
  h.record(a, b, null, null);
  h.record(b, c, null, null);
  assert.deepEqual(h.undo().scene, b);
  h.record(b, d, null, null);
  assert.equal(h.info().canRedo, false);
  assert.equal(h.redo(), null);
  assert.deepEqual(h.undo().scene, b);
});

test("Can jump precisely to a retained history point", () => {
  const a = scene(), b = moved(a, 20), c = moved(b, 40);
  const h = new SceneHistory(a, null);
  h.record(a, b, null, null);
  h.record(b, c, null, null);
  const id = h.info().entries[0].id;
  assert.deepEqual(h.goTo(id).scene, a);
  assert.equal(h.info().canRedo, true);
  assert.equal(h.goTo(-123), null);
  assert.deepEqual(h.redo().scene, b);
});

test("History caps old checkpoints, while preserving the latest undo steps", () => {
  const a = scene();
  const h = new SceneHistory(a, null, 2);
  let previous = a;
  for (const x of [1, 2, 3, 4]) {
    const next = moved(previous, x);
    h.record(previous, next, null, null);
    previous = next;
  }
  assert.equal(h.info().totalStates, 3);
  assert.equal(h.undo().scene.objects[0].x, 3);
  assert.equal(h.undo().scene.objects[0].x, 2);
  assert.equal(h.undo(), null);
});

test("Reset clears old history, transaction and redo states", () => {
  const a = scene(), b = moved(a, 10);
  const h = new SceneHistory(a, null);
  h.record(a, b, null, null);
  h.begin(b, null, "Edit Field");
  h.reset(a, null);
  assert.equal(h.info().totalStates, 1);
  assert.equal(h.hasTransaction(), false);
  assert.equal(h.undo(), null);
});

test("A field blur must not terminate an unrelated canvas gesture", () => {
  const a = scene(), b = moved(a, 5);
  const h = new SceneHistory(a, null);
  h.begin(a, null, "Edit Field");
  h.begin(a, null, "Move Object");
  assert.equal(h.end(b, null, "Edit Field"), false);
  assert.equal(h.hasTransaction(), true);
  assert.equal(h.end(b, null, "Move Object"), true);
  assert.equal(h.info().totalStates, 2);
});
