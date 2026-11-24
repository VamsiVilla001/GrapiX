// Line up and spread (11.83): where each item goes, and when the whole action is refused instead.
//
// A line-up that moves some items and quietly leaves others is worse than none, so the tests hold the
// refusals as hard as the moves: every refusal sends nothing.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { APP_MENUS, type MenuNode } from "../src/app-menu";
import { ARRANGE_COMMANDS, arrangeEdits, arrangeLabel, arrangeWords, isArrangeCommand } from "../src/arrange";
import { isRefused } from "../src/inspector";
import page from "../web/main.ts?raw";

function item(id: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): SceneObject {
  return {
    type: "rect", id, name: id, visible: true, locked: false, opacity: 1, x, y, zDepth: 0, zIndex: 0, layerId: "",
    width, height, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0, radius: 0,
    ...extra,
  } as unknown as SceneObject;
}

function group(id: string, childIds: string[], extra: Record<string, unknown> = {}): SceneObject {
  return { ...item(id, 0, 0, 0, 0, extra), type: "group", childIds } as unknown as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return { id: "s", name: "S", version: 4, canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } }, objects } as unknown as SceneDocument;
}

/** The new x or y of each item the batch moves. */
function moves(outcome: readonly SceneEdit[] | { refused: string }): Record<string, number> {
  if (isRefused(outcome)) throw new Error(`refused: ${outcome.refused}`);
  const result: Record<string, number> = {};
  for (const edit of outcome) {
    if (edit.edit !== "setObjectField") throw new Error(`not a position edit: ${edit.edit}`);
    result[`${edit.objectIds[0]}.${edit.field.name}`] = edit.field.value as number;
  }
  return result;
}

function refusal(outcome: readonly SceneEdit[] | { refused: string }): string {
  if (!isRefused(outcome)) throw new Error(`not refused: ${JSON.stringify(outcome)}`);
  return outcome.refused;
}

const three = scene([item("a", 100, 100, 50, 40), item("b", 300, 160, 80, 60), item("c", 700, 40, 20, 100)]);
const all = ["a", "b", "c"];

describe("line up", () => {
  it("sends every left edge to the leftmost one, and moves only x", () => {
    expect(moves(arrangeEdits(three, all, "line-left"))).toEqual({ "b.x": 100, "c.x": 100 });
  });

  it("sends every right edge to the rightmost one", () => {
    // The rightmost edge is c's: 720.
    expect(moves(arrangeEdits(three, all, "line-right"))).toEqual({ "a.x": 670, "b.x": 640 });
  });

  it("sends the centres across to the middle of the whole selection", () => {
    // Outer box 100..720: centre 410.
    expect(moves(arrangeEdits(three, all, "line-centre"))).toEqual({ "a.x": 385, "b.x": 370, "c.x": 400 });
  });

  it("does the same down the other way, moving only y", () => {
    // Top 40, bottom 220, middle 130.
    expect(moves(arrangeEdits(three, all, "line-top"))).toEqual({ "a.y": 40, "b.y": 40 });
    expect(moves(arrangeEdits(three, all, "line-bottom"))).toEqual({ "a.y": 180, "c.y": 120 });
    expect(moves(arrangeEdits(three, all, "line-middle"))).toEqual({ "a.y": 110, "b.y": 100, "c.y": 80 });
  });

  it("uses the box on the canvas, after scale and rotation, and moves the item's own x by the difference", () => {
    const doc = scene([
      item("wide", 100, 100, 50, 50, { scaleX: 2 }),
      // Turned a quarter turn about its top-left corner: its box runs from x 300 - 40 to 300.
      item("turned", 300, 100, 100, 40, { rotation: 90 }),
    ]);
    // wide's box: 100..200. turned's box: 260..300. Lining the left edges moves turned by -160.
    expect(moves(arrangeEdits(doc, ["wide", "turned"], "line-left"))).toEqual({ "turned.x": 140 });
  });

  it("sends nothing for an item that is already there, and only for the others", () => {
    // `a` is on the left edge already: only `b` is sent.
    const doc = scene([item("a", 100, 10, 50, 40), item("b", 300, 90, 80, 60)]);
    expect(moves(arrangeEdits(doc, ["a", "b"], "line-left"))).toEqual({ "b.x": 100 });
  });
});

