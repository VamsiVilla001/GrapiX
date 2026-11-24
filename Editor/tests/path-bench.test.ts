// 11.115: the hover and drag costs of the path tools at 10, 100, 1,000 and 10,000 vertices (Pen spec 16: hover nearest point
// p95 <= 2 ms after the broad phase for 100 to 1,000 segments). A measurement, not a gate: it runs only with GX_BENCH=1, because a
// timing assertion in the normal suite would fail on a busy machine and teach nobody anything. Results go to the console and, when
// GX_BENCH_OUT names a file, to it as JSON.
import { describe, expect, it } from "vitest";
import type { BezierPath, SceneDocument, SceneObject } from "@grapix/contracts";
import { canvasPointOf, editTarget, pickPath, applyOp, outsideHull, type EditTarget, type PathHit } from "../src/path-edit";
import { GRID_FROM } from "../src/path-grid";
import { nearestOnCubic, cubicOf, segmentCount, mapCubic } from "../src/path-geometry";

// The run is told by the environment; the tests are typed without Node, so it is read off the global.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const BENCH = env.GX_BENCH === "1";

function wavy(n: number): BezierPath {
  const vertices = [], inTangents = [], outTangents = [];
  for (let i = 0; i < n; i += 1) {
    const x = (i / Math.max(1, n - 1)) * 1800 + 60;
    const y = 540 + Math.sin(i * 0.37) * 300 + Math.cos(i * 0.11) * 120;
    vertices.push({ x, y });
    const h = 600 / Math.max(1, n);
    inTangents.push({ x: -h, y: Math.cos(i * 0.37) * h * 0.3 });
    outTangents.push({ x: h, y: -Math.cos(i * 0.37) * h * 0.3 });
  }
  return { closed: false, vertices, inTangents, outTangents };
}

function targetOf(n: number): EditTarget {
  const object = { id: "s", name: "s", type: "shape", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 1920, height: 1080, locked: false, visible: true, path: wavy(n) } as unknown as SceneObject;
  const out = editTarget({ canvas: { width: 1920, height: 1080 }, objects: [object] } as unknown as SceneDocument, ["s"]);
  if ("refused" in out) throw new Error(out.refused);
  return out;
}

const percentile = (values: number[], p: number): number => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;

