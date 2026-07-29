import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeleteTemplateFromKeyboard } from "../src/components/templateDeleteShortcut";

test("template deletion is scoped to keyboard focus inside the Templates panel", () => {
  assert.equal(shouldDeleteTemplateFromKeyboard({
    key: "Delete",
    hasSelection: true,
    targetInsideTemplatesPanel: true,
    targetIsEditable: false
  }), true);

  assert.equal(shouldDeleteTemplateFromKeyboard({
    key: "Delete",
    hasSelection: true,
    targetInsideTemplatesPanel: false,
    targetIsEditable: false
  }), false, "Delete from Material Manager must not remove the selected scene");
});

test("template deletion ignores inputs, handled events, other keys, and no selection", () => {
  const base = {
    key: "Delete",
    hasSelection: true,
    targetInsideTemplatesPanel: true,
    targetIsEditable: false
  };
  assert.equal(shouldDeleteTemplateFromKeyboard({ ...base, targetIsEditable: true }), false);
  assert.equal(shouldDeleteTemplateFromKeyboard({ ...base, defaultPrevented: true }), false);
  assert.equal(shouldDeleteTemplateFromKeyboard({ ...base, key: "Backspace" }), false);
  assert.equal(shouldDeleteTemplateFromKeyboard({ ...base, hasSelection: false }), false);
});
