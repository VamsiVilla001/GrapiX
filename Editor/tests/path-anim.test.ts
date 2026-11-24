// 11.112 and 11.113 on the page: vertex ids and kinds through every path operation, the auto handles, and the blend of two keys, held to the
// backend's answers in the shared fixture (Shared/contracts/fixtures/path-geometry.json, written by `gx_contracts::path_geometry`).
import { describe, expect, it } from "vitest";
import type { BezierPath, PathChannel, SceneDocument, SceneObject } from "@grapix/contracts";
import fixture from "../../Shared/contracts/fixtures/path-geometry.json";
import {
  controlBounds,
  convertVertex,
  deleteVertices,
  deriveAutoHandles,
  effective,
  fitDeleteVertex,
  freshId,
  hasAuto,
  idsOf,
  insertVertex,
  kindsOf,
  materialiseAt,
  pathBounds,
  reshapeSegment,
  reversePath,
  sameTopology,
  setAutoTension,
  setFirstVertex,
  setHandle,
  setVertexKind,
  whyNot,
  withIds,
  type Pt,
} from "../src/path-geometry";
import { drawnPathAtFrame, evaluatePathChannel, lerpPaths, pathChannelOf, targetField, targetOfField } from "../src/path-anim";

const { kinds, animated } = fixture as unknown as {
  kinds: Record<string, unknown>;
  animated: { channel: PathChannel; frames: { frame: number; path: BezierPath; held: string | null }[] };
};
const path = (name: string): BezierPath => kinds[name] as BezierPath;
const v = (x: number, y: number): Pt => ({ x, y });
const kinded = path("kinded");

function expectPath(actual: BezierPath | undefined, expected: BezierPath, digits = 9) {
  expect(actual, whyNot).toBeDefined();
  expect(actual!.closed).toBe(expected.closed);
  expect(actual!.vertexIds).toEqual(expected.vertexIds);
  expect(actual!.vertexKinds).toEqual(expected.vertexKinds);
  expect(actual!.autoTension).toEqual(expected.autoTension);
  for (const key of ["vertices", "inTangents", "outTangents"] as const) {
    expect(actual![key]).toHaveLength(expected[key].length);
    actual![key].forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[key][i]!.x, digits);
      expect(p.y).toBeCloseTo(expected[key][i]!.y, digits);
    });
  }
}

describe("ids and kinds, the same as the backend", () => {
  it("derives the same auto handles and draws the same effective path", () => {
    const handles = kinds.autoHandles as { in: Pt; out: Pt }[];
    handles.forEach((h, i) => {
      const got = deriveAutoHandles(kinded, i);
      expect(got.in.x).toBeCloseTo(h.in.x, 9);
      expect(got.in.y).toBeCloseTo(h.in.y, 9);
      expect(got.out.x).toBeCloseTo(h.out.x, 9);
      expect(got.out.y).toBeCloseTo(h.out.y, 9);
    });
    expectPath(effective(kinded), path("effective"));
    expect(hasAuto(kinded)).toBe(true);
    expect(effective(path("reverse"))).toBeDefined();
  });

  it("makes the same edits on a path with ids, kinds and a tension", () => {
    expectPath(reversePath(kinded), path("reverse"));
    expectPath(setFirstVertex(kinded, 2), path("first"));
    expectPath(insertVertex(kinded, 1, 0.3), path("insertFresh"));
    expectPath(insertVertex(kinded, 2, 0.5, 77), path("insertGiven"));
    expectPath(deleteVertices(kinded, [1]), path("delete"));
    expectPath(setVertexKind(kinded, 0, "smooth"), path("kindSmooth"));
    expectPath(setVertexKind(kinded, 1, "symmetric"), path("kindSymmetric"));
    expectPath(setVertexKind(kinded, 0, "auto"), path("kindAuto"));
    expectPath(setVertexKind(kinded, 2, "corner"), path("kindCorner"));
    expectPath(setHandle(kinded, 2, "out", v(10, 25), "smooth"), path("handleSmooth"));
    expectPath(setHandle(kinded, 1, "in", v(-7, 9), "none"), path("handleBreak"));
    expectPath(reshapeSegment(kinded, 2, 0.4, v(6, -9)), path("reshape"));
    expectPath(convertVertex(kinded, 3), path("convert"));
    expectPath(setAutoTension(kinded, 0.25), path("tension"));
    const keep = kinds.keep as { path: BezierPath; deviation: number };
    const fit = fitDeleteVertex(kinded, 1)!;
    expectPath(fit.path, keep.path, 6);
    expect(fit.deviation).toBeCloseTo(keep.deviation, 6);
  });

  it("measures the same bounds, from the drawn path", () => {
    const control = kinds.controlBounds as [number, number, number, number];
    const got = controlBounds(kinded)!;
    [got.minX, got.minY, got.maxX, got.maxY].forEach((n, i) => expect(n).toBeCloseTo(control[i]!, 9));
    const drawn = kinds.pathBounds as [number, number, number, number];
    const exact = pathBounds(kinded)!;
    [exact.minX, exact.minY, exact.maxX, exact.maxY].forEach((n, i) => expect(n).toBeCloseTo(drawn[i]!, 6));
  });
});

