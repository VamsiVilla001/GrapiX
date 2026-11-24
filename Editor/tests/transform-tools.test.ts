// The drag tools (11.102): Move, Rotate and Scale. Each is held as hard on what it refuses as on what it moves:
// a refusal sends nothing, and a drag that changes nothing sends nothing.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { isRefused } from "../src/inspector";
import {
  MIN_RADIUS,
  MIN_SCALE,
  TOOL_FIELDS,
  beginToolDrag,
  previewDocument,
  toolDragChanges,
  toolDragEdits,
  toolDragLabel,
  type ToolDrag,
} from "../src/transform-tools";

function rect(id: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): SceneObject {
  return {
    type: "rect", id, name: id, visible: true, locked: false, opacity: 1, x, y, zDepth: 0, zIndex: 0, layerId: "",
    width, height, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0, radius: 0,
    ...extra,
  } as unknown as SceneObject;
}

function group(id: string, childIds: string[], extra: Record<string, unknown> = {}): SceneObject {
  return { ...rect(id, 0, 0, 0, 0, extra), type: "group", childIds } as unknown as SceneObject;
}

function scene(objects: SceneObject[], channels: { objectId: string; property: string; keys: unknown[] }[] = []): SceneDocument {
  return {
    id: "s", name: "S", version: 4,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    objects,
    timeline: { channels, phases: [], pathChannels: [] },
  } as unknown as SceneDocument;
}

const at = (x: number, y: number) => ({ x, y });
const NO_MODS = { shift: false };
const SHIFT = { shift: true };

function begin(tool: "move" | "rotate" | "scale" | "pivot", document: SceneDocument, ids: string[], start = at(0, 0)): ToolDrag {
  const drag = beginToolDrag(tool, document, ids, start);
  if (isRefused(drag)) throw new Error(`refused: ${drag.refused}`);
  return drag;
}

const values = (changes: ReturnType<typeof toolDragChanges>) => Object.fromEntries(changes.map((c) => [`${c.id}.${c.field}`, c.value]));

