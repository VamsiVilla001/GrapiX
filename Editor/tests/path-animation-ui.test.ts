// 11.112 and 11.113 in the Editor: the playhead shows a path where its channel has it, edits of an animated path carry the frame, the
// timeline lists path keys and moves, deletes and eases them with the path edits, and the page wires the buttons.
import { describe, expect, it } from "vitest";
import type { BezierPath, PathChannel, SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { editPathEdit, editTarget, gestureOp, joinEdits, kindEdits, pathEditFrame, pathEditSketch, type EditTarget } from "../src/path-edit";
import { previewSceneAt } from "../src/preview-playback";
import { timelineModel } from "../src/timeline/model";
import { planCopy, planDelete, planEasyEase, planMove, planSetEasing, planSetSegmentBezier } from "../src/timeline/key-edit";
import { wireFrame } from "../src/command-client";
import { addFeatherPointAt, featherPointMarks, linkMaskToShape, maskSketches, maskTarget, patchMask, unlinkPath, type MaskTarget } from "../src/mask-edit";
import { linkUsersWords, linkedPathOf, pathLinkOf } from "../src/path-anim";
import { pathEditRevision } from "../src/path-edit";
import html from "../web/index.html?raw";
import main from "../web/main.ts?raw";

const v = (x: number, y: number) => ({ x, y });
const square = (x0: number, dx = 0): BezierPath => ({
  closed: true,
  vertices: [v(x0 + dx, 0), v(x0 + 100 + dx, 0), v(x0 + 100 + dx, 100), v(x0 + dx, 100)],
  inTangents: [v(0, 0), v(0, 0), v(0, 0), v(0, 0)],
  outTangents: [v(0, 0), v(0, 0), v(0, 0), v(0, 0)],
  vertexIds: [0, 1, 2, 3],
  vertexKinds: ["corner", "corner", "corner", "corner"],
});

function shapeWith(path: BezierPath, extra: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "s", name: "Shape", type: "shape", x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false,
    zIndex: 0, anchor: undefined, path, ...extra,
  } as unknown as SceneObject;
}

function sceneWith(object: SceneObject, pathChannels: PathChannel[] = []): SceneDocument {
  return {
    id: "d", name: "D", version: 2, workingColorSpace: "srgb", colorDepth: "32",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100n, channels: [], phases: [], pathChannels },
    dataContext: {}, assets: [], fonts: [], materials: [], controls: [], textStyles: [],
    objects: [object],
  } as unknown as SceneDocument;
}

const shapeTarget = { kind: "shape", subpath: 0 } as const;
const channel = (keys: { frame: number; path: BezierPath; easing?: "linear" | "hold" | "ease-in-out" }[]): PathChannel => ({
  objectId: "s",
  target: shapeTarget,
  keys: keys.map((k) => ({ frame: wireFrame(k.frame), path: k.path, easing: k.easing ?? "linear" })),
});

describe("the path at the playhead", () => {
  const animated = channel([{ frame: 0, path: square(0) }, { frame: 20, path: square(0, 200) }]);
  const doc = sceneWith(shapeWith(square(0)), [animated]);

  it("is what the channel holds there, in the preview scene and in the edit target", () => {
    const at10 = previewSceneAt(doc, 10, null).document.objects[0]! as unknown as { path: BezierPath };
    expect(at10.path.vertices[0]).toEqual(v(100, 0));
    const target = editTarget(doc, ["s"], undefined, 10) as EditTarget;
    expect(target.paths[0]!.path.vertices[0]).toEqual(v(100, 0));
    expect(target.animated).toEqual([0]);
    expect(target.frame).toBe(10);
    // The sketch the viewport draws is that path.
    expect(pathEditSketch(target, []).vertices[0]).toMatchObject({ x: 100, y: 0 });
    // A path with no channel is what it is, at any frame, and is not animated.
    const still = editTarget(sceneWith(shapeWith(square(0))), ["s"], undefined, 10) as EditTarget;
    expect(still.animated).toEqual([]);
    expect(still.paths[0]!.path.vertices[0]).toEqual(v(0, 0));
  });

  it("says what a held key is when the neighbours differ in vertices", () => {
    const odd = { ...square(0, 200), vertexIds: [0, 2, 1, 3] };
    const held = sceneWith(shapeWith(square(0)), [channel([{ frame: 0, path: square(0) }, { frame: 20, path: odd }])]);
    const result = previewSceneAt(held, 10, null);
    expect(result.issues.join(" ")).toContain("different ids");
    expect((result.document.objects[0] as unknown as { path: BezierPath }).path.vertices[0]).toEqual(v(0, 0));
  });
});