describe("ids and kinds, on their own terms", () => {
  it("writes a vertex out before an edit reads it, and keeps the other auto vertices auto", () => {
    const written = materialiseAt(kinded, [2]);
    expect(written.vertexKinds![2]).toBe("smooth");
    expect(written.outTangents[2]).toEqual(deriveAutoHandles(kinded, 2).out);
    expect(materialiseAt(setVertexKind(kinded, 0, "auto")!, [2]).vertexKinds![0]).toBe("auto");
    // An edit whose result is refused says why, by name.
    expect(setVertexKind(kinded, 0, "corner")).toBeUndefined();
    expect(whyNot).toBe("it is that kind already");
    expect(insertVertex(kinded, 0, 0.5, 20)).toBeUndefined();
    expect(whyNot).toBe("that vertex id is taken");
    expect(setAutoTension(kinded, 2)).toBeUndefined();
  });

  it("names ids by index when a path has none, and compares topology by them", () => {
    const old: BezierPath = { closed: true, vertices: [v(0, 0), v(1, 0), v(1, 1)], inTangents: [v(0, 0), v(0, 0), v(0, 0)], outTangents: [v(0, 0), v(0, 0), v(0, 0)] };
    expect(idsOf(old)).toEqual([0, 1, 2]);
    expect(kindsOf(old)).toEqual(["corner", "corner", "corner"]);
    expect(freshId(old)).toBe(3);
    expect(sameTopology(old, withIds(old))).toBe(true);
    expect(sameTopology(old, { ...old, closed: false })).toBe(false);
    expect(sameTopology(withIds(old), { ...old, vertexIds: [0, 2, 1] })).toBe(false);
    // An old path stays free of the new fields through an edit.
    const moved = insertVertex(old, 0, 0.5)!;
    expect(moved.vertexIds).toBeUndefined();
    expect(moved.vertexKinds).toBeUndefined();
  });
});

describe("a path channel at a frame, the same as the backend", () => {
  it("blends, eases and holds as the backend does", () => {
    for (const expected of animated.frames) {
      const got = evaluatePathChannel(animated.channel, expected.frame)!;
      expectPath(got.path, expected.path);
      expect(got.held ?? null).toBe(expected.held);
    }
  });

  it("holds before the first key and after the last, and says nothing for a channel without keys", () => {
    expect(evaluatePathChannel({ ...animated.channel, keys: [] }, 5)).toBeUndefined();
    const first = animated.channel.keys[0]!;
    expect(evaluatePathChannel(animated.channel, 0)!.path).toEqual(first.path);
    expect(lerpPaths(first.path, { ...first.path, closed: false }, 0.5)).toBeUndefined();
  });

  it("reads a track's name as a target and back", () => {
    for (const target of [{ kind: "shape", subpath: 0 }, { kind: "shape", subpath: 2 }, { kind: "mask", index: 1 }] as const) {
      expect(targetOfField(targetField(target))).toEqual(target);
    }
    expect(targetOfField("opacity")).toBeUndefined();
  });

  it("gives the path at the playhead of a scene: the channel's, with its auto handles drawn", () => {
    const base = animated.channel.keys[0]!.path;
    const object = { id: "s", name: "S", type: "shape", path: base } as unknown as SceneObject;
    const document = {
      timeline: { durationFrames: 100n, channels: [], phases: [], pathChannels: [{ ...animated.channel, objectId: "s" }] },
      objects: [object],
    } as unknown as SceneDocument;
    const target = { kind: "shape", subpath: 0 } as const;
    expect(pathChannelOf(document, "s", target)).toBeDefined();
    const drawn = drawnPathAtFrame(document, object, target, 5)!;
    const want = animated.frames.find((f) => f.frame === 5)!.path;
    expectPath(effective(want), drawn);
    expect(pathChannelOf(document, "other", target)).toBeUndefined();
  });
});