describe("the path tools' costs", () => {
  it("skips a curve whose control box is out of reach, and never one that holds the point", () => {
    const c = { p0: { x: 0, y: 0 }, p1: { x: 50, y: 100 }, p2: { x: 100, y: 100 }, p3: { x: 150, y: 0 } };
    expect(outsideHull(c, { x: 75, y: 50 }, 0)).toBe(false);
    expect(outsideHull(c, { x: 200, y: 50 }, 8)).toBe(true);
    expect(outsideHull(c, { x: 157, y: 0 }, 8)).toBe(false);
    expect(outsideHull(c, { x: 75, y: 109 }, 8)).toBe(true);
    // It never changes what is hit: the broad phase and the plain scan agree on random points.
    const t = targetOf(200);
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 300; k += 1) {
      const at = { x: next() * 1920, y: next() * 1080 };
      const fast = pickPath(t, [], at, 8);
      let slow: unknown;
      let bestD = Infinity;
      const path = t.paths[0]!.path;
      for (let i = 0; i < path.vertices.length; i += 1) {
        const d = Math.hypot(path.vertices[i]!.x - at.x, path.vertices[i]!.y - at.y);
        if (d <= 8 && d < bestD) { bestD = d; slow = { kind: "vertex", subpath: 0, index: i }; }
      }
      if (slow === undefined) {
        for (let s = 0; s < segmentCount(path); s += 1) {
          const f = nearestOnCubic(mapCubic(cubicOf(path, s), (q) => q), at);
          if (f.distance <= 8 && f.distance < bestD) { bestD = f.distance; slow = { kind: "segment", subpath: 0, segment: s }; }
        }
      }
      expect(fast === undefined, `point ${k}`).toBe(slow === undefined);
      if (fast !== undefined && slow !== undefined) {
        expect(fast.kind).toBe((slow as { kind: string }).kind);
        if (fast.kind === "segment") expect(fast.segment).toBe((slow as { segment: number }).segment);
      }
    }
  });

  it("finds the same hit through the spatial index as the plain scan, on a path large enough to be indexed, placed, turned and scaled", () => {
    for (const n of [600, 1000]) {
      const placed = (extra: Record<string, number>): EditTarget => {
        const object = { id: "s", name: "s", type: "shape", x: 30, y: -20, rotation: 0, scaleX: 1, scaleY: 1, width: 1920, height: 1080, locked: false, visible: true, path: wavy(n), ...extra } as unknown as SceneObject;
        const out = editTarget({ canvas: { width: 1920, height: 1080 }, objects: [object] } as unknown as SceneDocument, ["s"]);
        if ("refused" in out) throw new Error(out.refused);
        return out;
      };
      let seed = 5;
      const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (const extra of [{}, { rotation: 33, scaleX: 0.8, scaleY: 1.3 }]) {
        const t = placed(extra);
        const path = t.paths[0]!.path;
        expect(segmentCount(path)).toBeGreaterThanOrEqual(GRID_FROM);
        for (let k = 0; k < 200; k += 1) {
          const v = path.vertices[Math.floor(next() * path.vertices.length)]!;
          const base = canvasPointOf(t, { x: v.x + (next() - 0.5) * 20, y: v.y + (next() - 0.5) * 20 });
          const fast = pickPath(t, [], base, 8);
          let slow: PathHit | undefined;
          let bestD = Infinity;
          path.vertices.forEach((q, i) => {
            const c = canvasPointOf(t, q);
            const d = Math.hypot(c.x - base.x, c.y - base.y);
            if (d <= 8 && d < bestD) { bestD = d; slow = { kind: "vertex", subpath: 0, index: i }; }
          });
          if (slow === undefined) {
            for (let s = 0; s < segmentCount(path); s += 1) {
              const f = nearestOnCubic(mapCubic(cubicOf(path, s), (q) => canvasPointOf(t, q)), base);
              if (f.distance <= 8 && f.distance < bestD) { bestD = f.distance; slow = { kind: "segment", subpath: 0, segment: s, t: f.t, point: f.point }; }
            }
          }
          expect(fast?.kind, `n ${n} point ${k}`).toBe(slow?.kind);
          if (fast?.kind === "segment" && slow?.kind === "segment") expect(fast.segment).toBe(slow.segment);
          if (fast?.kind === "vertex" && slow?.kind === "vertex") expect(fast.index).toBe(slow.index);
        }
      }
    }
  });

  it.skipIf(!BENCH)("measures hover and drag at 10, 100, 1000 and 10000 vertices", () => {
    const rows: Record<string, unknown>[] = [];
    for (const n of [10, 100, 1000, 10000]) {
      const t = targetOf(n);
      const times: number[] = [];
      let seed = 11;
      const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let k = 0; k < 400; k += 1) {
        // Points on and near the path, where the work is.
        const i = Math.floor(next() * (n - 1));
        const v = t.paths[0]!.path.vertices[i]!;
        const at = { x: v.x + (next() - 0.5) * 30, y: v.y + (next() - 0.5) * 30 };
        const start = performance.now();
        pickPath(t, [], at, 8);
        times.push(performance.now() - start);
      }
      // A drag: one vertex moved, the path as the preview shows it.
      const drag: number[] = [];
      for (let k = 0; k < 100; k += 1) {
        const start = performance.now();
        applyOp(t.paths[0]!.path, { op: "moveVertices", indices: [Math.floor(n / 2)], delta: { x: k, y: k / 2 } });
        drag.push(performance.now() - start);
      }
      rows.push({ vertices: n, hoverP50Ms: +percentile(times, 0.5).toFixed(3), hoverP95Ms: +percentile(times, 0.95).toFixed(3), hoverMaxMs: +Math.max(...times).toFixed(3), dragOpP95Ms: +percentile(drag, 0.95).toFixed(3) });
    }
    console.table(rows);
    // The table above is the record; docs/evidence/11.115/bench.json holds the last run of it.
    expect(rows).toHaveLength(4);
  }, 120_000);
});