describe("starting a drag", () => {
  it("needs something selected", () => {
    const outcome = beginToolDrag("move", scene([rect("a", 0, 0, 10, 10)]), [], at(0, 0));
    expect(isRefused(outcome) && outcome.refused).toBe("Select an object first.");
  });

  it("ignores ids that are not in the document", () => {
    const outcome = beginToolDrag("move", scene([rect("a", 0, 0, 10, 10)]), ["gone"], at(0, 0));
    expect(isRefused(outcome) && outcome.refused).toBe("Select an object first.");
  });

  it("refuses a locked object by name", () => {
    const document = scene([rect("a", 0, 0, 10, 10, { locked: true }), rect("b", 0, 0, 10, 10)]);
    const outcome = beginToolDrag("move", document, ["a", "b"], at(0, 0));
    expect(isRefused(outcome) && outcome.refused).toBe("a is locked. Unlock it first; nothing was changed.");
    const both = beginToolDrag("move", scene([rect("a", 0, 0, 1, 1, { locked: true }), rect("b", 0, 0, 1, 1, { locked: true })]), ["a", "b"], at(0, 0));
    expect(isRefused(both) && both.refused).toBe("2 items are locked. Unlock them first; nothing was changed.");
  });

  it("refuses a property that has keys, for exactly the tools that change it", () => {
    const document = scene([rect("a", 0, 0, 10, 10)], [{ objectId: "a", property: "rotation", keys: [{ frame: 0 }] }]);
    expect(isRefused(beginToolDrag("rotate", document, ["a"], at(0, 0)))).toBe(true);
    const refused = beginToolDrag("rotate", document, ["a"], at(0, 0));
    expect(isRefused(refused) && refused.refused).toBe("a has keys on rotation. Change it with its keys in the timeline, so the animation is not left behind.");
    // Move does not touch rotation.
    expect(isRefused(beginToolDrag("move", document, ["a"], at(0, 0)))).toBe(false);
    // A channel with no keys is not an animation.
    expect(isRefused(beginToolDrag("rotate", scene([rect("a", 0, 0, 10, 10)], [{ objectId: "a", property: "rotation", keys: [] }]), ["a"], at(0, 0)))).toBe(false);
    // Another object's keys are not this object's.
    expect(isRefused(beginToolDrag("rotate", scene([rect("a", 0, 0, 10, 10), rect("b", 0, 0, 10, 10)], [{ objectId: "b", property: "rotation", keys: [{}] }]), ["a"], at(0, 0)))).toBe(false);
  });

  it("names the property that blocks each tool", () => {
    const keyed = (property: string) => scene([rect("a", 0, 0, 10, 10)], [{ objectId: "a", property, keys: [{}] }]);
    for (const [tool, fields] of Object.entries(TOOL_FIELDS)) {
      for (const field of fields) {
        const outcome = beginToolDrag(tool as "move", keyed(field), ["a"], at(0, 0));
        expect(isRefused(outcome), `${tool} with keys on ${field}`).toBe(true);
      }
    }
    // Written out, so a field dropped from the table is noticed: each tool and the properties it changes.
    const blocks: Record<string, string[]> = {
      move: ["x", "y"],
      rotate: ["rotation", "x", "y"],
      scale: ["scaleX", "scaleY", "x", "y"],
    };
    for (const [tool, fields] of Object.entries(blocks)) {
      for (const field of fields) expect(isRefused(beginToolDrag(tool as "move", keyed(field), ["a"], at(0, 0))), `${tool} with keys on ${field}`).toBe(true);
    }
    for (const field of ["opacity", "width", "rotationX"]) {
      for (const tool of ["move", "rotate", "scale"] as const) expect(isRefused(beginToolDrag(tool, keyed(field), ["a"], at(0, 0))), `${tool} with keys on ${field}`).toBe(false);
    }
    expect(isRefused(beginToolDrag("move", keyed("scaleX"), ["a"], at(0, 0)))).toBe(false);
    expect(isRefused(beginToolDrag("scale", keyed("rotation"), ["a"], at(0, 0)))).toBe(false);
  });

  it("moves an item in a plain group, and refuses it when a group above is turned or scaled", () => {
    const plain = scene([group("g", ["a"], { x: 50 }), rect("a", 10, 10, 10, 10)]);
    expect(isRefused(beginToolDrag("move", plain, ["a"], at(0, 0)))).toBe(false);
    for (const extra of [{ rotation: 10 }, { scaleX: 2 }, { scaleY: 0.5 }]) {
      const turned = scene([group("g", ["a"], extra), rect("a", 10, 10, 10, 10)]);
      const outcome = beginToolDrag("move", turned, ["a"], at(0, 0));
      expect(isRefused(outcome) && outcome.refused, JSON.stringify(extra)).toBe("a is inside a rotated or scaled group, so a move would go the wrong way. Select the group instead.");
    }
    // A group above that group counts too.
    const deep = scene([group("outer", ["inner"], { rotation: 5 }), group("inner", ["a"]), rect("a", 0, 0, 1, 1)]);
    expect(isRefused(beginToolDrag("move", deep, ["a"], at(0, 0)))).toBe(true);
  });

  it("turns and scales only items outside every group, and the group itself", () => {
    const document = scene([group("g", ["a"]), rect("a", 10, 10, 10, 10), rect("b", 0, 0, 5, 5)]);
    for (const tool of ["rotate", "scale"] as const) {
      const outcome = beginToolDrag(tool, document, ["a"], at(0, 0));
      expect(isRefused(outcome) && outcome.refused, tool).toContain("is inside a group");
      expect(isRefused(beginToolDrag(tool, document, ["g"], at(100, 100))), `${tool} the group`).toBe(false);
      expect(isRefused(beginToolDrag(tool, document, ["b"], at(100, 100))), `${tool} outside`).toBe(false);
    }
  });

  it("refuses an item in a locked group, naming both", () => {
    const document = scene([group("g", ["a"], { locked: true, name: "Lower third" }), rect("a", 10, 10, 10, 10)]);
    for (const tool of ["move", "rotate", "scale"] as const) {
      const outcome = beginToolDrag(tool, document, ["a"], at(100, 100));
      expect(isRefused(outcome) && outcome.refused, tool).toBe("a is in Lower third, which is locked. Unlock it first; nothing was changed.");
    }
    // A lock higher up counts too.
    const deep = scene([group("outer", ["inner"], { locked: true }), group("inner", ["a"]), rect("a", 0, 0, 1, 1)]);
    expect(isRefused(beginToolDrag("move", deep, ["a"], at(100, 100)))).toBe(true);
  });

  it("takes the middle from what is drawn, and the values from what is stored", () => {
    const stored = scene([rect("a", 0, 0, 100, 100)]);
    // At this frame the animation has the rectangle twice as wide: its middle is at 100, not 50.
    const drawn = scene([rect("a", 0, 0, 200, 100)]);
    const drag = begin("rotate", stored, ["a"], at(300, 50));
    expect(drag.centre).toEqual({ x: 50, y: 50 });
    const shown = beginToolDrag("rotate", stored, ["a"], at(300, 50), drawn);
    expect(isRefused(shown)).toBe(false);
    if (!isRefused(shown)) {
      expect(shown.centre).toEqual({ x: 100, y: 50 });
      expect(shown.items[0]).toMatchObject({ x: 0, y: 0, rotation: 0 });
    }
  });

  it("acts on the group, not on a child that is selected with it", () => {
    const document = scene([group("g", ["a"]), rect("a", 10, 10, 10, 10)]);
    const drag = begin("move", document, ["g", "a"]);
    expect(drag.items.map((item) => item.id)).toEqual(["g"]);
  });

  it("finds the middle of the selection from the boxes, and of a group from its own point", () => {
    const drag = begin("rotate", scene([rect("a", 0, 0, 100, 40), rect("b", 200, 100, 100, 100)]), ["a", "b"]);
    expect(drag.centre).toEqual({ x: 150, y: 100 });
    const lone = begin("rotate", scene([group("g", [], { x: 30, y: 40 })]), ["g"]);
    expect(lone.centre).toEqual({ x: 30, y: 40 });
  });
});

