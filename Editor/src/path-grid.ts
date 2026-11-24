// A spatial index over the segments of one path (plan row 11.115, Pen spec 16: hover nearest point p95 under 2 ms at 10,000 vertices).
//
// A segment lies inside the box of its four control points, so a uniform grid of those boxes finds every segment a point can be near
// without testing the others. The grid is built once per path (a path is never changed in place, so its object identity is its version)
// and a query returns the segments whose cells the pointer's box touches, in ascending order, so the nearest hit and its tie-breaking are
// exactly the plain scan's. Paths below `GRID_FROM` segments are not indexed: the plain scan is as fast and has nothing to build.

import type { BezierPath } from "@grapix/contracts";
import { effective, segmentCount } from "./path-geometry";

/** Paths with fewer segments than this are scanned plainly. */
export const GRID_FROM = 256;

/** A segment whose box spans more cells than this is kept in a list every query returns, so one long curve cannot fill the grid. */
const MOST_CELLS = 64;

interface SegmentGrid {
  readonly minX: number;
  readonly minY: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly cells: ReadonlyMap<number, readonly number[]>;
  readonly always: readonly number[];
}

const grids = new WeakMap<BezierPath, SegmentGrid>();

function build(path: BezierPath): SegmentGrid {
  const drawn = effective(path);
  const n = segmentCount(drawn);
  const boxes = new Float64Array(n * 4);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let s = 0; s < n; s += 1) {
    const a = drawn.vertices[s]!;
    const b = drawn.vertices[(s + 1) % drawn.vertices.length]!;
    const o = drawn.outTangents[s]!;
    const i = drawn.inTangents[(s + 1) % drawn.vertices.length]!;
    const xs = [a.x, a.x + o.x, b.x + i.x, b.x];
    const ys = [a.y, a.y + o.y, b.y + i.y, b.y];
    boxes[s * 4] = Math.min(...xs);
    boxes[s * 4 + 1] = Math.min(...ys);
    boxes[s * 4 + 2] = Math.max(...xs);
    boxes[s * 4 + 3] = Math.max(...ys);
    minX = Math.min(minX, boxes[s * 4]!);
    minY = Math.min(minY, boxes[s * 4 + 1]!);
    maxX = Math.max(maxX, boxes[s * 4 + 2]!);
    maxY = Math.max(maxY, boxes[s * 4 + 3]!);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cell = span / side;
  const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
  const cells = new Map<number, number[]>();
  const always: number[] = [];
  for (let s = 0; s < n; s += 1) {
    const c0 = Math.floor((boxes[s * 4]! - minX) / cell);
    const r0 = Math.floor((boxes[s * 4 + 1]! - minY) / cell);
    const c1 = Math.floor((boxes[s * 4 + 2]! - minX) / cell);
    const r1 = Math.floor((boxes[s * 4 + 3]! - minY) / cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MOST_CELLS) {
      always.push(s);
      continue;
    }
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const key = r * cols + c;
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [s]);
        else list.push(s);
      }
    }
  }
  return { minX, minY, cell, cols, rows, cells, always };
}

/** The segments of `path` whose control box could hold a point within `radius` of `(x, y)` (all in the path's own space), ascending.
 *  `undefined` when the path is too small to be worth indexing: the caller scans every segment. */
export function segmentsNear(path: BezierPath, x: number, y: number, radius: number): number[] | undefined {
  if (segmentCount(path) < GRID_FROM) return undefined;
  let grid = grids.get(path);
  if (grid === undefined) {
    grid = build(path);
    grids.set(path, grid);
  }
  const c0 = Math.max(0, Math.floor((x - radius - grid.minX) / grid.cell));
  const r0 = Math.max(0, Math.floor((y - radius - grid.minY) / grid.cell));
  const c1 = Math.min(grid.cols - 1, Math.floor((x + radius - grid.minX) / grid.cell));
  const r1 = Math.min(grid.rows - 1, Math.floor((y + radius - grid.minY) / grid.cell));
  const found = new Set<number>(grid.always);
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      for (const s of grid.cells.get(r * grid.cols + c) ?? []) found.add(s);
    }
  }
  return [...found].sort((a, b) => a - b);
}
