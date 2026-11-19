// The Scene Manager list view's keyboard rules (11.72).
import { describe, expect, it } from "vitest";
import { createDeleteArm, DELETE_ARM_MS, moveRow, rowCommand } from "../src/scene-list-nav";

const ids = ["scene/a", "scene/b", "scene/c"];

describe("moving between rows", () => {
  it("steps down and up and stops at the ends", () => {
    expect(moveRow(ids, "scene/a", "ArrowDown")).toBe("scene/b");
    expect(moveRow(ids, "scene/c", "ArrowDown")).toBe("scene/c");
    expect(moveRow(ids, "scene/b", "ArrowUp")).toBe("scene/a");
    expect(moveRow(ids, "scene/a", "ArrowUp")).toBe("scene/a");
  });

  it("starts at the first row when nothing is focused, and Home / End jump", () => {
    expect(moveRow(ids, undefined, "ArrowDown")).toBe("scene/a");
    expect(moveRow(ids, undefined, "ArrowUp")).toBe("scene/a");
    expect(moveRow(ids, "scene/b", "Home")).toBe("scene/a");
    expect(moveRow(ids, "scene/b", "End")).toBe("scene/c");
  });

  it("does nothing for other keys, an unknown row or an empty list", () => {
    expect(moveRow(ids, "scene/a", "x")).toBeUndefined();
    expect(moveRow([], "scene/a", "ArrowDown")).toBeUndefined();
    expect(moveRow(ids, "scene/gone", "ArrowDown")).toBe("scene/a");
  });
});

describe("what a key does to the focused row", () => {
  it("opens on Enter, deletes on Delete and opens the menu on the menu key or Shift+F10", () => {
    expect(rowCommand("Enter")).toBe("open");
    expect(rowCommand("Delete")).toBe("delete");
    expect(rowCommand("ContextMenu")).toBe("menu");
    expect(rowCommand("F10", true)).toBe("menu");
    expect(rowCommand("F10")).toBeUndefined();
    expect(rowCommand("a")).toBeUndefined();
  });
});

describe("Delete takes two presses on the same row", () => {
  it("the first press arms, the second within the window deletes", () => {
    const arm = createDeleteArm();
    expect(arm.press("scene/a", 1000)).toBe(false);
    expect(arm.armed()).toBe("scene/a");
    expect(arm.press("scene/a", 1000 + DELETE_ARM_MS)).toBe(true);
    expect(arm.armed()).toBeUndefined();
  });

  it("a second press after the window only re-arms", () => {
    const arm = createDeleteArm();
    arm.press("scene/a", 0);
    expect(arm.press("scene/a", DELETE_ARM_MS + 1)).toBe(false);
    expect(arm.armed()).toBe("scene/a");
  });

  it("a press on another row moves the arming and deletes nothing", () => {
    const arm = createDeleteArm();
    arm.press("scene/a", 0);
    expect(arm.press("scene/b", 10)).toBe(false);
    expect(arm.armed()).toBe("scene/b");
    expect(arm.press("scene/a", 20)).toBe(false);
  });

  it("disarm cancels", () => {
    const arm = createDeleteArm();
    arm.press("scene/a", 0);
    arm.disarm();
    expect(arm.press("scene/a", 10)).toBe(false);
  });
});