describe("spread", () => {
  it("makes the gaps between edges equal across and keeps the two outermost items where they are", () => {
    // a 0..100, b 150..170, c 600..700: widths 100 + 20 + 100 = 220, span 700, two gaps of 240.
    const doc = scene([item("a", 0, 0, 100, 10), item("b", 150, 0, 20, 10), item("c", 600, 0, 100, 10)]);
    expect(moves(arrangeEdits(doc, ["a", "b", "c"], "spread-across"))).toEqual({ "b.x": 340 });
  });

  it("orders by position on the canvas, not by the order the items were selected or made", () => {
    const doc = scene([item("c", 600, 0, 100, 10), item("a", 0, 0, 100, 10), item("b", 150, 0, 20, 10)]);
    expect(moves(arrangeEdits(doc, ["b", "c", "a"], "spread-across"))).toEqual({ "b.x": 340 });
  });

  it("orders by centre, so a wide item that starts early but sits late is not the first", () => {
    // `wide` starts first (0..1000) but its centre (500) is after `small`'s (110). By centre, `small` and
    // `last` are the outermost and stay: 20 + 1000 + 100 = 1120 of 2000 leaves two gaps of 440.
    const doc = scene([item("wide", 0, 0, 1000, 10), item("small", 100, 0, 20, 10), item("last", 2000, 0, 100, 10)]);
    expect(moves(arrangeEdits(doc, ["wide", "small", "last"], "spread-across"))).toEqual({ "wide.x": 560 });
  });

  it("spreads down the same way, moving only y", () => {
    const doc = scene([item("a", 0, 0, 10, 100), item("b", 0, 150, 10, 20), item("c", 0, 600, 10, 100)]);
    expect(moves(arrangeEdits(doc, ["a", "b", "c"], "spread-down"))).toEqual({ "b.y": 340 });
  });

  it("gives every item between the ends its own place, with items of different sizes", () => {
    // 0..10, 50..80, 90..130, 1000..1010: sizes 10 + 30 + 40 + 10 = 90, span 1010, three gaps of 306.666...
    const doc = scene([item("a", 0, 0, 10, 5), item("b", 50, 0, 30, 5), item("c", 90, 0, 40, 5), item("d", 1000, 0, 10, 5)]);
    const result = moves(arrangeEdits(doc, ["a", "b", "c", "d"], "spread-across"));
    expect(result["b.x"]).toBeCloseTo(316.666667, 5);
    expect(result["c.x"]).toBeCloseTo(653.333333, 5);
    expect(result["a.x"]).toBeUndefined();
    expect(result["d.x"]).toBeUndefined();
  });

  it("says so when they are already even", () => {
    const doc = scene([item("a", 0, 0, 100, 10), item("b", 200, 0, 100, 10), item("c", 400, 0, 100, 10)]);
    expect(refusal(arrangeEdits(doc, ["a", "b", "c"], "spread-across"))).toBe("Nothing to move: they are already evenly spaced.");
  });
});

