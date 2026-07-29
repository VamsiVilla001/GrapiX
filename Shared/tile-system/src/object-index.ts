/**
 * Object-to-tile spatial index.
 *
 * The index exists so that moving one object does not cost a scan of the grid.
 * A 512-tile grid over a 50,000 x 50,000 stage has 9,604 tiles; dragging a lower
 * third must touch four of them, not all of them.
 *
 * `upsert` returns exactly which tiles the object entered and left, so the tile
 * manager can dirty the minimum set. That is the difference between "render on
 * change" and "render everything every frame".
 */

import { rectsIntersect, unionRects, type StageRect } from "@grapix/stage-model";

import { tileBounds, tileId, tilesForRect, type TileGrid, type TileId } from "./grid.js";
import { filterStackExtent, type FilterOverscanSource } from "./state.js";

export interface IndexedObject {
  objectId: string;
  /** Untransformed-to-stage bounds, already in stage coordinates. */
  bounds: StageRect;
  /** Logical units this object's filters reach beyond `bounds`. */
  filterExtent: number;
  /** Bounds inflated by `filterExtent`; what the index actually keys on. */
  effectiveBounds: StageRect;
  tiles: TileId[];
}

export interface IndexDelta {
  objectId: string;
  entered: TileId[];
  left: TileId[];
  /** True when the object's tile set is unchanged but its geometry moved. */
  movedWithinTiles: boolean;
}

export interface ObjectPlacement {
  objectId: string;
  bounds: StageRect;
  filters?: readonly FilterOverscanSource[];
  /** Pre-computed extent, if the caller already knows it. */
  filterExtent?: number;
}

/**
 * Incremental spatial index from scene objects to tiles.
 *
 * Not a quadtree: a uniform grid *is* the spatial structure here, so the index
 * only needs the two directions of the mapping plus enough per-object state to
 * compute a delta.
 */
export class TileObjectIndex {
  private readonly grid: TileGrid;
  private readonly objects = new Map<string, IndexedObject>();
  private readonly tileObjects = new Map<TileId, Set<string>>();

  constructor(grid: TileGrid) {
    this.grid = grid;
  }

  get objectCount(): number {
    return this.objects.size;
  }

  get occupiedTileCount(): number {
    return this.tileObjects.size;
  }

  /**
   * Insert or move an object.
   *
   * The returned delta names only the tiles that changed membership, which is
   * the set the caller must mark dirty. When the tile set is unchanged but the
   * object moved, `movedWithinTiles` is true and the caller must still dirty the
   * object's current tiles — the pixels changed even though membership did not.
   */
  upsert(placement: ObjectPlacement): IndexDelta {
    const filterExtent =
      placement.filterExtent ?? filterStackExtent(placement.filters ?? []);
    const effectiveBounds = inflate(placement.bounds, filterExtent);

    const nextTiles = tilesForRect(this.grid, effectiveBounds).map((coord) =>
      tileId(coord.column, coord.row)
    );
    const nextSet = new Set(nextTiles);

    const previous = this.objects.get(placement.objectId);
    const previousSet = new Set(previous?.tiles ?? []);

    const entered: TileId[] = [];
    for (const id of nextTiles) {
      if (!previousSet.has(id)) {
        entered.push(id);
        this.addToTile(id, placement.objectId);
      }
    }

    const left: TileId[] = [];
    for (const id of previousSet) {
      if (!nextSet.has(id)) {
        left.push(id);
        this.removeFromTile(id, placement.objectId);
      }
    }

    const geometryChanged =
      previous === undefined
      || previous.bounds.x !== placement.bounds.x
      || previous.bounds.y !== placement.bounds.y
      || previous.bounds.width !== placement.bounds.width
      || previous.bounds.height !== placement.bounds.height
      || previous.filterExtent !== filterExtent;

    this.objects.set(placement.objectId, {
      objectId: placement.objectId,
      bounds: { ...placement.bounds },
      filterExtent,
      effectiveBounds,
      tiles: nextTiles
    });

    return {
      objectId: placement.objectId,
      entered,
      left,
      movedWithinTiles: geometryChanged && entered.length === 0 && left.length === 0
    };
  }

