import assert from "node:assert/strict";
import test from "node:test";
import {
  describeHistoryStep,
  isSaveShortcut,
  isTextEntryTarget,
  resolveHistoryIntent
} from "../src/lib/historyShortcut";

/**
 * Which key presses are history commands, and which are deliberately not.
 *
 * The refusals matter more than the acceptances: stealing Ctrl+Z from a text field would make typing
 * feel broken *and* silently revert a finished scene edit, and claiming an Alt chord would fight the
 * assistant and the diagnostics console, which own Ctrl+Alt+A and Ctrl+Alt+C.
 */

/** A stand-in for the parts of a KeyboardEvent the resolver reads. */
const press = (key: string, modifiers: Record<string, boolean> = {}, target: unknown = null) => ({
  key,
  target: target as EventTarget | null,
  ...modifiers
});

const element = (tagName: string, contentEditable = false) => ({
  tagName,
  isContentEditable: contentEditable
});

test("Ctrl+Z undoes and Ctrl+Shift+Z redoes", () => {
  assert.equal(resolveHistoryIntent(press("z", { ctrlKey: true })), "undo");
  assert.equal(resolveHistoryIntent(press("z", { ctrlKey: true, shiftKey: true })), "redo");
});

test("Meta is Ctrl, so the same chords work on macOS", () => {
  assert.equal(resolveHistoryIntent(press("z", { metaKey: true })), "undo");
  assert.equal(resolveHistoryIntent(press("z", { metaKey: true, shiftKey: true })), "redo");
});

test("Ctrl+Y also redoes, because Windows authors reach for it", () => {
  assert.equal(resolveHistoryIntent(press("y", { ctrlKey: true })), "redo");
  assert.equal(resolveHistoryIntent(press("y", { ctrlKey: true, shiftKey: true })), null);
});

test("an upper-case Z from a held Shift still resolves", () => {
  assert.equal(resolveHistoryIntent(press("Z", { ctrlKey: true, shiftKey: true })), "redo");
});

test("a bare Z is not a history command", () => {
  assert.equal(resolveHistoryIntent(press("z")), null);
  assert.equal(resolveHistoryIntent(press("z", { shiftKey: true })), null);
});

test("an Alt chord belongs to the assistant and the console, not to history", () => {
  assert.equal(resolveHistoryIntent(press("z", { ctrlKey: true, altKey: true })), null);
});

test("text-entry targets keep the browser's own text undo", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(
      resolveHistoryIntent(press("z", { ctrlKey: true }, element(tag))),
      null,
      `${tag} must keep native undo`
    );
  }
  assert.equal(resolveHistoryIntent(press("z", { ctrlKey: true }, element("DIV", true))), null);
});

test("a plain element is not a text-entry target", () => {
  assert.equal(isTextEntryTarget(element("DIV") as unknown as EventTarget), false);
  assert.equal(isTextEntryTarget(null), false);
  assert.equal(resolveHistoryIntent(press("z", { ctrlKey: true }, element("DIV"))), "undo");
});

test("a step is described with its module and its label", () => {
  const labels = { "scene-manager": "Object Manager" };
  assert.equal(
    describeHistoryStep("Undo", { label: "Delete 3 objects", scope: "scene-manager" }, labels),
    "Undo Object Manager · Delete 3 objects"
  );
});

test("an unknown scope is named as itself rather than hidden", () => {
  assert.equal(
    describeHistoryStep("Redo", { label: "Edit object", scope: "mystery" }, {}),
    "Redo mystery · Edit object"
  );
});

test("a step with no label still says something useful", () => {
  assert.equal(describeHistoryStep("Undo", { scope: "canvas" }, { canvas: "Canvas" }), "Undo change in Canvas");
  assert.equal(describeHistoryStep("Undo", { label: "Move object" }), "Undo Move object");
  assert.equal(describeHistoryStep("Undo", {}), "Undo");
});

test("an empty history says so instead of offering a command", () => {
  assert.equal(describeHistoryStep("Undo", undefined), "Nothing to undo");
  assert.equal(describeHistoryStep("Redo", undefined), "Nothing to redo");
});

/* ── Save ─────────────────────────────────────────────────────────────────────────────────── */

/** A keyboard event, as much of one as the predicate reads. */
function keyEvent(overrides: Partial<KeyboardEvent> & { key: string }) {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

test("Ctrl+S and Cmd+S both mean save", () => {
  assert.equal(isSaveShortcut(keyEvent({ key: "s", ctrlKey: true })), true);
  assert.equal(isSaveShortcut(keyEvent({ key: "s", metaKey: true })), true);
  assert.equal(isSaveShortcut(keyEvent({ key: "S", ctrlKey: true })), true, "caps lock still saves");
});

test("a bare S does not save", () => {
  assert.equal(isSaveShortcut(keyEvent({ key: "s" })), false);
  assert.equal(isSaveShortcut(keyEvent({ key: "a", ctrlKey: true })), false);
});

/**
 * Save As does not exist yet. Claiming its chord would make a real command look implemented while
 * doing nothing, which is worse than letting the browser have it.
 */
test("Ctrl+Shift+S is left alone until Save As exists", () => {
  assert.equal(isSaveShortcut(keyEvent({ key: "s", ctrlKey: true, shiftKey: true })), false);
});

/** Alt chords belong to the assistant and console toggles. */
test("an Alt chord is not save", () => {
  assert.equal(isSaveShortcut(keyEvent({ key: "s", ctrlKey: true, altKey: true })), false);
});

/**
 * Unlike undo, save is a document command: an author who has just typed a headline and reaches for
 * Ctrl+S means save the scene. `isSaveShortcut` reads no target, so a text field cannot suppress it.
 */
test("save does not defer to a text field the way undo does", () => {
  assert.equal(isSaveShortcut(keyEvent({ key: "s", ctrlKey: true })), true);
  assert.equal(
    resolveHistoryIntent({
      key: "z",
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      target: { tagName: "INPUT", isContentEditable: false }
    } as unknown as KeyboardEvent),
    null,
    "undo still defers, so the two rules are genuinely different"
  );
});