describe("what is refused, and moves nothing", () => {
  it("asks for enough items", () => {
    expect(refusal(arrangeEdits(three, ["a"], "line-left"))).toBe("Select two or more items to line up.");
    expect(refusal(arrangeEdits(three, [], "line-left"))).toBe("Select two or more items to line up.");
    expect(refusal(arrangeEdits(three, ["a", "b"], "spread-across"))).toBe("Select three or more items to spread.");
  });

  it("refuses a locked item by name, even when others could move", () => {
    const doc = scene([item("a", 0, 0, 10, 10), item("b", 50, 0, 10, 10, { locked: true, name: "Logo" }), item("c", 90, 0, 10, 10)]);
    expect(refusal(arrangeEdits(doc, ["a", "b", "c"], "line-left"))).toBe('"Logo" is locked. Unlock it first; nothing was moved.');
    const two = scene([item("a", 0, 0, 10, 10, { locked: true, name: "A" }), item("b", 50, 0, 10, 10, { locked: true, name: "B" })]);
    expect(refusal(arrangeEdits(two, ["a", "b"], "line-left"))).toBe('"A", "B" are locked. Unlock them first; nothing was moved.');
  });

  it("refuses a group, layer or camera, which has no box of its own", () => {
    const doc = scene([item("a", 0, 0, 10, 10), group("g", ["a"], { name: "Panel" })]);
    expect(refusal(arrangeEdits(doc, ["a", "g"], "line-left"))).toBe('"Panel" has no box of its own to line up. Select the items inside it instead.');
  });

  it("refuses items from different groups, and lines up items of one group in that group's space", () => {
    const doc = scene([
      item("a", 0, 0, 10, 10), item("b", 50, 0, 10, 10), item("c", 90, 0, 10, 10),
      group("g1", ["a"]), group("g2", ["b"]),
    ]);
    const different = "These items are in different groups. Select items from one group, or items outside every group.";
    expect(refusal(arrangeEdits(doc, ["a", "b"], "line-left"))).toBe(different);
    expect(refusal(arrangeEdits(doc, ["a", "c"], "line-left"))).toBe(different);
    // Two items of the same group line up in that group's space.
    const same = scene([item("a", 0, 0, 10, 10), item("b", 50, 0, 10, 10), group("g", ["a", "b"])]);
    expect(moves(arrangeEdits(same, ["a", "b"], "line-left"))).toEqual({ "b.x": 0 });
  });

  it("says nothing moved when everything is already in place", () => {
    const doc = scene([item("a", 0, 0, 10, 10), item("b", 0, 40, 10, 10)]);
    expect(refusal(arrangeEdits(doc, ["a", "b"], "line-left"))).toBe("Nothing to move: they are already lined up.");
  });
});

describe("rounding", () => {
  it("does not send a move that is only floating-point noise, and tidies the ones it sends", () => {
    const doc = scene([item("a", 0.1 + 0.2, 0, 10, 10), item("b", 0.3, 40, 10, 10)]);
    // Both left edges are 0.3 to within 1e-16: nothing to move.
    expect(refusal(arrangeEdits(doc, ["a", "b"], "line-left"))).toBe("Nothing to move: they are already lined up.");
    // 0.1 + 0.35 is 0.44999999999999996 in floating point; the author sees and stores 0.45.
    const odd = scene([item("a", 0, 0, 0.1, 10), item("b", 0.5, 0, 0.2, 10), item("c", 1, 0, 0.3, 10)]);
    expect(moves(arrangeEdits(odd, ["a", "b", "c"], "spread-across"))).toEqual({ "b.x": 0.45 });
  });
});

describe("the words and the menu", () => {
  it("names every command in plain words, and the count it moved", () => {
    expect(ARRANGE_COMMANDS).toHaveLength(8);
    expect(arrangeWords("line-left")).toBe("Line up left edges");
    expect(arrangeWords("line-middle")).toBe("Line up middles down");
    expect(arrangeWords("spread-down")).toBe("Spread evenly down");
    expect(arrangeLabel("line-top", 1)).toBe("Line up top edges: 1 item moved");
    expect(arrangeLabel("spread-across", 2)).toBe("Spread evenly across: 2 items moved");
    expect(isArrangeCommand("line-left")).toBe(true);
    expect(isArrangeCommand("line-diagonal")).toBe(false);
  });

  it("has every command once in Edit > Line up and spread, none of them waiting on a row", () => {
    const all: MenuNode[] = [];
    const walk = (nodes: readonly MenuNode[]) => {
      for (const node of nodes) {
        all.push(node);
        if (node.kind === "submenu") walk(node.items);
      }
    };
    walk(APP_MENUS.flatMap((menu) => menu.items));
    const natives = all.flatMap((node) => (node.kind === "command" && node.native?.startsWith("arrange-") ? [node.native.slice(8)] : []));
    expect([...natives].sort()).toEqual([...ARRANGE_COMMANDS].sort());
    const entry = all.find((node) => node.kind === "submenu" && node.id === "edit.line-up");
    expect(entry).toMatchObject({ label: "Line up and spread" });
  });

  it("sends the batch from the page as one command tagged for the composition, and shows a refusal as words", () => {
    expect(page).toContain("arrangeEdits(");
    expect(page).toMatch(/runEdits\(\s*outcome,\s*arrangeLabel\(command, outcome\.length\),\s*"viewport"/);
    expect(page).toContain("isArrangeCommand(");
  });
});