describe("Move", () => {
  const document = scene([rect("a", 100, 100, 50, 50), rect("b", 300, 200, 50, 50)]);

  it("shifts every selected item by the pointer's travel", () => {
    const drag = begin("move", document, ["a", "b"], at(10, 10));
    expect(values(toolDragChanges(drag, at(25, 4), NO_MODS))).toEqual({ "a.x": 115, "a.y": 94, "b.x": 315, "b.y": 194 });
  });

  it("keeps to the axis the pointer has gone furthest along with Shift", () => {
    const drag = begin("move", document, ["a"], at(0, 0));
    expect(values(toolDragChanges(drag, at(30, 10), SHIFT))).toEqual({ "a.x": 130 });
    expect(values(toolDragChanges(drag, at(10, -30), SHIFT))).toEqual({ "a.y": 70 });
    expect(values(toolDragChanges(drag, at(20, 20), SHIFT))).toEqual({ "a.x": 120 });
  });

  it("changes nothing when the pointer is back where it started", () => {
    const drag = begin("move", document, ["a"], at(10, 10));
    expect(toolDragChanges(drag, at(10, 10), NO_MODS)).toEqual([]);
  });

  it("sends only the field that changed", () => {
    const drag = begin("move", document, ["a"], at(0, 0));
    expect(values(toolDragChanges(drag, at(5, 0), NO_MODS))).toEqual({ "a.x": 105 });
  });

  it("moves a group by its own position, so its children go with it", () => {
    const grouped = scene([group("g", ["a"], { x: 10, y: 10 }), rect("a", 5, 5, 10, 10)]);
    const drag = begin("move", grouped, ["g", "a"], at(0, 0));
    expect(values(toolDragChanges(drag, at(7, 3), NO_MODS))).toEqual({ "g.x": 17, "g.y": 13 });
  });
});

