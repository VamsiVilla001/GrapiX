// What the Pivot panel shows for the selection (plan row 11.103): where the pivot is now, and which of the nine places on
// the box it sits on. Pure, so the words and the highlighted cell are held by tests; the page only draws them.

import type { SceneDocument } from "@grapix/contracts";
import { GRID } from "./anchor-point";
import { selectionRoots } from "./object-manager";
import { localBox } from "./overlay";

export interface PivotView {
  /** `none`: nothing usable is selected. `one`: a single object. `many`: several. */
  readonly kind: "none" | "one" | "many";
  /** One line for the panel. */
  readonly summary: string;
  /** The pivot, in the object's own pixels; absent when the selected objects do not agree. */
  readonly x?: number;
  readonly y?: number;
  /** The place on the box the pivot is on, for one object (an id of `GRID`). */
  readonly place?: string;
}

const tidy = (value: number): number => Math.round(value * 100) / 100;
/** How close to a place on the box the pivot counts as being on it, in the object's own pixels. */
const ON_PLACE = 0.01;

export function pivotView(document: SceneDocument, selectedIds: readonly string[]): PivotView {
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const objects = selectionRoots(document, selectedIds).flatMap((id) => {
    const object = byId.get(id);
    return object === undefined ? [] : [object];
  });
  if (objects.length === 0) return { kind: "none", summary: "" };

  const points = objects.map((object) => ({ x: object.anchor?.x ?? 0, y: object.anchor?.y ?? 0 }));
  const sameX = points.every((p) => p.x === points[0]!.x);
  const sameY = points.every((p) => p.y === points[0]!.y);
  const x = sameX ? tidy(points[0]!.x) : undefined;
  const y = sameY ? tidy(points[0]!.y) : undefined;
  const where = (sameX ? `x ${tidy(points[0]!.x)}` : "x differs") + ", " + (sameY ? `y ${tidy(points[0]!.y)}` : "y differs");

  if (objects.length > 1) {
    return { kind: "many", summary: `${objects.length} items: pivot ${where}`, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
  }
  const object = objects[0]!;
  const box = localBox(object);
  const place =
    box === undefined
      ? undefined
      : GRID.find(
          (cell) =>
            Math.abs(points[0]!.x - (box.left + cell.fx * box.width)) <= ON_PLACE &&
            Math.abs(points[0]!.y - (box.top + cell.fy * box.height)) <= ON_PLACE,
        );
  return {
    kind: "one",
    summary: `${object.name}: pivot ${where}${place === undefined ? "" : ` (${place.label.toLowerCase()})`}`,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(place === undefined ? {} : { place: place.id }),
  };
}
