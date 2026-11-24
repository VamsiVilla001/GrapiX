// The Editor's path maths (Editor/src/path-geometry.ts) held to the backend's (Shared/contracts/src/path_geometry.rs):
// the shared fixture holds the Rust answers, and every number and edit here must come out the same.
import { describe, expect, it } from "vitest";
import type { BezierPath } from "@grapix/contracts";
import fixture from "../../Shared/contracts/fixtures/path-geometry.json";
import {
  arcLength,
  convertVertex,
  cubicBounds,
  cubicOf,
  cubicsOf,
  curvatureAt,
  deleteVertex,
  deleteKeepShape,
  deleteVertices as deleteVerticesOf,
  fitDeleteVertex,
  hasHandles,
  insertVertex,
  isSmooth,
  isStraight,
  joinPaths,
  moveVertices,
  nearestOnCubic,
  nearestOnPath,
  pathBounds,
  pathIsValid,
  pathLengths,
  pointAt,
  reshapeSegment,
  reversePath,
  segmentCount,
  setClosed,
  setFirstVertex,
  setHandle,
  snapAngle,
  splitCubic,
  tAtLength,
  tangentAt,
  whyNot,
  type Cubic,
  type Pt,
} from "../src/path-geometry";

const { cubics, edits } = fixture as unknown as { cubics: FixtureCubic[]; edits: Record<string, BezierPath> };
interface FixtureCubic {
  cubic: [Pt, Pt, Pt, Pt];
  q: Pt;
  distance: number;
  bounds: [number, number, number, number];
  length: number;
  curvature: number;
}
const asCubic = ([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt]): Cubic => ({ p0, p1, p2, p3 });
const v = (x: number, y: number): Pt => ({ x, y });
const wave = edits.wave!;
const blob = edits.blob!;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function expectPath(actual: BezierPath | undefined, expected: BezierPath) {
  expect(actual).toBeDefined();
  expect(actual!.closed).toBe(expected.closed);
  for (const key of ["vertices", "inTangents", "outTangents"] as const) {
    expect(actual![key]).toHaveLength(expected[key].length);
    actual![key].forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[key][i]!.x, 9);
      expect(p.y).toBeCloseTo(expected[key][i]!.y, 9);
    });
  }
}

/** Every point of `a` lies on `b`, and the outlines are as long. */
function sameOutline(a: BezierPath, b: BezierPath) {
  for (const c of cubicsOf(a)) {
    for (let k = 0; k <= 20; k++) expect(nearestOnPath(b, pointAt(c, k / 20))!.distance).toBeLessThan(1e-6);
  }
  expect(pathLengths(a, 1e-9).total).toBeCloseTo(pathLengths(b, 1e-9).total, 5);
}