describe("Rotate", () => {
  // A 100 x 100 box at the origin: its middle is (50, 50), its corner (0, 0) sits 70.7 away.
  const document = scene([rect("a", 0, 0, 100, 100)]);

  it("turns by the angle the pointer sweeps about the middle, and orbits the position with it", () => {
    const drag = begin("rotate", document, ["a"], at(150, 50));
    const changes = values(toolDragChanges(drag, at(50, 150), NO_MODS));
    expect(changes["a.rotation"]).toBe(90);
    // The corner (0,0) is at (-50,-50) from the middle; a quarter turn clockwise puts it at (50,-50): (100, 0).
    expect(changes["a.x"]).toBeCloseTo(100, 3);
    // y was 0 and is 0: a field that does not change is not sent.
    expect(changes["a.y"] ?? 0).toBeCloseTo(0, 3);
  });

  it("adds to the rotation the object already has", () => {
    const turned = scene([rect("a", 0, 0, 100, 100, { rotation: 30 })]);
    const middle = begin("rotate", turned, ["a"]).centre;
    // The pointer goes from 100 to the right of the middle to 100 below it: a quarter turn clockwise.
    const drag = begin("rotate", turned, ["a"], at(middle.x + 100, middle.y));
    const changes = values(toolDragChanges(drag, at(middle.x, middle.y + 100), NO_MODS));
    expect(changes["a.rotation"]).toBeCloseTo(30 + 90, 3);
  });

  it("turns a half turn to 180, not to -180", () => {
    const drag = begin("rotate", document, ["a"], at(150, 50));
    expect(values(toolDragChanges(drag, at(-50, 50), NO_MODS))["a.rotation"]).toBe(180);
  });

  it("snaps the sweep to 15 degrees with Shift", () => {
    const drag = begin("rotate", document, ["a"], at(150, 50));
    // 20 degrees about (50,50).
    const radians = (20 * Math.PI) / 180;
    const pointer = at(50 + 100 * Math.cos(radians), 50 + 100 * Math.sin(radians));
    expect(values(toolDragChanges(drag, pointer, SHIFT))["a.rotation"]).toBe(15);
    expect(values(toolDragChanges(drag, pointer, NO_MODS))["a.rotation"]).toBeCloseTo(20, 3);
  });

  it("does not jump a whole turn when the pointer crosses the half turn", () => {
    const drag = begin("rotate", document, ["a"], at(-50, 40));
    const above = values(toolDragChanges(drag, at(-50, 60), NO_MODS))["a.rotation"]!;
    expect(Math.abs(above)).toBeLessThan(30);
  });

  it("turns several items as one block about the middle of all of them", () => {
    const pair = scene([rect("a", 0, 0, 10, 10), rect("b", 90, 0, 10, 10)]);
    const drag = begin("rotate", pair, ["a", "b"], at(150, 5));
    const changes = values(toolDragChanges(drag, at(50, 105), NO_MODS));
    expect(changes["a.rotation"]).toBe(90);
    expect(changes["b.rotation"]).toBe(90);
    // The two keep their distance: a is 90 left of b before, and 90 above after a quarter turn.
    expect(changes["b.y"]! - changes["a.y"]!).toBeCloseTo(90, 3);
    expect(changes["b.x"]! - changes["a.x"]!).toBeCloseTo(0, 3);
  });

  it("keeps the turn where it was when the pointer is on the middle, which has no direction", () => {
    const drag = begin("rotate", document, ["a"], at(150, 50));
    expect(toolDragChanges(drag, at(50, 50), NO_MODS)).toEqual([]);
    const before = values(toolDragChanges(drag, at(50, 150), NO_MODS));
    expect(before["a.rotation"]).toBe(90);
    expect(values(toolDragChanges(drag, at(50, 50), NO_MODS))["a.rotation"]).toBe(90);
  });

  it("refuses a drag that starts on the middle, and says where to start", () => {
    for (const tool of ["rotate", "scale"] as const) {
      const outcome = beginToolDrag(tool, document, ["a"], at(50, 50));
      expect(isRefused(outcome), tool).toBe(true);
      expect(isRefused(outcome) && outcome.refused, tool).toContain("Start the drag away from the middle of the selection");
      expect(isRefused(beginToolDrag(tool, document, ["a"], at(50 + MIN_RADIUS - 1, 50))), `${tool} just inside`).toBe(true);
      expect(isRefused(beginToolDrag(tool, document, ["a"], at(50 + MIN_RADIUS, 50))), `${tool} just outside`).toBe(false);
    }
    // Move has no middle to keep away from.
    expect(isRefused(beginToolDrag("move", document, ["a"], at(50, 50)))).toBe(false);
  });

  it("goes on turning past a half turn, and back", () => {
    const drag = begin("rotate", document, ["a"], at(150, 50));
    const around = (degrees: number) => {
      const radians = (degrees * Math.PI) / 180;
      return at(50 + 100 * Math.cos(radians), 50 + 100 * Math.sin(radians));
    };
    const turn = (degrees: number) => values(toolDragChanges(drag, around(degrees), NO_MODS))["a.rotation"]!;
    expect(turn(90)).toBeCloseTo(90, 3);
    expect(turn(170)).toBeCloseTo(170, 3);
    // Across the half turn: 190 degrees, not -170.
    expect(turn(190)).toBeCloseTo(190, 3);
    expect(turn(260)).toBeCloseTo(260, 3);
    expect(turn(350)).toBeCloseTo(350, 3);
    // And back the way it came.
    expect(turn(250)).toBeCloseTo(250, 3);
  });

  it("puts the first item on the 15 degree grid with Shift, not just the sweep", () => {
    const tilted = scene([rect("a", 0, 0, 100, 100, { rotation: 7 })]);
    const middle = begin("rotate", tilted, ["a"]).centre;
    const drag = begin("rotate", tilted, ["a"], at(middle.x + 100, middle.y));
    const radians = (20 * Math.PI) / 180;
    const pointer = at(middle.x + 100 * Math.cos(radians), middle.y + 100 * Math.sin(radians));
    // 7 + 20 = 27 goes to 30, so the sweep is 23.
    expect(values(toolDragChanges(drag, pointer, SHIFT))["a.rotation"]).toBe(30);
  });
});