  /** Remove an object. The returned `left` set is what must be dirtied. */
  remove(objectId: string): IndexDelta {
    const existing = this.objects.get(objectId);
    if (!existing) {
      return { objectId, entered: [], left: [], movedWithinTiles: false };
    }

    for (const id of existing.tiles) {
      this.removeFromTile(id, objectId);
    }
    this.objects.delete(objectId);

    return { objectId, entered: [], left: existing.tiles, movedWithinTiles: false };
  }

  clear(): void {
    this.objects.clear();
    this.tileObjects.clear();
  }

  get(objectId: string): IndexedObject | undefined {
    return this.objects.get(objectId);
  }

  /** Tiles an object currently occupies. */
  tilesForObject(objectId: string): TileId[] {
    return this.objects.get(objectId)?.tiles.slice() ?? [];
  }

  /**
   * Objects overlapping a tile, sorted for determinism.
   *
   * Sorted because two engines rendering the same frame must submit draws in the
   * same order, or a transparent overlap can differ between them.
   */
  objectsInTile(id: TileId): string[] {
    const set = this.tileObjects.get(id);
    return set ? [...set].sort() : [];
  }

  objectCountInTile(id: TileId): number {
    return this.tileObjects.get(id)?.size ?? 0;
  }

  /** Overscan a tile needs: the largest filter extent among its objects. */
  requiredOverscan(id: TileId, minimum = 0): number {
    const set = this.tileObjects.get(id);
    if (!set) return minimum;

    let maximum = minimum;
    for (const objectId of set) {
      const extent = this.objects.get(objectId)?.filterExtent ?? 0;
      if (extent > maximum) maximum = extent;
    }
    return Math.ceil(maximum);
  }

  /**
   * Objects whose effective bounds intersect a rectangle.
   *
   * Goes through the tile map rather than scanning every object, then filters
   * precisely — the tile map is a conservative first pass.
   */
  objectsInRect(bounds: StageRect): string[] {
    const candidates = new Set<string>();
    for (const coord of tilesForRect(this.grid, bounds)) {
      const set = this.tileObjects.get(tileId(coord.column, coord.row));
      if (!set) continue;
      for (const objectId of set) candidates.add(objectId);
    }

    const result: string[] = [];
    for (const objectId of candidates) {
      const entry = this.objects.get(objectId);
      if (entry && rectsIntersect(entry.effectiveBounds, bounds)) {
        result.push(objectId);
      }
    }
    return result.sort();
  }

  /** Every tile that currently holds at least one object. */
  occupiedTiles(): TileId[] {
    return [...this.tileObjects.keys()].sort();
  }

  /**
   * Union of every indexed object's effective bounds.
   *
   * The area that could possibly need rendering. On a sparse 50,000-wide stage
   * this is usually a small fraction of the whole thing.
   */
  contentBounds(): StageRect {
    let result: StageRect | undefined;
    for (const entry of this.objects.values()) {
      result = result ? unionRects(result, entry.effectiveBounds) : { ...entry.effectiveBounds };
    }
    return result ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /**
   * Objects that straddle more than one tile.
   *
   * These are the seam risks, so diagnostics surface them explicitly.
   */
  multiTileObjects(): string[] {
    const result: string[] = [];
    for (const entry of this.objects.values()) {
      if (entry.tiles.length > 1) result.push(entry.objectId);
    }
    return result.sort();
  }

  /** Logical bounds of a tile, for callers that only hold the index. */
  boundsOfTile(id: TileId): StageRect | undefined {
    const parts = id.split(":");
    if (parts.length !== 3) return undefined;
    const column = Number.parseInt(parts[1], 10);
    const row = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(column) || !Number.isInteger(row)) return undefined;
    return tileBounds(this.grid, { column, row });
  }

  private addToTile(id: TileId, objectId: string): void {
    const existing = this.tileObjects.get(id);
    if (existing) {
      existing.add(objectId);
      return;
    }
    this.tileObjects.set(id, new Set([objectId]));
  }

  private removeFromTile(id: TileId, objectId: string): void {
    const existing = this.tileObjects.get(id);
    if (!existing) return;
    existing.delete(objectId);
    if (existing.size === 0) {
      this.tileObjects.delete(id);
    }
  }
}

function inflate(bounds: StageRect, amount: number): StageRect {
  if (!(amount > 0)) return { ...bounds };
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2
  };
}
