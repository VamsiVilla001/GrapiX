import { getMaterialBindingId, type SceneObject } from "@grapix/shared-types";
import { sortObjectsForRender } from "../../../rendering/sceneMaterial";
import { expandSearchMatches } from "./objectSearch";

/**
 * The panel's row projection: from a scene to the ordered rows it draws.
 *
 * One walker. The render used to recurse and `flatMap` its way through the same tree, which meant
 * the DOM order was defined by the traversal and nothing else could know it — so a keyboard model
 * or an `aria-posinset` had to guess at a second walk and drift from the first. `buildTreeRows`
 * flattens once and the render iterates the result, so the order, the indentation, the set metadata
 * and the navigation order are all the same list.
 */
export interface ObjectTreeNode {
  object: SceneObject;
  children: ObjectTreeNode[];
}

export interface LayerStack {
  layerId: string;
  objects: SceneObject[];
  roots: ObjectTreeNode[];
}

/**
 * The rows to draw, grouped by compositing band.
 *
 * A search keeps a match's **ancestors** and, for a matched container, its **descendants**. Filtering
 * the flat list first — which is what this used to do — showed a matched group as empty and promoted
 * a matched child to a root, so the panel reported a parentage the scene did not have. That was
 * merely confusing while the tree was read-only; with drag-and-drop it is a trap, because the author
 * drops against a structure that is not there.
 */
export function createLayerStacks(objects: SceneObject[], search: string): LayerStack[] {
  const visible = search ? expandSearchMatches(objects, search) : null;
  const filteredObjects = visible ? objects.filter((object) => visible.has(object.id)) : objects;
  const grouped = new Map<string, SceneObject[]>();

  for (const object of filteredObjects) {
    const layerId = object.layerId || "main";
    grouped.set(layerId, [...(grouped.get(layerId) ?? []), object]);
  }

  return [...grouped.entries()].map(([layerId, layerObjects]) => ({
    layerId,
    objects: sortObjectsForRender(layerObjects).reverse(),
    roots: createObjectTree(layerObjects)
  }));
}

export function createObjectTree(objects: SceneObject[]): ObjectTreeNode[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const childIds = new Set<string>();

  for (const object of objects) {
    if (object.type !== "group" && object.type !== "layer") continue;
    for (const childId of object.childIds) {
      if (byId.has(childId) && childId !== object.id) childIds.add(childId);
    }
  }

  const buildNode = (object: SceneObject, ancestors: Set<string>): ObjectTreeNode => {
    if ((object.type !== "group" && object.type !== "layer") || ancestors.has(object.id)) return { object, children: [] };
    const nextAncestors = new Set(ancestors).add(object.id);
    const children = object.childIds
      .map((childId) => byId.get(childId))
      .filter((child): child is SceneObject => Boolean(child))
      .map((child) => buildNode(child, nextAncestors));
    return { object, children };
  };

  const roots = sortObjectsForRender(objects.filter((object) => !childIds.has(object.id))).reverse();
  const nodes = roots.map((object) => buildNode(object, new Set()));
  const included = new Set<string>();
  const visit = (node: ObjectTreeNode) => {
    included.add(node.object.id);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);

  // Malformed cyclic legacy groups must remain inspectable instead of
  // disappearing from the table.
  for (const object of sortObjectsForRender(objects).reverse()) {
    if (!included.has(object.id)) nodes.push(buildNode(object, new Set()));
  }
  return nodes;
}

export function formatLayerName(layerId: string): string {
  if (layerId === "main") return "Main";
  return layerId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}


/** Cells every row has before the property columns: name, visibility, lock, status. */
export const FIXED_COLUMNS = 4;

/** A band header draws name, visibility, lock and a status spacer — and no property cells. */
const BAND_CELLS = 4;

/** A mask draws name, visibility, a lock spacer, its actions, and one cell spanning the columns. */
const MASK_CELLS = 5;

export type TreeRowKind = "band" | "object" | "mask";