describe("Scale", () => {
  const document = scene([rect("a", 0, 0, 100, 100)]);

  it("grows by the pointer's distance from the middle over where it started, the same on both axes", () => {
    const drag = begin("scale", document, ["a"], at(100, 50));
    const changes = values(toolDragChanges(drag, at(150, 50), NO_MODS));
    expect(changes["a.scaleX"]).toBe(2);
    expect(changes["a.scaleY"]).toBe(2);
    // The corner (0,0), 50 left and 50 above the middle, goes to 100 away: (-50,-50).
    expect(changes["a.x"]).toBe(-50);
    expect(changes["a.y"]).toBe(-50);
  });

  it("multiplies the scale the object already has", () => {
    const grown = scene([rect("a", 0, 0, 100, 100, { scaleX: 2, scaleY: 3 })]);
    const drag = begin("scale", grown, ["a"], at(0, 0));
    const middle = drag.centre;
    const start = beginToolDrag("scale", grown, ["a"], { x: middle.x + 100, y: middle.y });
    if (isRefused(start)) throw new Error("refused");
    const changes = values(toolDragChanges(start, { x: middle.x + 50, y: middle.y }, NO_MODS));
    expect(changes["a.scaleX"]).toBe(1);
    expect(changes["a.scaleY"]).toBe(1.5);
  });

  it("does not go below the smallest scale, and never to nothing or backwards", () => {
    const drag = begin("scale", document, ["a"], at(50 + 10000, 50));
    const changes = values(toolDragChanges(drag, at(50 + MIN_RADIUS, 50), NO_MODS));
    expect(changes["a.scaleX"]).toBe(MIN_SCALE);
    expect(changes["a.scaleY"]).toBe(MIN_SCALE);
    // On the middle itself it is as small as it goes, not back at full size.
    expect(values(toolDragChanges(drag, at(50, 50), NO_MODS))["a.scaleX"]).toBe(MIN_SCALE);
  });

  it("grows several items as one block, so the spaces between them grow too", () => {
    const pair = scene([rect("a", 0, 0, 10, 10), rect("b", 90, 0, 10, 10)]);
    const drag = begin("scale", pair, ["a", "b"], at(100, 5));
    const changes = values(toolDragChanges(drag, at(150, 5), NO_MODS));
    expect(changes["a.scaleX"]).toBe(2);
    expect(changes["b.x"]! - changes["a.x"]!).toBe(180);
  });
});

