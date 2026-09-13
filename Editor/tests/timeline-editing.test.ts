// Selection-driven timeline and keyframe editing (11.22).
//
// The failures these guard are the ones that lose an author's work:
//   - a drag that silently overwrites the key it lands on;
//   - a multi-key gesture that becomes N undo steps, so undo leaves the
//     selection half-moved;
//   - a run of keys that refuses to slide because it collides with itself;
//   - group rows quietly making node count proportional to the document.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import {
  isRefused,
  keysInSpan,
  planCopy,
  planDelete,
  planMove,
  planPaste,
  planSetEasing,
  snapFrame,
  SNAP_TOLERANCE_FRAMES,
} from "../src/timeline/key-edit";
import { keyId, parseKeyId, timelineModel } from "../src/timeline/model";

function rect(id: string, name = id): SceneObject {
  return { type: "rect", id, name, radius: 0, x: 0, y: 0 } as unknown as SceneObject;
}

function scene(
  channels: { objectId: string; property: string; frames: number[] }[],
  objects: SceneObject[],
  durationFrames = 500,
): SceneDocument {
  return {
    id: "s",
    name: "S",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: {
      durationFrames: durationFrames as unknown as bigint,
      channels: channels.map((channel) => ({
        objectId: channel.objectId,
        property: channel.property,
        keys: channel.frames.map((frame) => ({
          frame: frame as unknown as bigint,
          value: frame,
          easing: "linear" as const,
        })),
      })),
    },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    objects,
  } as SceneDocument;
}

const twoObjects = () =>
  scene(
    [
      { objectId: "card", property: "x", frames: [0, 10, 20] },
      { objectId: "card", property: "opacity", frames: [0, 30] },
      { objectId: "banner", property: "x", frames: [5] },
    ],
    [rect("card", "Card"), rect("banner", "Banner")],
  );

describe("selection reveals tracks", () => {
  it("shows only the selected objects' tracks", () => {
    const all = timelineModel(twoObjects());
    expect(all.tracks).toHaveLength(3);

    const justCard = timelineModel(twoObjects(), { selectedIds: ["card"] });
    expect(justCard.tracks.map((track) => track.property).sort()).toEqual(["opacity", "x"]);
    expect(justCard.tracks.every((track) => track.objectId === "card")).toBe(true);
  });

  it("shows the whole document when nothing is selected", () => {
    // An empty timeline would be a worse default than a full one.
    expect(timelineModel(twoObjects(), { selectedIds: [] }).tracks).toHaveLength(3);
  });

  it("groups tracks under a collapsible object row", () => {
    const model = timelineModel(twoObjects());
    const groups = model.rows.filter((row) => row.kind === "object");
    expect(groups).toHaveLength(2);
    expect(model.rows).toHaveLength(2 + 3);

    const collapsed = timelineModel(twoObjects(), { collapsedIds: ["card"] });
    // Card's two tracks are hidden; its group row remains, and still reports
    // how many it is hiding.
    expect(collapsed.rows).toHaveLength(2 + 1);
    const card = collapsed.rows.find((row) => row.kind === "object" && row.objectId === "card");
    expect(card).toMatchObject({ collapsed: true, trackCount: 2 });
    // Collapsing is a view state: the tracks are still in the model.
    expect(collapsed.tracks).toHaveLength(3);
  });
});

describe("key identity", () => {
  it("round-trips through its id", () => {
    expect(parseKeyId(keyId("card", "x", 20))).toEqual({
      objectId: "card",
      property: "x",
      frame: 20,
    });
    expect(parseKeyId("nonsense")).toBeUndefined();
  });
});

describe("snapping", () => {
  it("snaps to a candidate within tolerance and rounds otherwise", () => {
    expect(snapFrame(21.4, [20, 40], SNAP_TOLERANCE_FRAMES)).toBe(20);
    expect(snapFrame(31, [20, 40], SNAP_TOLERANCE_FRAMES)).toBe(31);
    // Frames are integers regardless: there is no half-frame position.
    expect(snapFrame(31.6, [], SNAP_TOLERANCE_FRAMES)).toBe(32);
    // The nearest candidate wins when two are in range.
    expect(snapFrame(22, [20, 24], SNAP_TOLERANCE_FRAMES)).toBe(20);
  });
});