describe("an edit of an animated path", () => {
  const animated = channel([{ frame: 0, path: square(0) }, { frame: 20, path: square(0, 200) }]);
  const target = editTarget(sceneWith(shapeWith(square(0)), [animated]), ["s"], undefined, 10) as EditTarget;
  const still = editTarget(sceneWith(shapeWith(square(0))), ["s"], undefined, 10) as EditTarget;

  it("carries the frame when the path is animated or the author is keying, and not otherwise", () => {
    expect(pathEditFrame(target, 0, false)).toBe(10);
    expect(pathEditFrame(still, 0, false)).toBeUndefined();
    expect(pathEditFrame(still, 0, true)).toBe(10);
    const edit = editPathEdit("s", 0, { op: "moveVertices", indices: [0], delta: v(1, 1) }, undefined, 10) as unknown as { frame?: bigint };
    expect(edit.frame).toBe(10);
    expect((editPathEdit("s", 0, { op: "reverse" }) as unknown as { frame?: bigint }).frame).toBeUndefined();
  });

  it("couples the far handle by the kind of the vertex it is on", () => {
    const smooth = { ...square(0), inTangents: [v(0, 0), v(-10, 0), v(0, 0), v(0, 0)], outTangents: [v(0, 0), v(10, 0), v(0, 0), v(0, 0)] };
    const gesture = (kind: "smooth" | "symmetric" | "corner" | "auto") => {
      const path: BezierPath = { ...smooth, vertexKinds: ["corner", kind, "corner", "corner"] };
      const t = editTarget(sceneWith(shapeWith(path)), ["s"]) as EditTarget;
      const made = gestureOp(t, { hit: { kind: "handle", subpath: 0, index: 1, side: "out" }, start: v(110, 0), moving: [] }, v(120, 0), { shift: false, alt: false });
      return made?.op as { coupling?: string };
    };
    expect(gesture("smooth").coupling).toBe("smooth");
    expect(gesture("symmetric").coupling).toBe("mirror");
    expect(gesture("corner").coupling).toBe("none");
    expect(gesture("auto").coupling).toBe("smooth");
  });

  it("makes one edit per vertex for a kind, one gesture, and refuses what changes nothing", () => {
    const planned = kindEdits(target, [{ subpath: 0, index: 0 }, { subpath: 0, index: 2 }], "smooth", false);
    if ("refused" in planned) throw new Error(planned.refused);
    expect(planned.edits).toHaveLength(2);
    expect(planned.edits[0]).toMatchObject({ edit: "editPath", op: { op: "setVertexKind", index: 0, kind: "smooth" }, frame: 10 });
    expect(kindEdits(still, [{ subpath: 0, index: 0 }], "corner", false)).toMatchObject({ refused: expect.stringContaining("corner already") });
    expect(kindEdits(still, [], "smooth", false)).toMatchObject({ refused: expect.stringContaining("Select") });
  });

  it("refuses a join of an animated shape by name", () => {
    const open = (path: BezierPath): BezierPath => ({ ...path, closed: false });
    const doc = sceneWith(shapeWith(open(square(0))), [animated]);
    const two = { ...doc, objects: [doc.objects[0]!, { ...shapeWith(open(square(300))), id: "t", name: "Other" } as SceneObject] } as SceneDocument;
    const outcome = joinEdits(two, ["s", "t"]);
    expect(outcome).toMatchObject({ refused: expect.stringContaining("animated path") });
  });
});