describe("the same numbers as the backend", () => {
  it("finds the same nearest distance, bounds, length and curvature for 40 curves", () => {
    for (const f of cubics) {
      const c = asCubic(f.cubic);
      expect(nearestOnCubic(c, f.q).distance).toBeCloseTo(f.distance, 6);
      const b = cubicBounds(c);
      [b.minX, b.minY, b.maxX, b.maxY].forEach((n, i) => expect(n).toBeCloseTo(f.bounds[i]!, 6));
      expect(arcLength(c, 0, 1, 1e-9)).toBeCloseTo(f.length, 5);
      expect(curvatureAt(c, 0.3)).toBeCloseTo(f.curvature, 9);
    }
  });

  it("makes the same edits", () => {
    expectPath(insertVertex(wave, 1, 0.4), edits.insertWave!);
    expectPath(insertVertex(blob, 3, 0.6), edits.insertBlobClosing!);
    expectPath(deleteVertex(blob, 1), edits.deleteBlob!);
    expectPath(convertVertex(blob, 2), edits.convertBlob!);
    expectPath(convertVertex(wave, 1), edits.convertWave!);
    expectPath(setHandle(wave, 1, "out", v(10, 25), "smooth"), edits.handleSmooth!);
    expectPath(setHandle(wave, 1, "in", v(7, 9), "mirror"), edits.handleMirror!);
    expectPath(moveVertices(wave, [0, 2], v(3.5, -2)), edits.moveWave!);
    expectPath(reshapeSegment(wave, 1, 0.35, v(12, -7)), edits.reshapeWave!);
    expectPath(reversePath(wave), edits.reverseWave!);
    expectPath(reversePath(blob), edits.reverseBlob!);
    expectPath(setFirstVertex(blob, 3), edits.firstBlob!);
  });

  it("fits one curve over two the way the Rust fit does (11.113), to within the iteration's own noise", () => {
    const cases: [string, BezierPath, number][] = [["keepWave", wave, 1], ["keepBlob", blob, 2], ["keepSplit", insertVertex(blob, 1, 0.4)!, 2]];
    for (const [name, path, index] of cases) {
      const fit = fitDeleteVertex(path, index)!;
      const expected = (edits as unknown as Record<string, { path: BezierPath; deviation: number }>)[name]!;
      expect(fit.path.vertices).toHaveLength(expected.path.vertices.length);
      // The two fits are the same algorithm; floating point differs only in the last places, which the 60 iterations can
      // magnify a little, so the comparison is to a thousandth of a unit.
      for (const key of ["vertices", "inTangents", "outTangents"] as const) {
        fit.path[key].forEach((p, i) => {
          expect(Math.abs(p.x - expected.path[key][i]!.x), `${name} ${key}[${i}].x`).toBeLessThan(1e-3);
          expect(Math.abs(p.y - expected.path[key][i]!.y), `${name} ${key}[${i}].y`).toBeLessThan(1e-3);
        });
      }
      expect(Math.abs(fit.deviation - expected.deviation), name).toBeLessThan(1e-3);
    }
  });

  it("keeps the shape only within the tolerance, refusing by name, and takes the end of an open path out exactly", () => {
    const corner: BezierPath = { closed: false, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], inTangents: [v(0, 0), v(0, 0), v(0, 0)], outTangents: [v(0, 0), v(0, 0), v(0, 0)] };
    expect(deleteKeepShape(corner, 1, 1)).toBeUndefined();
    expect(whyNot).toBe("taking that vertex out would change the shape by more than the tolerance");
    expect(deleteKeepShape(corner, 1, 100)!.vertices).toHaveLength(2);
    expect(deleteKeepShape(corner, 1, -1)).toBeUndefined();
    expect(whyNot).toBe("the tolerance must be a distance of zero or more");
    expect(fitDeleteVertex(corner, 0)).toEqual({ path: deleteVertex(corner, 0), deviation: 0 });
    expect(fitDeleteVertex(corner, 7)).toBeUndefined();
    const split = insertVertex(wave, 0, 0.5)!;
    expect(fitDeleteVertex(split, 1)!.deviation).toBeLessThan(0.5);
  });
});