describe("moving keys", () => {
  it("is one gesture, whatever the selection size", () => {
    const model = timelineModel(twoObjects());
    const plan = planMove(model, [keyId("card", "x", 0), keyId("card", "x", 10)], 100);
    expect(isRefused(plan)).toBe(false);
    if (isRefused(plan)) return;
    // Two calls, but the caller runs them as one undo entry; the label says so.
    expect(plan.calls).toHaveLength(2);
    expect(plan.label).toBe("Move 2 keys +100 frames");
    expect(plan.calls.every((call) => call.command === "cmd_keyframe_move")).toBe(true);
  });

  it("orders a rightward slide from the rightmost key so it cannot self-collide", () => {
    // Sliding 0,10,20 one frame right must move 20 first; starting at 0 would
    // refuse against the key still sitting on 10.
    const model = timelineModel(twoObjects());
    const plan = planMove(
      model,
      [keyId("card", "x", 0), keyId("card", "x", 10), keyId("card", "x", 20)],
      1,
    );
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.calls.map((call) => call.args.fromFrame)).toEqual([20, 10, 0]);

    // And leftward starts from the leftmost, for the same reason. Keys 10 and
    // 20 shift to 9 and 19; starting the run at 0 would legitimately refuse,
    // since frame -1 is off the timeline.
    const left = planMove(
      model,
      [keyId("card", "x", 10), keyId("card", "x", 20)],
      -1,
    );
    if (isRefused(left)) throw new Error(left.refused);
    expect(left.calls.map((call) => call.args.fromFrame)).toEqual([10, 20]);
  });

  it("refuses a landing frame an unselected key already holds, by name", () => {
    const model = timelineModel(twoObjects());
    const plan = planMove(model, [keyId("card", "x", 0)], 10);
    expect(isRefused(plan)).toBe(true);
    if (!isRefused(plan)) return;
    expect(plan.refused).toContain("frame 10");
    expect(plan.refused).toContain("already has a key");
  });

  it("allows keys to move through frames their own selection is vacating", () => {
    // The whole run 0,10,20 shifts by 10. Both 10 and 20 are landing frames
    // that are already occupied — but by keys that are themselves moving, so
    // the gesture is legal. Selecting only 0 and 10 would correctly refuse,
    // because 20 would not be vacating.
    const model = timelineModel(twoObjects());
    const whole = planMove(
      model,
      [keyId("card", "x", 0), keyId("card", "x", 10), keyId("card", "x", 20)],
      10,
    );
    expect(isRefused(whole)).toBe(false);

    const partial = planMove(model, [keyId("card", "x", 0), keyId("card", "x", 10)], 10);
    expect(partial).toMatchObject({ refused: expect.stringContaining("frame 20") });
  });

  it("refuses moves outside the timeline rather than clamping", () => {
    const model = timelineModel(twoObjects());
    expect(planMove(model, [keyId("card", "x", 0)], -5)).toMatchObject({
      refused: expect.stringContaining("before the start"),
    });
    expect(planMove(model, [keyId("card", "x", 20)], 1_000)).toMatchObject({
      refused: expect.stringContaining("outside the 500-frame timeline"),
    });
    expect(planMove(model, [], 5)).toMatchObject({ refused: "no keys are selected" });
    expect(planMove(model, [keyId("card", "x", 0)], 0)).toMatchObject({
      refused: "the keys did not move",
    });
  });
});

describe("deleting keys", () => {
  it("is one gesture over the whole selection", () => {
    const plan = planDelete([keyId("card", "x", 0), keyId("card", "opacity", 30)]);
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.calls).toHaveLength(2);
    expect(plan.label).toBe("Delete 2 keys");
    expect(plan.calls[0]!.command).toBe("cmd_keyframe_remove");
    expect(planDelete([])).toMatchObject({ refused: "no keys are selected" });
  });
});