/**
 * One drawn row, with everything a `treegrid` and a keyboard need to describe it.
 *
 * `level` is 1-based for `aria-level`: a band is 1, its root objects are 2. `depth` is the
 * indentation step the row's tree cell uses, which is *not* the same number — a mask is one level
 * below its object but drawn at a half step, and an object's depth is measured from its band.
 */
export interface TreeRow {
  /** `band:<layerId>`, an object id, or `<objectId>:<maskId>`. Unique across the panel. */
  id: string;
  kind: TreeRowKind;
  level: number;
  posInSet: number;
  setSize: number;
  /** True when the row can reveal something: child objects, masks, or a band's contents. */
  expandable: boolean;
  expanded: boolean;
  /** Indentation step for the tree cell. Bands are 0; a band's root objects are 0 as well. */
  depth: number;
  layerId: string;
  /**
   * How many cells this row actually draws.
   *
   * Rows are not all the same width, and the keyboard has to know: a band has no property cells, so
   * an author arrowing left from column 6 of an object row onto a band would otherwise spend four
   * presses walking an invisible index before anything moved.
   */
  cellCount: number;
  objectId?: string;
  maskId?: string;
}

/**
 * Flatten the bands into the rows the panel draws, in draw order.
 *
 * Masks come before child objects under the same parent, which is the order the panel has always
 * drawn them, and they share one set with those children: an object with two masks and one child
 * group has a set of three, because that is what a reader navigating it encounters.
 */
export function buildTreeRows(
  layers: readonly LayerStack[],
  collapsedIds: ReadonlySet<string>,
  propertyColumns: number
): TreeRow[] {
  const rows: TreeRow[] = [];

  layers.forEach((layer, bandIndex) => {
    const bandCollapsed = collapsedIds.has(layer.layerId);
    rows.push({
      id: `band:${layer.layerId}`,
      kind: "band",
      level: 1,
      posInSet: bandIndex + 1,
      setSize: layers.length,
      expandable: layer.roots.length > 0,
      expanded: !bandCollapsed,
      depth: 0,
      layerId: layer.layerId,
      cellCount: BAND_CELLS
    });
    if (bandCollapsed) return;
    layer.roots.forEach((node, index) => {
      pushNode(rows, node, layer.layerId, collapsedIds, 2, 0, index + 1, layer.roots.length, propertyColumns);
    });
  });

  return rows;
}

/** One object row, then its masks, then its child objects — the order the panel draws them. */
function pushNode(
  rows: TreeRow[],
  node: ObjectTreeNode,
  layerId: string,
  collapsedIds: ReadonlySet<string>,
  level: number,
  depth: number,
  posInSet: number,
  setSize: number,
  propertyColumns: number
): void {
  const masks = node.object.masks ?? [];
  // Masks and child objects share one set: a reader navigating an object with two masks and one
  // child group meets three things, so being told "1 of 2" then "1 of 1" would misdescribe it.
  const childCount = masks.length + node.children.length;
  const collapsed = collapsedIds.has(node.object.id);

  rows.push({
    id: node.object.id,
    kind: "object",
    level,
    posInSet,
    setSize,
    expandable: childCount > 0,
    expanded: childCount > 0 && !collapsed,
    depth,
    layerId,
    cellCount: FIXED_COLUMNS + propertyColumns,
    objectId: node.object.id
  });
  if (collapsed) return;

  masks.forEach((mask, index) => {
    rows.push({
      id: `${node.object.id}:${mask.id}`,
      kind: "mask",
      level: level + 1,
      posInSet: index + 1,
      setSize: childCount,
      expandable: false,
      expanded: false,
      depth,
      layerId,
      cellCount: MASK_CELLS,
      objectId: node.object.id,
      maskId: mask.id
    });
  });

  node.children.forEach((child, index) => {
    pushNode(rows, child, layerId, collapsedIds, level + 1, depth + 1, masks.length + index + 1, childCount, propertyColumns);
  });
}