/** A small deterministic generator. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const randomCubic = (next: () => number): Cubic => {
  const p = () => v((next() - 0.5) * 400, (next() - 0.5) * 400);
  return { p0: p(), p1: p(), p2: p(), p3: p() };
};

describe("curves", () => {
  it("start and end on their vertices", () => {
    const next = rng(1);
    for (let i = 0; i < 30; i++) {
      const c = randomCubic(next);
      expect(pointAt(c, 0)).toEqual(c.p0);
      expect(pointAt(c, 1)).toEqual(c.p3);
    }
  });

  it("split into two halves that are the same curve", () => {
    const next = rng(2);
    for (let i = 0; i < 30; i++) {
      const c = randomCubic(next);
      const t = 0.05 + 0.9 * next();
      const { left, right } = splitCubic(c, t);
      for (let k = 0; k <= 20; k++) {
        const u = k / 20;
        const part = u <= t ? pointAt(left, u / t) : pointAt(right, (u - t) / (1 - t));
        expect(dist(pointAt(c, u), part)).toBeLessThan(1e-9);
      }
    }
  });

  it("have a nearest point that is the global minimum, also for a loop, a cusp and a point", () => {
    const next = rng(4);
    const cases: Cubic[] = [
      { p0: v(0, 0), p1: v(300, 200), p2: v(-200, 200), p3: v(100, 0) },
      { p0: v(0, 0), p1: v(100, 100), p2: v(0, 100), p3: v(100, 0) },
      { p0: v(5, 5), p1: v(5, 5), p2: v(5, 5), p3: v(5, 5) },
      ...Array.from({ length: 60 }, () => randomCubic(next)),
    ];
    for (const c of cases) {
      for (const q of [v(50, 60), v(50, 300), v(-80, 20), v(5, 5), v((next() - 0.5) * 600, (next() - 0.5) * 600)]) {
        const found = nearestOnCubic(c, q);
        let dense = Infinity;
        for (let k = 0; k <= 8000; k++) dense = Math.min(dense, dist(pointAt(c, k / 8000), q));
        expect(found.distance).toBeLessThanOrEqual(dense + 1e-9);
        expect(dist(pointAt(c, found.t), found.point)).toBeLessThan(1e-12);
      }
    }
  });

  it("have exact bounds", () => {
    const next = rng(5);
    for (let i = 0; i < 20; i++) {
      const c = randomCubic(next);
      const b = cubicBounds(c);
      let lowX = Infinity;
      let highX = -Infinity;
      for (let k = 0; k <= 4000; k++) {
        const p = pointAt(c, k / 4000);
        expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
        expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9);
        lowX = Math.min(lowX, p.x);
        highX = Math.max(highX, p.x);
      }
      expect(lowX).toBeCloseTo(b.minX, 2);
      expect(highX).toBeCloseTo(b.maxX, 2);
    }
    expect(pathBounds({ closed: false, vertices: [], inTangents: [], outTangents: [] })).toBeUndefined();
    expect(pathBounds(blob)!.minX).toBeLessThan(0);
  }, 30_000);

  it("have a length that a reversed path shares, and a length to parameter that undoes it", () => {
    expect(pathLengths(wave, 1e-9).total).toBeCloseTo(pathLengths(reversePath(wave), 1e-9).total, 6);
    const c = cubicOf(wave, 0);
    const whole = arcLength(c);
    expect(arcLength(c, 0, 0.5) + arcLength(c, 0.5, 1)).toBeCloseTo(whole, 5);
    expect(arcLength(c, 0.7, 0.2)).toBe(0);
    const t = tAtLength(c, whole / 3);
    expect(arcLength(c, 0, t)).toBeCloseTo(whole / 3, 4);
    expect(tAtLength(c, -1)).toBe(0);
    expect(tAtLength(c, whole * 2)).toBe(1);
  });

  it("never give NaN for a repeated control point", () => {
    const point: Cubic = { p0: v(5, 5), p1: v(5, 5), p2: v(5, 5), p3: v(5, 5) };
    expect(curvatureAt(point, 0.5)).toBe(0);
    expect(tangentAt(point, 0.5)).toBeUndefined();
    const corner: Cubic = { p0: v(0, 0), p1: v(0, 0), p2: v(10, 0), p3: v(10, 0) };
    expect(tangentAt(corner, 0)!.x).toBeCloseTo(1, 12);
    expect(isStraight(corner)).toBe(true);
    expect(isStraight({ p0: v(0, 0), p1: v(3, 4), p2: v(6, 0), p3: v(10, 0) })).toBe(false);
  });
});

describe("edits", () => {
  it("insert a vertex without changing the curve, and refuse a vertex that is there", () => {
    for (const path of [wave, blob]) {
      for (let s = 0; s < segmentCount(path); s++) {
        for (const t of [0.2, 0.5, 0.83]) {
          const next = insertVertex(path, s, t)!;
          expect(next.vertices).toHaveLength(path.vertices.length + 1);
          sameOutline(path, next);
          sameOutline(next, path);
          expect(pathIsValid(next)).toBe(true);
        }
      }
    }
    expect(insertVertex(wave, 0, 0)).toBeUndefined();
    expect(whyNot).toBe("that is a vertex already");
    expect(insertVertex(wave, 0, 1)).toBeUndefined();
    expect(insertVertex(wave, 0, Number.NaN)).toBeUndefined();
    expect(insertVertex(wave, 2, 0.5)).toBeUndefined();
    expect(whyNot).toBe("there is no such segment");
  });

  it("delete a vertex but keep the least a path needs", () => {
    const next = deleteVertex(wave, 1)!;
    expect(next.vertices).toEqual([v(0, 0), v(200, 50)]);
    expect(deleteVertex(next, 0)).toBeUndefined();
    expect(whyNot).toBe("a path keeps two vertices");
    expect(deleteVertex(blob, 9)).toBeUndefined();
    expect(whyNot).toBe("there is no such vertex");
    const triangle = deleteVertex(blob, 3)!;
    expect(deleteVertex(triangle, 0)).toBeUndefined();
    expect(whyNot).toBe("a closed path keeps three vertices");
  });

  it("convert a corner to smooth and back", () => {
    const smooth = convertVertex(blob, 2)!;
    expect(isSmooth(smooth, 2)).toBe(true);
    expect(hasHandles(smooth, 2)).toBe(true);
    const back = convertVertex(smooth, 2)!;
    expect(hasHandles(back, 2)).toBe(false);
    const open: BezierPath = { closed: false, vertices: [v(0, 0), v(30, 0)], inTangents: [v(0, 0), v(0, 0)], outTangents: [v(0, 0), v(0, 0)] };
    expect(convertVertex(open, 0)!.outTangents[0]!.x).toBeCloseTo(10, 12);
    expect(convertVertex({ ...open, vertices: [v(0, 0), v(0, 0)] }, 0)).toBeUndefined();
    expect(whyNot).toBe("its neighbours are on top of it");
    expect(convertVertex(open, 2)).toBeUndefined();
  });

  it("move a handle alone, in line or mirrored", () => {
    expect(setHandle(wave, 1, "out", v(0, 50))!.inTangents[1]).toEqual(wave.inTangents[1]);
    const smooth = setHandle(wave, 1, "out", v(0, 10), "smooth")!;
    expect(smooth.inTangents[1]!.x).toBeCloseTo(0, 9);
    expect(smooth.inTangents[1]!.y).toBeCloseTo(-50, 9);
    const mirror = setHandle(wave, 1, "out", v(7, 9), "mirror")!;
    expect(mirror.inTangents[1]).toEqual(v(-7, -9));
    expect(setHandle(wave, 1, "out", v(0, 0), "smooth")!.inTangents[1]).toEqual(wave.inTangents[1]);
    expect(setHandle(wave, 1, "out", v(Number.NaN, 0))).toBeUndefined();
    expect(whyNot).toBe("a handle must be a finite point");
    expect(setHandle(wave, 7, "out", v(1, 1))).toBeUndefined();
  });

  it("move vertices with their handles, and refuse what is not finite", () => {
    const next = moveVertices(wave, [1, 1, 2], v(5, -5))!;
    expect(next.vertices).toEqual([v(0, 0), v(105, -5), v(205, 45)]);
    expect(next.inTangents).toEqual(wave.inTangents);
    expect(moveVertices(wave, [0], v(Number.POSITIVE_INFINITY, 0))).toBeUndefined();
    expect(whyNot).toBe("a move must be a finite distance");
  });

  it("reshape a segment so the grabbed point follows the pointer exactly", () => {
    for (const [path, segment] of [[wave, 0], [wave, 1], [blob, 3]] as const) {
      for (const t of [0.25, 0.5, 0.7]) {
        const before = pointAt(cubicOf(path, segment), t);
        const next = reshapeSegment(path, segment, t, v(12, -7))!;
        const after = pointAt(cubicOf(next, segment), t);
        expect(dist(after, v(before.x + 12, before.y - 7))).toBeLessThan(1e-9);
        expect(next.vertices).toEqual(path.vertices);
      }
    }
    expect(isSmooth(reshapeSegment(wave, 1, 0.5, v(0, 30))!, 1)).toBe(true);
    expect(reshapeSegment(wave, 0, 0, v(1, 1))).toBeUndefined();
    expect(whyNot).toBe("grab the curve between its vertices");
  });

  it("reverse, restart and close without changing the outline", () => {
    for (const path of [wave, blob]) {
      sameOutline(path, reversePath(path));
      expectPath(reversePath(reversePath(path)), path);
    }
    sameOutline(blob, setFirstVertex(blob, 2)!);
    expect(setFirstVertex(wave, 1)).toBeUndefined();
    expect(setFirstVertex(blob, 4)).toBeUndefined();
    expect(setClosed(wave, true)!.closed).toBe(true);
    expect(setClosed(blob, false)!.closed).toBe(false);
    expect(setClosed(deleteVertex(wave, 1)!, true)).toBeUndefined();
    expect(whyNot).toBe("a closed path needs three vertices");
  });

  it("snap an angle to the step asked for", () => {
    const at = snapAngle(v(0, 0), v(100, 30), 15);
    expect(Math.atan2(at.y, at.x)).toBeCloseTo((15 * Math.PI) / 180, 9);
    expect(Math.hypot(at.x, at.y)).toBeCloseTo(Math.hypot(100, 30), 9);
    expect(snapAngle(v(0, 0), v(5, 5), 0)).toEqual(v(5, 5));
    expect(snapAngle(v(1, 1), v(1, 1), 15)).toEqual(v(1, 1));
  });
});

describe("the gaps the mutants found", () => {
  it("finds the turning point of a coordinate whose derivative is linear", () => {
    // x has a second difference of nil, so its derivative is a straight line with one root at 0.75, beyond both ends' values.
    const c: Cubic = { p0: v(0, 0), p1: v(3, 0), p2: v(4, 0), p3: v(3, 0) };
    let top = -Infinity;
    for (let k = 0; k <= 10000; k++) top = Math.max(top, pointAt(c, k / 10000).x);
    expect(top).toBeGreaterThan(3.1);
    expect(cubicBounds(c).maxX).toBeCloseTo(top, 6);
  });

  it("refuses to delete no vertex", () => {
    expect(deleteVertex(wave, 9)).toBeUndefined();
    expect(deleteVerticesOf(wave, [])).toBeUndefined();
    expect(whyNot).toBe("there is no such vertex");
  });

  it("calls a vertex smooth only when both handles are there and opposite", () => {
    const z = v(0, 0);
    const make = (a: Pt, b: Pt): BezierPath => ({ closed: false, vertices: [v(0, 0), v(50, 0)], inTangents: [a, z], outTangents: [b, z] });
    expect(isSmooth(make(v(-10, 0), v(20, 0)), 0)).toBe(true);
    // In line but on the same side: a point that doubles back is not smooth.
    expect(isSmooth(make(v(10, 0), v(20, 0)), 0)).toBe(false);
    // A handle that is no handle (a hair long) does not make a smooth point, though it is in line.
    expect(isSmooth(make(v(-1e-7, 0), v(20, 0)), 0)).toBe(false);
    expect(isSmooth(make(z, v(20, 0)), 0)).toBe(false);
  });

  it("calls a segment straight only when both inner control points are on the chord", () => {
    expect(isStraight({ p0: v(0, 0), p1: v(3, 0), p2: v(6, 5), p3: v(10, 0) })).toBe(false);
    expect(isStraight({ p0: v(0, 0), p1: v(3, 4), p2: v(6, 0), p3: v(10, 0) })).toBe(false);
    expect(isStraight({ p0: v(0, 0), p1: v(3, 0), p2: v(6, 0), p3: v(10, 0) })).toBe(true);
    expect(isStraight({ p0: v(5, 5), p1: v(5, 5), p2: v(5, 5), p3: v(5, 5) })).toBe(true);
  });

  it("checks a path's arrays agree and are finite", () => {
    expect(pathIsValid(wave)).toBe(true);
    expect(pathIsValid({ ...wave, inTangents: wave.inTangents.slice(1) })).toBe(false);
    expect(pathIsValid({ ...wave, outTangents: [...wave.outTangents, v(0, 0)] })).toBe(false);
    expect(pathIsValid({ ...wave, vertices: [v(0, 0), v(Number.NaN, 1), v(2, 2)] })).toBe(false);
  });

  it("gives nothing for a length of nothing and the whole for more than the whole", () => {
    const c = cubicOf(wave, 0);
    expect(tAtLength(c, 0)).toBe(0);
    expect(tAtLength(c, arcLength(c))).toBe(1);
  });
});

describe("joining open paths keeps both where they are (11.110)", () => {
  const line = (xs: number[], y = 0): BezierPath => ({ closed: false, vertices: xs.map((x) => ({ x, y })), inTangents: xs.map(() => ({ x: 0, y: 0 })), outTangents: xs.map(() => ({ x: 0, y: 0 })) });
  it("makes one vertex of two ends within the merge distance, and keeps every vertex when they are further apart", () => {
    const merged = joinPaths(line([0, 50, 100]), line([100.3, 150, 200]))!;
    expect(merged.vertices.map((v) => v.x)).toEqual([0, 50, 100, 150, 200]);
    const apart = joinPaths(line([0, 50, 100]), line([103, 150, 200]))!;
    expect(apart.vertices.map((v) => v.x)).toEqual([0, 50, 100, 103, 150, 200]);
    // The handles at the meeting ends are the ones they had.
    const a = { ...line([0, 100]), outTangents: [{ x: 0, y: 0 }, { x: 7, y: 8 }] };
    const b = { ...line([160, 260]), inTangents: [{ x: -3, y: -4 }, { x: 0, y: 0 }] };
    const kept = joinPaths(a, b)!;
    expect(kept.outTangents[1]).toEqual({ x: 7, y: 8 });
    expect(kept.inTangents[2]).toEqual({ x: -3, y: -4 });
    // A merged vertex takes the first path's incoming handle and the second's outgoing one.
    const c = { ...line([100, 200]), outTangents: [{ x: 5, y: 6 }, { x: 0, y: 0 }], inTangents: [{ x: 1, y: 1 }, { x: 0, y: 0 }] };
    const d = { ...line([0, 100]), inTangents: [{ x: 0, y: 0 }, { x: -2, y: -2 }], outTangents: [{ x: 0, y: 0 }, { x: 9, y: 9 }] };
    const both = joinPaths(d, c)!;
    expect(both.vertices).toHaveLength(3);
    expect(both.inTangents[1]).toEqual({ x: -2, y: -2 });
    expect(both.outTangents[1]).toEqual({ x: 5, y: 6 });
    expect(joinPaths({ ...line([0, 10, 20]), closed: true }, line([20, 30]))).toBeUndefined();
  });
});