describe("path keys on the timeline", () => {
  const animated = channel([{ frame: 0, path: square(0) }, { frame: 20, path: square(0, 200) }, { frame: 40, path: square(0, 50) }]);
  const doc = sceneWith(shapeWith(square(0)), [animated]);
  const model = timelineModel(doc);

  it("lists a path channel as a track whose keys are the path keys", () => {
    expect(model.tracks).toHaveLength(1);
    const track = model.tracks[0]!;
    expect(track.property).toBe("path");
    expect(track.label).toBe("Path");
    expect(Array.from(track.keys.frames)).toEqual([0, 20, 40]);
    expect(track.pathTarget).toEqual(shapeTarget);
    expect(model.keyCount).toBe(3);
    const mask = timelineModel(sceneWith(shapeWith(square(0)), [{ ...animated, target: { kind: "mask", index: 1 } }])).tracks[0]!;
    expect([mask.property, mask.label]).toEqual(["masks[1].path", "Mask 2 path"]);
  });

  it("moves, deletes and eases path keys with the path edits, and numeric keys as before", () => {
    const id = (frame: number) => `s/path/${frame}`;
    const moved = planMove(model, [id(20)], 5);
    expect("edits" in moved && moved.edits[0]).toMatchObject({ edit: "movePathKey", objectId: "s", target: shapeTarget, fromFrame: 20, toFrame: 25 });
    const removed = planDelete([id(0), id(40)]);
    expect("edits" in removed && removed.edits.map((e: SceneEdit) => (e as { edit: string }).edit)).toEqual(["removePathKey", "removePathKey"]);
    const eased = planSetEasing(model, [id(20)], "hold");
    expect("edits" in eased && eased.edits[0]).toMatchObject({ edit: "setPathKey", frame: 20, easing: "hold", path: animated.keys[1]!.path });
    const both = planEasyEase(model, [id(20)], "both");
    expect("edits" in both && both.edits.every((e: SceneEdit) => (e as { edit: string }).edit === "setPathKey")).toBe(true);
    const curve = planSetSegmentBezier(model, "s", "path", 0, { x1: 0.2, y1: 0, x2: 0.8, y2: 1 });
    expect("edits" in curve && curve.edits[0]).toMatchObject({ edit: "setPathKey", frame: 0, easing: "custom-bezier", bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } });
    // A numeric key is moved and removed as before.
    const withNumbers = { ...doc, timeline: { ...doc.timeline, channels: [{ objectId: "s", property: "opacity", keys: [{ frame: wireFrame(10), value: 1, easing: "linear" as const }] }] } } as SceneDocument;
    const numeric = planMove(timelineModel(withNumbers), ["s/opacity/10"], 1);
    expect("edits" in numeric && numeric.edits[0]).toMatchObject({ edit: "moveKeyframe", property: "opacity" });
    // Copying keys copies numbers: a path key is left out.
    expect(planCopy(model, [id(20)])).toEqual([]);
  });
});

