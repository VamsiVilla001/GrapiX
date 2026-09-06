import assert from "node:assert/strict";
import test from "node:test";
import {
  alignMoves,
  canAlign,
  canDistribute,
  distributeMoves,
  movableTargets,
  resolveAlignFrame,
  selectionBoundsOf,
  type AlignTarget
} from "../src/tools/alignment";

function target(id: string, x: number, y: number, width = 100, height = 50, locked = false): AlignTarget {
  return { id, bounds: { x, y, width, height }, locked };
}

const CANVAS = { x: 0, y: 0, width: 1920, height: 1080 };

function applied(targets: AlignTarget[], moves: { id: string; dx: number; dy: number }[]): AlignTarget[] {
  return targets.map((item) => {
    const move = moves.find((candidate) => candidate.id === item.id);
    if (!move) return item;
    return { ...item, bounds: { ...item.bounds, x: item.bounds.x + move.dx, y: item.bounds.y + move.dy } };
  });
}

test("align left brings every left edge to the selection's left edge", () => {
  const targets = [target("a", 100, 0), target("b", 300, 100), target("c", 50, 200)];
  const frame = selectionBoundsOf(targets);
  const result = applied(targets, alignMoves(targets, "left", frame));

  assert.deepEqual(result.map((item) => item.bounds.x), [50, 50, 50]);
  assert.deepEqual(result.map((item) => item.bounds.y), [0, 100, 200], "the other axis is untouched");
});

test("align right and horizontal centre use edges, not positions", () => {
  const targets = [target("a", 0, 0, 100), target("b", 0, 0, 300)];
  const frame = selectionBoundsOf(targets);

  const right = applied(targets, alignMoves(targets, "right", frame));
  assert.deepEqual(right.map((item) => item.bounds.x + item.bounds.width), [300, 300]);

  const centre = applied(targets, alignMoves(targets, "center-x", frame));
  assert.deepEqual(centre.map((item) => item.bounds.x + item.bounds.width / 2), [150, 150]);
});

test("vertical alignment mirrors the horizontal cases", () => {
  const targets = [target("a", 0, 10, 100, 40), target("b", 0, 200, 100, 80)];
  const frame = selectionBoundsOf(targets);

  assert.deepEqual(
    applied(targets, alignMoves(targets, "top", frame)).map((item) => item.bounds.y),
    [10, 10]
  );
  assert.deepEqual(
    applied(targets, alignMoves(targets, "bottom", frame)).map((item) => item.bounds.y + item.bounds.height),
    [280, 280]
  );
  assert.deepEqual(
    applied(targets, alignMoves(targets, "center-y", frame)).map((item) => item.bounds.y + item.bounds.height / 2),
    [145, 145]
  );
});

test("aligning to the canvas centres on the canvas, not on the selection", () => {
  const targets = [target("a", 0, 0, 200, 100)];
  const frame = resolveAlignFrame("canvas", targets, { canvas: CANVAS });
  const result = applied(targets, alignMoves(targets, "center-x", frame));

  assert.equal(result[0].bounds.x + result[0].bounds.width / 2, 960);
});

test("the key object holds still and everything else comes to it", () => {
  const targets = [target("a", 0, 0), target("key", 500, 0), target("c", 900, 0)];
  const frame = resolveAlignFrame("key-object", targets, { canvas: CANVAS, keyObjectId: "key" });
  const movable = movableTargets(targets, "key-object", "key");
  const moves = alignMoves(movable, "left", frame);

  assert.equal(moves.find((move) => move.id === "key"), undefined, "the key object is never moved");
  const result = applied(targets, moves);
  assert.deepEqual(result.map((item) => item.bounds.x), [500, 500, 500]);
});

test("a locked object is reference geometry: it anchors the others but never moves", () => {
  const targets = [target("a", 0, 0), target("locked", 400, 0, 100, 50, true)];
  const frame = selectionBoundsOf(targets);
  const moves = alignMoves(targets, "right", frame);

  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, "a");
});

test("distributing centres spaces the middle evenly and leaves the ends alone", () => {
  const targets = [target("a", 0, 0, 100), target("b", 150, 0, 100), target("c", 600, 0, 100)];
  const moves = distributeMoves(targets, "center-x");
  const result = applied(targets, moves);
  const centres = result.map((item) => item.bounds.x + item.bounds.width / 2);

  assert.deepEqual(centres, [50, 350, 650]);
  assert.equal(moves.some((move) => move.id === "a" || move.id === "c"), false);
});

test("equal spacing makes the gaps identical, which distributing centres does not", () => {
  // Different widths: distributing centres would leave visibly uneven gaps.
  const targets = [target("a", 0, 0, 100), target("b", 200, 0, 300), target("c", 900, 0, 100)];
  const result = applied(targets, distributeMoves(targets, "spacing-x"))
    .sort((left, right) => left.bounds.x - right.bounds.x);

  const gaps = [
    result[1].bounds.x - (result[0].bounds.x + result[0].bounds.width),
    result[2].bounds.x - (result[1].bounds.x + result[1].bounds.width)
  ];
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 1e-9, `gaps ${gaps.join(" vs ")}`);
  assert.equal(result[0].bounds.x, 0, "the first stays put");
  assert.equal(result[2].bounds.x, 900, "the last stays put");
});

test("equal vertical spacing works on the other axis", () => {
  const targets = [target("a", 0, 0, 50, 100), target("b", 0, 150, 50, 40), target("c", 0, 500, 50, 100)];
  const result = applied(targets, distributeMoves(targets, "spacing-y"))
    .sort((left, right) => left.bounds.y - right.bounds.y);

  const gaps = [
    result[1].bounds.y - (result[0].bounds.y + result[0].bounds.height),
    result[2].bounds.y - (result[1].bounds.y + result[1].bounds.height)
  ];
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 1e-9);
});

test("distribution needs three objects; two have no interior to space", () => {
  assert.deepEqual(distributeMoves([target("a", 0, 0), target("b", 500, 0)], "center-x"), []);
  assert.equal(canDistribute([target("a", 0, 0), target("b", 500, 0)]), false);
  assert.equal(canDistribute([target("a", 0, 0), target("b", 5, 0), target("c", 9, 0)]), true);
});

test("what the buttons may offer follows from the selection", () => {
  const one = [target("a", 0, 0)];
  const two = [target("a", 0, 0), target("b", 10, 0)];

  assert.equal(canAlign(one, "selection"), false, "one object is already aligned to itself");
  assert.equal(canAlign(one, "canvas"), true, "one object can still be centred on the canvas");
  assert.equal(canAlign(two, "selection"), true);
  assert.equal(canAlign([target("a", 0, 0, 100, 50, true)], "canvas"), false, "locked has nothing to move");
});

test("an unresolvable reference falls back to the selection rather than doing nothing", () => {
  const targets = [target("a", 0, 0), target("b", 400, 0)];
  const noKey = resolveAlignFrame("key-object", targets, { canvas: CANVAS, keyObjectId: null });
  assert.deepEqual(noKey, selectionBoundsOf(targets));

  const noParent = resolveAlignFrame("parent", targets, { canvas: CANVAS, parentBounds: null });
  assert.deepEqual(noParent, selectionBoundsOf(targets));
});

test("a move is only reported when it actually moves something", () => {
  const targets = [target("a", 100, 0), target("b", 100, 0)];
  assert.deepEqual(alignMoves(targets, "left", selectionBoundsOf(targets)), []);
});