/// Read the frame off a paste call's keyframe payload.
///
/// Narrowed rather than asserted: `args` is an IPC payload typed
/// `Record<string, unknown>`, so claiming a shape here would suppress the
/// check instead of performing it — and this assertion is the whole point of
/// the test.
function pastedFrame(call: { readonly args: Record<string, unknown> }): number {
  const keyframe = call.args.keyframe;
  if (keyframe !== null && typeof keyframe === "object" && "frame" in keyframe) {
    const frame = keyframe.frame;
    if (typeof frame === "number") return frame;
  }
  throw new Error(`paste call carried no numeric frame: ${JSON.stringify(call.args)}`);
}

describe("copy and paste", () => {
  it("copies frames relative to the earliest key, so a run keeps its shape", () => {
    const model = timelineModel(twoObjects());
    const clipboard = planCopy(model, [keyId("card", "x", 10), keyId("card", "x", 20)]);
    expect(clipboard.map((key) => key.offset)).toEqual([0, 10]);
    expect(clipboard[0]!.value).toBe(10);
  });

  it("pastes at the playhead, preserving the spacing", () => {
    const model = timelineModel(twoObjects());
    const clipboard = planCopy(model, [keyId("card", "x", 10), keyId("card", "x", 20)]);
    const plan = planPaste(model, clipboard, 200);
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.calls.map(pastedFrame)).toEqual([200, 210]);
    expect(plan.label).toBe("Paste 2 keys at 200");
  });

  it("refuses a paste that would land on an existing key, never overwriting", () => {
    const model = timelineModel(twoObjects());
    const clipboard = planCopy(model, [keyId("card", "x", 0)]);
    // Frame 20 already holds a key on that channel.
    expect(planPaste(model, clipboard, 20)).toMatchObject({
      refused: expect.stringContaining("already has a key"),
    });
    expect(planPaste(model, clipboard, 9_999)).toMatchObject({
      refused: expect.stringContaining("outside the 500-frame timeline"),
    });
    expect(planPaste(model, [], 0)).toMatchObject({ refused: "the clipboard is empty" });
  });
});

describe("marquee selection", () => {
  it("returns the keys inside a frame span on the given tracks", () => {
    const model = timelineModel(twoObjects());
    const xTrack = model.tracks.findIndex(
      (track) => track.objectId === "card" && track.property === "x",
    );
    expect(keysInSpan(model, [xTrack], 5, 25)).toEqual([
      keyId("card", "x", 10),
      keyId("card", "x", 20),
    ]);
    // Backwards drags describe the same span.
    expect(keysInSpan(model, [xTrack], 25, 5)).toHaveLength(2);
    expect(keysInSpan(model, [xTrack], 100, 200)).toEqual([]);
  });
});

describe("easing assignment (11.23)", () => {
  it("rewrites each key's curve while keeping its frame and value", () => {
    const model = timelineModel(twoObjects());
    const plan = planSetEasing(
      model,
      [keyId("card", "x", 0), keyId("card", "x", 20)],
      "ease-in-out",
    );
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.calls).toHaveLength(2);
    expect(plan.label).toBe("Set easing to ease-in-out on 2 keys");
    // The fixture's key at frame 20 holds value 20: the curve changes, the key
    // does not move and does not change value.
    expect(plan.calls[1]!.args.keyframe).toMatchObject({
      frame: 20,
      value: 20,
      easing: "ease-in-out",
    });
  });

  it("refuses a custom bezier with no control points, before any round trip", () => {
    const model = timelineModel(twoObjects());
    expect(planSetEasing(model, [keyId("card", "x", 0)], "custom-bezier")).toMatchObject({
      refused: "a custom bezier needs its control points",
    });
    const withPoints = planSetEasing(model, [keyId("card", "x", 0)], "custom-bezier", {
      x1: 0.3,
      y1: 1.4,
      x2: 0.6,
      y2: 1,
    });
    expect(isRefused(withPoints)).toBe(false);
  });

  it("refuses an empty selection and an unknown key by name", () => {
    const model = timelineModel(twoObjects());
    expect(planSetEasing(model, [], "linear")).toMatchObject({
      refused: "no keys are selected",
    });
    expect(planSetEasing(model, [keyId("card", "x", 999)], "linear")).toMatchObject({
      refused: expect.stringContaining("no key on card.x at frame 999"),
    });
  });
});