describe("the page", () => {
  it("has the path animation and vertex kind controls, wired", () => {
    for (const id of ["path-keying", "path-key-set", "path-key-remove", "auto-tension"]) expect(html).toContain(`id="${id}"`);
    for (const kind of ["corner", "smooth", "symmetric", "auto"]) expect(html).toContain(`data-vertex-kind="${kind}"`);
    expect(main).toContain("pathKeying = ui.pathKeying.checked;");
    expect(main).toMatch(/ui\.pathKeySet\.addEventListener\("click", \(\) => void keyPathAtPlayhead\(\)\);/);
    expect(main).toMatch(/ui\.pathKeyRemove\.addEventListener\("click", \(\) => void removePathKeyAtPlayhead\(\)\);/);
    expect(main).toContain("setSelectedVertexKind(button.dataset.vertexKind as VertexKind)");
    // A keyed path goes in as one batch of path keys at the playhead, in one history entry.
    expect(main).toMatch(/edit: "setPathKey",[\s\S]*frame: wireFrame\(currentFrame\)/);
    expect(main).toMatch(/edit: "removePathKey", objectId: target\.object\.id, target: at, frame: wireFrame\(currentFrame\)/);
    // The Pen cannot carry on an animated path, and the page reads the path at the playhead.
    expect(main).toContain("if (animatesPath(scene, object.id)) return false;");
    expect(main).toContain("editTarget(scene, selection, pathMask, currentFrame)");
  });
});

describe("linked paths (11.112)", () => {
  const mask = { id: "m1", path: square(0), mode: "add", feather: 0, expansion: 0, opacity: 1, inverted: false };
  const card = { id: "card", name: "Card", type: "rect", x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false, zIndex: 1, masks: [mask] } as unknown as SceneObject;
  const linked = (): SceneDocument => ({
    ...sceneWith(shapeWith(square(0))),
    objects: [shapeWith(square(0)), card],
    pathLinks: [{ id: "path-link-1", revision: 3n, users: [{ objectId: "s", subpath: 0 }, { objectId: "card", maskId: "m1" }] }],
  }) as unknown as SceneDocument;

  it("finds the link a path is in, by the shape's subpath or the mask's id, and names the others", () => {
    const doc = linked();
    const shape = doc.objects[0]!;
    const link = pathLinkOf(doc, shape, shapeTarget)!;
    expect(link.id).toBe("path-link-1");
    expect(pathLinkOf(doc, card, { kind: "mask", index: 0 })?.id).toBe("path-link-1");
    expect(pathLinkOf(doc, card, { kind: "mask", index: 3 })).toBeUndefined();
    expect(pathLinkOf(sceneWith(shapeWith(square(0))), shape, shapeTarget)).toBeUndefined();
    expect(linkUsersWords(doc, link, linkedPathOf(shape, shapeTarget))).toBe("Card mask 1");
    expect(linkUsersWords(doc, link, linkedPathOf(card, { kind: "mask", index: 0 }))).toBe("Shape");
  });

  it("names the revision an edit of a linked path was made on", () => {
    const doc = linked();
    const target = editTarget(doc, ["s"], undefined, 0) as EditTarget;
    expect(pathEditRevision(target, 0)).toBe(3);
    expect((editPathEdit("s", 0, { op: "reverse" }, undefined, undefined, 3) as unknown as { baseRevision?: number }).baseRevision).toBe(3);
    expect((editPathEdit("s", 0, { op: "reverse" }) as unknown as { baseRevision?: number }).baseRevision).toBeUndefined();
    const masked = editTarget(doc, ["card"], 0, 0) as EditTarget;
    expect(pathEditRevision(masked, 0)).toBe(3);
    // An unlinked path names none.
    expect(pathEditRevision(editTarget(sceneWith(shapeWith(square(0))), ["s"], undefined, 0) as EditTarget, 0)).toBeUndefined();
  });

  it("links a mask to a shape by one edit, refuses an open shape, and unlinks by address", () => {
    const doc = { ...linked(), pathLinks: [] } as unknown as SceneDocument;
    const edit = linkMaskToShape(doc, card, 0, "s");
    expect(edit).toEqual({ edit: "linkPaths", source: { objectId: "s", target: { kind: "shape", subpath: 0 } }, target: { objectId: "card", target: { kind: "mask", index: 0 } } });
    expect(linkMaskToShape(doc, card, 5, "s")).toMatchObject({ refused: "There is no mask 6." });
    expect(linkMaskToShape(doc, card, 0, "nope")).toMatchObject({ refused: expect.stringContaining("not in the scene") });
    const open = { ...doc, objects: [shapeWith({ ...square(0), closed: false }), card] } as SceneDocument;
    expect(linkMaskToShape(open, card, 0, "s")).toMatchObject({ refused: expect.stringContaining("open path") });
    expect(unlinkPath("card", { kind: "mask", index: 0 })).toEqual({ edit: "unlinkPath", path: { objectId: "card", target: { kind: "mask", index: 0 } } });
  });

  it("is in the Masks panel and the path tools, wired", () => {
    expect(html).toContain('id="path-unlink"');
    expect(main).toContain('ui.pathUnlink.addEventListener("click", () => void unlinkEditedPath());');
    expect(main).toContain('"Link to shape"');
    expect(main).toContain("linkMaskToShape(document_, object, index, shapePick.value)");
    expect(main).toContain('unlinkPath(object.id, { kind: "mask", index })');
    expect(main).toContain("pathEditRevision(target, subpath)");
  });
});