describe("what a drag sends and shows", () => {
  const document = scene([rect("a", 100, 100, 50, 50), rect("b", 300, 200, 50, 50)]);

  it("sends one setObjectField per changed field, as one batch", () => {
    const drag = begin("move", document, ["a", "b"], at(0, 0));
    const edits = toolDragEdits(toolDragChanges(drag, at(10, 5), NO_MODS));
    expect(edits).toEqual([
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 110 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 105 } },
      { edit: "setObjectField", objectIds: ["b"], field: { name: "x", value: 310 } },
      { edit: "setObjectField", objectIds: ["b"], field: { name: "y", value: 205 } },
    ]);
  });

  it("sends nothing for a drag that changes nothing", () => {
    const drag = begin("move", document, ["a"], at(0, 0));
    expect(toolDragEdits(toolDragChanges(drag, at(0, 0), NO_MODS))).toEqual([]);
  });

  it("does not send a value that rounds back to the stored one, which Rust would refuse as unchanged", () => {
    const drag = begin("scale", scene([rect("a", 0, 0, 100, 100)]), ["a"], at(100, 50));
    // 1.00002 times the start radius: scaleX would be 1.00002, which rounds to 1.
    const changes = toolDragChanges(drag, at(50 + 50 * 1.00002, 50), NO_MODS);
    expect(changes.filter((c) => c.field === "scaleX" || c.field === "scaleY")).toEqual([]);
    expect(changes.every((c) => Math.abs(c.value - Math.round(c.value * 1e4) / 1e4) < 1e-12)).toBe(true);
  });

  it("shows the changes on a copy and leaves the document alone", () => {
    const drag = begin("move", document, ["a"], at(0, 0));
    const changes = toolDragChanges(drag, at(10, 5), NO_MODS);
    const shown = previewDocument(document, changes);
    expect(shown.objects.find((o) => o.id === "a")).toMatchObject({ x: 110, y: 105 });
    expect(shown.objects.find((o) => o.id === "b")).toBe(document.objects[1]);
    expect(document.objects[0]).toMatchObject({ x: 100, y: 100 });
    expect(previewDocument(document, [])).toBe(document);
  });

  it("says what was done in words", () => {
    const move = begin("move", document, ["a"], at(0, 0));
    expect(toolDragLabel(move, toolDragChanges(move, at(10, 5), NO_MODS))).toBe("Moved a by 10, 5");
    const many = begin("move", document, ["a", "b"], at(0, 0));
    expect(toolDragLabel(many, toolDragChanges(many, at(-4, 0), NO_MODS))).toBe("Moved 2 items by -4, 0");
    const turn = begin("rotate", scene([rect("a", 0, 0, 100, 100)]), ["a"], at(150, 50));
    expect(toolDragLabel(turn, toolDragChanges(turn, at(50, 150), NO_MODS))).toBe("Rotated a by 90°");
    const grow = begin("scale", scene([rect("a", 0, 0, 100, 100)]), ["a"], at(100, 50));
    expect(toolDragLabel(grow, toolDragChanges(grow, at(150, 50), NO_MODS))).toBe("Scaled a to 200%");
  });
});