describe("subpaths (11.112)", () => {
  it("has a Remove subpath control that sends one removeSubpath edit for the subpath of the selected vertex", () => {
    expect(html).toContain('id="path-subpath-remove"');
    expect(main).toContain('ui.subpathRemove.addEventListener("click", () => void removeSelectedSubpath());');
    expect(main).toMatch(/edit: "removeSubpath", shapeId: target\.object\.id, subpath/);
    expect(main).toContain("a mask is one path. Remove the mask instead.");
  });
});


describe("the matte pick whip (3.30)", () => {
  it("lets a click on any layer, in the viewport or the object list, choose the matte, and Escape let it go", () => {
    expect(main).toContain('maskButton("Pick whip"');
    expect(main).toMatch(/if \(matteWhip !== undefined\) \{\s*event\.preventDefault\(\);\s*takeMatteWhip\(hitTestOverlay\(previewScene, eventScenePoint\(event\)\)\);/);
    expect(main).toMatch(/if \(matteWhip !== undefined\) \{\s*takeMatteWhip\(id\);\s*return;/);
    expect(main).toContain('if (event.key === "Escape" && matteWhip !== undefined)');
    // The choice is the same edit as the list's: setMatte, so its refusals (itself, locked, no pixels) are the same.
    expect(main).toContain('setMatte(scene, target, sourceId, object?.trackMatte?.mode ?? "alpha")');
  });
});

describe("the matte views (3.30)", () => {
  it("are chosen in the Masks panel, drawn by the engine from a changed copy, and let go with the selection", () => {
    expect(main).toContain("maskSelect(\"View\", MATTE_VIEWS");
    expect(main).toContain('shell().invoke<ArrayBuffer>("cmd_engine_preview", { endpoint, target, frame, ...(matteView === undefined ? {} : { matteView }) })');
    expect(main).toContain('if (matteView !== undefined) return "engine";');
    expect(main).toMatch(/if \(matteView !== undefined && !selection\.includes\(matteView\.objectId\)\)/);
  });
});

describe("the variable feather (11.108)", () => {
  const square = (): BezierPath => ({
    closed: true,
    vertices: [v(0, 0), v(100, 0), v(100, 100), v(0, 100)],
    inTangents: [v(0, 0), v(0, 0), v(0, 0), v(0, 0)],
    outTangents: [v(0, 0), v(0, 0), v(0, 0), v(0, 0)],
  });
  const layer = (extra: Record<string, unknown> = {}): SceneObject =>
    ({
      id: "card", name: "Card", type: "rect", x: 50, y: 20, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false, zIndex: 1,
      masks: [{ id: "m1", path: square(), mode: "add", feather: 8, expansion: 0, opacity: 1, inverted: false, ...extra }],
    }) as unknown as SceneObject;
  const doc = (object: SceneObject): SceneDocument => ({ ...sceneWith(object), objects: [object] }) as SceneDocument;
  const targetOf = (object: SceneObject): MaskTarget => {
    const found = maskTarget(doc(object), [object.id]);
    if ("refused" in found) throw new Error(found.refused);
    return found;
  };

  it("sets points as one edit, drops the field when none are left, and refuses by name what the engine would", () => {
    const edit = patchMask(targetOf(layer()), 0, { featherPoints: [{ segment: 1, t: 0.5, radius: -12, tension: 0.5 }] }) as unknown as { masks: { featherPoints?: unknown[] }[] };
    expect(edit.masks[0]!.featherPoints).toEqual([{ segment: 1, t: 0.5, radius: -12, tension: 0.5 }]);
    const cleared = patchMask(targetOf(layer({ featherPoints: [{ segment: 0, t: 0, radius: 5, tension: 0 }] })), 0, { featherPoints: [] }) as unknown as { masks: Record<string, unknown>[] };
    expect("featherPoints" in cleared.masks[0]!).toBe(false);
    for (const [point, words] of [
      [{ segment: 4, t: 0.5, radius: 1, tension: 0 }, "4 segments"],
      [{ segment: 0, t: 1.5, radius: 1, tension: 0 }, "0 to 1 along"],
      [{ segment: 0, t: 0.5, radius: 400, tension: 0 }, "-250 to 250"],
      [{ segment: 0, t: 0.5, radius: 1, tension: 2 }, "tension"],
    ] as const) {
      expect(patchMask(targetOf(layer()), 0, { featherPoints: [point] }), words).toMatchObject({ refused: expect.stringContaining(words === "4 segments" ? "4 segments" : words) });
    }
    expect(patchMask(targetOf(layer()), 0, { featherPoints: Array.from({ length: 65 }, () => ({ segment: 0, t: 0, radius: 1, tension: 0 })) })).toMatchObject({ refused: expect.stringContaining("at most 64") });
  });

  it("puts a point where a click is nearest the edge, and draws it where it is on the canvas with its reach", () => {
    const object = layer();
    const edit = addFeatherPointAt(doc(object), targetOf(object), 0, { x: 50 + 100, y: 20 + 30 }) as unknown as { masks: { featherPoints: { segment: number; t: number; radius: number }[] }[] };
    // The right edge (segment 1) at 30 of 100 down; the point takes half of the uniform feather outward.
    // (A straight segment with no handles is a cubic whose parameter is not even: 30 of 100 down is t 0.363.)
    expect(edit.masks[0]!.featherPoints[0]).toMatchObject({ segment: 1, t: 0.363, radius: 4 });
    const marks = featherPointMarks(doc(layer({ featherPoints: [{ segment: 1, t: 0.3, radius: -20, tension: 0 }] })), layer(), layer({ featherPoints: [{ segment: 1, t: 0.3, radius: -20, tension: 0 }] }).masks![0]!);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.x).toBeCloseTo(150, 9);
    expect(marks[0]!.y).toBeCloseTo(20 + 100 * (3 * 0.09 - 2 * 0.027), 6);
    expect(marks[0]!.radius).toBe(-20);
    const sketch = maskSketches(doc(layer({ featherPoints: [{ segment: 1, t: 0.3, radius: -20, tension: 0 }] })), layer({ featherPoints: [{ segment: 1, t: 0.3, radius: -20, tension: 0 }] }))[0]!;
    expect(sketch.feather, "the uniform band is not drawn for a variable feather").toBe(0);
    expect(sketch.featherPoints).toHaveLength(1);
  });

  it("is in the Masks panel and on the canvas, wired", () => {
    expect(main).toContain("function featherPointsRow(target: MaskTarget, index: number): HTMLElement {");
    expect(main).toContain("featherPointsRow(target, index),");
    expect(main).toMatch(/if \(featherArm !== undefined\) \{\s*event\.preventDefault\(\);\s*takeFeatherPoint\(eventScenePoint\(event\)\);/);
    expect(main).toContain("addFeatherPointAt(scene, target, arm.index, at)");
  });
});