describe("Pivot", () => {
  /** Where a point of the object's own space lands on the canvas, from the stored values. */
  const landing = (o: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; anchorX: number; anchorY: number }, q: { x: number; y: number }) => {
    const r = (o.rotation * Math.PI) / 180;
    const sx = (q.x - o.anchorX) * o.scaleX;
    const sy = (q.y - o.anchorY) * o.scaleY;
    return { x: o.x + sx * Math.cos(r) - sy * Math.sin(r), y: o.y + sx * Math.sin(r) + sy * Math.cos(r) };
  };
  const state = (object: SceneObject) => ({
    x: object.x, y: object.y, rotation: object.rotation, scaleX: object.scaleX, scaleY: object.scaleY,
    anchorX: object.anchor?.x ?? 0, anchorY: object.anchor?.y ?? 0,
  });

  it("is a tool that can be started with nothing to keep away from", () => {
    const outcome = beginToolDrag("pivot", scene([rect("a", 0, 0, 100, 100)]), ["a"], at(50, 50));
    expect(isRefused(outcome)).toBe(false);
    expect(TOOL_FIELDS.pivot).toEqual(["x", "y"]);
  });

  it("moves the pivot with the pointer and the position with it, so no point of the object moves", () => {
    for (const extra of [{}, { rotation: 30 }, { scaleX: 2, scaleY: 0.5 }, { rotation: 90, scaleX: 3, anchor: { x: 20, y: 10 } }]) {
      const object = rect("a", 300, 200, 100, 60, extra);
      const drag = begin("pivot", scene([object]), ["a"], at(0, 0));
      const changes = toolDragChanges(drag, at(40, -25), NO_MODS);
      const after = { ...state(object) } as Record<string, number>;
      for (const change of changes) after[change.field] = change.value;
      const was = state(object);
      for (const q of [{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 33, y: 7 }]) {
        const a = landing(was, q);
        const b = landing(after as typeof was, q);
        expect(b.x, JSON.stringify(extra)).toBeCloseTo(a.x, 2);
        expect(b.y, JSON.stringify(extra)).toBeCloseTo(a.y, 2);
      }
      // The pivot itself is now where the pointer went: the old pivot on the canvas plus the drag.
      const pivotNow = landing(after as typeof was, { x: after.anchorX!, y: after.anchorY! });
      expect(pivotNow.x).toBeCloseTo(was.x + 40, 2);
      expect(pivotNow.y).toBeCloseTo(was.y - 25, 2);
    }
  });

  it("keeps to one axis with Shift, and sends nothing for a drag that comes back", () => {
    const drag = begin("pivot", scene([rect("a", 300, 200, 100, 60)]), ["a"], at(0, 0));
    expect(values(toolDragChanges(drag, at(30, 10), SHIFT))).toEqual({ "a.x": 330, "a.anchorX": 30, "a.anchorY": 0 });
    expect(toolDragChanges(drag, at(0, 0), NO_MODS)).toEqual([]);
  });

  it("sends the pivot as one setAnchor and the position as two fields, in one batch", () => {
    const drag = begin("pivot", scene([rect("a", 300, 200, 100, 60)]), ["a"], at(0, 0));
    const edits = toolDragEdits(toolDragChanges(drag, at(40, -25), NO_MODS));
    expect(edits).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 40, y: -25 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 340 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 175 } },
    ]);
  });

  it("shows the new pivot on the preview copy, and leaves the document alone", () => {
    const document = scene([rect("a", 300, 200, 100, 60, { anchor: { x: 5, y: 5 } })]);
    const drag = begin("pivot", document, ["a"], at(0, 0));
    const shown = previewDocument(document, toolDragChanges(drag, at(40, -25), NO_MODS));
    expect(shown.objects[0]).toMatchObject({ x: 340, y: 175, anchor: { x: 45, y: -20 } });
    expect(document.objects[0]).toMatchObject({ x: 300, y: 200, anchor: { x: 5, y: 5 } });
    // A field of the object is not invented for the pivot.
    expect(Object.keys(shown.objects[0]!)).not.toContain("anchorX");
  });

  it("changes the pivot of every selected object by the same distance on the canvas", () => {
    const document = scene([rect("a", 0, 0, 10, 10, { rotation: 90 }), rect("b", 100, 0, 10, 10)]);
    const drag = begin("pivot", document, ["a", "b"], at(0, 0));
    const changes = values(toolDragChanges(drag, at(10, 0), NO_MODS));
    // b is not turned: its pivot goes 10 along. a is a quarter turn: the same 10 on the canvas is -0 along and... its own y.
    expect(changes["b.anchorX"]).toBe(10);
    expect(changes["a.anchorX"] ?? 0).toBeCloseTo(0, 6);
    expect(changes["a.anchorY"]).toBe(-10);
  });

  it("refuses by name what has no pivot to move, or cannot keep its picture", () => {
    for (const [objects, ids, text] of [
      [[group("g", [])], ["g"], "g draws nothing of its own, so it has no pivot to move. Select the items inside it."],
      [[{ ...rect("m", 0, 0, 10, 10), type: "mesh" } as unknown as SceneObject], ["m"], "m keeps its pivot in 3D, which the Pivot tool does not move yet."],
      [[rect("a", 0, 0, 10, 10, { scaleX: 0 })], ["a"], "a has a scale of 0, so its pivot cannot be placed without moving what is drawn."],
      [[rect("a", 0, 0, 10, 10, { locked: true })], ["a"], "a is locked. Unlock it first; nothing was changed."],
    ] as const) {
      const outcome = beginToolDrag("pivot", scene([...objects]), [...ids], at(0, 0));
      expect(isRefused(outcome) && outcome.refused, text).toBe(text);
    }
  });

  it("refuses keys on the position, and an item in a rotated group, like Move", () => {
    const keyed = scene([rect("a", 0, 0, 10, 10)], [{ objectId: "a", property: "x", keys: [{}] }]);
    const refused = beginToolDrag("pivot", keyed, ["a"], at(0, 0));
    expect(isRefused(refused) && refused.refused).toBe("a has keys on x. Use the Pivot panel, which can add a key at the playhead or move the keys.");
    const turned = scene([group("g", ["a"], { rotation: 10 }), rect("a", 0, 0, 10, 10)]);
    const outcome = beginToolDrag("pivot", turned, ["a"], at(0, 0));
    expect(isRefused(outcome) && outcome.refused).toContain("a pivot move would go the wrong way".replace("a pivot", "pivot"));
    // The pivot cannot be keyed, so keys on the scale or the turn do not matter.
    const scaleKeyed = scene([rect("a", 0, 0, 10, 10)], [{ objectId: "a", property: "rotation", keys: [{}] }]);
    expect(isRefused(beginToolDrag("pivot", scaleKeyed, ["a"], at(0, 0)))).toBe(false);
  });

  it("says what was done", () => {
    const drag = begin("pivot", scene([rect("a", 300, 200, 100, 60)]), ["a"], at(0, 0));
    expect(toolDragLabel(drag, toolDragChanges(drag, at(40, -25), NO_MODS))).toBe("Moved the pivot of a by 40, -25");
  });
});
